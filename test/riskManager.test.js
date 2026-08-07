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

// SEC-05: guard difensivo su sizePosition — equity/price non validi devono
// sollevare un errore esplicito, mai propagare NaN in silenzio.
test('sizePosition: rifiuta equity undefined', () => {
  assert.throws(() => riskManager.sizePosition({}, undefined, 50, 3), /equity non valido/);
});

test('sizePosition: rifiuta equity NaN', () => {
  assert.throws(() => riskManager.sizePosition({}, NaN, 50, 3), /equity non valido/);
});

test('sizePosition: rifiuta equity zero', () => {
  assert.throws(() => riskManager.sizePosition({}, 0, 50, 3), /equity non valido/);
});

test('sizePosition: rifiuta equity negativo', () => {
  assert.throws(() => riskManager.sizePosition({}, -500, 50, 3), /equity non valido/);
});

test('sizePosition: rifiuta price non valido', () => {
  assert.throws(() => riskManager.sizePosition({}, 10000, 0, 3), /price non valido/);
  assert.throws(() => riskManager.sizePosition({}, 10000, NaN, 3), /price non valido/);
});

// SEC-01: applyDcaFill — media ponderata + ricalcolo TP/SL sul nuovo entry.
test('applyDcaFill: media ponderata corretta e size sommata', () => {
  const position = { side: 'long', entryPx: 100, size: 1 };
  const r = riskManager.applyDcaFill(position, 90, 1, {
    tp: { enabled: true, mode: 'percent', value: 10 },
    sl: { enabled: true, mode: 'percent', value: 5 }
  });
  assert.equal(r.size, 2);
  assert.equal(r.entryPx, 95); // (100*1 + 90*1) / 2
  assert.equal(r.tpPx, 95 * 1.10);
  assert.equal(r.slPx, 95 * 0.95);
});

test('applyDcaFill: pesi diversi tra size vecchia e size aggiunta', () => {
  const position = { side: 'short', entryPx: 200, size: 3 };
  const r = riskManager.applyDcaFill(position, 220, 1, {
    tp: { enabled: true, mode: 'percent', value: 5 },
    sl: { enabled: true, mode: 'percent', value: 5 }
  });
  assert.equal(r.size, 4);
  assert.equal(r.entryPx, (200 * 3 + 220 * 1) / 4);
});

test('applyDcaFill: modalità atr rispettata (non percent)', () => {
  const position = { side: 'long', entryPx: 100, size: 1 };
  const r = riskManager.applyDcaFill(position, 90, 1, {
    tp: { enabled: true, mode: 'atr', value: 2 },
    sl: { enabled: true, mode: 'atr', value: 1 }
  }, { atr: 3 });
  assert.equal(r.entryPx, 95);
  assert.equal(r.tpPx, 95 + 2 * 3);
  assert.equal(r.slPx, 95 - 1 * 3);
});

test('computeTrailing long: alza lo stop solo a favore', () => {
  const cfg = { trailing: { enabled: true, mode: 'percent', value: 1 } };
  const up = riskManager.computeTrailing({ side: 'long', slPx: 95 }, 100, cfg); // candidate 99 > 95
  assert.ok(up > 95);
  const noMove = riskManager.computeTrailing({ side: 'long', slPx: 99.5 }, 100, cfg); // candidate 99 < 99.5
  assert.equal(noMove, null);
});
