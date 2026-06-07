/**
 * BACKTESTER (Perps)
 * ==================
 *
 * Rigioca una strategia sulle candele storiche di Hyperliquid e ne misura
 * l'edge: win rate, profit factor, expectancy, max drawdown, return.
 *
 * Riusa direttamente lo strategyEngine (stesse regole dei bot live) e il
 * riskManager (stessi calcoli TP/SL/trailing), così il backtest riflette
 * fedelmente il comportamento reale.
 *
 * Niente look-ahead: il segnale a ogni candela usa solo le candele chiuse
 * fino a quel punto; l'entrata avviene alla chiusura della candela segnale;
 * TP/SL vengono verificati sui massimi/minimi delle candele successive.
 *
 * ⚠️ I risultati sono storici/statistici: non garantiscono rendimenti futuri.
 */

import strategyEngine from './strategyEngine.js';
import riskManager from './riskManager.js';
import client from './hyperliquidClient.js';

const DAY_MS = 86400000;

/** Warm-up minimo (numero candele) prima di iniziare a valutare i segnali. */
function computeWarmup(config) {
  let maxPeriod = 20;
  const scan = (rules) => (rules || []).forEach(r => {
    if (r.type === 'indicator' && r.period) maxPeriod = Math.max(maxPeriod, r.period);
    if (r.indicator === 'macd') maxPeriod = Math.max(maxPeriod, 35);
    if (r.indicator === 'bollinger') maxPeriod = Math.max(maxPeriod, r.params?.period || 20);
  });
  scan(config.entryRules);
  scan(config.exitRules);
  return Math.max(50, maxPeriod + 35);
}

/** Verifica se la candela colpisce TP o SL. Ritorna { px, reason } o null. */
function checkExit(state, candle) {
  const { side, tpPx, slPx } = state;
  if (side === 'long') {
    // In caso di tocco simultaneo si assume lo SL prima (conservativo)
    if (slPx != null && candle.l <= slPx) return { px: slPx, reason: 'sl' };
    if (tpPx != null && candle.h >= tpPx) return { px: tpPx, reason: 'tp' };
  } else {
    if (slPx != null && candle.h >= slPx) return { px: slPx, reason: 'sl' };
    if (tpPx != null && candle.l <= tpPx) return { px: tpPx, reason: 'tp' };
  }
  return null;
}

function pnlPct(side, entry, exit) {
  return side === 'long' ? (exit - entry) / entry : (entry - exit) / entry;
}

export async function runBacktest(config, coin, opts = {}) {
  const interval = opts.interval || config.candleInterval || '15m';
  const lookbackDays = opts.lookbackDays || 30;
  const notionalUsd = opts.notionalUsd || 1000;

  const raw = await client.getCandles(coin, interval, lookbackDays * DAY_MS) || [];
  const C = raw
    .map(k => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c }))
    .filter(k => !isNaN(k.c));

  if (C.length < 60) {
    return { error: 'Dati storici insufficienti per il backtest', candles: C.length };
  }

  const warmup = computeWarmup(config);
  const trades = [];
  const equityCurve = [];
  let equity = 0;          // PnL cumulato in USD su notionalUsd
  let peak = 0, maxDD = 0; // drawdown in USD
  let state = null;        // posizione simulata

  const openTrade = (side, candle) => {
    const { tpPx, slPx } = riskManager.computeTpSl(candle.c, side, config);
    state = { side, entryPx: candle.c, tpPx, slPx, entryTime: candle.t, entryIdx: null };
  };
  const closeTrade = (exitPx, time, reason) => {
    const ret = pnlPct(state.side, state.entryPx, exitPx);
    const usd = notionalUsd * ret;
    equity += usd;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    trades.push({
      side: state.side, entryPx: state.entryPx, exitPx,
      retPct: ret * 100, pnlUsd: usd, reason,
      entryTime: state.entryTime, exitTime: time
    });
    state = null;
  };

  for (let i = warmup; i < C.length; i++) {
    const candle = C[i];
    const snapshot = { coin, price: candle.c, candles: C.slice(0, i + 1), funding: null };

    if (state) {
      // 1) TP/SL intrabar
      const hit = checkExit(state, candle);
      if (hit) {
        closeTrade(hit.px, candle.t, hit.reason);
      } else {
        // 2) trailing stop
        const newSl = riskManager.computeTrailing({ side: state.side, slPx: state.slPx }, candle.c, config);
        if (newSl != null) state.slPx = newSl;
        // 3) regole di uscita
        const dec = strategyEngine.evaluate(config, snapshot, { inPosition: true, side: state.side });
        if (dec.action === 'close') closeTrade(candle.c, candle.t, 'exit');
      }
    } else {
      const dec = strategyEngine.evaluate(config, snapshot, { inPosition: false });
      if (dec.action === 'open_long') openTrade('long', candle);
      else if (dec.action === 'open_short') openTrade('short', candle);
    }
    equityCurve.push({ t: candle.t, equity: Number(equity.toFixed(2)) });
  }

  // Chiusura forzata di un'eventuale posizione ancora aperta a fine periodo
  if (state) closeTrade(C[C.length - 1].c, C[C.length - 1].t, 'eod');

  return {
    stats: computeStats(trades, notionalUsd, maxDD),
    trades,
    equityCurve,
    period: {
      from: C[0].t, to: C[C.length - 1].t, candles: C.length, interval,
      days: Math.round((C[C.length - 1].t - C[0].t) / DAY_MS)
    },
    notionalUsd
  };
}

function computeStats(trades, notionalUsd, maxDD) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const winRate = n ? wins.length / n : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = n ? totalPnl / n : 0; // USD medio per trade
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgHold = n ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / n : 0;

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate,                                   // 0..1
    profitFactor,
    expectancy,                                // USD/trade
    avgWin, avgLoss,
    totalPnl,                                  // USD su notionalUsd
    totalReturnPct: notionalUsd ? (totalPnl / notionalUsd) * 100 : 0,
    maxDrawdown: maxDD,                        // USD
    maxDrawdownPct: notionalUsd ? (maxDD / notionalUsd) * 100 : 0,
    avgHoldMs: avgHold
  };
}

export default { runBacktest };
