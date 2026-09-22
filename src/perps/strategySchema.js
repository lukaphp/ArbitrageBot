/**
 * SCHEMA DI SCAMBIO DELLE STRATEGIE (export/import) — STRAT-01
 * ============================================================
 *
 * Formato del file e VALIDAZIONE, come funzioni pure: nessuna I/O, nessun
 * accesso al DB, nessuna dipendenza da express. Sta qui e non dentro
 * `server.js` per la stessa ragione per cui i calcoli di rischio stanno in
 * `riskManager.js`: la parte che decide se un file è accettabile deve essere
 * testabile in isolamento, e deve essere UNA — usata sia dall'import dello
 * storico strategie sia dall'import di un bot, senza due copie che divergono.
 *
 * Il vincolo di prodotto è "un file malformato non deve creare un bot con
 * configurazione parzialmente vuota". Da qui due scelte:
 *
 *  1. **Tutto o nulla per voce, e nessuna scrittura se la busta è sbagliata.**
 *     Una voce che non passa non viene "aggiustata" con valori di default: un
 *     bot creato da una config a metà è un bot che opera con soldi veri secondo
 *     regole che nessuno ha scritto.
 *  2. **Niente clamp silenzioso.** Una leva oltre il massimo consentito viene
 *     RIFIUTATA con la motivazione, non ridotta di nascosto: la strategia
 *     importata non sarebbe più quella che l'utente credeva di importare.
 *
 * La busta è autodescrittiva (`kind` + `version`) così un file che non c'entra
 * nulla si riconosce subito, invece di scoprirlo campo per campo a metà
 * dell'importazione. Lo stesso formato è prodotto da due sorgenti: una voce
 * dello storico strategie e un bot esistente (`bots.config_json`).
 */

import { HYPERLIQUID_CONFIG } from '../config/config.js';

export const EXPORT_KIND = 'arbitragebot.strategies';
export const EXPORT_VERSION = 1;

/** Intervalli candela accettati (allineati a INTERVAL_MS di marketData.js). */
export const VALID_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'
]);

/** Tipi di regola riconosciuti da strategyEngine.evaluate(). */
export const VALID_RULE_TYPES = new Set(['price', 'funding', 'external', 'indicator']);
export const VALID_INDICATORS = new Set(['rsi', 'ema', 'sma', 'adx', 'macd', 'bollinger']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Busta di export. `items` sono già normalizzati dal chiamante (vedi
 * historyExportItem/botExportItem).
 */
export function buildEnvelope(items, { network = null, source = null } = {}) {
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    network,
    ...(source ? { source } : {}),
    items
  };
}

/**
 * Voce di export a partire da una riga dello storico strategie
 * (`proposals.history()`). `payload.config` è ciò che rende il file
 * riutilizzabile: senza, è solo un promemoria.
 */
export function historyExportItem(h) {
  return {
    coin: h.coin,
    status: h.status,
    rationale: h.rationale,
    confidence: h.confidence,
    createdAt: h.createdAt,
    decidedAt: h.decidedAt,
    model: h.model,
    costUsd: h.costUsd,
    payload: h.payload
  };
}

/**
 * Voce di export a partire da una riga `bots`. Volutamente NON esporta
 * `master_address` né lo stato/PnL: un file di strategia descrive *come* si
 * opera, non su quale conto — reimportarlo su un altro account non deve
 * portarsi dietro l'indirizzo di chi l'ha esportato.
 */
export function botExportItem(row) {
  const config = typeof row.config_json === 'string'
    ? JSON.parse(row.config_json)
    : (row.config || {});
  return {
    coin: row.coin,
    name: row.name,
    createdAt: row.created_at,
    payload: {
      coin: row.coin,
      interval: config.candleInterval || null,
      config
    }
  };
}

/** Nome file suggerito, senza caratteri che diano problemi in un header HTTP. */
export function exportFileName(label, count = 1) {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = String(label || 'strategie').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return count === 1
    ? `strategia-${safe || 'export'}-${stamp}.json`
    : `strategie-${count}-${stamp}.json`;
}

/**
 * Valida la CONFIGURAZIONE di strategia (il blob che finisce in
 * `bots.config_json`). Ritorna la lista dei problemi: vuota = accettabile.
 *
 * Non pretende di conoscere ogni campo opzionale — una config valida può avere
 * chiavi che questa funzione non guarda. Controlla ciò che, se sbagliato,
 * produce un bot rotto o pericoloso: nessuna regola d'ingresso (non aprirebbe
 * mai), regole di tipo sconosciuto (ignorate a runtime, quindi una strategia
 * diversa da quella dichiarata), leva/sizing fuori dai limiti del server.
 */
export function validateStrategyConfig(config, { prefix = '' } = {}) {
  const errors = [];
  const at = (msg) => errors.push(`${prefix}${msg}`);

  if (!isPlainObject(config)) {
    at('la configurazione della strategia non è un oggetto.');
    return errors;
  }

  if (!Array.isArray(config.entryRules) || !config.entryRules.length) {
    at('nessuna regola d\'ingresso (config.entryRules vuoto): un bot così non aprirebbe mai una posizione.');
  } else {
    config.entryRules.forEach((r, i) => validateRule(r, `regola d'ingresso ${i + 1}`, at));
  }
  if (config.exitRules !== undefined) {
    if (!Array.isArray(config.exitRules)) at('config.exitRules deve essere una lista.');
    else config.exitRules.forEach((r, i) => validateRule(r, `regola d'uscita ${i + 1}`, at));
  }

  if (config.candleInterval !== undefined && !VALID_INTERVALS.has(config.candleInterval)) {
    at(`intervallo candele non riconosciuto: ${config.candleInterval}.`);
  }

  // Leva: rifiutata, non ridotta. Un clamp silenzioso importerebbe una
  // strategia diversa da quella nel file.
  const maxLev = HYPERLIQUID_CONFIG.risk?.maxLeverage;
  if (config.leverage !== undefined) {
    if (!Number.isFinite(config.leverage) || config.leverage <= 0) {
      at(`leva non valida: ${config.leverage}.`);
    } else if (Number.isFinite(maxLev) && config.leverage > maxLev) {
      at(`leva ${config.leverage}x oltre il massimo consentito dal server (${maxLev}x): correggi il file, non viene ridotta automaticamente.`);
    }
  }

  if (config.sizing !== undefined) {
    const s = config.sizing;
    if (!isPlainObject(s)) at('config.sizing deve essere un oggetto { mode, value }.');
    else {
      if (s.mode !== undefined && !['percent', 'fixed'].includes(s.mode)) at(`sizing.mode non riconosciuto: ${s.mode}.`);
      if (!Number.isFinite(s.value) || s.value <= 0) at(`sizing.value non valido: ${s.value}.`);
      if (s.mode === 'percent' && Number.isFinite(s.value) && s.value > 100) at(`sizing.value ${s.value}% oltre il 100% dell'equity.`);
    }
  }

  for (const key of ['tp', 'sl', 'trailing']) {
    const blk = config[key];
    if (blk === undefined) continue;
    if (!isPlainObject(blk)) { at(`config.${key} deve essere un oggetto.`); continue; }
    if (blk.enabled && !Number.isFinite(blk.value)) at(`config.${key}.value non valido: ${blk.value}.`);
    if (blk.mode !== undefined && !['percent', 'absolute', 'atr'].includes(blk.mode)) at(`config.${key}.mode non riconosciuto: ${blk.mode}.`);
  }

  errors.push(...validatePartialTp(config.partialTp, prefix));

  // Parametri del SIZING DINAMICO ATR (config.risk). Volutamente NON si
  // toccano `maxPositionUsd`/`maxLeverage`/`maxDailyLossUsd`, che vivono nello
  // stesso oggetto ma non sono mai stati validati qui: iniziare a rifiutarli
  // ora farebbe fallire import di file che oggi passano, e non è questa la
  // storia. Stessa regola del resto del file: si rifiuta, non si aggiusta —
  // un riskPerTradePct di 500 importato in silenzio dimensionerebbe una
  // posizione cinque volte l'equity.
  if (config.risk !== undefined) {
    const r = config.risk;
    if (!isPlainObject(r)) at('config.risk deve essere un oggetto.');
    else {
      if (r.useDynamicSizing !== undefined && typeof r.useDynamicSizing !== 'boolean') {
        at(`risk.useDynamicSizing deve essere true o false: ${JSON.stringify(r.useDynamicSizing)}.`);
      }
      if (r.riskPerTradePct !== undefined && (!Number.isFinite(r.riskPerTradePct) || r.riskPerTradePct <= 0 || r.riskPerTradePct > 100)) {
        at(`risk.riskPerTradePct non valido: ${r.riskPerTradePct} (atteso un numero > 0 e <= 100, è una percentuale dell'equity a rischio per trade).`);
      }
      if (r.atrMultiplier !== undefined && (!Number.isFinite(r.atrMultiplier) || r.atrMultiplier <= 0)) {
        at(`risk.atrMultiplier non valido: ${r.atrMultiplier} (atteso un numero > 0).`);
      }
      if (r.atrPeriod !== undefined && (!Number.isInteger(r.atrPeriod) || r.atrPeriod < 2)) {
        at(`risk.atrPeriod non valido: ${r.atrPeriod} (atteso un intero >= 2).`);
      }
    }
  }

  if (config.dca !== undefined) {
    const d = config.dca;
    if (!isPlainObject(d)) at('config.dca deve essere un oggetto.');
    else {
      if (d.steps !== undefined && (!Number.isInteger(d.steps) || d.steps < 0)) at(`dca.steps non valido: ${d.steps}.`);
      if (d.stepPercent !== undefined && (!Number.isFinite(d.stepPercent) || d.stepPercent <= 0)) at(`dca.stepPercent non valido: ${d.stepPercent}.`);
    }
  }

  return errors;
}

/**
 * Legge la config di strategia da una riga `bots`, qualunque forma abbia
 * (`config_json` stringa, `config` già oggetto, niente del tutto).
 *
 * Viveva in `src/mcp/tools.js`. È stata spostata qui, insieme a
 * `mergeStrategyConfig`, perché ha un secondo consumatore fuori dal layer MCP
 * (`agents/executionAgent`, per le proposte `tune_params`) e importare
 * `mcp/tools.js` da lì avrebbe tirato dentro guardrail, botManager e l'intera
 * superficie degli strumenti — oltre a creare un ciclo con `botManager`, che a
 * sua volta ha bisogno della fusione. Qui non c'è I/O e non c'è nessun import
 * oltre alla config: è il posto dove stanno già le funzioni pure che parlano di
 * configurazione di strategia. `mcp/tools.js` continua a ri-esportarle, così i
 * chiamanti (e i test) esistenti non cambiano.
 */
export function extractBotConfig(botRow) {
  if (!botRow) return {};
  const raw = botRow.config_json || botRow.config || {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Fonde i parametri di un aggiornamento nella config esistente, scendendo di UN
 * livello sui blocchi annidati.
 *
 * Perché non basta lo spread. La config di strategia è fatta di blocchi
 * (`risk`, `sizing`, `tp`, `sl`, `trailing`, `dca`) e uno spread shallow li
 * sostituisce interi: `params.risk = { useDynamicSizing: true }` cancellava
 * `maxPositionUsd`/`maxLeverage`/`maxDailyLossUsd` di quel bot, cioè il tetto
 * di rischio PER BOT, senza dirlo a nessuno. Restava in piedi il solo cap
 * globale di HYPERLIQUID_CONFIG, quindi non una posizione senza limiti — ma un
 * limite che l'operatore credeva di avere e non aveva più. Chi aggiorna un
 * singolo campo non sta chiedendo di azzerare gli altri.
 *
 * Un livello e non ricorsivo, di proposito: la profondità serve ai blocchi di
 * primo livello, e una fusione ricorsiva renderebbe impossibile sostituire un
 * sotto-oggetto per intero senza prima svuotarlo campo per campo.
 *
 * Restano SOSTITUZIONI integrali, perché sono richieste esplicite e non
 * aggiornamenti parziali:
 *  - un valore non-oggetto (`risk: null`) — è il modo legittimo di azzerare un
 *    blocco, e interpretarlo come merge toglierebbe il solo modo di cancellarlo;
 *  - gli array (`entryRules`, `partialTp`) — una lista fusa elemento per
 *    elemento sarebbe una strategia che nessuno ha scritto;
 *  - il caso in cui la config attuale NON ha un oggetto su quella chiave.
 *
 * Funzione pura: si verifica in isolamento, senza passare dalle due conferme MCP.
 */
export function mergeStrategyConfig(currentConfig, params) {
  const base = isPlainObject(currentConfig) ? currentConfig : {};
  if (!isPlainObject(params)) return { ...base };

  const merged = { ...base };
  for (const [key, value] of Object.entries(params)) {
    merged[key] = (isPlainObject(base[key]) && isPlainObject(value))
      ? { ...base[key], ...value }
      : value;
  }
  return merged;
}

/**
 * Valida la SCALA di take profit parziali (`config.partialTp`).
 *
 * Perché serve, e perché non bastava il giro che già c'era sopra: il loop su
 * `['tp', 'sl', 'trailing']` non include `partialTp`, che ha una forma diversa
 * (una LISTA di gradini, non un blocco `{enabled, mode, value}`). Il risultato
 * era che questa chiave non veniva guardata da nessuno: un payload malformato
 * attraversava l'import e `update_strategy_params` senza una parola e arrivava
 * fino a `bot._placeTpSl`.
 *
 * Cosa succederebbe là in fondo, gradino per gradino — è questo che motiva le
 * tre regole qui sotto, non un gusto per la severità:
 *  - `riskManager.computeTpLadder` FILTRA i gradini con `portion > 0 &&
 *    atPercent > 0`. Un gradino scritto male (portion negativa, `atPercent`
 *    stringa, voce `null`) non produce nessun errore: sparisce. Il bot opera
 *    con una scala di uscita diversa da quella configurata, e il solo modo di
 *    accorgersene è contare i trigger sull'exchange.
 *  - `portion` è una FRAZIONE della size (0-1), non una percentuale. Un `50`
 *    scritto al posto di `0.5` passa il filtro e chiede di chiudere cinquanta
 *    volte la posizione.
 *  - la somma delle `portion` oltre 1 chiede di chiudere più size di quanta ne
 *    esista: sull'exchange diventa un ordine di chiusura rifiutato o, peggio,
 *    l'apertura di una posizione opposta.
 *
 * Coerente col resto del file: si RIFIUTA, non si aggiusta. Nessun clamp della
 * somma a 1, nessuno scarto silenzioso del gradino storto — sarebbe di nuovo
 * una strategia che nessuno ha scritto.
 *
 * Tolleranza sulla somma: `1 + 1e-9`, perché `0.3 + 0.3 + 0.4` in virgola
 * mobile fa 1.0000000000000002 e rifiutare una scala legittima per l'ultimo bit
 * della mantissa sarebbe un falso positivo, non un controllo.
 */
function validatePartialTp(ladder, prefix = '') {
  const errors = [];
  const at = (msg) => errors.push(`${prefix}${msg}`);
  if (ladder === undefined || ladder === null) return errors;

  if (!Array.isArray(ladder)) {
    at('config.partialTp deve essere una lista di gradini { portion, atPercent }.');
    return errors;
  }

  let sum = 0;
  ladder.forEach((step, i) => {
    const where = `partialTp, gradino ${i + 1}`;
    if (!isPlainObject(step)) {
      at(`${where}: non è un oggetto { portion, atPercent }.`);
      return;
    }
    if (!Number.isFinite(step.portion) || step.portion <= 0 || step.portion > 1) {
      at(`${where}: portion non valida: ${JSON.stringify(step.portion)} (attesa una frazione della posizione > 0 e <= 1 — 0.5 è metà, non 50).`);
    } else {
      sum += step.portion;
    }
    if (!Number.isFinite(step.atPercent) || step.atPercent <= 0) {
      at(`${where}: atPercent non valido: ${JSON.stringify(step.atPercent)} (atteso un numero > 0, la distanza percentuale dall'ingresso).`);
    }
  });

  if (sum > 1 + 1e-9) {
    at(`config.partialTp: la somma delle portion è ${sum.toFixed(4)}, oltre 1 — chiuderebbe più size di quanta ne esista in posizione.`);
  }

  return errors;
}

/**
 * SINONIMI DI SEGNALE ACCETTATI — OPS-FLEET-02
 *
 * `evaluate()` RESTITUISCE `open_long`/`open_short` come azione, ma si ASPETTA
 * `long`/`short` nel campo `signal` di una regola. Sono due vocabolari diversi a
 * un carattere di distanza, e chi scrive la config (in produzione: un agente)
 * ha usato quello sbagliato per tutta la flotta. La mappatura è univoca: non c'è
 * nessuna lettura alternativa di `signal: 'open_long'` su una regola d'ingresso.
 */
const SIGNAL_ALIASES = { open_long: 'long', open_short: 'short' };

/**
 * NORMALIZZAZIONE DELLA FORMA DI UNA REGOLA — OPS-FLEET-02
 * =======================================================
 *
 * Perché esiste. La flotta OPS-FLEET-02 è rimasta ~46 ore senza produrre un solo
 * segnale mentre l'RSI reale attraversava le soglie decine di volte per coin. La
 * causa non era il mercato né le soglie: le regole persistite in
 * `bots.config_json` deviavano dal formato canonico su due campi, e in entrambi
 * i casi `strategyEngine` le scartava restituendo `match:false` — cioè un bot che
 * non può aprire, che si comporta esattamente come un bot in attesa.
 *
 * Cosa si corregge, e soltanto questo:
 *  - `type` assente ma `indicator` presente → `type: 'indicator'`. Deduzione
 *    univoca: nessun altro tipo di regola ha un campo `indicator`.
 *  - `signal: 'open_long'|'open_short'` → `'long'|'short'` (vedi SIGNAL_ALIASES).
 *
 * Cosa NON si corregge, di proposito: una regola senza `type` e senza
 * `indicator` (per esempio solo `op`+`value`) potrebbe essere `price` o
 * `funding`. Indovinare significherebbe far operare il bot con una regola che
 * nessuno ha scritto — la stessa ragione per cui `validateStrategyConfig`
 * rifiuta invece di aggiustare. Quelle regole finiscono in `unevaluable`.
 *
 * Non è un "aggiustaggio silenzioso": ogni correzione è elencata in `changes` e
 * ogni regola inservibile in `unevaluable`, e il chiamante è tenuto a dirlo
 * (vedi `strategyEngine.evaluate` e `PerpsBot.start`). Il silenzio è il difetto
 * che stiamo riparando, non solo la forma sbagliata.
 *
 * Funzione PURA: non muta la config ricevuta, ritorna copie.
 *
 * @returns {{ config: object, changes: string[], unevaluable: string[] }}
 */
export function normalizeStrategyConfig(config) {
  const changes = [];
  const unevaluable = [];
  if (!isPlainObject(config)) return { config, changes, unevaluable };

  let touched = false;
  const out = { ...config };

  for (const scope of ['entryRules', 'exitRules']) {
    const rules = config[scope];
    if (!Array.isArray(rules)) continue;
    let scopeTouched = false;
    const label = scope === 'entryRules' ? 'ingresso' : 'uscita';

    const normalized = rules.map((rule, i) => {
      const where = `regola d'${label} ${i + 1}`;
      if (!isPlainObject(rule)) {
        unevaluable.push(`${where}: non è un oggetto, sarà ignorata.`);
        return rule;
      }
      let r = rule;
      const copy = () => { if (r === rule) r = { ...rule }; return r; };

      if (!VALID_RULE_TYPES.has(r.type) && VALID_INDICATORS.has(r.indicator)) {
        copy().type = 'indicator';
        changes.push(`${where}: campo "type" assente, dedotto "indicator" da indicator="${rule.indicator}".`);
      }
      if (SIGNAL_ALIASES[r.signal] && r.type !== 'external') {
        const canon = SIGNAL_ALIASES[r.signal];
        copy().signal = canon;
        changes.push(`${where}: signal "${rule.signal}" interpretato come "${canon}".`);
      }
      if (!VALID_RULE_TYPES.has(r.type)) {
        unevaluable.push(`${where}: tipo "${r.type}" non riconosciuto (ammessi: ${[...VALID_RULE_TYPES].join(', ')}), non potrà MAI essere soddisfatta.`);
      } else if (r.type === 'indicator' && !VALID_INDICATORS.has(r.indicator)) {
        unevaluable.push(`${where}: indicatore "${r.indicator}" non riconosciuto (ammessi: ${[...VALID_INDICATORS].join(', ')}), non potrà MAI essere soddisfatta.`);
      }
      if (r !== rule) scopeTouched = true;
      return r;
    });

    if (scopeTouched) { out[scope] = normalized; touched = true; }
  }

  return { config: touched ? out : config, changes, unevaluable };
}

function validateRule(rule, where, at) {
  if (!isPlainObject(rule)) return at(`${where}: non è un oggetto.`);
  if (!VALID_RULE_TYPES.has(rule.type)) {
    // Una regola di tipo sconosciuto non fa fallire il bot: strategyEngine la
    // ignora. È peggio — la strategia importata sarebbe più permissiva di quella
    // descritta nel file, senza che nessuno lo veda.
    return at(`${where}: tipo "${rule.type}" non riconosciuto (ammessi: ${[...VALID_RULE_TYPES].join(', ')}).`);
  }
  if (rule.type === 'indicator' && !VALID_INDICATORS.has(rule.indicator)) {
    at(`${where}: indicatore "${rule.indicator}" non riconosciuto (ammessi: ${[...VALID_INDICATORS].join(', ')}).`);
  }
  if (rule.type === 'external' && !isNonEmptyString(rule.signal)) {
    at(`${where}: segnale esterno senza nome (campo "signal").`);
  }
  if (rule.type === 'price' || rule.type === 'funding') {
    if (!Number.isFinite(rule.value)) at(`${where}: valore di confronto non numerico (${rule.value}).`);
  }
}

/**
 * Valida UNA voce del file. Ritorna { ok, errors, value }, dove `value` è la
 * voce normalizzata pronta per la scrittura (coin, interval, config, metadati).
 */
export function validateItem(item, index = 0) {
  const where = `voce ${index + 1}`;
  const errors = [];

  if (!isPlainObject(item)) return { ok: false, errors: [`${where}: non è un oggetto.`], value: null };
  if (!isNonEmptyString(item.coin)) errors.push(`${where}: campo "coin" mancante o vuoto.`);

  const payload = item.payload;
  if (!isPlainObject(payload)) {
    errors.push(`${where}${item.coin ? ` (${item.coin})` : ''}: manca "payload".`);
    return { ok: false, errors, value: null };
  }

  const config = payload.config;
  const label = `${where}${item.coin ? ` (${item.coin})` : ''}: `;
  if (!isPlainObject(config)) {
    errors.push(`${label}manca payload.config, la configurazione della strategia.`);
    return { ok: false, errors, value: null };
  }

  const interval = payload.interval || config.candleInterval || null;
  if (!interval) errors.push(`${label}intervallo delle candele non indicato.`);
  else if (!VALID_INTERVALS.has(interval)) errors.push(`${label}intervallo non riconosciuto: ${interval}.`);

  errors.push(...validateStrategyConfig(config, { prefix: label }));

  if (errors.length) return { ok: false, errors, value: null };

  return {
    ok: true,
    errors: [],
    value: {
      coin: item.coin.trim(),
      name: isNonEmptyString(item.name) ? item.name.trim() : null,
      interval,
      // La config viene copiata così com'è, con `candleInterval` allineato
      // all'intervallo effettivo: è l'unico campo che i due posti (payload e
      // config) potrebbero dichiarare in modo diverso.
      config: { ...config, candleInterval: interval },
      rationale: typeof item.rationale === 'string' ? item.rationale : null,
      confidence: Number.isFinite(item.confidence) ? item.confidence : null,
      status: isNonEmptyString(item.status) ? item.status : null,
      model: isNonEmptyString(item.model) ? item.model : null
    }
  };
}

/**
 * Valida la busta completa. Ritorna { ok, errors, items } con `items`
 * normalizzati. `ok:false` significa NIENTE scrittura: nessun import parziale,
 * perché un import "quasi riuscito" lascia l'utente a indovinare cosa è entrato.
 */
export function validateEnvelope(parsed, { maxItems = 100 } = {}) {
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ['Il file non contiene un oggetto JSON.'], items: [] };
  }
  if (parsed.kind !== EXPORT_KIND) {
    return { ok: false, errors: [`Non è un export di strategie di ArbitrageBot (kind: ${parsed.kind ?? 'assente'}).`], items: [] };
  }
  if (parsed.version !== EXPORT_VERSION) {
    return { ok: false, errors: [`Versione del formato non supportata: ${parsed.version ?? 'assente'} (attesa ${EXPORT_VERSION}).`], items: [] };
  }
  if (!Array.isArray(parsed.items) || !parsed.items.length) {
    return { ok: false, errors: ['Il file non contiene strategie (items vuoto o assente).'], items: [] };
  }
  if (parsed.items.length > maxItems) {
    return { ok: false, errors: [`Troppe voci nel file: ${parsed.items.length} (massimo ${maxItems}).`], items: [] };
  }

  const errors = [];
  const items = [];
  parsed.items.forEach((it, i) => {
    const r = validateItem(it, i);
    if (r.ok) items.push(r.value);
    else errors.push(...r.errors);
  });

  return { ok: errors.length === 0, errors, items };
}

/**
 * Accetta anche una lista nuda di voci (`{ items: [...] }` senza busta): è la
 * forma in cui la UI inoltra al server le voci che ha già validato lei, dopo
 * aver aperto la busta. La validazione per-voce resta identica — quella del
 * client è il primo controllo, questo è quello che decide, perché è qui che si
 * scrive.
 */
export function validateItemList(list, { maxItems = 100 } = {}) {
  if (!Array.isArray(list) || !list.length) {
    return { ok: false, errors: ['Nessuna strategia da importare (items vuoto o assente).'], items: [] };
  }
  if (list.length > maxItems) {
    return { ok: false, errors: [`Troppe voci: ${list.length} (massimo ${maxItems}).`], items: [] };
  }
  const errors = [];
  const items = [];
  list.forEach((it, i) => {
    const r = validateItem(it, i);
    if (r.ok) items.push(r.value);
    else errors.push(...r.errors);
  });
  return { ok: errors.length === 0, errors, items };
}

export default {
  EXPORT_KIND, EXPORT_VERSION, VALID_INTERVALS, VALID_RULE_TYPES, VALID_INDICATORS,
  buildEnvelope, historyExportItem, botExportItem, exportFileName,
  validateStrategyConfig, validateItem, validateEnvelope, validateItemList,
  extractBotConfig, mergeStrategyConfig, normalizeStrategyConfig
};
