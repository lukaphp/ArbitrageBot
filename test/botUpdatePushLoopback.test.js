/**
 * MCP-SYNC-02 · gli aggiornamenti autonomi del tick arrivano alla UI anche dal processo MCP.
 * =========================================================================================
 *
 * IL BUCO. `bot._emit()` chiama `botManager._onUpdate(getState())` alla fine di
 * ogni tick. `_onUpdate` emetteva su Socket.IO solo `if (this.io)` — e quando il
 * bot gira nel processo MCP Stdio (`botManager.loadFromDb()` in
 * `src/mcp/server.js`) quel processo NON ha nessun client Socket.IO, quindi `io`
 * è sempre `null` e l'update spariva senza traccia: niente eccezione, niente
 * log, solo una dashboard ferma. MCP-SYNC-01 aveva coperto i tool MCP che
 * MUTANO (bussano a `/internal/mcp/reload`), ma non i cambi di stato che il bot
 * decide da solo dentro il tick — nuova valutazione, apertura/chiusura da
 * segnale, TP/SL scattato, errore.
 *
 * PUNTO DI OSSERVAZIONE. La stessa scelta di MCP-SYNC-01, per la stessa ragione:
 * si guarda la RICHIESTA HTTP verso `/internal/mcp/bot-update`, non la funzione
 * che la fa. Spiare `postInternal` dall'esterno non intercetterebbe nulla
 * (`botManager` usa il binding importato), e un test sull'effetto a valle
 * passerebbe comunque perché qui Express e MCP sono lo stesso processo. Si
 * sostituisce quindi `http.request`, filtrando SOLO questo percorso e delegando
 * tutto il resto all'originale.
 *
 * I DUE RAMI VANNO TESTATI INSIEME. Il fix riguarda il ramo `io === null`; il
 * ramo con `io` presente deve restare identico a prima, POST inclusa (che non
 * deve esserci). Un test che guardasse solo il primo non accorgerebbe di un
 * doppio push.
 *
 * COSA NON COPRE. Non c'è nessun processo separato qui: la POST è simulata, non
 * attraversa davvero un socket, e la rotta viene invocata prendendo l'handler
 * dal router stack di Express (nessun `listen`, come in test/perfAggregations).
 * Il ponte reale tra DUE processi non è riproducibile in un test unitario —
 * quello che si verifica è che il chiamante bussi e che l'handler faccia la cosa
 * giusta con quello che riceve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `npm test` imposta PERPS_LOOPBACK_PUSH=0 per non far partire POST vere verso
// la porta 3000 dagli altri file di test (dove i bot nascono con `io` null e
// nessuno intercetta `http.request`). Qui il ponte è l'OGGETTO del test, quindi
// va riacceso — e l'intercettazione sotto garantisce che nessuna richiesta esca
// davvero. La variabile si legge a ogni chiamata, quindi impostarla qui basta.
process.env.PERPS_LOOPBACK_PUSH = '1';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-botpush-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { isInternalIp } = await import('../src/utils/internalLoopback.js');

botManager.bots.clear();

const ENDPOINT = '/internal/mcp/bot-update';

// ---------------------------------------------------------------------------
// Osservatorio sulla POST loopback.
// ---------------------------------------------------------------------------
const posts = [];
/** 200 = risposta automatica; null = la risposta la dà il test, a mano. */
let autoStatus = 200;
const originalRequest = http.request;
http.request = function (options, ...rest) {
  if (!options || typeof options !== 'object' || options.path !== ENDPOINT) {
    return originalRequest.call(this, options, ...rest);
  }
  const cb = rest.find(a => typeof a === 'function');
  const entry = { options, body: null, handlers: {}, done: false };
  entry.respond = (statusCode) => {
    if (entry.done) return;
    entry.done = true;
    if (cb) cb({ statusCode, resume: () => {} });
  };
  entry.fail = () => {
    if (entry.done) return;
    entry.done = true;
    entry.handlers.error?.(new Error('ECONNREFUSED'));
  };
  const req = {
    on(ev, fn) { entry.handlers[ev] = fn; return req; },
    destroy() { return req; },
    end(body) {
      entry.body = body;
      if (autoStatus !== null) setImmediate(() => entry.respond(autoStatus));
      return req;
    }
  };
  posts.push(entry);
  return req;
};

/** La POST non è attesa da nessuno: si drenano le microtask prima di guardare. */
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
const resetPosts = () => { posts.length = 0; botManager._forwardFailures = 0; };

/** Finto Socket.IO: registra cosa sarebbe arrivato ai browser. */
function fakeIo() {
  const emitted = [];
  return { emitted, emit: (event, payload) => emitted.push({ event, payload }) };
}

const stateOf = (id, action) => ({
  id,
  name: 'Bot Push',
  coin: 'PUSH-PERP',
  status: 'running',
  lastEval: action ? { action, reason: 'test' } : null,
  position: null
});

test('ramo io PRESENTE: emit diretto, nessuna POST loopback (non-regressione)', async () => {
  resetPosts();
  const io = fakeIo();
  botManager.io = io;
  try {
    botManager._onUpdate(stateOf('bot-io-1', 'hold'));
    await flush();

    assert.deepEqual(io.emitted.map(e => e.event), ['perps:botUpdate'],
      'su azione non operativa si emette solo botUpdate, come prima del fix');
    assert.equal(io.emitted[0].payload.id, 'bot-io-1');
    assert.equal(posts.length, 0,
      'con io presente NON deve partire nessuna POST: sarebbe un push doppio');

    // L'azione operativa aggiunge dashboardRefresh — regola invariata.
    io.emitted.length = 0;
    botManager._onUpdate(stateOf('bot-io-1', 'open_long'));
    await flush();
    assert.deepEqual(io.emitted.map(e => e.event), ['perps:botUpdate', 'perps:dashboardRefresh']);
    assert.deepEqual(io.emitted[1].payload, {
      reason: 'strategy_signal', botId: 'bot-io-1', action: 'open_long'
    });
    assert.equal(posts.length, 0);
  } finally {
    botManager.io = null;
  }
});

test('ramo io NULL: lo stato viene inoltrato al processo Express via loopback', async () => {
  resetPosts();
  botManager.io = null;

  const state = stateOf('bot-mcp-1', 'open_short');
  const returned = botManager._onUpdate(state);

  // Non-bloccante: `_onUpdate` non restituisce una Promise e la richiesta è già
  // partita quando il tick prosegue.
  assert.equal(returned, undefined, '_onUpdate non restituisce nulla da attendere');
  assert.equal(posts.length, 1, 'prima del fix qui non partiva niente: update perso in silenzio');

  const [post] = posts;
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.hostname, '127.0.0.1');
  assert.equal(post.options.path, ENDPOINT);
  assert.ok(post.options.timeout > 0 && post.options.timeout <= 3000,
    'timeout basso: il tick non può restare appeso a Express');

  const body = JSON.parse(post.body);
  assert.deepEqual(body.state, state, 'viaggia lo stato già calcolato, senza un secondo giro DB');

  await flush();
});

test('POST fallita: nessuna eccezione verso il tick, e un solo log per episodio', async () => {
  resetPosts();
  botManager.io = null;
  autoStatus = null; // risposta manuale
  try {
    // Tre tentativi falliti consecutivi su bot diversi (bot uguale verrebbe
    // saltato dal guard in-flight, che è l'oggetto del test successivo).
    for (const id of ['bot-fail-1', 'bot-fail-2', 'bot-fail-3']) {
      assert.doesNotThrow(() => botManager._onUpdate(stateOf(id, 'hold')));
      posts[posts.length - 1].fail();
      await flush();
    }
    assert.equal(posts.length, 3);
    assert.equal(botManager._forwardFailures, 3,
      'i fallimenti si contano (il log ne segnala solo il primo: episodio, non tentativo)');

    // Ripristino: il contatore torna a zero, così il prossimo episodio riloggherà.
    botManager._onUpdate(stateOf('bot-fail-1', 'hold'));
    posts[posts.length - 1].respond(200);
    await flush();
    assert.equal(botManager._forwardFailures, 0, 'consegna riuscita = episodio chiuso');

    // Un 4xx/5xx conta come fallimento quanto un socket rifiutato: la UI resta
    // ferma allo stesso modo.
    botManager._onUpdate(stateOf('bot-fail-2', 'hold'));
    posts[posts.length - 1].respond(403);
    await flush();
    assert.equal(botManager._forwardFailures, 1, 'una risposta non 2xx non è una consegna');
  } finally {
    autoStatus = 200;
  }
});

test('una sola POST in volo per bot: gli stati intermedi si saltano, non si accodano', async () => {
  resetPosts();
  botManager.io = null;
  autoStatus = null;
  try {
    botManager._onUpdate(stateOf('bot-flight', 'hold'));
    assert.equal(posts.length, 1);

    // Tick successivi mentre la prima è ancora in volo: nessuna coda.
    botManager._onUpdate(stateOf('bot-flight', 'hold'));
    botManager._onUpdate(stateOf('bot-flight', 'hold'));
    await flush();
    assert.equal(posts.length, 1, 'ogni payload è uno snapshot completo: vince l\'ultimo, non si accoda');

    // Un ALTRO bot non è bloccato da quello in volo.
    botManager._onUpdate(stateOf('bot-flight-altro', 'hold'));
    assert.equal(posts.length, 2, 'il guard è per bot, non globale');

    // Chiusa la prima, il bot torna a poter inoltrare.
    posts[0].respond(200);
    await flush();
    botManager._onUpdate(stateOf('bot-flight', 'hold'));
    assert.equal(posts.length, 3);
    posts[1].respond(200);
    posts[2].respond(200);
    await flush();
    assert.equal(botManager._forwardInFlight.size, 0, 'nessun bot resta marcato in volo per sempre');
  } finally {
    autoStatus = 200;
  }
});

test('PERPS_LOOPBACK_PUSH=0 spegne l\'inoltro (interruttore della sola suite di test)', async () => {
  resetPosts();
  botManager.io = null;
  process.env.PERPS_LOOPBACK_PUSH = '0';
  try {
    botManager._onUpdate(stateOf('bot-off', 'open_long'));
    await flush();
    assert.equal(posts.length, 0, 'con il ponte spento non deve uscire nessuna richiesta');
  } finally {
    process.env.PERPS_LOOPBACK_PUSH = '1';
  }
  // E riacceso torna a inoltrare: l\'interruttore non lascia strascichi.
  botManager._onUpdate(stateOf('bot-off', 'open_long'));
  await flush();
  assert.equal(posts.length, 1);
});

test('il callback di un PerpsBot reale è quello che inoltra (wiring, non solo la funzione)', async () => {
  resetPosts();
  botManager.io = null;
  const created = botManager.createBot({
    name: 'Bot Wiring', coin: 'WIRE-PERP', network: 'testnet',
    masterAddress: '0xWIRE', config: { paper: true, loopInterval: 3600000 }
  });
  const bot = botManager.bots.get(created.id);
  // `_emit()` è ciò che ogni tick chiama alla fine: si invoca quello, non il
  // tick intero, per non dipendere da mercato e broker.
  bot._emit();
  await flush();

  assert.equal(posts.length, 1, 'bot._emit() passa da botManager._onUpdate e finisce sul ponte');
  assert.equal(JSON.parse(posts[0].body).state.id, created.id);
  botManager.deleteBot(created.id);
});

// ---------------------------------------------------------------------------
// Lato server: la rotta interna.
// ---------------------------------------------------------------------------
function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function callEndpoint({ ip = '127.0.0.1', body = {} } = {}) {
  const handler = routeHandler('post', ENDPOINT);
  const captured = { statusCode: 200, body: null };
  await handler({ ip, socket: {}, body, query: {}, params: {} }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  return captured;
}

test('/internal/mcp/bot-update: emette ai browser esattamente come il ramo con io', async () => {
  const io = fakeIo();
  botManager.io = io;
  try {
    const state = stateOf('bot-route-1', 'close');
    const res = await callEndpoint({ body: { state } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, emitted: true });
    assert.deepEqual(io.emitted.map(e => e.event), ['perps:botUpdate', 'perps:dashboardRefresh'],
      'stesso insieme di eventi del percorso in-process: i due rami non devono divergere');
    assert.deepEqual(io.emitted[0].payload, state, 'lo stato arriva al browser così com\'è');
    assert.deepEqual(io.emitted[1].payload, {
      reason: 'strategy_signal', botId: 'bot-route-1', action: 'close'
    });

    // Azione non operativa: solo botUpdate, come in-process.
    io.emitted.length = 0;
    await callEndpoint({ body: { state: stateOf('bot-route-1', 'hold') } });
    assert.deepEqual(io.emitted.map(e => e.event), ['perps:botUpdate']);
  } finally {
    botManager.io = null;
  }
});

test('/internal/mcp/bot-update: stesso cancello IP di /internal/mcp/reload', async () => {
  const io = fakeIo();
  botManager.io = io;
  try {
    for (const ip of ['203.0.113.10', '10.0.0.4', '192.168.1.9', '']) {
      const res = await callEndpoint({ ip, body: { state: stateOf('bot-route-2', 'close') } });
      assert.equal(res.statusCode, 403, `IP ${ip || '(vuoto)'} deve essere respinto`);
      assert.equal(res.body.success, false);
    }
    assert.equal(io.emitted.length, 0, 'un IP respinto non emette nulla ai browser');

    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.17.0.3']) {
      const res = await callEndpoint({ ip, body: { state: stateOf('bot-route-2', 'hold') } });
      assert.equal(res.statusCode, 200, `IP ${ip} deve essere ammesso`);
    }
  } finally {
    botManager.io = null;
  }
});

test('/internal/mcp/bot-update: body senza stato utile = 400, non un emit a vuoto', async () => {
  const io = fakeIo();
  botManager.io = io;
  try {
    for (const body of [{}, { state: null }, { state: 'ciao' }, { state: { name: 'senza id' } }]) {
      const res = await callEndpoint({ body });
      assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)} deve essere rifiutato`);
    }
    assert.equal(io.emitted.length, 0);
  } finally {
    botManager.io = null;
  }
});

test('/internal/mcp/bot-update: senza client Socket.IO risponde 200 con emitted:false', async () => {
  botManager.io = null;
  const res = await callEndpoint({ body: { state: stateOf('bot-route-3', 'hold') } });
  assert.equal(res.statusCode, 200, 'non è un errore del chiamante: Express può non avere ancora client');
  assert.deepEqual(res.body, { success: true, emitted: false });
});

test('isInternalIp: la regola è una sola, condivisa da tutte le rotte interne', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.17.0.2', '172.31.255.1']) {
    assert.equal(isInternalIp(ip), true, `${ip} è interno`);
  }
  for (const ip of ['', null, undefined, '10.0.0.1', '192.168.0.1', '203.0.113.1', '1.172.0.1', '127.0.0.1.evil.com']) {
    assert.equal(isInternalIp(ip), false, `${ip} NON è interno`);
  }
});

test.after(() => {
  http.request = originalRequest;
  try { botManager.stopAll(); } catch { /* noop */ }
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
