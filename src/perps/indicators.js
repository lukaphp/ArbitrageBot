/**
 * INDICATORI TECNICI
 * ==================
 *
 * Funzioni pure su array di candele Hyperliquid (formato { t, o, h, l, c, v }).
 * Wrappano la libreria `technicalindicators` e restituiscono l'ultimo valore
 * (o l'oggetto completo per MACD/Bollinger) utile allo strategy engine.
 */

import pkg from 'technicalindicators';
const { RSI, EMA, SMA, MACD, BollingerBands, ATR, ADX } = pkg;

/** Estrae i prezzi di chiusura da un array di candele. */
export function closes(candles) {
  return (candles || []).map(c => parseFloat(c.c)).filter(n => !isNaN(n));
}

function ohlc(candles) {
  const high = [], low = [], close = [];
  for (const c of candles || []) { high.push(+c.h); low.push(+c.l); close.push(+c.c); }
  return { high, low, close };
}

/** Average True Range: volatilità media (per stop adattivi). Ultimo valore. */
export function atr(candles, period = 14) {
  if ((candles || []).length < period + 1) return null;
  const { high, low, close } = ohlc(candles);
  const out = ATR.calculate({ period, high, low, close });
  return out.length ? out[out.length - 1] : null;
}

/** Average Directional Index: forza del trend (filtro di regime). Ultimo valore. */
export function adx(candles, period = 14) {
  if ((candles || []).length < period * 2) return null;
  const { high, low, close } = ohlc(candles);
  const out = ADX.calculate({ period, high, low, close });
  const last = out.length ? out[out.length - 1] : null;
  return last ? last.adx : null;
}

export function rsi(candles, period = 14) {
  const values = closes(candles);
  if (values.length < period + 1) return null;
  const out = RSI.calculate({ period, values });
  return out.length ? out[out.length - 1] : null;
}

export function ema(candles, period = 20) {
  const values = closes(candles);
  if (values.length < period) return null;
  const out = EMA.calculate({ period, values });
  return out.length ? out[out.length - 1] : null;
}

export function sma(candles, period = 20) {
  const values = closes(candles);
  if (values.length < period) return null;
  const out = SMA.calculate({ period, values });
  return out.length ? out[out.length - 1] : null;
}

export function macd(candles, { fast = 12, slow = 26, signal = 9 } = {}) {
  const values = closes(candles);
  if (values.length < slow + signal) return null;
  const out = MACD.calculate({
    values, fastPeriod: fast, slowPeriod: slow, signalPeriod: signal,
    SimpleMAOscillator: false, SimpleMASignalLine: false
  });
  return out.length ? out[out.length - 1] : null; // { MACD, signal, histogram }
}

export function bollinger(candles, { period = 20, stdDev = 2 } = {}) {
  const values = closes(candles);
  if (values.length < period) return null;
  const out = BollingerBands.calculate({ period, stdDev, values });
  return out.length ? out[out.length - 1] : null; // { lower, middle, upper, pb }
}

/**
 * QUAL-01 item 4 — candele MINIME perché una regola produca un valore.
 *
 * Rispecchia una per una le guardie di warmup delle funzioni qui sopra (rsi:
 * `period + 1`, adx: `period * 2`, macd: `slow + signal`, …). Serve alla
 * diagnostica: un bot con meno candele del necessario resta su `hold` per
 * sempre — gli indicatori tornano `null` e nessuna regola è mai soddisfatta —
 * senza che nulla lo dica. Se una guardia cambia là, va cambiata anche qui:
 * sono la stessa affermazione scritta due volte, ed è il prezzo per poter
 * chiedere "quante candele ti servono?" senza calcolare l'indicatore.
 *
 * 0 = la regola non dipende dalle candele (price, funding, external).
 */
export function requiredCandles(rule) {
  if (!rule || rule.type !== 'indicator') return 0;
  const p = rule.period;
  switch (rule.indicator) {
    case 'rsi': return (p || 14) + 1;
    case 'atr': return (p || 14) + 1;
    case 'adx': return (p || 14) * 2;
    case 'ema': return p || 20;
    case 'sma': return p || 20;
    case 'macd': { const { slow = 26, signal = 9 } = rule.params || {}; return slow + signal; }
    case 'bollinger': { const { period = 20 } = rule.params || {}; return period; }
    default: return 0;
  }
}

/** Massimo warmup richiesto da uno o più insiemi di regole (0 se nessuno ne ha bisogno). */
export function warmupCandles(...ruleSets) {
  return [].concat(...ruleSets)
    .reduce((max, rule) => Math.max(max, requiredCandles(rule)), 0);
}

// ---- Serie complete (per il backtester vettorializzato) ----
//
// Gli indicatori usati sono CAUSALI: il valore alla barra i calcolato sull'intera
// serie coincide con quello calcolato sul prefisso [0..i]. Quindi precalcolando
// la serie UNA volta e allineandola a destra otteniamo gli stessi identici valori
// del ricalcolo per-candela, ma in O(N) invece di O(N²).

/** Allinea a destra l'output di un indicatore sull'array dei valori. */
function alignRight(len, out) {
  const offset = len - out.length;
  const aligned = new Array(len).fill(null);
  for (let i = offset; i < len; i++) aligned[i] = out[i - offset];
  return aligned;
}

/** Chiave stabile per identificare l'indicatore di una regola (cache/precompute). */
export function ruleKey(rule) {
  const p = rule.period;
  switch (rule.indicator) {
    case 'rsi': return `rsi:${p || 14}`;
    case 'ema': return `ema:${p || 20}`;
    case 'sma': return `sma:${p || 20}`;
    case 'macd': { const { fast = 12, slow = 26, signal = 9 } = rule.params || {}; return `macd:${fast}-${slow}-${signal}`; }
    case 'bollinger': { const { period = 20, stdDev = 2 } = rule.params || {}; return `bb:${period}-${stdDev}`; }
    case 'adx': return `adx:${p || 14}`;
    default: return `?:${rule.indicator}`;
  }
}

/** Serie ATR completa, index-aligned (per stop adattivi nel backtester). */
export function atrSeries(candles, period = 14) {
  const { high, low, close } = ohlc(candles);
  const out = ATR.calculate({ period, high, low, close });
  return alignRight(candles.length, out || []);
}

/**
 * Precalcola le serie complete (index-aligned) per tutte le regole indicator di
 * entry+exit. Ritorna una Map chiave→array[len] (valori o null in warmup).
 */
export function precomputeSeries(candles, ruleSets = []) {
  const values = closes(candles);
  const len = candles.length;
  const series = new Map();
  const rules = [].concat(...ruleSets).filter(r => r && r.type === 'indicator');
  for (const rule of rules) {
    const key = ruleKey(rule);
    if (series.has(key)) continue;
    let out;
    switch (rule.indicator) {
      case 'rsi': out = RSI.calculate({ period: rule.period || 14, values }); break;
      case 'ema': out = EMA.calculate({ period: rule.period || 20, values }); break;
      case 'sma': out = SMA.calculate({ period: rule.period || 20, values }); break;
      case 'macd': {
        const { fast = 12, slow = 26, signal = 9 } = rule.params || {};
        out = MACD.calculate({ values, fastPeriod: fast, slowPeriod: slow, signalPeriod: signal, SimpleMAOscillator: false, SimpleMASignalLine: false });
        break;
      }
      case 'bollinger': {
        const { period = 20, stdDev = 2 } = rule.params || {};
        out = BollingerBands.calculate({ period, stdDev, values });
        break;
      }
      case 'adx': {
        const { high, low, close } = ohlc(candles);
        const raw = ADX.calculate({ period: rule.period || 14, high, low, close });
        out = raw.map(r => (r ? r.adx : null));
        break;
      }
      default: continue;
    }
    series.set(key, alignRight(len, out || []));
  }
  return series;
}

/**
 * Calcola un set di indicatori richiesti da una lista di regole.
 * Ritorna una mappa nome->valore (per logging/diagnostica).
 */
export function computeForRules(candles, rules = []) {
  const result = {};
  for (const rule of rules) {
    if (rule.type !== 'indicator') continue;
    const p = rule.period;
    switch (rule.indicator) {
      case 'rsi': result[`rsi${p || 14}`] = rsi(candles, p || 14); break;
      case 'ema': result[`ema${p || 20}`] = ema(candles, p || 20); break;
      case 'sma': result[`sma${p || 20}`] = sma(candles, p || 20); break;
      case 'macd': result.macd = macd(candles, rule.params); break;
      case 'bollinger': result.bollinger = bollinger(candles, rule.params); break;
      default: break;
    }
  }
  return result;
}

export default { closes, rsi, ema, sma, macd, bollinger, computeForRules };
