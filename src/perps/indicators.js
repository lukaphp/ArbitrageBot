/**
 * INDICATORI TECNICI
 * ==================
 *
 * Funzioni pure su array di candele Hyperliquid (formato { t, o, h, l, c, v }).
 * Wrappano la libreria `technicalindicators` e restituiscono l'ultimo valore
 * (o l'oggetto completo per MACD/Bollinger) utile allo strategy engine.
 */

import pkg from 'technicalindicators';
const { RSI, EMA, SMA, MACD, BollingerBands } = pkg;

/** Estrae i prezzi di chiusura da un array di candele. */
export function closes(candles) {
  return (candles || []).map(c => parseFloat(c.c)).filter(n => !isNaN(n));
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
