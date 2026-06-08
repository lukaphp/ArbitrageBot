/**
 * OPTIMIZER (Hyperopt)
 * ====================
 *
 * Cerca la migliore combinazione di parametri di una strategia eseguendo molti
 * backtest e classificandoli per un obiettivo (expectancy, profit factor, SQN…).
 *
 * Ispirato a Hyperopt di Freqtrade. Per difendersi dall'overfitting usa la
 * validazione WALK-FORWARD: ottimizza sui dati IN-SAMPLE (prima parte del
 * periodo) e poi verifica il migliore sui dati OUT-OF-SAMPLE (ultima parte mai
 * vista durante la ricerca). Se l'edge regge anche fuori campione è più
 * affidabile; se crolla, i parametri erano sovra-ottimizzati.
 *
 * Riusa interamente il backtester (stesse regole dei bot live). Le candele
 * vengono scaricate UNA volta e riusate su tutte le valutazioni.
 *
 * ⚠️ I risultati sono storici/statistici: non garantiscono rendimenti futuri.
 */

import { runBacktest, fetchCandles } from './backtester.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

const OPT = HYPERLIQUID_CONFIG.optimizer;

/** Valori unici, ordinati, interi positivi. */
function uniqInts(arr) {
  return [...new Set(arr.map(n => Math.round(n)).filter(n => n > 0))].sort((a, b) => a - b);
}

/** Periodi candidati attorno a quello scelto dall'utente (0.5x … 2x). */
function periodCandidates(p) {
  return uniqInts([Math.max(2, p * 0.5), p, p * 1.5, p * 2]);
}

/** Soglie RSI candidate attorno al valore scelto, nel lato corretto. */
function rsiThresholdCandidates(value, op) {
  const base = [value - 10, value - 5, value, value + 5];
  const lo = op === '<' ? 5 : 50;
  const hi = op === '<' ? 50 : 95;
  return [...new Set(base.map(v => Math.round(v)).filter(v => v >= lo && v <= hi))].sort((a, b) => a - b);
}

/**
 * Costruisce lo spazio di ricerca dai campi ottimizzabili presenti nel config.
 * Ogni dimensione ha: key, label, values[], apply(clone, value).
 *
 * Nota: leva e sizing NON entrano nello spazio perché il backtester ragiona in
 * percentuale su un notional fisso, quindi non cambiano l'esito; contano TP, SL,
 * trailing e i parametri degli indicatori (periodi/soglie).
 */
export function buildSpace(config, override = {}) {
  const dims = [];

  if (config.tp?.enabled && typeof config.tp.value === 'number') {
    dims.push({
      key: 'tp', label: 'Take Profit %',
      values: override.tp || [1, 1.5, 2, 3, 4, 5, 6, 8],
      apply: (c, v) => { c.tp.value = v; }
    });
  }
  if (config.sl?.enabled && typeof config.sl.value === 'number') {
    dims.push({
      key: 'sl', label: 'Stop Loss %',
      values: override.sl || [0.5, 1, 1.5, 2, 2.5, 3, 4],
      apply: (c, v) => { c.sl.value = v; }
    });
  }
  if (config.trailing?.enabled && typeof config.trailing.value === 'number') {
    dims.push({
      key: 'trailing', label: 'Trailing %',
      values: override.trailing || [0.5, 1, 1.5, 2, 3],
      apply: (c, v) => { c.trailing.value = v; }
    });
  }

  ['entryRules', 'exitRules'].forEach(scope => {
    (config[scope] || []).forEach((rule, idx) => {
      if (rule.type !== 'indicator') return;
      if (typeof rule.period === 'number') {
        dims.push({
          key: `${scope}[${idx}].period`,
          label: `${rule.indicator?.toUpperCase() || ''} periodo`,
          values: periodCandidates(rule.period),
          apply: (c, v) => { c[scope][idx].period = v; }
        });
      }
      if (rule.indicator === 'rsi' && (rule.op === '<' || rule.op === '>') && typeof rule.value === 'number') {
        dims.push({
          key: `${scope}[${idx}].value`,
          label: `RSI soglia (${rule.op})`,
          values: rsiThresholdCandidates(rule.value, rule.op),
          apply: (c, v) => { c[scope][idx].value = v; }
        });
      }
    });
  });

  return dims.filter(d => d.values.length > 1);
}

/** Genera le combinazioni da valutare (random sampling o grid cappata). */
function buildCombos(dims, method, maxEvals) {
  if (!dims.length) return [{}];

  const gridSize = dims.reduce((n, d) => n * d.values.length, 1);

  if (method === 'grid' && gridSize <= maxEvals) {
    // Prodotto cartesiano completo
    let combos = [{}];
    for (const d of dims) {
      const next = [];
      for (const combo of combos) {
        for (const v of d.values) next.push({ ...combo, [d.key]: v });
      }
      combos = next;
    }
    return combos;
  }

  // Random sampling (default, o grid troppo grande): combinazioni uniche
  const seen = new Set();
  const combos = [];
  let attempts = 0;
  const cap = Math.min(maxEvals, gridSize);
  while (combos.length < cap && attempts < cap * 20) {
    attempts++;
    const combo = {};
    for (const d of dims) combo[d.key] = d.values[Math.floor(Math.random() * d.values.length)];
    const sig = JSON.stringify(combo);
    if (seen.has(sig)) continue;
    seen.add(sig);
    combos.push(combo);
  }
  return combos;
}

/** Applica una combinazione a una copia profonda del config base. */
function applyCombo(baseConfig, dims, combo) {
  const clone = structuredClone(baseConfig);
  for (const d of dims) {
    if (combo[d.key] !== undefined) d.apply(clone, combo[d.key]);
  }
  return clone;
}

/** Punteggio dell'obiettivo a partire dalle statistiche di un backtest. */
function scoreOf(stats, objective) {
  if (!stats || !stats.trades) return -Infinity;
  switch (objective) {
    case 'profitFactor':
      return isFinite(stats.profitFactor) ? stats.profitFactor : 999;
    case 'totalReturnPct':
      return stats.totalReturnPct;
    case 'sqn': {
      // System Quality Number = √N · media/σ dei ritorni dei trade
      return stats._sqn ?? -Infinity;
    }
    case 'expectancy':
    default:
      return stats.expectancy;
  }
}

/** Calcola lo SQN dai trade (richiede l'array trades del backtest). */
function computeSqn(trades) {
  const n = trades.length;
  if (n < 2) return 0;
  const rets = trades.map(t => t.retPct);
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? (Math.sqrt(n) * mean) / sd : 0;
}

/** Estrae le metriche salienti per la leaderboard. */
function summarize(result) {
  const s = result.stats;
  return {
    trades: s.trades,
    winRate: s.winRate,
    profitFactor: s.profitFactor,
    expectancy: s.expectancy,
    totalReturnPct: s.totalReturnPct,
    maxDrawdownPct: s.maxDrawdownPct,
    sqn: s._sqn
  };
}

export async function optimize(baseConfig, coin, opts = {}) {
  const interval = opts.interval || baseConfig.candleInterval || '15m';
  const lookbackDays = opts.lookbackDays || 60;
  const method = opts.method === 'grid' ? 'grid' : 'random';
  const objective = opts.objective || 'expectancy';
  const maxEvals = Math.min(opts.maxEvals || OPT.maxEvals, 200);
  const minTrades = opts.minTrades ?? OPT.minTrades;
  const oosFraction = Math.min(Math.max(opts.oosFraction ?? OPT.oosFraction, 0.1), 0.5);

  // 1) Candele scaricate una volta sola, cappate alle ultime N
  let candles = await fetchCandles(coin, interval, lookbackDays);
  if (candles.length > OPT.candleCap) candles = candles.slice(candles.length - OPT.candleCap);
  if (candles.length < 120) {
    return { error: 'Dati storici insufficienti per l\'ottimizzazione', candles: candles.length };
  }

  // 2) Split temporale in-sample / out-of-sample
  const splitIdx = Math.floor(candles.length * (1 - oosFraction));
  const inSample = candles.slice(0, splitIdx);
  const outSample = candles.slice(splitIdx);

  // 3) Spazio di ricerca
  const dims = buildSpace(baseConfig);
  if (!dims.length) {
    return { error: 'Nessun parametro ottimizzabile in questa strategia (servono TP/SL/trailing o indicatori con periodo/soglia).' };
  }

  const combos = buildCombos(dims, method, maxEvals);
  const runOpts = { interval, notionalUsd: opts.notionalUsd || 1000 };

  // 4) Valuta ogni combinazione sui dati in-sample
  const evaluated = [];
  for (const combo of combos) {
    const cfg = applyCombo(baseConfig, dims, combo);
    try {
      const res = await runBacktest(cfg, coin, { ...runOpts, candles: inSample });
      if (res.error) continue;
      res.stats._sqn = computeSqn(res.trades);
      const score = scoreOf(res.stats, objective);
      evaluated.push({ combo, config: cfg, stats: res.stats, score, trades: res.stats.trades });
    } catch (e) {
      logger.warn('Optimizer: backtest fallito per una combinazione', e.message);
    }
  }

  // 5) Filtra per numero minimo di trade e classifica
  const valid = evaluated.filter(e => e.trades >= minTrades);
  const pool = valid.length ? valid : evaluated; // se nessuno raggiunge minTrades, mostra comunque qualcosa
  pool.sort((a, b) => b.score - a.score);

  if (!pool.length) {
    return { error: 'Nessuna combinazione ha prodotto trade nel periodo selezionato.' };
  }

  const best = pool[0];

  // 6) Validazione walk-forward del migliore sui dati out-of-sample
  let outOfSample = null;
  try {
    const oosRes = await runBacktest(best.config, coin, { ...runOpts, candles: outSample });
    if (!oosRes.error) {
      oosRes.stats._sqn = computeSqn(oosRes.trades);
      outOfSample = summarize(oosRes);
    }
  } catch (e) {
    logger.warn('Optimizer: backtest OOS fallito', e.message);
  }

  const bestParams = {};
  for (const d of dims) bestParams[d.key] = { label: d.label, value: best.combo[d.key] };

  // Verdetto onesto sull'edge fuori campione
  let verdict = 'unknown';
  if (outOfSample) {
    const inExp = best.stats.expectancy;
    const outExp = outOfSample.expectancy;
    if (outExp > 0 && outExp >= inExp * 0.5) verdict = 'robust';
    else if (outExp > 0) verdict = 'weaker';
    else verdict = 'overfit';
  }

  return {
    objective,
    method,
    evals: evaluated.length,
    dims: dims.map(d => ({ key: d.key, label: d.label, values: d.values })),
    best: {
      params: bestParams,
      config: best.config,
      inSample: summarize({ stats: best.stats }),
      outOfSample,
      verdict
    },
    leaderboard: pool.slice(0, 12).map(e => ({
      params: Object.fromEntries(dims.map(d => [d.key, e.combo[d.key]])),
      ...summarize({ stats: e.stats })
    })),
    period: {
      interval,
      candles: candles.length,
      inSampleCandles: inSample.length,
      outSampleCandles: outSample.length,
      from: candles[0].t,
      to: candles[candles.length - 1].t,
      days: Math.round((candles[candles.length - 1].t - candles[0].t) / 86400000)
    },
    minTrades
  };
}

export default { optimize, buildSpace };
