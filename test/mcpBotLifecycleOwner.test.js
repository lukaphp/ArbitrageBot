/**
 * CRIT #7 · un solo processo possiede il tick loop (owner = Express).
 * ==================================================================
 *
 * IL DOPPIO ESECUTORE. Sul VPS il processo MCP Stdio (tenuto vivo dal watchdog
 * di Hermes) importa gli STESSI singleton del processo Express. Due percorsi
 * facevano nascere un tick loop LÌ, in parallelo a quello di Express, sulla
 * stessa riga `positions` e sullo stesso account paper:
 *
 *  1. `botManager.loadFromDb()` all'avvio di `src/mcp/server.js`: avvia da solo
 *     ogni bot con `status = 'running'` sul DB — senza che nessuno chieda niente;
 *  2. `bot_control('start')` via MCP: `botManager.startBot()` locale, mentre
 *     `notifyExpressReload()` lo fa partire ANCHE in Express.
 *
 * La prova sul campo è il `trailing_json` del 12/09 con `slOid` e `tpOids` mai
 * coesistiti nello stesso broker: due esecutori che piazzavano trigger a turno.
 *
 * COSA VERIFICA QUESTO FILE. Il processo MCP non esegue più: delega. Gli
 * osservabili sono due, e nessuno dei due è «la funzione X è stata chiamata»:
 *  - il LOOP LOCALE (`bot.status` / `bot.timer` dell'istanza in questo processo):
 *    dopo la delega deve restare fermo, altrimenti il secondo esecutore è ancora lì;
 *  - la RICHIESTA HTTP verso `/internal/mcp/bot-control`, intercettata come in
 *    MCP-SYNC-01/02 (spiare l'export non intercetta i chiamanti interni, che
 *    usano il binding locale).
 *
 * CONTROLLO DI RIFERIMENTO: ogni caso «processo MCP» ha il suo gemello nel ruolo
 * di default (Express), dove il comportamento deve restare identico a prima —
 * esecuzione locale e POST verso `/internal/mcp/reload`. Se l'osservatorio fosse
 * cieco, quei gemelli fallirebbero e il resto non varrebbe niente.
 *
 * COSA NON COPRE. Non ci sono due processi veri: la POST non attraversa un
 * socket. I due lati si verificano separatamente — il chiamante (che deve
 * bussare e non eseguire) e la rotta di Express (che deve eseguire davvero),
 * presa dal router stack senza `listen`, come in `botUpdatePushLoopback`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERPS_LOOPBACK_PUSH = '0'; // niente push autonomi del tick in mezzo

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-owner-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { declareProcessRole, getProcessRole, ownsTickLoop } = await import('../src/utils/processRole.js');
const { handleBotControl, handleGetSystemSnapshot, handleEmergencyShutdown } = await import('../src/mcp/tools.js');

// Nessuna rete dentro il tick: `_runTick` si ferma alla prima await e finisce
// nel suo catch. Quello che conta qui è se il loop ESISTE, non cosa valuta.
marketData.getSnapshot = async () => { throw new Error('mercato non disponibile nel test'); };

const CONTROL = '/internal/mcp/bot-control';
const STATES = '/internal/mcp/bot-states';
const RELOAD = '/internal/mcp/reload';

// ---------------------------------------------------------------------------
// Osservatorio sulle richieste interne. Nessuna esce davvero.
// ---------------------------------------------------------------------------
const calls = [];
/** Risposta che il finto Express dà: { status, body } oppure 'error' per irraggiungibile. */
let reply = { status: 200, body: { success: true } };
const originalRequest = http.request;
http.request = function (options, ...rest) {
  const p = options && typeof options === 'object' ? String(options.path || '') : '';
  if (!p.startsWith('/internal/')) return originalRequest.call(this, options, ...rest);
  const cb = rest.find(a => typeof a === 'function');
  const entry = { path: p, method: options.method, body: null, handlers: {} };
  calls.push(entry);
  const req = {
    on(ev, fn) { entry.handlers[ev] = fn; return req; },
    destroy() { return req; },
    end(body) {
      entry.body = body ? JSON.parse(body) : null;
      setImmediate(() => {
        if (reply === 'error') { entry.handlers.error?.(new Error('ECONNREFUSED')); return; }
        const payload = JSON.stringify(reply.body ?? {});
        const listeners = {};
        const res = {
          statusCode: reply.status,
          resume: () => {},
          setEncoding: () => {},
          on(ev, fn) { listeners[ev] = fn; return res; }
        };
        cb?.(res);
        setImmediate(() => { listeners.data?.(payload); listeners.end?.(); });
      });
      return req;
    }
  };
  return req;
};

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const reset = () => { calls.length = 0; reply = { status: 200, body: { success: true } }; };
const callsTo = (p) => calls.filter(c => c.path === p);

let seq = 0;
function makeBot({ status = 'stopped' } = {}) {
  const id = `owner-test-${Date.now()}-${seq++}`;
  db.insertBot({
    id, name: `Bot ${id}`, coin: 'SOL-PERP', network: 'testnet',
    masterAddress: '0x000000000000000000000000000000000000dEaD',
    config: { paper: true, loopInterval: 3600000 },
    status, linked_agent_id: 'hermes_agent_01', actor_label: 'Hermes',
    actor_id: 'hermes_agent_01', is_managed_by_agent: 1
  });
  return id;
}

/** Il bot sta davvero ticcando IN QUESTO processo? */
function localLoop(id) {
  const bot = botManager.bots.get(id);
  return { present: !!bot, status: bot?.status ?? null, timer: !!bot?.timer };
}

test.beforeEach(() => { declareProcessRole('express'); reset(); });
test.afterEach(async () => {
  declareProcessRole('express');
  for (const bot of botManager.bots.values()) bot.stop();
  await flush();
  botManager.bots.clear();
});

test('ruolo di default: owner del tick loop, nessuna delega (controllo di riferimento)', () => {
  assert.equal(getProcessRole(), 'express');
  assert.equal(ownsTickLoop(), true,
    'chi non si dichiara esegue in locale: un default che delega manderebbe Express a bussare a sé stesso');
});

test('processo MCP: bot_control(start) DELEGA e non apre un secondo loop qui', async () => {
  const id = makeBot();
  botManager.loadFromDb();
  declareProcessRole('mcp_stdio');
  reply = { status: 200, body: { success: true, result: 'started', state: { id, name: 'Bot', status: 'running' } } };

  const res = await handleBotControl({ bot_id: id, action: 'start' });
  await flush();

  assert.equal(res.success, true);
  assert.equal(res.data.status, 'running', 'lo stato torna da chi esegue davvero, non da una finzione locale');

  const posted = callsTo(CONTROL);
  assert.equal(posted.length, 1, 'una sola richiesta al processo che possiede il loop');
  assert.deepEqual(posted[0].body, { bot_id: id, action: 'start' });
  assert.equal(posted[0].method, 'POST');

  const loop = localLoop(id);
  assert.equal(loop.status, 'stopped', 'PRIMA DEL FIX qui il bot risultava running: era il secondo esecutore');
  assert.equal(loop.timer, false, 'nessun timer di tick avviato in questo processo');
  assert.equal(callsTo(RELOAD).length, 0,
    'delegando non serve anche il reload: Express ha appena eseguito l\'azione e lo sa già');
});

test('processo Express: stessa chiamata, esecuzione locale (comportamento invariato)', async () => {
  const id = makeBot();
  botManager.loadFromDb();

  const res = await handleBotControl({ bot_id: id, action: 'start' });
  await flush();

  assert.equal(res.success, true);
  assert.equal(res.data.status, 'running');
  const loop = localLoop(id);
  assert.equal(loop.status, 'running', 'chi possiede il loop lo avvia davvero');
  assert.equal(loop.timer, true);
  assert.equal(callsTo(CONTROL).length, 0, 'nessuna delega: sarebbe Express che bussa a sé stesso');
  assert.equal(callsTo(RELOAD).length, 1, 'il ponte di MCP-SYNC-01 resta dov\'era');
});

test('processo MCP: stop e restart passano dalla stessa delega', async () => {
  const id = makeBot({ status: 'running' });
  declareProcessRole('mcp_stdio');
  botManager.loadFromDb(); // nel processo MCP il bot è caricato ma fermo

  reply = { status: 200, body: { success: true, result: 'stopped', state: { id, status: 'stopped' } } };
  const stop = await handleBotControl({ bot_id: id, action: 'stop' });
  assert.equal(stop.success, true);
  assert.equal(stop.data.status, 'stopped');

  reply = { status: 200, body: { success: true, result: 'restarted', state: { id, status: 'running' } } };
  const restart = await handleBotControl({ bot_id: id, action: 'restart' });
  await flush();

  assert.equal(restart.success, true);
  assert.deepEqual(callsTo(CONTROL).map(c => c.body.action), ['stop', 'restart']);
  assert.equal(localLoop(id).timer, false, 'nemmeno il restart accende un loop in questo processo');
});

test('processo MCP con Express irraggiungibile: errore esplicito, non un successo finto', async () => {
  const id = makeBot();
  botManager.loadFromDb();
  declareProcessRole('mcp_stdio');
  reply = 'error';

  const res = await handleBotControl({ bot_id: id, action: 'start' });
  await flush();

  assert.equal(res.success, false, 'un successo locale qui divergerebbe di nuovo dal processo che esegue');
  assert.match(res.message, /non .*(raggiungibile|eseguit)/i,
    `il messaggio deve dire che l'azione NON è stata eseguita — ricevuto: ${res.message}`);
  assert.equal(localLoop(id).timer, false, 'e soprattutto: nessun ripiego che avvii il loop qui');
});

test('processo MCP: Express risponde con un errore applicativo → l\'errore arriva a Hermes', async () => {
  const id = makeBot();
  botManager.loadFromDb();
  declareProcessRole('mcp_stdio');
  reply = { status: 404, body: { success: false, error: 'Bot non trovato' } };

  const res = await handleBotControl({ bot_id: id, action: 'start' });
  await flush();

  assert.equal(res.success, false);
  assert.match(res.message, /Bot non trovato/);
});

test('avvio del processo MCP: loadFromDb NON fa partire i bot che il DB dà per running', async () => {
  const id = makeBot({ status: 'running' });

  declareProcessRole('mcp_stdio');
  botManager.bots.clear();
  botManager.loadFromDb();
  await flush();

  const loop = localLoop(id);
  assert.equal(loop.present, true, 'il bot resta leggibile in memoria (snapshot, config, guardrail)');
  assert.equal(loop.status, 'stopped', 'PRIMA DEL FIX partiva qui in automatico: il doppio esecutore nasceva senza che nessuno chiedesse niente');
  assert.equal(loop.timer, false);
  assert.equal(db.getBot(id).status, 'running', 'e il DB non viene toccato: il bot è running, semplicemente non qui');

  // Controllo di riferimento: nel processo owner lo stesso codice avvia davvero.
  declareProcessRole('express');
  botManager.bots.clear();
  botManager.loadFromDb();
  await flush();
  assert.equal(localLoop(id).timer, true, 'in Express il resume automatico resta quello di sempre');
});

test('processo MCP: il watchdog non parte (non ha bot da sorvegliare qui)', () => {
  declareProcessRole('mcp_stdio');
  botManager.watchdogTimer = null;
  botManager.startWatchdog();
  assert.equal(botManager.watchdogTimer, null,
    'sorvegliare bot che girano in un altro processo produrrebbe solo falsi crash');

  declareProcessRole('express');
  botManager.startWatchdog();
  assert.ok(botManager.watchdogTimer, 'in Express il watchdog resta acceso');
  clearInterval(botManager.watchdogTimer);
  botManager.watchdogTimer = null;
});

test('processo MCP: get_system_snapshot legge lo stato da chi esegue, non dalla propria memoria', async () => {
  const id = makeBot({ status: 'running' });
  declareProcessRole('mcp_stdio');
  botManager.bots.clear();
  botManager.loadFromDb(); // qui i bot NON girano: la memoria locale direbbe 'stopped'
  reply = { status: 200, body: { success: true, states: [{ id, name: 'Bot', coin: 'SOL-PERP', status: 'running', lastEval: { action: 'hold' } }] } };

  const res = await handleGetSystemSnapshot();
  await flush();

  assert.equal(res.success, true);
  assert.equal(callsTo(STATES).length, 1, 'lo stato si chiede al processo che esegue');
  assert.equal(res.data.system_health.active_bots, 1,
    'dire a Hermes "0 bot attivi" mentre Express ne fa girare uno è la bugia peggiore di tutte');
  assert.equal(res.data.bots[0].last_eval_action, 'hold', 'e arriva anche ciò che sta solo in memoria dell\'altro processo');
  assert.ok(!res.data.alerts.some(a => a.type === 'bot_states_degraded'));
});

test('processo MCP con Express giù: lo snapshot degrada al DB e lo DICHIARA', async () => {
  const id = makeBot({ status: 'running' });
  declareProcessRole('mcp_stdio');
  botManager.bots.clear();
  botManager.loadFromDb();
  reply = 'error';

  const res = await handleGetSystemSnapshot();
  await flush();

  assert.equal(res.success, true, 'perdere l\'osservabilità del tutto sarebbe peggio');
  assert.equal(res.data.system_health.active_bots, 1, 'lo status viene dal DB, che è condiviso');
  assert.equal(res.data.bots[0].id, id);
  const alert = res.data.alerts.find(a => a.type === 'bot_states_degraded');
  assert.ok(alert, 'il degrado va dichiarato: senza, Hermes crede di avere una fotografia completa');
  assert.match(alert.message, /DB/i);
});

test('processo MCP: emergency_shutdown ferma i bot su Express e conta solo quelli fermati davvero', async () => {
  const id = makeBot({ status: 'running' });
  declareProcessRole('mcp_stdio');
  botManager.bots.clear();
  botManager.loadFromDb();
  reply = { status: 200, body: { success: true, result: 'stopped', state: { id, status: 'stopped' } } };

  const res = await handleEmergencyShutdown({ confirm: true });
  await flush();

  assert.equal(res.success, true);
  assert.deepEqual(callsTo(CONTROL).map(c => c.body), [{ bot_id: id, action: 'stop' }],
    'i bot da fermare si leggono dal DB: in questo processo non ce n\'è nessuno in esecuzione');
  assert.equal(res.data.stopped_bots_count, 1);
  assert.equal(db.getSetting('killswitch'), 'on');
});

test('processo MCP: emergency_shutdown con Express giù NON dichiara i bot fermati', async () => {
  const id = makeBot({ status: 'running' });
  declareProcessRole('mcp_stdio');
  botManager.bots.clear();
  botManager.loadFromDb();
  reply = 'error';

  const res = await handleEmergencyShutdown({ confirm: true });
  await flush();

  assert.equal(res.success, false, 'il kill-switch è attivo ma i bot girano ancora: non è un successo');
  assert.equal(res.data.stopped_bots_count, 0);
  assert.deepEqual(res.data.failed_bot_ids, [id]);
  assert.match(res.message, /kill-switch/i);
  assert.equal(db.getSetting('killswitch'), 'on', 'il kill-switch resta attivo: è l\'unica cosa che ha davvero effetto cross-processo');
});

// ---------------------------------------------------------------------------
// L'altro lato del ponte: la rotta di Express.
// ---------------------------------------------------------------------------
function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function callRoute(routePath, { ip = '127.0.0.1', body = {} } = {}) {
  const handler = routeHandler('post', routePath);
  const captured = { statusCode: 200, body: null };
  await handler({ ip, socket: {}, body, query: {}, params: {} }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  return captured;
}

test('/internal/mcp/bot-control: Express esegue davvero e risponde con lo stato reale', async () => {
  const id = makeBot();
  botManager.loadFromDb();

  const started = await callRoute(CONTROL, { body: { bot_id: id, action: 'start' } });
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.success, true);
  assert.equal(started.body.result, 'started');
  assert.equal(started.body.state.status, 'running');
  assert.equal(localLoop(id).timer, true, 'il loop nasce QUI, che è il punto del fix');

  // Idempotenza dichiarata: "era già così" non è "l'ho fatto adesso".
  const again = await callRoute(CONTROL, { body: { bot_id: id, action: 'start' } });
  assert.equal(again.body.result, 'already_running');

  const stopped = await callRoute(CONTROL, { body: { bot_id: id, action: 'stop' } });
  assert.equal(stopped.body.result, 'stopped');
  assert.equal(localLoop(id).timer, false);
});

test('/internal/mcp/bot-control: un bot mai caricato viene preso dal DB senza toccare gli altri', async () => {
  const running = makeBot({ status: 'running' });
  botManager.loadFromDb();
  const before = botManager.bots.get(running);
  assert.equal(before.status, 'running');

  const nuovo = makeBot(); // inserito nel DB dopo il load: non è in memoria
  assert.equal(botManager.bots.has(nuovo), false);

  const res = await callRoute(CONTROL, { body: { bot_id: nuovo, action: 'start' } });
  assert.equal(res.body.success, true);
  assert.equal(botManager.bots.get(running), before,
    'l\'istanza già in esecuzione non va sostituita: ricaricare TUTTO abbandonerebbe il suo timer, cioè un altro loop orfano');
});

test('/internal/mcp/bot-control: cancello IP, azione e bot inesistente', async () => {
  const id = makeBot();
  botManager.loadFromDb();

  for (const ip of ['203.0.113.10', '10.0.0.4', '192.168.1.9', '']) {
    const res = await callRoute(CONTROL, { ip, body: { bot_id: id, action: 'start' } });
    assert.equal(res.statusCode, 403, `IP ${ip || '(vuoto)'} respinto`);
  }
  assert.equal(localLoop(id).timer, false, 'una richiesta respinta non esegue nulla');

  const bad = await callRoute(CONTROL, { body: { bot_id: id, action: 'delete-all' } });
  assert.equal(bad.statusCode, 400);

  const missing = await callRoute(CONTROL, { body: { bot_id: 'non-esiste', action: 'start' } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.success, false);
});

test('/internal/mcp/bot-states: restituisce gli stati veri di Express, stesso cancello IP', async () => {
  const id = makeBot();
  botManager.loadFromDb();
  await callRoute(CONTROL, { body: { bot_id: id, action: 'start' } });

  const res = await callRoute(STATES, { body: {} });
  assert.equal(res.statusCode, 200);
  const mine = res.body.states.find(s => s.id === id);
  assert.ok(mine && mine.status === 'running');

  const denied = await callRoute(STATES, { ip: '203.0.113.10', body: {} });
  assert.equal(denied.statusCode, 403);
});

test.after(() => {
  http.request = originalRequest;
  declareProcessRole('express');
  try { botManager.stopAll(); } catch { /* noop */ }
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
