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

// ---- CRIT-01: classificazione del fill reale ----

test('resolveFillSize: fill pieno', () => {
  const r = riskManager.resolveFillSize(1.5, 1.5);
  assert.equal(r.filled, 1.5);
  assert.equal(r.full, true);
  assert.equal(r.partial, false);
  assert.equal(r.none, false);
  assert.equal(r.ratio, 1);
});

test('resolveFillSize: fill parziale', () => {
  const r = riskManager.resolveFillSize(2, 0.5);
  assert.equal(r.filled, 0.5);
  assert.equal(r.partial, true);
  assert.equal(r.none, false);
  assert.equal(r.ratio, 0.25);
});

test('resolveFillSize: totalSz null/0/non numerico = nessun fill', () => {
  for (const bad of [null, undefined, 0, -1, NaN, 'x']) {
    const r = riskManager.resolveFillSize(1, bad);
    assert.equal(r.none, true, `totalSz ${String(bad)} deve valere "nessun fill"`);
    assert.equal(r.filled, 0);
    assert.equal(r.partial, false, 'nessun fill non è un fill parziale: sono casi da trattare diversamente');
  }
});

test('resolveFillSize: un fill pieno restituito con errore di virgola mobile non è "parziale"', () => {
  // Senza tolleranza, ogni apertura genererebbe una notifica di fill parziale.
  const r = riskManager.resolveFillSize(0.3, 0.3 - Number.EPSILON);
  assert.equal(r.partial, false);
  assert.equal(r.full, true);
});

test('resolveFillSize: fill superiore al pianificato non è parziale (né un errore)', () => {
  const r = riskManager.resolveFillSize(1, 1.2);
  assert.equal(r.partial, false);
  assert.equal(r.full, true);
  assert.equal(r.filled, 1.2, 'si usa comunque la size reale, non quella pianificata');
});

// ---- WARN-03: slippage reale ----

test('computeSlippage: nessuno scostamento = 0', () => {
  assert.equal(riskManager.computeSlippage(100, 100), 0);
});

test('computeSlippage: scostamento in su e in giù danno lo stesso valore assoluto', () => {
  assert.ok(Math.abs(riskManager.computeSlippage(100.1, 100) - 0.001) < 1e-12);
  assert.ok(Math.abs(riskManager.computeSlippage(99.9, 100) - 0.001) < 1e-12);
});

test('computeSlippage: scostamento grande', () => {
  assert.ok(Math.abs(riskManager.computeSlippage(105, 100) - 0.05) < 1e-12);
});

test('computeSlippage: prezzi non utilizzabili → null, non 0', () => {
  // 0 significherebbe "eseguito esattamente al prezzo atteso": un dato assente
  // non deve poter essere confuso con un'esecuzione perfetta.
  for (const [a, b] of [[null, 100], [100, null], [0, 100], [100, 0], [NaN, 100], [undefined, undefined]]) {
    assert.equal(riskManager.computeSlippage(a, b), null, `computeSlippage(${a}, ${b})`);
  }
});
