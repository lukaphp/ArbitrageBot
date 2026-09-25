/**
 * MCP TOOLS IMPLEMENTATION (ArbitrageBot)
 * =======================================
 *
 * Layer di sicurezza e middleware per l'interazione con agenti AI (Hermes).
 * Nessun agente scrive direttamente sul DB SQLite; ogni operazione passa da
 * queste funzioni che applicano safeguards, validazione, cache invalidation,
 * il Protocollo Guardrails pre-flight e audit logging con actor 'hermes_mcp_call'.
 */

import db from '../db/database.js';
import botManager from '../perps/botManager.js';
import paperBroker from '../perps/paperBroker.js';
import client from '../perps/hyperliquidClient.js';
import riskAgent from '../agents/riskAgent.js';
import logger from '../utils/logger.js';
import { postInternal, requestInternal } from '../utils/internalLoopback.js';
import { ownsTickLoop } from '../utils/processRole.js';
import { mergeStrategyConfig, extractBotConfig } from '../perps/strategySchema.js';
import { runBacktest } from '../perps/backtester.js';
import {
  validateInstructionOverride,
  checkOrderVelocity,
  recordOrderExecution,
  validateRiskCeiling,
  checkPositionUniqueness,
  checkPositionUniquenessLive,
  requestTwoStageConfirmation,
  validateAndConsumeConfirmation,
  evaluateBacktestGate,
  GUARDRAILS_CONFIG
} from './guardrails.js';

/** Oggetto "semplice": né null, né array, né istanza esotica. */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `mergeStrategyConfig` ed `extractBotConfig` sono definite in
 * `perps/strategySchema.js` (funzioni pure sulla configurazione di strategia) e
 * ri-esportate qui: hanno un secondo consumatore fuori dal layer MCP
 * (`agents/executionAgent`, proposte `tune_params`) e devono restare UNA sola,
 * non due copie che divergono. I chiamanti e i test che le importano da qui
 * continuano a funzionare identici.
 */
export { mergeStrategyConfig, extractBotConfig };

/**
 * Registra una chiamata MCP nell'audit log del database.
 */
export function logMcpAudit(toolName, detail = {}) {
  try {
    db.ensure();
    db.insertAudit('hermes_mcp_call', toolName, detail);
  } catch (err) {
    logger.warn(`⚠️ MCP Audit log fallito per ${toolName}:`, err.message);
  }
}

/**
 * Guardrail applicativo sui parametri del SIZING DINAMICO ATR
 * (`config.risk.useDynamicSizing` e compagni).
 *
 * Perché serve qui e non basta lo schema di strategia: `register_bot` e
 * `update_strategy_params` dichiarano la config come `z.record(z.any())`, cioè
 * un agente può scriverci dentro qualunque cosa. Un `riskPerTradePct: 500`
 * accettato in silenzio non è un errore di battitura innocuo — è una posizione
 * dimensionata cinque volte l'equity; un `atrMultiplier: 0` è una divisione per
 * zero che a valle diventa un NaN. `riskManager.sizePosition` degrada al sizing
 * statico invece di lanciare (il warmup delle candele è un caso normale),
 * quindi senza questo cancello il valore assurdo resterebbe nella config a
 * tempo indeterminato, segnalato solo da un warn per tick.
 *
 * Legge i campi da `source.risk` (la forma vera della config) e, in subordine,
 * dallo stesso livello di `leverage`/`maxPositionUsd`, che gli altri guardrail
 * di questo file leggono già piatti.
 *
 * @returns stringa `GUARDRAIL_VIOLATION: …` se qualcosa non va, altrimenti null
 */
export function validateDynamicSizingParams(source) {
  if (!isPlainObject(source)) return null;
  const nested = isPlainObject(source.risk) ? source.risk : {};
  const pick = (key) => (nested[key] !== undefined ? nested[key] : source[key]);

  const useDynamicSizing = pick('useDynamicSizing');
  if (useDynamicSizing !== undefined && typeof useDynamicSizing !== 'boolean') {
    return `GUARDRAIL_VIOLATION: useDynamicSizing deve essere true o false (ricevuto: ${JSON.stringify(useDynamicSizing)}).`;
  }

  const riskPerTradePct = pick('riskPerTradePct');
  if (riskPerTradePct != null) {
    const v = Number(riskPerTradePct);
    if (!Number.isFinite(v) || v <= 0 || v > 100) {
      return `GUARDRAIL_VIOLATION: riskPerTradePct non valido: ${riskPerTradePct}. Deve essere un numero > 0 e <= 100 (percentuale di equity a rischio per trade).`;
    }
  }

  const atrMultiplier = pick('atrMultiplier');
  if (atrMultiplier != null) {
    const v = Number(atrMultiplier);
    if (!Number.isFinite(v) || v <= 0) {
      return `GUARDRAIL_VIOLATION: atrMultiplier non valido: ${atrMultiplier}. Deve essere un numero > 0.`;
    }
  }

  // `atrPeriod` si legge SOLO da `risk`: al livello superiore `config.atrPeriod`
  // è un campo preesistente e diverso (il periodo ATR di TP/SL/trailing), e non
  // è questa la storia in cui iniziare a rifiutarlo.
  const atrPeriod = nested.atrPeriod;
  if (atrPeriod != null) {
    const v = Number(atrPeriod);
    if (!Number.isInteger(v) || v < 2) {
      return `GUARDRAIL_VIOLATION: atrPeriod non valido: ${atrPeriod}. Deve essere un intero >= 2.`;
    }
  }

  return null;
}

/**
 * Notifica il processo Express HTTP di sincronizzare botManager dal DB.
 *
 * Necessario quando il tool MCP gira in un processo Stdio separato (es. Hermes
 * invoca `docker exec ... node src/mcp/server.js`): le modifiche al DB
 * non aggiornano automaticamente la Map in-memory del processo Express.
 * Questo endpoint loopback è protetto a livello IP (solo 127.x / 172.x).
 *
 * Non-blocking: il fallimento non deve interrompere la risposta MCP.
 */

/** Finestra storica su cui si misura l'edge di una strategia scritta da un agente. */
const BACKTEST_GATE_LOOKBACK_DAYS = 30;

/**
 * BACKTEST GATE — guscio di I/O attorno a `evaluateBacktestGate`.
 *
 * Divisione dei compiti, identica a quella fra `bot.js` e `riskManager.js`:
 * qui si SCARICANO le candele e si fa girare il backtester; la soglia e il
 * verdetto stanno tutti nella funzione pura dei guardrail, che è l'unico posto
 * dove leggere "cosa blocca cosa" — sia per `register_bot` sia per
 * `update_strategy_params`. Questa funzione non decide nulla: traduce un esito
 * (o un guasto) in qualcosa che la funzione pura sappia giudicare.
 *
 * DUE PROPRIETÀ CHE NON SI POSSONO PERDERE:
 *
 *  1. NON LANCIA MAI. Un backtester che esplode, una rete che cade o un
 *     formato di candele inatteso diventano `{ error }`, cioè `inconclusive`:
 *     la creazione passa e l'incertezza viene scritta. Un guardrail guasto che
 *     blocca tutto è peggio del guardrail assente — e l'eccezione qui sarebbe
 *     un `register_bot` fallito con un messaggio che non parla di trading.
 *  2. Senza `entryRules` NON si scarica niente. Una config senza regole
 *     d'ingresso non può produrre un solo trade: il backtest sarebbe una
 *     chiamata di rete il cui esito è noto in anticipo (zero trade). Il
 *     verdetto lo emette comunque la funzione pura, non un ramo scritto qui.
 *
 * Al riassunto si aggiunge il CONTESTO della misura (coin, intervallo, giorni):
 * senza, `profitFactor: 0.4` salvato sulla config non dice su cosa né su quanto
 * tempo è stato misurato, e fra un mese nessuno può rifarlo uguale.
 *
 * @param {object} config configurazione di strategia CANDIDATA (già fusa, nel
 *   caso di un aggiornamento: è quella con cui il bot opererebbe davvero)
 * @param {string} coin coin normalizzata (es. `SOL-PERP`)
 * @returns {Promise<{verdict: string, blocked: boolean, reason: string, summary: object}>}
 */
async function runBacktestGate(config, coin) {
  const entryRules = Array.isArray(config?.entryRules) ? config.entryRules : null;
  let result;

  if (!entryRules || entryRules.length === 0) {
    result = { error: 'nessuna regola di ingresso da valutare (strategia senza entryRules)' };
  } else {
    try {
      result = await runBacktest(config, coin, {
        interval: config.candleInterval,
        lookbackDays: BACKTEST_GATE_LOOKBACK_DAYS
      });
    } catch (err) {
      // L'eccezione VERA nel messaggio: "backtest non disponibile" non dice a
      // Hermes (né a chi legge l'audit fra un mese) se è caduta la rete o si è
      // rotto il backtester.
      result = { error: err?.message || String(err) };
      logger.warn(`⚠️ Backtest Gate non concludente su ${coin}: ${result.error}`);
    }
  }

  const gate = evaluateBacktestGate(result);
  return {
    ...gate,
    summary: {
      ...gate.summary,
      coin,
      interval: result?.period?.interval || config?.candleInterval || null,
      lookbackDays: BACKTEST_GATE_LOOKBACK_DAYS
    }
  };
}

/**
 * CRIT #7 — esegue un'azione di ciclo di vita NEL PROCESSO CHE POSSIEDE IL LOOP.
 *
 * Nel processo Express (o in qualunque processo che non si sia dichiarato MCP
 * Stdio) è una chiamata diretta: nulla cambia rispetto a prima. Nel processo MCP
 * Stdio diventa una delega HTTP su loopback: quel processo non avvia più bot, e
 * quindi non può più esistere un secondo tick loop sulla stessa riga `positions`.
 *
 * L'esito che torna a Hermes è quello VERO di Express, `result` compreso. In
 * particolare NON si finge nulla quando Express non risponde: si lancia, il
 * chiamante risponde `success: false` e l'agente sa che l'azione non è stata
 * eseguita da nessuno. Un successo locale in quel caso rimetterebbe in piedi
 * esattamente la divergenza fra i due processi che questa issue chiude.
 *
 * Timeout generoso (15s): un `restart` attende su Express la fine del tick in
 * volo (`whenIdle`), che può durare quanto un giro di chiamate a Hyperliquid.
 */
async function applyBotLifecycle(botId, action) {
  if (ownsTickLoop()) {
    if (action === 'reload_config') {
      return { state: await botManager.reloadBotFromDb(botId), result: 'config_reloaded' };
    }
    return botManager.applyLifecycleLocal(botId, action);
  }

  const res = await requestInternal('/internal/mcp/bot-control', { bot_id: botId, action }, { timeoutMs: 15000 });
  if (!res.reached) {
    throw new Error(`Processo Express non raggiungibile (${res.error}): l'azione '${action}' NON è stata eseguita in nessun processo. I bot girano solo lì; riprova quando il server principale risponde.`);
  }
  if (!res.ok || res.body?.success !== true) {
    throw new Error(res.body?.error || `il processo Express ha rifiutato l'azione '${action}' (HTTP ${res.status})`);
  }
  return { state: res.body.state, result: res.body.result, delegated: true };
}

/**
 * Stato dei bot, letto da chi li esegue davvero.
 *
 * Nel processo MCP le istanze locali esistono ma sono ferme per costruzione:
 * leggerle direttamente significherebbe raccontare a Hermes che nessun bot è
 * attivo. Si chiede quindi a Express; se non risponde si degrada al DB — che
 * conosce `status`, nome e coin ma non `lastEval`/`lastTickAt`/posizione — e IL
 * DEGRADO SI DICHIARA, perché una fotografia parziale spacciata per completa è
 * il modo in cui un agente prende decisioni sbagliate con la massima fiducia.
 *
 * @returns {Promise<{bots: object[], degraded: string|null}>}
 */
async function readBotStates() {
  if (ownsTickLoop()) return { bots: botManager.listStates(), degraded: null };

  const res = await requestInternal('/internal/mcp/bot-states', {}, { timeoutMs: 5000 });
  if (res.reached && res.ok && Array.isArray(res.body?.states)) {
    return { bots: res.body.states, degraded: null };
  }
  const reason = res.reached
    ? `il processo Express ha risposto ${res.status}`
    : `il processo Express non è raggiungibile (${res.error})`;
  logger.warn(`get_system_snapshot: stato dei bot letto dal DB — ${reason}`);
  const today = new Date().toISOString().split('T')[0];
  const bots = db.listBots().map(row => ({
    id: row.id,
    name: row.name,
    coin: row.coin,
    status: row.status,
    actor_label: row.actor_label,
    is_managed_by_agent: !!row.is_managed_by_agent,
    linked_agent_id: row.linked_agent_id,
    dailyPnl: db.getDailyPnl(row.id, today)
  }));
  return { bots, degraded: reason };
}

async function notifyExpressReload() {
  // La POST loopback vive in `src/utils/internalLoopback.js`, condivisa con
  // `botManager` (che la usa per inoltrare gli update autonomi del tick loop):
  // un solo posto dove stanno host, porta, timeout e la regola "non fallire mai
  // rumorosamente". Il valore di ritorno qui si ignora di proposito — lo Stdio
  // funziona anche a Express spento.
  await postInternal('/internal/mcp/reload');
}

/**
 * 1. BOT CONTROL
 * Controlla il ciclo di vita del bot (start, stop, restart) con salvaguardia crash/watchdog.
 */
export async function handleBotControl({ bot_id, action }) {
  if (!bot_id) {
    return { success: false, message: 'Parametro bot_id obbligatorio.' };
  }
  if (!['start', 'stop', 'restart'].includes(action)) {
    return { success: false, message: `Azione non valida: ${action}. Usa 'start', 'stop' o 'restart'.` };
  }

  db.ensure();
  const botRow = db.getBot(bot_id);
  if (!botRow) {
    const errorMsg = `Bot non trovato nel DB (id: ${bot_id})`;
    logMcpAudit('bot_control', { bot_id, action, error: errorMsg, success: false });
    return { success: false, message: errorMsg };
  }

  try {
    // CRIT #7 — l'azione la esegue il processo che possiede il tick loop. Qui
    // non c'è più nessun `startBot()` locale incondizionato: nel processo MCP
    // Stdio quello era il secondo esecutore, che girava in parallelo a Express
    // sulla stessa riga `positions`.
    const { state, result, delegated } = await applyBotLifecycle(bot_id, action);

    logMcpAudit('bot_control', { bot_id, action, result, status: state?.status, delegated: !!delegated, success: true });

    // Notifica il processo Express di sincronizzare botManager dal DB. Non serve
    // quando l'azione È STATA eseguita da lui: l'ha appena fatta e lo sa già.
    if (!delegated) notifyExpressReload().catch(() => {});

    const message = result === 'already_running'
      ? `Bot '${botRow.name}' (${bot_id}) è già in esecuzione.`
      : result === 'already_stopped'
        ? `Bot '${botRow.name}' (${bot_id}) è già fermo.`
        : `Bot '${botRow.name}' (${bot_id}) impostato su '${state?.status || action}' con successo.`;

    return { success: true, message, data: state };
  } catch (error) {
    const errorMsg = `Errore durante ${action} del bot: ${error.message}`;
    logMcpAudit('bot_control', { bot_id, action, error: errorMsg, success: false });
    return { success: false, message: errorMsg };
  }
}

/**
 * 2. PLACE ORDER PAPER
 * Esegue un ordine paper con Protocollo Guardrails Pre-Flight:
 * - Instruction Override (Blacklist check)
 * - Order Velocity Gate (Cooldown anti-loop)
 * - Position Uniqueness Gate (no doppio ingresso nello stesso verso su bot+coin),
 *   su due sorgenti: riga `positions` in DB e posizioni dell'account paper
 * - Risk Ceiling Hard-Gate (Max Leverage <= 5x, Account Exposure <= maxPositionUsd, Daily Loss Limit)
 */
export async function handlePlaceOrderPaper({ bot_id, side, size, entry_price = null, leverage = null }) {
  if (!bot_id) {
    return { success: false, message: 'Parametro bot_id obbligatorio.' };
  }
  const normalizedSide = String(side || '').toLowerCase();
  if (normalizedSide !== 'long' && normalizedSide !== 'short') {
    return { success: false, message: `Side non valido: ${side}. Usa 'long' o 'short'.` };
  }
  const numericSize = parseFloat(size);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return { success: false, message: `Size non valida: ${size}. Deve essere un numero positivo.` };
  }

  // Safe-guard 0: Kill-Switch Globale
  if (riskAgent.isKillSwitchOn()) {
    const msg = 'GUARDRAIL_VIOLATION: Kill-switch globale attivo. Ordine rifiutato.';
    logMcpAudit('place_order_paper', { bot_id, side, size, error: msg, guardrail: 'kill_switch', success: false });
    return { success: false, error: msg, message: msg };
  }

  db.ensure();
  const botRow = db.getBot(bot_id);
  if (!botRow) {
    const msg = `Bot non trovato (id: ${bot_id})`;
    logMcpAudit('place_order_paper', { bot_id, side, size, error: msg, success: false });
    return { success: false, message: msg };
  }

  const coin = botRow.coin;
  const network = botRow.network || 'testnet';
  const masterAddress = botRow.masterAddress || botRow.master_address || 'paper_hermes';
  const botConfig = extractBotConfig(botRow);

  // GUARDRAIL 1: INSTRUCTION OVERRIDE & BLACKLIST
  const overrideCheck = validateInstructionOverride({ coin, botConfig });
  if (!overrideCheck.ok) {
    logMcpAudit('place_order_paper', { bot_id, coin, side, size, error: overrideCheck.error, guardrail: 'instruction_override', success: false });
    return { success: false, error: overrideCheck.error, message: overrideCheck.error };
  }

  // GUARDRAIL 2: ORDER VELOCITY GATE (Cooldown anti-loop)
  const velocityCheck = checkOrderVelocity(bot_id);
  if (!velocityCheck.ok) {
    logMcpAudit('place_order_paper', { bot_id, coin, side, size, error: velocityCheck.error, guardrail: 'order_velocity', success: false });
    return { success: false, error: velocityCheck.error, message: velocityCheck.error };
  }

  // GUARDRAIL 3: POSITION UNIQUENESS GATE — LIVELLO 1 (posizione tracciata in DB)
  // Prima del prezzo e del Risk Ceiling: è una lettura sincrona in DB e non serve
  // nessun dato di mercato per sapere che il segnale è già stato agito — fail-fast,
  // stesso principio del Budget Ceiling in bot.js. Il verso opposto (riduzione o
  // chiusura) passa e prosegue normalmente. Il livello 2 (stato dell'account) è
  // più sotto, appena le posizioni sono disponibili: qui non lo si può anticipare
  // senza pagare un fetch che questo livello spesso rende inutile.
  const uniquenessCheck = checkPositionUniqueness({ botId: bot_id, coin, side: normalizedSide });
  if (!uniquenessCheck.ok) {
    logMcpAudit('place_order_paper', { bot_id, coin, side, size, error: uniquenessCheck.error, guardrail: 'position_uniqueness', success: false });
    return { success: false, error: uniquenessCheck.error, message: uniquenessCheck.error };
  }

  try {
    // Ottiene il prezzo di mercato corrente o usa entry_price fornito
    let px = parseFloat(entry_price);
    if (!Number.isFinite(px) || px <= 0) {
      px = await client.getMid(coin, network).catch(() => null);
    }
    if (!px || px <= 0) {
      const msg = `Prezzo di mercato non disponibile per la coin ${coin}`;
      logMcpAudit('place_order_paper', { bot_id, coin, side, size, error: msg, success: false });
      return { success: false, message: msg };
    }

    // Recupera lo stato paper e il daily PnL del bot/account.
    // Nessun `.catch()` qui di proposito: se la lettura dell'account fallisce,
    // l'eccezione arriva al catch in fondo e l'ordine NON viene eseguito. È il
    // fail-closed che serve al guardrail qui sotto — con lo stato dell'account
    // ignoto non si apre niente.
    const paperAccount = await paperBroker.getAccount(masterAddress, network);
    const today = new Date().toISOString().split('T')[0];
    // CRIT #7 — l'istanza in memoria vale come sorgente del PnL giornaliero SOLO
    // nel processo che esegue il bot: lì `dailyPnl` è aggiornato a ogni chiusura.
    // Nel processo MCP l'istanza non ticca, quindi quel campo resta fermo al
    // valore letto all'avvio del processo e il Daily Loss Limit — un guardrail
    // sul denaro — verrebbe valutato su un numero vecchio di ore. Il DB è scritto
    // da `bot._registerClose` ed è la sorgente condivisa.
    const botInstance = ownsTickLoop() ? botManager.bots.get(bot_id) : null;
    const currentDailyPnl = (botInstance && typeof botInstance.dailyPnl === 'number')
      ? botInstance.dailyPnl
      : db.getDailyPnl(bot_id, today);

    // GUARDRAIL 4: POSITION UNIQUENESS GATE — LIVELLO 2 (stato dell'account)
    // Il livello 1 legge la riga `positions`, che questo percorso NON scrive: su
    // un bot fermo, pilotato solo dall'agente, quella riga non esiste mai e il
    // duplicato passerebbe. Qui la sorgente è l'account (fonte di verità sulla
    // posizione, lo stesso criterio di `bot._reconcile`). Le posizioni si passano
    // GREZZE: se la lista è assente il cancello blocca invece di dedurre "nessuna
    // posizione" (vedi checkPositionUniquenessLive).
    const liveUniquenessCheck = checkPositionUniquenessLive({
      botId: bot_id,
      coin,
      side: normalizedSide,
      accountPositions: paperAccount.positions
    });

    if (!liveUniquenessCheck.ok) {
      logMcpAudit('place_order_paper', { bot_id, coin, side, size, error: liveUniquenessCheck.error, guardrail: 'position_uniqueness', success: false });
      return { success: false, error: liveUniquenessCheck.error, message: liveUniquenessCheck.error };
    }

    // GUARDRAIL 5: RISK CEILING HARD-GATE
    // (Max Leverage <= 5x, Account Exposure <= maxPositionUsd, Daily Loss Limit)
    const riskCeilingCheck = validateRiskCeiling({
      botRow,
      botConfig,
      side: normalizedSide,
      size: numericSize,
      entryPrice: px,
      requestedLeverage: leverage,
      accountPositions: paperAccount.positions || [],
      dailyPnl: currentDailyPnl
    });

    if (!riskCeilingCheck.ok) {
      logMcpAudit('place_order_paper', { bot_id, coin, side, size, error: riskCeilingCheck.error, guardrail: 'risk_ceiling', success: false });
      return { success: false, error: riskCeilingCheck.error, message: riskCeilingCheck.error };
    }

    // Esecuzione Paper Order
    const isBuy = normalizedSide === 'long';
    const result = await paperBroker.placeMarketOrder({
      masterAddress,
      coin,
      isBuy,
      size: numericSize
    }, network);

    if (result.error) {
      logMcpAudit('place_order_paper', { bot_id, coin, side, size, error: result.error, success: false });
      return { success: false, message: `Errore broker paper: ${result.error}` };
    }

    // Registra timestamp per Order Velocity Gate
    recordOrderExecution(bot_id);

    // Salva nel database trades per tracciabilità storica
    try {
      db.insertTrade({
        botId: bot_id,
        coin,
        side: normalizedSide,
        px: result.avgPx || px,
        sz: numericSize,
        fee: (result.avgPx || px) * numericSize * 0.00035,
        hlOid: result.oid || Date.now()
      });
    } catch (dbErr) {
      logger.warn('Registrazione trade paper in DB fallita:', dbErr.message);
    }

    // Notifica Socket.IO dashboard
    if (botManager.io) {
      botManager.io.emit('perps:dashboardRefresh', {
        reason: 'mcp_place_order_paper',
        botId: bot_id,
        coin,
        side: normalizedSide,
        size: numericSize
      });
    }

    // …e il processo Express, che nel percorso MCP Stdio è un ALTRO processo:
    // lì `botManager.io` è null e l'emit qui sopra non raggiunge nessuno.
    notifyExpressReload().catch(() => {});

    const resPayload = {
      bot_id,
      coin,
      side: normalizedSide,
      size: numericSize,
      executed_price: result.avgPx || px,
      notional_usd: numericSize * (result.avgPx || px),
      order_id: result.oid,
      paper: true,
      timestamp: Date.now()
    };

    logMcpAudit('place_order_paper', { ...resPayload, success: true });

    return {
      success: true,
      message: `Ordine paper ${normalizedSide.toUpperCase()} eseguito con successo su ${coin} (${numericSize} @ $${(result.avgPx || px).toFixed(4)})`,
      data: resPayload
    };
  } catch (error) {
    const msg = `Errore esecuzione ordine paper: ${error.message}`;
    logMcpAudit('place_order_paper', { bot_id, side, size, error: msg, success: false });
    return { success: false, message: msg };
  }
}

/**
 * 3. GET SYSTEM SNAPSHOT
 * Ritorna lo stato consolidato di tutti i bot, P&L cumulativo, uPNL e alert di sistema.
 */
export async function handleGetSystemSnapshot() {
  db.ensure();

  try {
    // CRIT #7 — nel processo MCP i bot girano altrove: lo stato si chiede a chi
    // li esegue (vedi `readBotStates`), e un eventuale ripiego sul DB si dichiara.
    const { bots, degraded } = await readBotStates();
    const killSwitch = riskAgent.isKillSwitchOn();

    // Recupera lo stato aggregato paper
    const paperMaster = 'paper_hermes';
    const paperAcc = await paperBroker.getAccount(paperMaster, 'testnet').catch(() => ({
      equity: 10000,
      positions: [],
      accountValue: 10000
    }));

    // Trade chiusi e P&L totale
    const trades = db.listTrades(50);
    const closedTradesCount = trades.length;
    const totalFees = trades.reduce((sum, t) => sum + (Number(t.fee) || 0), 0);
    const realizedPnl = trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);

    // uPnL dalle posizioni aperte
    const openPositions = paperAcc.positions || [];
    const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + (Number(p.unrealizedPnl) || 0), 0);

    // Diagnostica Alert e Watchdog
    const alerts = [];
    if (killSwitch) {
      alerts.push({ level: 'critical', type: 'kill_switch', message: 'Kill-switch globale attivo: trading bloccato.' });
    }
    if (degraded) {
      alerts.push({
        level: 'warning',
        type: 'bot_states_degraded',
        message: `Stato dei bot letto dal DB e non dal processo che li esegue (${degraded}): status attendibile, ma ultima valutazione, ultimo tick e posizione in corso NON sono in questa risposta.`
      });
    }

    const now = Date.now();
    for (const b of bots) {
      if (b.status === 'running') {
        const lastTick = b.lastTickAt ? Number(b.lastTickAt) : 0;
        if (lastTick > 0 && (now - lastTick > 120000)) {
          alerts.push({
            level: 'warning',
            type: 'stale_bot',
            bot_id: b.id,
            bot_name: b.name,
            message: `Bot ${b.name} fermo da ${Math.round((now - lastTick) / 1000)}s senza nuovi tick.`
          });
        }
      }
    }

    const payload = {
      timestamp: now,
      system_health: {
        kill_switch: killSwitch,
        active_bots: bots.filter(b => b.status === 'running').length,
        total_bots: bots.length,
        open_positions_count: openPositions.length
      },
      portfolio: {
        equity: paperAcc.equity,
        realized_pnl: realizedPnl,
        unrealized_pnl: totalUnrealizedPnl,
        total_fees: totalFees,
        closed_trades_count: closedTradesCount
      },
      bots: bots.map(b => ({
        id: b.id,
        name: b.name,
        coin: b.coin,
        status: b.status,
        actor_label: b.actor_label || 'Manuale',
        is_managed_by_agent: !!b.is_managed_by_agent,
        last_eval_action: b.lastEval?.action || 'none',
        daily_pnl: b.dailyPnl || 0
      })),
      open_positions: openPositions.map(p => ({
        coin: p.coin,
        side: p.side,
        size: p.size,
        entry_price: p.entryPx,
        unrealized_pnl: p.unrealizedPnl,
        margin_used: p.marginUsed
      })),
      alerts
    };

    logMcpAudit('get_system_snapshot', { active_bots: payload.system_health.active_bots, alerts_count: alerts.length, success: true });

    return {
      success: true,
      data: payload
    };
  } catch (error) {
    const msg = `Errore durante il recupero dello snapshot di sistema: ${error.message}`;
    logMcpAudit('get_system_snapshot', { error: msg, success: false });
    return { success: false, message: msg };
  }
}

/**
 * 4. EMERGENCY SHUTDOWN
 * Protocollo Guardrail: Conferma a due stadi temporizzata (finestra di 60s).
 */
export async function handleEmergencyShutdown({ threshold = null, confirmation_token = null, confirm = false }) {
  // Se non viene fornito un token di conferma valido (Stadio 1)
  if (!confirmation_token && confirm !== true) {
    const prompt = requestTwoStageConfirmation({
      action: 'emergency_shutdown',
      payload: { threshold },
      summary: 'Arresto immediato di tutti i bot attivi e attivazione del kill-switch globale.'
    });
    logMcpAudit('emergency_shutdown', { status: 'confirmation_required', threshold, success: false });
    return {
      success: false,
      ...prompt
    };
  }

  // Se è fornito confirmation_token, effettua la validazione e il consumo anti-replay (Stadio 2)
  if (confirmation_token) {
    const validation = validateAndConsumeConfirmation({
      confirmation_token,
      action: 'emergency_shutdown'
    });
    if (!validation.ok) {
      logMcpAudit('emergency_shutdown', { confirmation_token, error: validation.error, success: false });
      return { success: false, error: validation.error, message: validation.error };
    }
  }

  db.ensure();
  try {
    // 1. Attiva Kill-Switch nel DB e nel RiskAgent
    riskAgent.setKillSwitch(true);

    // 2. Arresta tutti i bot in esecuzione.
    //
    // CRIT #7 — chi sono "quelli in esecuzione" dipende dal processo. In Express
    // sono le istanze che stanno ticcando; nel processo MCP non ce n'è nessuna
    // (i loop stanno di là), quindi il ciclo locale avrebbe contato zero e la
    // risposta avrebbe dichiarato un arresto mai avvenuto. La lista arriva dal
    // DB, che è la sorgente condivisa fra i due processi, e ogni arresto passa
    // dal proprietario del loop.
    const targets = ownsTickLoop()
      ? [...botManager.bots.values()].filter(b => b.status === 'running').map(b => b.id)
      : db.listBots().filter(r => r.status === 'running').map(r => r.id);

    let stoppedCount = 0;
    const failedBotIds = [];
    for (const botId of targets) {
      try {
        await applyBotLifecycle(botId, 'stop');
        stoppedCount++;
      } catch (err) {
        failedBotIds.push(botId);
        logger.warn(`Arresto bot ${botId} in emergency_shutdown fallito:`, err.message);
      }
    }

    // 3. Emette evento Socket.IO
    if (botManager.io) {
      botManager.io.emit('perps:killSwitch', { on: true, actor: 'hermes_mcp_call', reason: 'emergency_shutdown' });
      botManager.io.emit('perps:dashboardRefresh', { reason: 'emergency_shutdown' });
    }

    // …e il processo Express, che nel percorso MCP Stdio è un ALTRO processo.
    // È il caso in cui una dashboard ferma fa più danno: kill-switch attivo e
    // bot fermi, ma la UI continua a mostrarli in esecuzione.
    notifyExpressReload().catch(() => {});

    const resPayload = {
      kill_switch: true,
      stopped_bots_count: stoppedCount,
      failed_bot_ids: failedBotIds,
      threshold: threshold != null ? Number(threshold) : null,
      timestamp: Date.now()
    };

    // Un arresto parziale NON è un successo: il kill-switch blocca i nuovi
    // ingressi (è una riga di `settings`, quindi vale per tutti i processi), ma
    // i bot che non si sono fermati continuano a gestire le posizioni aperte.
    // Dirlo è l'unica cosa che permette a chi legge di intervenire a mano.
    if (failedBotIds.length) {
      const msg = `🚨 EMERGENCY SHUTDOWN PARZIALE: kill-switch ATTIVO (nessun nuovo ingresso), ma ${failedBotIds.length} bot su ${targets.length} NON sono stati arrestati: ${failedBotIds.join(', ')}. Verifica il processo che li esegue.`;
      logMcpAudit('emergency_shutdown', { ...resPayload, success: false });
      return { success: false, message: msg, data: resPayload };
    }

    logMcpAudit('emergency_shutdown', { ...resPayload, success: true });

    return {
      success: true,
      message: `🚨 EMERGENCY SHUTDOWN COMPLETATO: Kill-switch attivato e ${stoppedCount} bot arrestati con successo.`,
      data: resPayload
    };
  } catch (error) {
    const msg = `Errore durante l'emergency shutdown: ${error.message}`;
    logMcpAudit('emergency_shutdown', { error: msg, success: false });
    return { success: false, message: msg };
  }
}

/**
 * 5. UPDATE STRATEGY PARAMS
 * Protocollo Guardrail: Modifica parametri di strategia con conferma a due stadi (60s)
 * e aggiornamento atomico DB / invalidazione cache runtime.
 */
export async function handleUpdateStrategyParams({ bot_id, params, confirmation_token = null }) {
  if (!bot_id) {
    return { success: false, message: 'Parametro bot_id obbligatorio.' };
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { success: false, message: 'Parametro params deve essere un oggetto chiave-valore valido.' };
  }

  db.ensure();
  const botRow = db.getBot(bot_id);
  if (!botRow) {
    const msg = `Bot non trovato (id: ${bot_id})`;
    logMcpAudit('update_strategy_params', { bot_id, params, error: msg, success: false });
    return { success: false, message: msg };
  }

  // Validazione dei parametri chiave prima di richiedere o eseguire la conferma
  if (params.leverage != null) {
    const lev = parseInt(params.leverage, 10);
    if (isNaN(lev) || lev < 1 || lev > GUARDRAILS_CONFIG.MAX_ACCOUNT_LEVERAGE) {
      const err = `GUARDRAIL_VIOLATION: Leva non valida: ${params.leverage}. Deve essere compresa tra 1 e ${GUARDRAILS_CONFIG.MAX_ACCOUNT_LEVERAGE}x.`;
      logMcpAudit('update_strategy_params', { bot_id, params, error: err, success: false });
      return { success: false, error: err, message: err };
    }
  }
  if (params.maxPositionUsd != null || params.max_position_usd != null) {
    const maxPos = parseFloat(params.maxPositionUsd || params.max_position_usd);
    if (isNaN(maxPos) || maxPos <= 0) {
      const err = 'GUARDRAIL_VIOLATION: maxPositionUsd deve essere un numero positivo.';
      return { success: false, error: err, message: err };
    }
  }
  const dynamicSizingErr = validateDynamicSizingParams(params);
  if (dynamicSizingErr) {
    logMcpAudit('update_strategy_params', { bot_id, params, error: dynamicSizingErr, guardrail: 'dynamic_sizing', success: false });
    return { success: false, error: dynamicSizingErr, message: dynamicSizingErr };
  }

  // Se non viene fornito il token di conferma (Stadio 1)
  if (!confirmation_token) {
    const prompt = requestTwoStageConfirmation({
      action: 'update_strategy_params',
      botId: bot_id,
      payload: { params },
      summary: `Aggiornamento parametri per bot '${botRow.name}' (${bot_id}): ${JSON.stringify(params)}`
    });
    logMcpAudit('update_strategy_params', { bot_id, params, status: 'confirmation_required', success: false });
    return {
      success: false,
      ...prompt
    };
  }

  // Se viene fornito confirmation_token, valida e consuma (Stadio 2)
  const validation = validateAndConsumeConfirmation({
    confirmation_token,
    action: 'update_strategy_params',
    botId: bot_id
  });
  if (!validation.ok) {
    logMcpAudit('update_strategy_params', { bot_id, confirmation_token, error: validation.error, success: false });
    return { success: false, error: validation.error, message: validation.error };
  }

  // BACKTEST GATE, ma SOLO se la patch tocca le regole d'ingresso: sono l'unica
  // cosa che cambia l'EDGE della strategia. Alzare la leva o stringere il tetto
  // di posizione cambia QUANTO si rischia — lo giudicano i cancelli sopra — e
  // rifare il backtest lì sarebbe una chiamata di rete per una misura che non
  // può essere cambiata dalla patch.
  //
  // Si misura la config CANDIDATA (quella attuale fusa con la patch, con lo
  // stesso `mergeStrategyConfig` che verrà applicato subito dopo), non le sole
  // `entryRules`: un backtest su regole nuove con tp/sl di default misurerebbe
  // una strategia che nessuno metterà mai in produzione.
  let backtestSummary = null;
  if (params.entryRules !== undefined) {
    const candidateConfig = mergeStrategyConfig(extractBotConfig(botRow), params);
    const gate = await runBacktestGate(candidateConfig, botRow.coin);
    if (gate.blocked) {
      const err = `GUARDRAIL_VIOLATION: Backtest Gate — ${gate.reason}`;
      logMcpAudit('update_strategy_params', {
        bot_id, params, error: err, guardrail: 'backtest', backtest: gate.summary, success: false
      });
      // Nessuna scrittura è ancora avvenuta: la config in DB resta quella con
      // cui il bot sta operando, intatta. Il rifiuto è fail-fast, non un
      // rollback di una patch già applicata a metà.
      return { success: false, error: err, message: err };
    }
    backtestSummary = gate.summary;
  }

  try {
    // Merge profondo di UN livello + ricarica runtime + emit UI: la sequenza sta
    // in `botManager.applyConfigPatch`, condivisa con le proposte `tune_params`
    // approvate a mano. Aggiornare un campo dentro `risk` (o
    // `sizing`/`tp`/`sl`/`trailing`/`dca`) non deve cancellare gli altri campi
    // dello stesso blocco: vedi `mergeStrategyConfig`.
    //
    // Il riassunto del backtest entra nella patch (quando c'è) perché deve
    // restare allegato alla strategia che descrive: se lo scrivessimo solo
    // nell'audit, la config in DB direbbe "regole nuove" senza dire su cosa
    // sono state verificate.
    const patch = backtestSummary ? { ...params, backtestSummary } : params;
    const { state: updatedState } = await botManager.applyConfigPatch(bot_id, patch, {
      reason: 'update_strategy_params'
    });

    // …e il processo Express, che nel percorso MCP Stdio è un ALTRO processo:
    // lì `botManager.io` è null e la config mostrata resterebbe quella vecchia.
    notifyExpressReload().catch(() => {});

    // CRIT #7 — `applyConfigPatch` ricarica l'istanza DI QUESTO processo. Da
    // quando i bot girano solo in Express, la patch fatta dal processo MCP
    // lascerebbe il loop vero con i parametri vecchi: `reload_config` glielo fa
    // ricostruire dalla riga di DB appena scritta, conservando lo stato di
    // esecuzione. `/internal/mcp/reload` non basta: aggiunge, rimuove e
    // riconcilia lo status, ma non ricostruisce un bot già presente.
    let runtimeWarning = null;
    if (!ownsTickLoop()) {
      try {
        await applyBotLifecycle(bot_id, 'reload_config');
      } catch (err) {
        runtimeWarning = `Parametri SALVATI sul DB ma NON applicati al bot in esecuzione: ${err.message}. Il bot continua con la configurazione precedente finché non viene ricaricato.`;
        logger.warn(`update_strategy_params: ${runtimeWarning}`);
      }
    }

    logMcpAudit('update_strategy_params', {
      bot_id,
      updated_keys: Object.keys(params),
      ...(backtestSummary ? { backtest: backtestSummary } : {}),
      runtime_reload_error: runtimeWarning,
      success: !runtimeWarning
    });

    if (runtimeWarning) {
      return { success: false, message: runtimeWarning, data: { bot_id, updated_params: params, current_config: updatedState.config } };
    }

    return {
      success: true,
      message: `Parametri di strategia aggiornati e cache in memoria ricaricata per il bot '${botRow.name}'.`,
      data: {
        bot_id,
        updated_params: params,
        current_config: updatedState.config
      }
    };
  } catch (error) {
    const msg = `Errore aggiornamento parametri strategia: ${error.message}`;
    logMcpAudit('update_strategy_params', { bot_id, params, error: msg, success: false });
    return { success: false, message: msg };
  }
}

/**
 * 6. REGISTER BOT (CREATE BOT)
 * Permette ad agenti autonomi (Hermes) di registrare e inizializzare nuovi bot di trading
 * validando i guardrail pre-flight (leva <= 5x, blacklist) e sincronizzando SQLite e runtime.
 */
export async function handleRegisterBot({
  name,
  coin,
  network = 'testnet',
  master_address = 'paper_hermes',
  config = {},
  max_allocation_usd = null,
  actor_label = 'Hermes',
  actor_id = 'hermes_agent_01',
  is_managed_by_agent = true,
  auto_start = false
}) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { success: false, message: 'Parametro name obbligatorio.' };
  }
  if (!coin || typeof coin !== 'string' || !coin.trim()) {
    return { success: false, message: 'Parametro coin obbligatorio.' };
  }

  // Normalizza coin (es. SOL -> SOL-PERP)
  let normalizedCoin = coin.trim().toUpperCase();
  if (!normalizedCoin.endsWith('-PERP')) {
    normalizedCoin = `${normalizedCoin}-PERP`;
  }

  const parsedConfig = typeof config === 'string' ? JSON.parse(config || '{}') : (config || {});

  // Pre-flight Guardrail 1: Instruction Override & Blacklist
  const overrideCheck = validateInstructionOverride({ coin: normalizedCoin, botConfig: parsedConfig });
  if (!overrideCheck.ok) {
    logMcpAudit('register_bot', { name, coin: normalizedCoin, error: overrideCheck.error, guardrail: 'instruction_override', success: false });
    return { success: false, error: overrideCheck.error, message: overrideCheck.error };
  }

  // Pre-flight Guardrail 2: Risk Ceiling - Max Leverage check
  if (parsedConfig.leverage != null) {
    const lev = parseInt(parsedConfig.leverage, 10);
    if (isNaN(lev) || lev < 1 || lev > GUARDRAILS_CONFIG.MAX_ACCOUNT_LEVERAGE) {
      const err = `GUARDRAIL_VIOLATION: Max Account Leverage exceeded. Richiesta leva ${parsedConfig.leverage}x, massimo consentito ${GUARDRAILS_CONFIG.MAX_ACCOUNT_LEVERAGE}x.`;
      logMcpAudit('register_bot', { name, coin: normalizedCoin, error: err, guardrail: 'risk_ceiling', success: false });
      return { success: false, error: err, message: err };
    }
  }

  if (parsedConfig.maxPositionUsd != null || parsedConfig.max_position_usd != null) {
    const maxPos = parseFloat(parsedConfig.maxPositionUsd || parsedConfig.max_position_usd);
    if (isNaN(maxPos) || maxPos <= 0) {
      const err = 'GUARDRAIL_VIOLATION: maxPositionUsd deve essere un numero positivo.';
      return { success: false, error: err, message: err };
    }
  }

  // Pre-flight Guardrail 3: parametri del sizing dinamico ATR
  const dynamicSizingErr = validateDynamicSizingParams(parsedConfig);
  if (dynamicSizingErr) {
    logMcpAudit('register_bot', { name, coin: normalizedCoin, error: dynamicSizingErr, guardrail: 'dynamic_sizing', success: false });
    return { success: false, error: dynamicSizingErr, message: dynamicSizingErr };
  }

  // Pre-flight Guardrail 4: BACKTEST GATE.
  //
  // Gli altri tre cancelli guardano QUANTO si rischia (leva, blacklist,
  // sizing); nessuno guardava SE la strategia abbia mai avuto un edge. Una
  // `entryRules` qualunque scritta da un agente arrivava in DB e da lì in
  // produzione, e la prima verifica del suo valore avveniva con i soldi.
  //
  // Si blocca solo la perdita netta conclamata su un campione non trascurabile
  // (vedi `evaluateBacktestGate`); l'incertezza NON blocca, viene scritta. Il
  // cancello è in coda agli altri di proposito: è l'unico che costa una
  // chiamata di rete, e non ha senso pagarla per una config che verrebbe
  // rifiutata comunque per la leva.
  const backtestGate = await runBacktestGate(parsedConfig, normalizedCoin);
  if (backtestGate.blocked) {
    const err = `GUARDRAIL_VIOLATION: Backtest Gate — ${backtestGate.reason}`;
    logMcpAudit('register_bot', {
      name, coin: normalizedCoin, error: err, guardrail: 'backtest', backtest: backtestGate.summary, success: false
    });
    return { success: false, error: err, message: err };
  }

  // Il riassunto viaggia DENTRO la config del bot, non solo nel log: la UI (e
  // il prossimo che si chiede perché questo bot esiste) deve poterlo leggere
  // senza rifare il backtest. Copia, non mutazione dell'oggetto del chiamante.
  const configWithBacktest = { ...parsedConfig, backtestSummary: backtestGate.summary };

  db.ensure();
  try {
    const botState = botManager.createBot({
      name: name.trim(),
      coin: normalizedCoin,
      network: network || 'testnet',
      masterAddress: (master_address && master_address.startsWith('0x')) ? master_address : '0x55dde41417dd529e51b173916b7fafef86573e72',
      config: configWithBacktest,
      linked_agent_id: actor_id || 'hermes_agent_01',
      max_allocation_usd: max_allocation_usd != null ? Number(max_allocation_usd) : (parsedConfig.maxPositionUsd ? Number(parsedConfig.maxPositionUsd) : null),
      actor_label: actor_label || 'Hermes',
      actor_id: actor_id || 'hermes_agent_01',
      is_managed_by_agent: is_managed_by_agent !== false
    });

    let finalState = botState;
    let startWarning = null;
    if (auto_start === true) {
      // CRIT #7 — l'avvio lo fa il proprietario del tick loop. Nel processo MCP
      // il bot esiste già sul DB a questo punto, quindi Express lo trova e lo
      // avvia; se non risponde, il bot resta CREATO E FERMO e lo si dice — meglio
      // di un bot dichiarato attivo che non sta girando da nessuna parte.
      try {
        const { state } = await applyBotLifecycle(botState.id, 'start');
        finalState = { ...state, warning: botState.warning };
      } catch (err) {
        startWarning = `Bot creato ma NON avviato: ${err.message}`;
        logger.warn(`register_bot: ${startWarning}`);
      }
    }

    if (botManager.io) {
      botManager.io.emit('perps:botCreate', finalState);
      botManager.io.emit('perps:dashboardRefresh', { reason: 'register_bot', botId: finalState.id });
    }

    const resPayload = {
      bot_id: finalState.id,
      name: finalState.name,
      coin: finalState.coin,
      status: finalState.status,
      actor_label: finalState.actor_label || actor_label || 'Hermes',
      is_managed_by_agent: finalState.is_managed_by_agent,
      config: finalState.config,
      warning: [finalState.warning, startWarning].filter(Boolean).join(' ') || null
    };

    logMcpAudit('register_bot', { ...resPayload, backtest: backtestGate.summary, success: true });

    // Notifica il processo Express di sincronizzare botManager dal DB
    notifyExpressReload().catch(() => {});

    return {
      success: true,
      message: `Bot '${finalState.name}' (${finalState.coin}) registrato con successo (id: ${finalState.id}, status: ${finalState.status}).`
        + (startWarning ? ` ATTENZIONE: ${startWarning}` : ''),
      data: resPayload
    };
  } catch (err) {
    const msg = `Errore registrazione bot: ${err.message}`;
    logMcpAudit('register_bot', { name, coin: normalizedCoin, error: msg, success: false });
    return { success: false, message: msg };
  }
}

/**
 * 7. DELETE BOT
 * Rimuove un bot dal DB e dal runtime con conferma a due stadi.
 */
export async function handleDeleteBot({ bot_id, confirmation_token = null }) {
  if (!bot_id) {
    return { success: false, message: 'Parametro bot_id obbligatorio.' };
  }

  db.ensure();
  const botRow = db.getBot(bot_id);
  if (!botRow) {
    const msg = `Bot non trovato (id: ${bot_id})`;
    logMcpAudit('delete_bot', { bot_id, error: msg, success: false });
    return { success: false, message: msg };
  }

  // Two-stage confirmation requirement
  if (!confirmation_token) {
    const prompt = requestTwoStageConfirmation({
      action: 'delete_bot',
      botId: bot_id,
      payload: { bot_id },
      summary: `Eliminazione definitiva del bot '${botRow.name}' (${bot_id}) dal DB e dal runtime.`
    });
    logMcpAudit('delete_bot', { bot_id, status: 'confirmation_required', success: false });
    return {
      success: false,
      ...prompt
    };
  }

  const validation = validateAndConsumeConfirmation({
    confirmation_token,
    action: 'delete_bot',
    botId: bot_id
  });
  if (!validation.ok) {
    logMcpAudit('delete_bot', { bot_id, confirmation_token, error: validation.error, success: false });
    return { success: false, error: validation.error, message: validation.error };
  }

  try {
    botManager.deleteBot(bot_id);

    if (botManager.io) {
      botManager.io.emit('perps:botDelete', { id: bot_id });
      botManager.io.emit('perps:dashboardRefresh', { reason: 'delete_bot', botId: bot_id });
    }

    logMcpAudit('delete_bot', { bot_id, name: botRow.name, success: true });

    // Notifica il processo Express di sincronizzare botManager dal DB
    notifyExpressReload().catch(() => {});

    return {
      success: true,
      message: `Bot '${botRow.name}' (${bot_id}) eliminato con successo.`,
      data: { bot_id, name: botRow.name }
    };
  } catch (err) {
    const msg = `Errore eliminazione bot: ${err.message}`;
    logMcpAudit('delete_bot', { bot_id, error: msg, success: false });
    return { success: false, message: msg };
  }
}
