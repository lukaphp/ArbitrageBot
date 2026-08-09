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
  validateStrategyConfig, validateItem, validateEnvelope, validateItemList
};
