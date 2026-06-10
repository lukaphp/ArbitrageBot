import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from '../src/perps/backtester.js';

// Candele sintetiche deterministiche con oscillazione, sufficienti a generare trade.
function makeCandles(n = 600) {
  const C = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 10) * 2;
    const o = p, c = p + Math.sin(i / 3) * 0.3;
    C.push({ t: i * 900000, o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c });
  }
  return C;
}

const config = {
  candleInterval: '15m', direction: 'both', logic: 'any',
  entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 40, signal: 'long' }],
  exitRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '>', value: 60, signal: 'close' }],
  tp: { enabled: true, mode: 'percent', value: 3 },
  sl: { enabled: true, mode: 'percent', value: 1.5 }
};

test('i costi riducono expectancy e PnL rispetto al backtest senza costi', async () => {
  const candles = makeCandles();
  const noFee = await runBacktest(config, 'TEST-PERP', { candles, feePct: 0, slippagePct: 0, fundingAprPct: 0 });
  const withFee = await runBacktest(config, 'TEST-PERP', { candles });
  assert.ok(noFee.stats.trades > 0, 'la strategia deve generare trade');
  assert.equal(withFee.stats.trades, noFee.stats.trades, 'stesso numero di trade');
  assert.ok(withFee.stats.totalPnl < noFee.stats.totalPnl, 'i costi riducono il PnL');
  assert.ok(withFee.stats.totalCosts > 0, 'i costi totali sono positivi');
});

test('i costi totali = trade × notional × (2·fee + 2·slippage)', async () => {
  const candles = makeCandles();
  const r = await runBacktest(config, 'TEST-PERP', { candles, feePct: 0.00035, slippagePct: 0.0005, fundingAprPct: 0, notionalUsd: 1000 });
  const expectedPerTrade = 1000 * (0.00035 + 0.0005) * 2; // 1.70$
  assert.ok(Math.abs(r.stats.totalCosts - r.stats.trades * expectedPerTrade) < 1e-6);
});

test('espone le ipotesi di costo usate', async () => {
  const r = await runBacktest(config, 'TEST-PERP', { candles: makeCandles() });
  assert.ok(r.costs && typeof r.costs.feePct === 'number');
});

test('dati insufficienti → errore esplicito', async () => {
  const r = await runBacktest(config, 'TEST-PERP', { candles: makeCandles(30) });
  assert.ok(r.error);
});
