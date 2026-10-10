/**
 * ISSUE #74 · il cancello di `/internal/*` guarda il peer TCP, non `req.ip`.
 * ========================================================================
 *
 * IL BUCO. Le rotte `/internal/mcp/*` non hanno login: le protegge solo chi
 * riesce a connettersi. Il controllo usava `req.ip`, che con `trust proxy 1`
 * viene dall'`X-Forwarded-For` scritto da Caddy — e ammetteva anche `172.*`.
 * Dietro `tailscale serve` → porta pubblicata → proxy Docker, il peer che Caddy
 * vede è il gateway 172.x: dalla tailnet, passando da Caddy, si poteva avviare
 * e fermare bot o piazzare ordini paper senza login. Lo stesso per qualunque
 * container sulla rete `web`.
 *
 * COSA SI VERIFICA.
 *  - Su TUTTE e cinque le rotte interne, un socket 172.x viene respinto anche se
 *    `req.ip` e `X-Forwarded-For` dicono 127.0.0.1 (handler reali presi dal
 *    router stack, come in test/botUpdatePushLoopback).
 *  - Con l'app VERA in ascolto e `trust proxy` attivo: una connessione loopback
 *    passa anche se l'`X-Forwarded-For` dice 172.x (conta il socket, non
 *    l'intestazione); una connessione da un'interfaccia NON loopback di questa
 *    macchina viene respinta anche con `X-Forwarded-For: 127.0.0.1`. Questo
 *    secondo caso dipende dall'avere un'interfaccia di rete non loopback: senza,
 *    il test viene saltato e lo dice.
 *
 * Le richieste vere vanno solo a `bot-states`, che è in sola lettura.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-internal-gate-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { isLoopbackAddress, isLoopbackRequest } = await import('../src/utils/internalLoopback.js');

botManager.bots.clear();

const ROUTES = [
  '/internal/mcp/reload',
  '/internal/mcp/bot-update',
  '/internal/mcp/bot-control',
  '/internal/mcp/place-order-paper',
  '/internal/mcp/bot-states'
];

function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function callRoute(routePath, req) {
  const captured = { statusCode: 200, body: null };
  await routeHandler('post', routePath)({ query: {}, params: {}, headers: {}, ...req }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  return captured;
}

/** POST vera verso l'app in ascolto; `host` è l'indirizzo a cui connettersi. */
function post(port, host, routePath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path: routePath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2, ...headers }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('isLoopbackRequest legge il socket e ignora req.ip e X-Forwarded-For', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, ip: '172.18.0.3' }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopbackRequest({
    socket: { remoteAddress: '172.18.0.3' }, ip: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1' }
  }), false, 'un X-Forwarded-For loopback non apre il cancello');
  assert.equal(isLoopbackRequest({ ip: '127.0.0.1' }), false, 'senza socket non si ammette nulla');
  assert.equal(isLoopbackRequest({ socket: {} }), false);
  assert.equal(isLoopbackRequest(undefined), false);
  assert.equal(isLoopbackAddress('::ffff:172.18.0.3'), false);
});

test('tutte le rotte /internal/*: socket 172.x respinto anche se req.ip e XFF dicono loopback', async () => {
  const io = { emitted: [], emit(event, payload) { this.emitted.push({ event, payload }); } };
  botManager.io = io;
  try {
    for (const route of ROUTES) {
      const res = await callRoute(route, {
        ip: '127.0.0.1',
        headers: { 'x-forwarded-for': '127.0.0.1' },
        socket: { remoteAddress: '172.18.0.3' },
        body: { bot_id: 'gate-test', action: 'start', side: 'long', size: 1, state: { id: 'gate-test' } }
      });
      assert.equal(res.statusCode, 403, `${route} deve respingere il socket 172.18.0.3`);
      assert.equal(res.body.success, false);
    }
    assert.equal(io.emitted.length, 0, 'una richiesta respinta non emette nulla ai browser');
  } finally {
    botManager.io = null;
  }
});

test('tutte le rotte /internal/*: socket loopback ammesso anche se req.ip è 172.x', async () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    // `bot-states` in sola lettura basta a dimostrare che il cancello si apre;
    // le altre rotte con un loopback sono coperte dai loro test dedicati.
    const res = await callRoute('/internal/mcp/bot-states', {
      ip: '172.18.0.3', socket: { remoteAddress }, body: {}
    });
    assert.equal(res.statusCode, 200, `socket ${remoteAddress} ammesso`);
    assert.equal(res.body.success, true);
  }
});

test('app vera con trust proxy: conta il peer TCP, non X-Forwarded-For', async (t) => {
  assert.equal(app.get('trust proxy'), 1, 'il test ha senso solo con trust proxy attivo, come in produzione');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const { port } = server.address();
  try {
    // Loopback vero con un XFF che, letto da `req.ip`, sarebbe la rete Docker.
    const viaLoopback = await post(port, '127.0.0.1', '/internal/mcp/bot-states', { 'X-Forwarded-For': '172.18.0.3' });
    assert.equal(viaLoopback.status, 200);
    assert.equal(viaLoopback.body.success, true);

    // Un'interfaccia non loopback di questa macchina: il peer TCP NON è loopback.
    const external = Object.values(os.networkInterfaces()).flat()
      .find(i => i && i.family === 'IPv4' && !i.internal);
    if (!external) {
      t.skip('nessuna interfaccia IPv4 non loopback: caso socket esterno non verificabile qui');
      return;
    }
    let viaLan;
    try {
      viaLan = await post(port, external.address, '/internal/mcp/bot-states', { 'X-Forwarded-For': '127.0.0.1' });
    } catch (err) {
      t.skip(`connessione a ${external.address} non riuscita (${err.code || err.message}): caso non verificabile qui`);
      return;
    }
    assert.equal(viaLan.status, 403,
      `peer ${external.address} con X-Forwarded-For: 127.0.0.1 deve essere respinto`);
    assert.equal(viaLan.body.success, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => {
  try { botManager.stopAll(); } catch { /* noop */ }
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
