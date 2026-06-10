import { test } from 'node:test';
import assert from 'node:assert/strict';
import riskManager from '../src/perps/riskManager.js';
import * as ind from '../src/perps/indicators.js';
import strategyEngine from '../src/perps/strategyEngine.js';

function makeCandles(n = 100) {
  const C = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 5) * 3;
    const o = p, c = p + 1;
    C.push({ t: i * 9e5, o, h: Math.max(o, c) + 2, l: Math.min(o, c) - 2, c });
  }
  return C;
}

test('stop ATR: SL a distanza k×ATR dall\'entry', () => {
  const atr = 5;
  const cfg = { sl: { enabled: true, mode: 'atr', value: 2 }, tp: { enabled: true, mode: 'atr', value: 3 } };
  const longRes = riskManager.computeTpSl(100, 'long', cfg, { atr });
  assert.equal(longRes.slPx, 100 - 2 * 5); // 90
  assert.equal(longRes.tpPx, 100 + 3 * 5); // 115
  const shortRes = riskManager.computeTpSl(100, 'short', cfg, { atr });
  assert.equal(shortRes.slPx, 100 + 2 * 5); // 110
  assert.equal(shortRes.tpPx, 100 - 3 * 5); // 85
});

test('stop ATR: senza ATR disponibile non produce uno stop fittizio', () => {
  const cfg = { sl: { enabled: true, mode: 'atr', value: 2 } };
  const r = riskManager.computeTpSl(100, 'long', cfg, { atr: null });
  assert.equal(r.slPx, null);
});

test('trailing ATR: distanza = k×ATR', () => {
  const cfg = { trailing: { enabled: true, mode: 'atr', value: 2 } };
  const sl = riskManager.computeTrailing({ side: 'long', slPx: null }, 100, cfg, { atr: 5 });
  assert.equal(sl, 90);
});

test('ATR e ADX restituiscono numeri su dati sufficienti', () => {
  const C = makeCandles(120);
  assert.equal(typeof ind.atr(C, 14), 'number');
  assert.equal(typeof ind.adx(C, 14), 'number');
});

test('regola ADX come filtro di regime', () => {
  const C = makeCandles(120);
  const adxVal = ind.adx(C, 14);
  const config = { entryRules: [{ type: 'indicator', indicator: 'adx', period: 14, op: '>', value: adxVal - 1, signal: 'long' }] };
  const dec = strategyEngine.evaluate(config, { coin: 'X', price: C[C.length - 1].c, candles: C }, { inPosition: false });
  assert.equal(dec.action, 'open_long'); // ADX corrente > soglia → trend abbastanza forte
});

test('ADX precalcolato ≡ ricalcolo', () => {
  const C = makeCandles(150);
  const rule = { type: 'indicator', indicator: 'adx', period: 14, op: '>', value: 20, signal: 'long' };
  const series = ind.precomputeSeries(C, [[rule]]);
  const key = ind.ruleKey(rule);
  const arr = series.get(key);
  const direct = ind.adx(C, 14);
  assert.ok(Math.abs(arr[C.length - 1] - direct) < 1e-9);
});
