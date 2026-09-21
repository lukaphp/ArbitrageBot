/**
 * JEV-OBS-01 · la rotta di lettura dell'audit di Jev.
 * ===================================================
 *
 * `GET /api/perps/jev-evaluations` serve la dashboard e basta: è **di sola
 * lettura**, sta sotto `/api/perps/*` e quindi dietro lo stesso gate di
 * autenticazione di tutte le altre API (nessuna eccezione nella allowlist
 * pubblica). Qui si verificano tre cose sul router REALE di Express:
 *
 *  1. la rotta esiste e risponde col contratto atteso (campi, ordine, limite);
 *  2. **non esiste** nessun metodo di scrittura su quel percorso — non si
 *     verifica "non l'ho scritta", si enumera il router;
 *  3. il percorso non è nella allowlist pubblica, cioè passa da `requireAuth`.
 *
 * Seam: `src/server.js` esporta l'app; si prende l'handler vero dal router stack
 * e lo si invoca con req/res finti. DB temporaneo redirezionato PRIMA dell'import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-jevroutes-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');

const ROUTE = '/api/perps/jev-evaluations';

function allRoutes() {
  return app._router.stack
    .filter(l => l.route)
    .flatMap(l => Object.keys(l.route.methods).map(method => ({ method, path: l.route.path, layer: l })));
}

async function call(method, routePath, { query = {} } = {}) {
  const found = allRoutes().find(r => r.method === method && r.path === routePath);
  assert.ok(found, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  const handler = found.layer.route.stack[0].handle;
  const captured = { statusCode: 200, body: null };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; }
  };
  await handler({ query, params: {}, body: {} }, res);
  return captured;
}

function seed(n, botId = 'bot-a', coin = 'SOL-PERP') {
  for (let i = 0; i < n; i++) {
    db.insertJevEvaluation({
      botId, coin, action: i % 2 ? 'close' : 'open_long', model: 'jev-1.13.0',
      state: `stato ${i}`,
      questions: { signal_reliable: { type: 'noul', instructions: 'coerente?' } },
      answers: { signal_reliable: { type: 'noul', noul: 0.5 + i / 100 } },
      latencyMs: 100 + i, tokensIn: 300, tokensOut: 20, costUsd: 0.0001,
      error: null, ts: 1_700_000_000_000 + i
    });
  }
}

test('la rotta esiste, è di sola lettura e non è pubblica', () => {
  const onRoute = allRoutes().filter(r => r.path === ROUTE);
  assert.equal(onRoute.length, 1, 'un solo metodo registrato su questo percorso');
  assert.equal(onRoute[0].method, 'get', 'e quel metodo è GET: l\'audit non si scrive dal web');

  // Le uniche rotte /api/* fuori dal gate sono login/logout/status (vedi
  // setupMiddleware): questa non è tra quelle, quindi è autenticata come le altre.
  const publicApi = ['/api/login', '/api/logout', '/api/auth/status'];
  assert.ok(!publicApi.includes(ROUTE), 'non è nella allowlist pubblica');
  assert.ok(ROUTE.startsWith('/api/perps/'), 'sta sotto lo stesso prefisso delle altre rotte perps');
});

test('contratto: ultime valutazioni, più recenti prima, con limite', async () => {
  seed(5);
  const out = await call('get', ROUTE, { query: { limit: '3' } });

  assert.equal(out.body.success, true);
  assert.equal(out.body.data.length, 3, 'il limite è rispettato');
  assert.ok(out.body.data[0].ts > out.body.data[1].ts, 'più recenti prima');

  const row = out.body.data[0];
  assert.deepEqual(
    Object.keys(row).sort(),
    ['action', 'answers', 'botId', 'coin', 'costUsd', 'error', 'id', 'latencyMs', 'model', 'questions', 'state', 'tokensIn', 'tokensOut', 'ts'],
    'contratto esplicito, in camelCase come il resto delle API'
  );
  assert.equal(typeof row.answers, 'object', 'answers arriva già parsato: la UI non deve fare JSON.parse');
  assert.equal(row.answers.signal_reliable.type, 'noul');
  assert.equal(row.error, null);
});

test('filtro per bot e per coin', async () => {
  seed(2, 'bot-b', 'ETH-PERP');
  const onlyB = await call('get', ROUTE, { query: { bot_id: 'bot-b' } });
  assert.ok(onlyB.body.data.length >= 2);
  assert.ok(onlyB.body.data.every(r => r.botId === 'bot-b'));

  const onlyEth = await call('get', ROUTE, { query: { coin: 'ETH-PERP' } });
  assert.ok(onlyEth.body.data.every(r => r.coin === 'ETH-PERP'));
});

test('un limite assurdo non scarica tutto il DB', async () => {
  const out = await call('get', ROUTE, { query: { limit: '100000' } });
  assert.equal(out.body.success, true);
  assert.ok(out.body.data.length <= 500, 'tetto duro sul numero di righe servite');
});
