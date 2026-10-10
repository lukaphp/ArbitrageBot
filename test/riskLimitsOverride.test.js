/**
 * #79 — i limiti di rischio per bot STRINGONO il globale, mai lo allargano, e
 * un NaN in ingresso BLOCCA invece di passare.
 * =========================================================================
 *
 * Prima `checkLimits` leggeva `config.risk?.maxLeverage ?? globale` e
 * `config.risk?.maxDailyLossUsd ?? globale`: l'override del bot sostituiva il
 * globale, quindi un bot poteva alzarsi da solo la leva massima o la perdita
 * giornaliera tollerata. E ogni confronto con NaN è falso: leva, equity,
 * notional o PnL di giornata non numerici facevano rispondere `{ ok: true }`.
 *
 * Funzione pura: nessun DB, nessun broker. I limiti globali di riferimento sono
 * quelli di `HYPERLIQUID_CONFIG.risk` letti a runtime (non numeri copiati qui),
 * così il test resta valido con qualunque env.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import riskManager, { resolveRiskLimit } from '../src/perps/riskManager.js';
import { HYPERLIQUID_CONFIG } from '../src/config/config.js';
import logger from '../src/utils/logger.js';

const GLOBAL_LEV = HYPERLIQUID_CONFIG.risk.maxLeverage;
const GLOBAL_LOSS = Math.abs(HYPERLIQUID_CONFIG.risk.maxDailyLossUsd);
const ACCOUNT = { equity: 10_000 };
const PLAN = { leverage: 2, notionalUsd: 100 };

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

/** Esegue `fn` con un limite globale sostituito, ripristinandolo sempre. */
function withGlobal(key, value, fn) {
  const prev = HYPERLIQUID_CONFIG.risk[key];
  HYPERLIQUID_CONFIG.risk[key] = value;
  try { return fn(); } finally { HYPERLIQUID_CONFIG.risk[key] = prev; }
}

// ---------------------------------------------------------------------------
// Leva massima: min(globale, bot)
// ---------------------------------------------------------------------------

test('override di leva PIÙ ALTO del globale: vale il globale', () => {
  const cfg = { risk: { maxLeverage: GLOBAL_LEV * 10 } };
  const r = riskManager.checkLimits(cfg, ACCOUNT, { ...PLAN, leverage: GLOBAL_LEV + 1 }, 0);
  assert.equal(r.ok, false, 'un bot non può alzarsi da solo la leva massima');
  assert.match(r.reason, new RegExp(`oltre il massimo \\(${GLOBAL_LEV}x\\)`));
});

test('override di leva PIÙ BASSO del globale: vale quello del bot', () => {
  const cfg = { risk: { maxLeverage: 2 } };
  assert.equal(riskManager.checkLimits(cfg, ACCOUNT, { ...PLAN, leverage: 2 }, 0).ok, true);
  const r = riskManager.checkLimits(cfg, ACCOUNT, { ...PLAN, leverage: 3 }, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Leva 3x oltre il massimo \(2x\)/);
});

test('override di leva non valido: ignorato (vale il globale) e segnalato UNA volta', () => {
  const cfg = { risk: { maxLeverage: 'abc-79' } };
  const { result, warns } = captureWarns(() => [
    riskManager.checkLimits(cfg, ACCOUNT, { ...PLAN, leverage: GLOBAL_LEV }, 0),
    riskManager.checkLimits(cfg, ACCOUNT, { ...PLAN, leverage: GLOBAL_LEV + 1 }, 0),
    riskManager.checkLimits(cfg, ACCOUNT, { ...PLAN, leverage: 2 }, 0)
  ]);
  assert.equal(result[0].ok, true, 'alla leva globale si apre');
  assert.equal(result[1].ok, false, 'oltre il globale no: un valore illeggibile non è "nessun limite"');
  const righe = warns.filter(w => /risk\.maxLeverage/.test(w) && /abc-79/.test(w));
  assert.equal(righe.length, 1, `un warn per episodio, non per tick (visti: ${JSON.stringify(warns)})`);
});

for (const invalido of [0, -5, NaN, '', null]) {
  test(`override di leva ${JSON.stringify(invalido) ?? String(invalido)}: si applica il globale`, () => {
    const r = resolveRiskLimit({ risk: { maxLeverage: invalido } }, 'maxLeverage');
    assert.equal(r.limit, GLOBAL_LEV);
    if (invalido !== null) assert.equal(r.ignored.length, 1, 'il valore scartato è riportato');
  });
}

// ---------------------------------------------------------------------------
// Perdita giornaliera: min(|globale|, |bot|)
// ---------------------------------------------------------------------------

test('override di perdita giornaliera PIÙ LARGO del globale: vale il globale', () => {
  const cfg = { risk: { maxDailyLossUsd: GLOBAL_LOSS * 10 } };
  const r = riskManager.checkLimits(cfg, ACCOUNT, PLAN, -GLOBAL_LOSS);
  assert.equal(r.ok, false, 'la soglia globale ferma comunque il bot');
  assert.match(r.reason, /perdita giornaliera/);
});

test('override di perdita giornaliera più stretto: vale quello del bot, anche scritto negativo', () => {
  for (const v of [50, -50]) {
    const cfg = { risk: { maxDailyLossUsd: v } };
    assert.equal(riskManager.checkLimits(cfg, ACCOUNT, PLAN, -49).ok, true, `valore ${v}`);
    const r = riskManager.checkLimits(cfg, ACCOUNT, PLAN, -50);
    assert.equal(r.ok, false, `valore ${v}`);
    assert.match(r.reason, /Limite di perdita giornaliera raggiunto \(50\$\)/);
  }
});

test('override di perdita giornaliera non valido: vale il globale, con warn', () => {
  const cfg = { risk: { maxDailyLossUsd: 'tanta-79' } };
  const { result, warns } = captureWarns(() => riskManager.checkLimits(cfg, ACCOUNT, PLAN, -GLOBAL_LOSS));
  assert.equal(result.ok, false);
  assert.ok(warns.some(w => /risk\.maxDailyLossUsd/.test(w) && /tanta-79/.test(w)));
});

// ---------------------------------------------------------------------------
// Fail-closed sugli ingressi
// ---------------------------------------------------------------------------

test('leva NaN / assente / non numerica: bloccato', () => {
  for (const leverage of [NaN, undefined, null, 'abc', Infinity, 0]) {
    const r = riskManager.checkLimits({}, ACCOUNT, { ...PLAN, leverage }, 0);
    assert.equal(r.ok, false, `leva ${String(leverage)}`);
    assert.match(r.reason, /[Ll]eva/);
  }
});

test('equity NaN / assente: bloccato (prima `NaN <= 0` era falso)', () => {
  for (const account of [{ equity: NaN }, {}, { accountValue: 'x' }, { equity: Infinity }]) {
    const r = riskManager.checkLimits({}, account, PLAN, 0);
    assert.equal(r.ok, false, JSON.stringify(account));
    assert.match(r.reason, /Equity/);
  }
  assert.equal(riskManager.checkLimits({}, { equity: 0 }, PLAN, 0).reason, 'Equity nullo o insufficiente',
    'il motivo storico per equity a zero resta invariato');
});

test('PnL di giornata NaN / null: bloccato', () => {
  for (const pnl of [NaN, null, 'abc', -Infinity]) {
    const r = riskManager.checkLimits({}, ACCOUNT, PLAN, pnl);
    assert.equal(r.ok, false, `pnl ${String(pnl)}`);
    assert.match(r.reason, /PnL di giornata/);
  }
  assert.equal(riskManager.checkLimits({}, ACCOUNT, PLAN).ok, true, 'PnL omesso = 0, comportamento invariato');
});

test('notional NaN / assente: bloccato (prima `NaN > tetto` era falso)', () => {
  for (const notionalUsd of [NaN, undefined, 'abc', Infinity]) {
    const r = riskManager.checkLimits({}, ACCOUNT, { leverage: 2, notionalUsd }, 0);
    assert.equal(r.ok, false, `notional ${String(notionalUsd)}`);
    assert.match(r.reason, /Notional/);
  }
});

test('limite GLOBALE inservibile: bloccato con motivo chiaro', () => {
  for (const v of [Infinity, NaN, 0, 'abc']) {
    const r = withGlobal('maxLeverage', v, () => riskManager.checkLimits({}, ACCOUNT, PLAN, 0));
    assert.equal(r.ok, false, `maxLeverage globale ${String(v)}`);
    assert.match(r.reason, /limite globale maxLeverage non utilizzabile/);
  }
  const r = withGlobal('maxDailyLossUsd', Infinity, () => riskManager.checkLimits({}, ACCOUNT, PLAN, 0));
  assert.equal(r.ok, false);
  assert.match(r.reason, /limite globale maxDailyLossUsd non utilizzabile/);
  // Anche con un override valido: senza globale non c'è un minimo da calcolare.
  const conOverride = withGlobal('maxLeverage', NaN,
    () => riskManager.checkLimits({ risk: { maxLeverage: 5 } }, ACCOUNT, PLAN, 0));
  assert.equal(conOverride.ok, false);
});

test('non-regressione: entro tutti i limiti si apre', () => {
  const r = riskManager.checkLimits({ risk: { maxLeverage: 10, maxPositionUsd: 1000, maxDailyLossUsd: 100 } },
    { accountValue: 1000 }, { leverage: 3, notionalUsd: 500 }, -10);
  assert.deepEqual(r, { ok: true, reason: 'OK' });
});

test('checkDcaAdd eredita il limite stretto: override più largo non apre la DCA oltre il globale', () => {
  const v = riskManager.checkDcaAdd({ risk: { maxLeverage: GLOBAL_LEV * 10 } }, {
    account: ACCOUNT, position: { size: 1 }, price: 10, addSize: 1, leverage: GLOBAL_LEV + 1, dailyPnl: 0
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /oltre il massimo/);
});
