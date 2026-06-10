import { test } from 'node:test';
import assert from 'node:assert/strict';
import strategyEngine from '../src/perps/strategyEngine.js';
import * as ind from '../src/perps/indicators.js';

function makeCandles(n = 800) {
  const C = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 9) * 2 + Math.cos(i / 17) * 1.2;
    const o = p, c = p + Math.sin(i / 3) * 0.4;
    C.push({ t: i * 900000, o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c });
  }
  return C;
}

const config = {
  direction: 'both', logic: 'any',
  entryRules: [
    { type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 40, signal: 'long' },
    { type: 'indicator', indicator: 'ema', period: 50, op: '<', value: 0, compareToPrice: true, signal: 'long' }
  ],
  exitRules: [
    { type: 'indicator', indicator: 'macd', cond: 'bearish', signal: 'close' },
    { type: 'indicator', indicator: 'bollinger', cond: 'above_upper', signal: 'close' }
  ]
};

test('vettorializzato ≡ ricalcolo per-candela (stessi segnali ad ogni barra)', () => {
  const C = makeCandles();
  const series = ind.precomputeSeries(C, [config.entryRules, config.exitRules]);
  const precomputedAt = (i) => { const o = {}; for (const [k, arr] of series) o[k] = arr[i]; return o; };

  for (let i = 60; i < C.length; i++) {
    for (const inPos of [false, true]) {
      const recompute = strategyEngine.evaluate(config,
        { coin: 'X', price: C[i].c, candles: C.slice(0, i + 1) }, { inPosition: inPos, side: 'long' });
      const vector = strategyEngine.evaluate(config,
        { coin: 'X', price: C[i].c, candles: C, precomputed: precomputedAt(i) }, { inPosition: inPos, side: 'long' });
      assert.equal(vector.action, recompute.action, `barra ${i} inPos=${inPos}`);
    }
  }
});

test('precompute è più veloce del ricalcolo per-candela', () => {
  const C = makeCandles(1500);
  const series = ind.precomputeSeries(C, [config.entryRules, config.exitRules]);
  const precomputedAt = (i) => { const o = {}; for (const [k, arr] of series) o[k] = arr[i]; return o; };

  const t0 = performance.now();
  for (let i = 60; i < C.length; i++) {
    strategyEngine.evaluate(config, { coin: 'X', price: C[i].c, candles: C.slice(0, i + 1) }, { inPosition: false });
  }
  const slow = performance.now() - t0;

  const t1 = performance.now();
  for (let i = 60; i < C.length; i++) {
    strategyEngine.evaluate(config, { coin: 'X', price: C[i].c, candles: C, precomputed: precomputedAt(i) }, { inPosition: false });
  }
  const fast = performance.now() - t1;

  // Atteso un netto miglioramento; soglia prudente (≥3×) per evitare flakiness in CI.
  assert.ok(fast < slow / 3, `vettoriale ${fast.toFixed(1)}ms vs ricalcolo ${slow.toFixed(1)}ms`);
});
