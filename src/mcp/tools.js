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
import {
  validateInstructionOverride,
  checkOrderVelocity,
  recordOrderExecution,
  validateRiskCeiling,
  requestTwoStageConfirmation,
  validateAndConsumeConfirmation,
  GUARDRAILS_CONFIG
} from './guardrails.js';

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
    let botInstance = botManager.bots.get(bot_id);

    // Se il bot non è caricato in memoria in botManager, lo carichiamo dal DB
    if (!botInstance) {
      botManager.loadFromDb();
      botInstance = botManager.bots.get(bot_id);
    }

    // Safeguard watchdog/crash: resetta stato anomalo al restart o start
    if (botInstance && (action === 'restart' || action === 'start')) {
      botInstance._crashed = false;
      botManager.lastWatchdogAlert.delete(bot_id);
    }

    let state;
    if (action === 'start') {
      if (botInstance && botInstance.status === 'running') {
        state = botInstance.getState();
        logMcpAudit('bot_control', { bot_id, action, result: 'already_running', success: true });
        return {
          success: true,
          message: `Bot '${botRow.name}' (${bot_id}) è già in esecuzione.`,
          data: state
        };
      }
      state = botManager.startBot(bot_id);
    } else if (action === 'stop') {
      if (botInstance && botInstance.status === 'stopped') {
        state = botInstance.getState();
        logMcpAudit('bot_control', { bot_id, action, result: 'already_stopped', success: true });
        return {
          success: true,
          message: `Bot '${botRow.name}' (${bot_id}) è già fermo.`,
          data: state
        };
      }
      state = botManager.stopBot(bot_id);
    } else if (action === 'restart') {
      if (botInstance) {
        botInstance.stop();
        await botInstance.whenIdle();
      }
      state = botManager.startBot(bot_id);
    }

    logMcpAudit('bot_control', { bot_id, action, result: 'success', status: state?.status, success: true });

    return {
      success: true,
      message: `Bot '${botRow.name}' (${bot_id}) impostato su '${state?.status || action}' con successo.`,
      data: state
    };
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
  const botConfig = typeof botRow.config === 'string' ? JSON.parse(botRow.config || '{}') : (botRow.config || {});

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

    // Recupera lo stato paper e il daily PnL del bot/account
    const paperAccount = await paperBroker.getAccount(masterAddress, network);
    const today = new Date().toISOString().split('T')[0];
    const botInstance = botManager.bots.get(bot_id);
    const currentDailyPnl = (botInstance && typeof botInstance.dailyPnl === 'number')
      ? botInstance.dailyPnl
      : db.getDailyPnl(bot_id, today);

    // GUARDRAIL 3: RISK CEILING HARD-GATE
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
    const bots = botManager.listStates();
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

    // 2. Arresta tutti i bot in esecuzione
    let stoppedCount = 0;
    for (const bot of botManager.bots.values()) {
      if (bot.status === 'running') {
        try {
          bot.stop();
          db.updateBot(bot.id, { status: 'stopped' });
          stoppedCount++;
        } catch (err) {
          logger.warn(`Arresto bot ${bot.id} in emergency_shutdown fallito:`, err.message);
        }
      }
    }

    // 3. Emette evento Socket.IO
    if (botManager.io) {
      botManager.io.emit('perps:killSwitch', { on: true, actor: 'hermes_mcp_call', reason: 'emergency_shutdown' });
      botManager.io.emit('perps:dashboardRefresh', { reason: 'emergency_shutdown' });
    }

    const resPayload = {
      kill_switch: true,
      stopped_bots_count: stoppedCount,
      threshold: threshold != null ? Number(threshold) : null,
      timestamp: Date.now()
    };

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

  try {
    const currentConfig = typeof botRow.config === 'string' ? JSON.parse(botRow.config || '{}') : (botRow.config || {});

    const mergedConfig = {
      ...currentConfig,
      ...params
    };

    // Aggiornamento atomico nel DB e ricaricamento runtime tramite botManager.updateBot
    const updatedState = await botManager.updateBot(bot_id, {
      name: botRow.name,
      coin: botRow.coin,
      config: mergedConfig,
      linked_agent_id: botRow.linked_agent_id,
      max_allocation_usd: botRow.max_allocation_usd,
      actor_label: botRow.actor_label,
      actor_id: botRow.actor_id,
      is_managed_by_agent: botRow.is_managed_by_agent
    });

    // Invalida e notifica UI via WebSocket
    if (botManager.io) {
      botManager.io.emit('perps:botUpdate', updatedState);
      botManager.io.emit('perps:dashboardRefresh', { reason: 'update_strategy_params', botId: bot_id });
    }

    logMcpAudit('update_strategy_params', { bot_id, updated_keys: Object.keys(params), success: true });

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
