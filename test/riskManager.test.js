import { test } from 'node:test';
import assert from 'node:assert/strict';
import riskManager from '../src/perps/riskManager.js';

test('computeTpSl long: TP sopra, SL sotto', () => {
  const { tpPx, slPx } = riskManager.computeTpSl(100, 'long', {
    tp: { enabled: true, mode: 'percent', value: 2 },
    sl: { enabled: true, mode: 'percent', value: 1 }
  });
  assert.equal(tpPx, 102);
  assert.equal(slPx, 99);
});

test('computeTpSl short: TP sotto, SL sopra', () => {
  const { tpPx, slPx } = riskManager.computeTpSl(100, 'short', {
    tp: { enabled: true, mode: 'percent', value: 2 },
    sl: { enabled: true, mode: 'percent', value: 1 }
  });
  assert.equal(tpPx, 98);
  assert.equal(slPx, 101);
});

test('sizePosition: notional = margine × leva, arrotondato', () => {
  const plan = riskManager.sizePosition({ leverage: 5, sizing: { mode: 'fixed', value: 100 } }, 10000, 50, 3);
  // 100$ margine × 5 = 500$ notional / 50 = 10 coin
  assert.equal(plan.size, 10);
  assert.equal(Math.round(plan.notionalUsd), 500);
});

test('checkLimits: rifiuta leva oltre il massimo', () => {
  const r = riskManager.checkLimits({ risk: { maxLeverage: 10 } }, { equity: 1000 }, { leverage: 20, notionalUsd: 100 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /[Ll]eva/);
});

test('checkLimits: rifiuta se limite perdita giornaliera raggiunto', () => {
  const r = riskManager.checkLimits({ risk: { maxDailyLossUsd: 100 } }, { equity: 1000 }, { leverage: 3, notionalUsd: 100 }, -150);
  assert.equal(r.ok, false);
  assert.match(r.reason, /giornaliera/);
});

test('checkLimits: ok entro i limiti', () => {
  const r = riskManager.checkLimits({ risk: { maxLeverage: 10, maxPositionUsd: 1000, maxDailyLossUsd: 100 } },
    { equity: 1000 }, { leverage: 3, notionalUsd: 500 }, 0);
  assert.equal(r.ok, true);
});

test('computeTrailing long: alza lo stop solo a favore', () => {
  const cfg = { trailing: { enabled: true, mode: 'percent', value: 1 } };
  const up = riskManager.computeTrailing({ side: 'long', slPx: 95 }, 100, cfg); // candidate 99 > 95
  assert.ok(up > 95);
  const noMove = riskManager.computeTrailing({ side: 'long', slPx: 99.5 }, 100, cfg); // candidate 99 < 99.5
  assert.equal(noMove, null);
});
