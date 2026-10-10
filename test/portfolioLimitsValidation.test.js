/**
 * #79 — `POST /api/perps/portfolio` non può più spegnere i cap di portafoglio.
 * ==========================================================================
 *
 * Prima `setLimits(req.body)` scriveva qualunque cosa: con
 * `maxTotalExposureUsd: 'abc'` il confronto `totale > 'abc'` in `canOpen` era
 * falso per ogni totale, e il tetto di esposizione spariva — idem posizioni
 * concorrenti e perdite consecutive. Qui si verificano i tre strati:
 *  - SCRITTURA (`setLimits`): whitelist delle chiavi, numeri finiti > 0, interi
 *    dove sono conteggi, tetto di plausibilità; tutto-o-niente;
 *  - LETTURA (`getLimits`): un valore già persistito e non valido ripiega sul
 *    default di QUELLA chiave, con un warn una sola volta;
 *  - DECISIONE (`canOpen`): un limite non numerico blocca.
 * E la rotta reale, invocata dal router stack di Express (stesso seam di
 * `advisorRoutes.test.js`): una richiesta non valida è un 400 leggibile.
 *
 * DB su file temporaneo, impostato PRIMA di importare server/portfolio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-pflimits79-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: logger } = await import('../src/utils/logger.js');
const { Portfolio, LIMIT_SPECS } = await import('../src/perps/portfolio.js');
const { default: app } = await import('../src/server.js');

const KEY = 'portfolio_limits';
const VALIDI = { maxConcurrentPositions: 4, maxTotalExposureUsd: 25_000, maxConsecutiveLosses: 5, cooldownMinutes: 30 };

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

function persisted() {
  const raw = db.getSetting(KEY);
  return raw ? JSON.parse(raw) : null;
}

function fresh(initial = VALIDI) {
  db.setSetting(KEY, JSON.stringify(initial));
  return new Portfolio();
}

// ---------------------------------------------------------------------------
// setLimits
// ---------------------------------------------------------------------------

test('setLimits: valori validi → salvati e restituiti', () => {
  const p = fresh();
  const out = p.setLimits({ maxConcurrentPositions: 2, maxTotalExposureUsd: 7500.5 });
  assert.equal(out.maxConcurrentPositions, 2);
  assert.equal(out.maxTotalExposureUsd, 7500.5);
  assert.equal(out.maxConsecutiveLosses, 5, 'le chiavi non toccate restano');
  assert.deepEqual(persisted(), out);
});

test('setLimits: "abc" → eccezione e NIENTE scritto, nemmeno i campi validi', () => {
  const p = fresh();
  assert.throws(
    () => p.setLimits({ maxConcurrentPositions: 2, maxTotalExposureUsd: 'abc' }),
    /maxTotalExposureUsd: "abc" non è un numero/
  );
  assert.deepEqual(persisted(), VALIDI, 'tutto-o-niente: un salvataggio a metà è una combinazione che nessuno ha scelto');
});

test('setLimits: chiave sconosciuta → rifiutata', () => {
  const p = fresh();
  assert.throws(() => p.setLimits({ maxPositions: 2 }), /maxPositions: chiave sconosciuta/);
  assert.deepEqual(persisted(), VALIDI);
});

test('setLimits: zero e negativi → rifiutati', () => {
  const p = fresh();
  for (const key of Object.keys(LIMIT_SPECS)) {
    for (const v of [0, -1]) {
      assert.throws(() => p.setLimits({ [key]: v }), /maggiore di zero/, `${key}=${v}`);
    }
  }
  assert.deepEqual(persisted(), VALIDI);
});

test('setLimits: conteggi non interi → rifiutati; importi e minuti frazionari ammessi', () => {
  const p = fresh();
  assert.throws(() => p.setLimits({ maxConcurrentPositions: 2.5 }), /intero/);
  assert.throws(() => p.setLimits({ maxConsecutiveLosses: 1.2 }), /intero/);
  assert.deepEqual(persisted(), VALIDI);
  const out = p.setLimits({ maxTotalExposureUsd: 1234.56, cooldownMinutes: 7.5 });
  assert.equal(out.cooldownMinutes, 7.5);
});

test('setLimits: oltre il tetto di plausibilità, Infinity, NaN, null, "" e booleani → rifiutati', () => {
  const p = fresh();
  const casi = [
    [{ maxConcurrentPositions: LIMIT_SPECS.maxConcurrentPositions.max + 1 }, /oltre il massimo/],
    [{ maxTotalExposureUsd: LIMIT_SPECS.maxTotalExposureUsd.max * 10 }, /oltre il massimo/],
    [{ maxTotalExposureUsd: Infinity }, /non è un numero/],
    [{ maxTotalExposureUsd: NaN }, /non è un numero/],
    // null è ciò che arriva da `parseInt('')` serializzato: un campo vuoto non è 0.
    [{ maxConcurrentPositions: null }, /non è un numero/],
    [{ maxConcurrentPositions: '' }, /non è un numero/],
    [{ maxConcurrentPositions: true }, /non è un numero/]
  ];
  for (const [body, re] of casi) assert.throws(() => p.setLimits(body), re, JSON.stringify(body));
  assert.deepEqual(persisted(), VALIDI);
});

test('setLimits: TUTTI i problemi in un solo messaggio', () => {
  const p = fresh();
  try {
    p.setLimits({ maxConcurrentPositions: 'x', cooldownMinutes: -1, foo: 1 });
    assert.fail('doveva lanciare');
  } catch (e) {
    assert.match(e.message, /maxConcurrentPositions/);
    assert.match(e.message, /cooldownMinutes/);
    assert.match(e.message, /foo: chiave sconosciuta/);
  }
});

test('setLimits: stringhe numeriche accettate e salvate come NUMERI', () => {
  const p = fresh();
  const out = p.setLimits({ maxConcurrentPositions: '6', maxTotalExposureUsd: ' 9000 ' });
  assert.equal(out.maxConcurrentPositions, 6);
  assert.equal(out.maxTotalExposureUsd, 9000);
  assert.equal(typeof persisted().maxConcurrentPositions, 'number');
});

test('setLimits: corpo non oggetto → rifiutato', () => {
  const p = fresh();
  for (const body of [null, [1, 2], 'abc', 42]) {
    assert.throws(() => p.setLimits(body), /serve un oggetto/, JSON.stringify(body));
  }
  assert.deepEqual(persisted(), VALIDI);
});

// ---------------------------------------------------------------------------
// getLimits — valori già persistiti prima del fix
// ---------------------------------------------------------------------------

test('getLimits: valore persistito corrotto → default per QUELLA chiave, warn una volta', () => {
  const p = fresh({ maxConcurrentPositions: 'abc', maxTotalExposureUsd: -5, maxConsecutiveLosses: 7, junk: 1 });
  const { result, warns } = captureWarns(() => [p.getLimits(), p.getLimits(), p.getLimits()]);
  const L = result[0];
  assert.equal(L.maxConcurrentPositions, 3, 'default');
  assert.ok(L.maxTotalExposureUsd > 0 && Number.isFinite(L.maxTotalExposureUsd), 'default, non -5');
  assert.equal(L.maxConsecutiveLosses, 7, 'la chiave valida resta quella salvata');
  assert.ok(!('junk' in L), 'nessuna chiave spuria');
  assert.equal(warns.filter(w => /— maxConcurrentPositions:/.test(w)).length, 1, 'un warn, non uno per lettura');
  assert.equal(warns.filter(w => /— maxTotalExposureUsd:/.test(w)).length, 1);
  assert.equal(warns.filter(w => /junk: chiave sconosciuta/.test(w)).length, 1, 'anche la chiave spuria è detta');
});

test('canOpen con un limite persistito corrotto: il cap NON si spegne', () => {
  const p = fresh({ maxConcurrentPositions: 'abc', maxTotalExposureUsd: 25_000, maxConsecutiveLosses: 99, cooldownMinutes: 60 });
  const full = { positions: [{ positionValue: 1 }, { positionValue: 1 }, { positionValue: 1 }] };
  const r = captureWarns(() => p.canOpen({ account: full, plannedNotional: 1, botId: 'pv-1' })).result;
  assert.equal(r.ok, false, 'prima `3 >= "abc"` era falso: il tetto di posizioni spariva');
  assert.match(r.reason, /posizioni concorrenti \(3\)/);
});

// ---------------------------------------------------------------------------
// canOpen — fail-closed
// ---------------------------------------------------------------------------

test('canOpen: un limite NaN (per qualunque via ci arrivi) blocca', () => {
  for (const key of Object.keys(LIMIT_SPECS)) {
    const p = new Portfolio();
    p.getLimits = () => ({ ...VALIDI, [key]: NaN });
    const r = p.canOpen({ account: { positions: [] }, plannedNotional: 1, botId: `pv-nan-${key}` });
    assert.equal(r.ok, false, key);
    assert.match(r.reason, new RegExp(`${key} non valido`));
  }
});

test('canOpen: limiti validi, comportamento invariato', () => {
  const p = fresh();
  assert.equal(p.canOpen({ account: { positions: [] }, plannedNotional: 100, botId: 'pv-ok' }).ok, true);
});

// ---------------------------------------------------------------------------
// Rotta reale
// ---------------------------------------------------------------------------

function handlerFor(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function call(method, routePath, body) {
  const captured = { statusCode: 200, body: null };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; }
  };
  await handlerFor(method, routePath)({ body, params: {}, query: {} }, res);
  return captured;
}

test('POST /api/perps/portfolio con un valore non numerico: 400 leggibile, niente scritto', async () => {
  db.setSetting(KEY, JSON.stringify(VALIDI));
  const r = await call('post', '/api/perps/portfolio', { maxTotalExposureUsd: 'abc', maxConcurrentPositions: 2 });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.success, false);
  assert.match(r.body.error, /maxTotalExposureUsd: "abc" non è un numero/);
  assert.deepEqual(persisted(), VALIDI);
});

test('POST /api/perps/portfolio con valori validi (come li manda la UI): 200 e salvati', async () => {
  db.setSetting(KEY, JSON.stringify(VALIDI));
  const body = { maxConcurrentPositions: 2, maxTotalExposureUsd: 8000, maxConsecutiveLosses: 4, cooldownMinutes: 45 };
  const r = await call('post', '/api/perps/portfolio', body);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.success, true);
  assert.deepEqual(persisted(), body);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
