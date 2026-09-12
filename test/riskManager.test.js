import { test } from 'node:test';
import assert from 'node:assert/strict';
import riskManager from '../src/perps/riskManager.js';
import logger from '../src/utils/logger.js';

/**
 * Cattura i `logger.warn` emessi durante `fn()`. Serve ai test del sizing
 * dinamico: il fallback al sizing statico NON deve essere silenzioso (è
 * l'unico segnale che una posizione è stata dimensionata con una regola
 * diversa da quella configurata), quindi il warn fa parte del contratto e
 * va verificato, non solo il numero che esce.
 */
function captureWarns(fn) {
  const original = logger.warn;
  const warns = [];
  logger.warn = (...args) => { warns.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), warns };
  } finally {
    logger.warn = original;
  }
}

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

// ---- Dynamic sizing ATR-based ----
//
// La size dinamica risponde a una domanda diversa da quella statica: non "quanta
// parte dell'equity impegno" ma "quanto perdo se lo stop viene toccato". Il
// rischio in USD (equity × riskPerTradePct%) diviso per la distanza di stop
// (atr × atrMultiplier) dà direttamente le unità di coin. Da qui i test:
// la formula, il cap che resta sovrano, e il fallback quando l'ATR non c'è
// (warmup candele insufficiente) — che deve essere RUMOROSO, mai silenzioso.

// Configurazione statica di riferimento: 100$ di margine × leva 5 = 500$ di
// notional, cioè 10 coin a 50$. È il termine di paragone di tutti i fallback.
const STATIC_CFG = { leverage: 5, sizing: { mode: 'fixed', value: 100 } };
const dynCfg = (risk) => ({ ...STATIC_CFG, risk: { useDynamicSizing: true, ...risk } });

test('sizePosition dinamico: size = rischio in USD / distanza di stop ATR', () => {
  const { result: plan, warns } = captureWarns(() => riskManager.sizePosition(
    dynCfg({ riskPerTradePct: 1, atrMultiplier: 2 }), 10000, 50, 3, { atr: 2 }
  ));
  // rischio = 10000 × 1% = 100$; distanza stop = 2 × 2 = 4$ → 25 coin
  assert.equal(plan.size, 25);
  assert.equal(plan.notionalUsd, 1250);      // 25 × 50
  assert.equal(plan.marginUsd, 250);         // notional / leva 5
  assert.deepEqual(warns, [], 'il percorso nominale non deve loggare warning');
});

test('sizePosition dinamico: default riskPerTradePct 1% e atrMultiplier 1.5', () => {
  const plan = riskManager.sizePosition(dynCfg({}), 10000, 50, 3, { atr: 2 });
  // 10000 × 1% = 100$ / (2 × 1.5 = 3$) = 33.333… coin, troncato a 3 decimali
  assert.equal(plan.size, 33.333);
  assert.ok(Math.abs(plan.notionalUsd - 33.333 * 50) < 1e-9);
});

test('sizePosition dinamico: size indipendente dalla leva (dipende da equity e ATR)', () => {
  // La leva NON entra nella formula dinamica: cambiare leva a parità di rischio
  // e di stop non deve cambiare quanto si compra, solo il margine impegnato.
  const a = riskManager.sizePosition(dynCfg({ riskPerTradePct: 1, atrMultiplier: 2 }), 10000, 50, 3, { atr: 2 });
  const b = riskManager.sizePosition({ ...dynCfg({ riskPerTradePct: 1, atrMultiplier: 2 }), leverage: 10 }, 10000, 50, 3, { atr: 2 });
  assert.equal(a.size, b.size);
  assert.equal(b.marginUsd, a.marginUsd / 2);
});

test('sizePosition dinamico: ATR più alto (più volatilità) → size più piccola', () => {
  const calmo = riskManager.sizePosition(dynCfg({ riskPerTradePct: 1, atrMultiplier: 2 }), 10000, 50, 3, { atr: 1 });
  const agitato = riskManager.sizePosition(dynCfg({ riskPerTradePct: 1, atrMultiplier: 2 }), 10000, 50, 3, { atr: 4 });
  assert.ok(agitato.size < calmo.size);
  assert.equal(calmo.size, 50);    // 100$ / (1 × 2) = 50 coin
  assert.equal(agitato.size, 12.5); // 100$ / (4 × 2) = 12.5 coin
});

test('sizePosition dinamico: il cap maxPositionUsd resta sovrano', () => {
  // Il sizing STATICO di questa config vale 10$ × 5 = 50$ di notional, ben
  // sotto il cap: così un cap rispettato non può essere confuso con un
  // fallback al ramo statico — se il test vedesse 50$ saprebbe distinguerli.
  const cfg = {
    leverage: 5,
    sizing: { mode: 'fixed', value: 10 },
    risk: { useDynamicSizing: true, riskPerTradePct: 5, atrMultiplier: 1, maxPositionUsd: 300 }
  };
  const plan = riskManager.sizePosition(cfg, 10000, 50, 3, { atr: 2 });
  // Senza cap: 500$ di rischio / 2$ = 250 coin = 12.500$ di notional.
  assert.equal(plan.notionalUsd, 300);
  assert.equal(plan.size, 6);
});

test('sizePosition dinamico: ATR assente/nullo/NaN → fallback statico, loggato', () => {
  for (const atr of [null, undefined, 0, -1, NaN, Infinity, 'x']) {
    const { result: plan, warns } = captureWarns(() => riskManager.sizePosition(
      dynCfg({ riskPerTradePct: 1, atrMultiplier: 2 }), 10000, 50, 3, { atr }
    ));
    // Il warmup delle candele è un caso ATTESO: non si lancia, si degrada.
    assert.equal(plan.size, 10, `atr ${String(atr)}: deve valere il sizing statico`);
    assert.equal(Math.round(plan.notionalUsd), 500);
    assert.equal(warns.length, 1, `atr ${String(atr)}: il fallback non deve essere silenzioso`);
    assert.match(warns[0], /sizePosition/);
    assert.match(warns[0], /dynamic sizing|sizing dinamico/i);
  }
});

test('sizePosition dinamico: riskPerTradePct o atrMultiplier non validi → fallback statico, loggato', () => {
  for (const risk of [
    { riskPerTradePct: 0, atrMultiplier: 2 },
    { riskPerTradePct: -1, atrMultiplier: 2 },
    { riskPerTradePct: NaN, atrMultiplier: 2 },
    { riskPerTradePct: 1, atrMultiplier: 0 },
    { riskPerTradePct: 1, atrMultiplier: -2 },
    { riskPerTradePct: 1, atrMultiplier: 'due' }
  ]) {
    const { result: plan, warns } = captureWarns(() => riskManager.sizePosition(
      dynCfg(risk), 10000, 50, 3, { atr: 2 }
    ));
    assert.equal(plan.size, 10, `${JSON.stringify(risk)}: deve valere il sizing statico`);
    assert.equal(warns.length, 1, `${JSON.stringify(risk)}: il fallback non deve essere silenzioso`);
  }
});

test('sizePosition dinamico: guard su equity/price valgono anche col ramo dinamico', () => {
  const cfg = dynCfg({ riskPerTradePct: 1, atrMultiplier: 2 });
  assert.throws(() => riskManager.sizePosition(cfg, NaN, 50, 3, { atr: 2 }), /equity non valido/);
  assert.throws(() => riskManager.sizePosition(cfg, 10000, 0, 3, { atr: 2 }), /price non valido/);
});

test('sizePosition: retrocompatibilità — 5° argomento assente, comportamento invariato', () => {
  // Chiamata "vecchia", senza ATR: identica a prima, e senza warning perché il
  // sizing dinamico non è nemmeno richiesto.
  const { result: plan, warns } = captureWarns(() => riskManager.sizePosition(STATIC_CFG, 10000, 50, 3));
  assert.equal(plan.size, 10);
  assert.equal(Math.round(plan.notionalUsd), 500);
  assert.deepEqual(warns, []);

  // useDynamicSizing esplicitamente falso: nessun warning, nessun cambiamento.
  const spento = captureWarns(() => riskManager.sizePosition(
    { ...STATIC_CFG, risk: { useDynamicSizing: false } }, 10000, 50, 3, { atr: 2 }
  ));
  assert.equal(spento.result.size, 10);
  assert.deepEqual(spento.warns, []);

  // useDynamicSizing attivo ma chiamante non aggiornato (nessun 5° argomento):
  // fallback statico rumoroso, non un NaN che arriva all'exchange.
  const nonAggiornato = captureWarns(() => riskManager.sizePosition(dynCfg({}), 10000, 50, 3));
  assert.equal(nonAggiornato.result.size, 10);
  assert.equal(nonAggiornato.warns.length, 1);
});

test('sizePosition dinamico: sizing.mode percent resta il fallback quando manca l\'ATR', () => {
  const cfg = { leverage: 3, sizing: { mode: 'percent', value: 10 }, risk: { useDynamicSizing: true } };
  const { result: plan } = captureWarns(() => riskManager.sizePosition(cfg, 10000, 50, 3, { atr: null }));
  // 10% di 10000 = 1000$ di margine × 3 = 3000$ / 50 = 60 coin
  assert.equal(plan.size, 60);
  assert.equal(Math.round(plan.notionalUsd), 3000);
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
