/**
 * ISSUE #27 (e con essa la causa residua di #26) — `place_order_paper` mutava il
 * paperBroker dal processo MCP Stdio.
 * ===========================================================================
 *
 * La Parte 1 del fix di #7 ha dato a Express la proprietà esclusiva del TICK
 * LOOP: il processo MCP non avvia più bot, delega. Restava fuori una scrittura:
 * `place_order_paper` chiamava `paperBroker.placeMarketOrder` nel processo che lo
 * eseguiva. Se quel processo è MCP Stdio, quella è una SECONDA sorgente di
 * scritture sulla stessa coppia (account, coin) — ed è esattamente ciò che rende
 * il merge di `_save()` un last-writer-wins (#26): il merge fonde per coin, ma su
 * una coin toccata da due processi nella stessa finestra non ha modo di decidere
 * chi ha ragione.
 *
 * COSA VERIFICA QUESTO FILE, e con quale osservabile. Non «la funzione di delega
 * è stata chiamata», che non dimostra niente: i due osservabili sono
 *  - la RICHIESTA HTTP verso `/internal/mcp/place-order-paper` (spiare l'export
 *    non intercetta i chiamanti interni, che usano il binding locale — stesso
 *    seam di MCP-SYNC-01/02 e `mcpBotLifecycleOwner`);
 *  - lo STATO DEL paperBroker LOCALE, che nel ruolo MCP deve restare INVARIATO.
 *    È l'osservabile che conta davvero: se la posizione appare nel broker di
 *    questo processo, la scrittura è avvenuta qui e il difetto è ancora lì.
 *
 * CONTROLLO DI RIFERIMENTO: ogni caso «processo MCP» ha il suo gemello nel ruolo
 * Express, dove la scrittura deve avvenire davvero in locale. Se l'osservatorio
 * fosse cieco quei gemelli fallirebbero e il resto non varrebbe niente.
 *
 * LA SCELTA DI DESIGN CHE QUESTO FILE INCHIODA: Express non raggiungibile =
 * RIFIUTO, non ripiego locale. Una LETTURA (`readBotStates`) degrada al DB e lo
 * dichiara; una SCRITTURA no — il ripiego sarebbe proprio il difetto da
 * eliminare. Un ordine non eseguito si ritenta; uno stato simulato corrotto da
 * due scritture concorrenti no, e non lascia traccia da cui accorgersene.
 *
 * COSA NON COPRE. Non ci sono due processi veri: la POST non attraversa un
 * socket. I due lati si verificano separatamente — il chiamante (che deve bussare
 * e non scrivere) e la rotta di Express (che deve scrivere davvero), presa dal
 * router stack senza `listen`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERPS_LOOPBACK_PUSH = '0';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-paperowner-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: paperBroker } = await import('../src/perps/paperBroker.js');
const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { declareProcessRole, ROLE_EXPRESS, ROLE_MCP_STDIO } = await import('../src/utils/processRole.js');
const { handlePlaceOrderPaper, placeOrderPaperLocal, PAPER_MASTER } = await import('../src/mcp/tools.js');

marketData.getSnapshot = async () => { throw new Error('mercato non disponibile nel test'); };
client.getMid = async () => 100;

const ROUTE = '/internal/mcp/place-order-paper';

// --- Intercetta l'intero prefisso /internal/, delegando all'originale il resto ---
const realRequest = http.request;
let intercepted = [];
/** Risposta che la finta Express restituisce; `null` = simula "non raggiungibile". */
let fakeReply = { success: true, message: 'eseguito da Express', data: { order_id: 42 } };
let fakeStatus = 200;

http.request = function (options, cb) {
  const p = typeof options === 'string' ? options : options?.path || '';
  if (!String(p).startsWith('/internal/')) return realRequest.apply(this, arguments);

  let body = '';
  const req = {
    on(ev, h) { if (ev === 'error' && fakeReply === null) setImmediate(() => h(new Error('ECONNREFUSED'))); return req; },
    write(chunk) { body += chunk; return true; },
    // `internalLoopback` usa `req.end(body)`, non `write()` + `end()`: se il fake
    // ignorasse l'argomento il corpo arriverebbe vuoto e l'assert «gli argomenti
    // arrivano intatti» misurerebbe il fake, non il codice.
    end(chunk) {
      if (chunk) body += chunk;
      if (fakeReply === null) return; // nessuna risposta: il timeout/errore arriva da `on('error')`
      intercepted.push({ path: p, body: JSON.parse(body || '{}') });
      const payload = JSON.stringify(fakeReply);
      const res = {
        statusCode: fakeStatus,
        setEncoding() {},
        resume() {},
        on(ev, h) {
          if (ev === 'data') h(payload);
          if (ev === 'end') setImmediate(h);
          return res;
        }
      };
      setImmediate(() => cb(res));
    },
    destroy() {},
    setTimeout() { return req; }
  };
  return req;
};

function seedBot(id, coin) {
  db.insertBot({
    id, name: `bot ${id}`, coin, network: 'testnet', masterAddress: PAPER_MASTER,
    config: { paper: true, leverage: 1, maxPositionUsd: 100000, risk: { maxPositionUsd: 100000 } },
    status: 'stopped', maxAllocationUsd: 100000, actorLabel: 'test', actorId: 'test'
  });
}

/** Posizioni del paperBroker LOCALE a questo processo, senza far scattare trigger. */
async function localPositions() {
  const acc = await paperBroker.peekAccount(PAPER_MASTER, 'testnet');
  return acc?.positions || [];
}

function reset() {
  intercepted = [];
  fakeReply = { success: true, message: 'eseguito da Express', data: { order_id: 42 } };
  fakeStatus = 200;
}

// ===========================================================================
// RUOLO MCP STDIO — deve DELEGARE e non scrivere
// ===========================================================================

test('ruolo MCP: l\'ordine paper NON muta il broker locale e bussa a Express', async () => {
  reset();
  seedBot('own-mcp-1', 'OWN1-PERP');
  declareProcessRole(ROLE_MCP_STDIO);
  try {
    const before = (await localPositions()).length;
    const out = await handlePlaceOrderPaper({ bot_id: 'own-mcp-1', side: 'long', size: 1 });

    assert.equal(out.success, true, `delega fallita: ${out.message}`);
    assert.equal(out.delegated, true, 'la risposta deve dichiarare che ha delegato');

    // Osservabile 1: la richiesta HTTP verso Express.
    assert.equal(intercepted.length, 1, `una sola POST attesa, ricevute ${intercepted.length}`);
    assert.equal(intercepted[0].path, ROUTE);
    assert.equal(intercepted[0].body.bot_id, 'own-mcp-1', 'gli argomenti devono arrivare intatti');
    assert.equal(intercepted[0].body.side, 'long');

    // Osservabile 2 — quello che conta: nessuna scrittura QUI.
    const after = await localPositions();
    assert.equal(after.length, before,
      `il paperBroker LOCALE è stato mutato: ${JSON.stringify(after.map(p => p.coin))}`);
    assert.equal(after.filter(p => p.coin === 'OWN1-PERP').length, 0);
  } finally { declareProcessRole(ROLE_EXPRESS); }
});

test('ruolo MCP: Express non raggiungibile → RIFIUTO esplicito, nessuna scrittura locale', async () => {
  reset();
  fakeReply = null; // ECONNREFUSED
  seedBot('own-mcp-2', 'OWN2-PERP');
  declareProcessRole(ROLE_MCP_STDIO);
  try {
    const out = await handlePlaceOrderPaper({ bot_id: 'own-mcp-2', side: 'long', size: 1 });

    assert.equal(out.success, false, 'un ordine non eseguito non è un successo');
    assert.match(out.message, /NON è stato eseguito in nessun processo/i,
      `il messaggio deve dire che nessun ordine è partito: ${out.message}`);

    // LA PROPRIETÀ CENTRALE: nessun ripiego locale. Sarebbe il difetto stesso.
    const after = await localPositions();
    assert.equal(after.filter(p => p.coin === 'OWN2-PERP').length, 0,
      'ripiego locale: è esattamente la seconda sorgente di scritture che #26 descrive');
    // …e nemmeno una riga di trade, che segnalerebbe un\'esecuzione avvenuta qui.
    assert.equal(db.listTradesBy ? db.listTradesBy('own-mcp-2').length : 0, 0);
  } finally { declareProcessRole(ROLE_EXPRESS); }
});

test('ruolo MCP: Express risponde HTTP non-2xx senza corpo → esito IGNOTO, non successo', async () => {
  reset();
  fakeStatus = 500;
  fakeReply = null;
  seedBot('own-mcp-3', 'OWN3-PERP');
  declareProcessRole(ROLE_MCP_STDIO);
  try {
    const out = await handlePlaceOrderPaper({ bot_id: 'own-mcp-3', side: 'long', size: 1 });
    assert.equal(out.success, false);
    const after = await localPositions();
    assert.equal(after.filter(p => p.coin === 'OWN3-PERP').length, 0);
  } finally { declareProcessRole(ROLE_EXPRESS); }
});

test('ruolo MCP: un RIFIUTO di guardrail deciso da Express arriva intatto al chiamante', async () => {
  reset();
  // La rotta risponde 200 con `success: false`: l'esito dell'ORDINE non è
  // l'esito della RICHIESTA, e il chiamante deve poterli distinguere.
  fakeReply = { success: false, error: 'GUARDRAIL_VIOLATION: coin in blacklist', message: 'GUARDRAIL_VIOLATION: coin in blacklist' };
  seedBot('own-mcp-4', 'OWN4-PERP');
  declareProcessRole(ROLE_MCP_STDIO);
  try {
    const out = await handlePlaceOrderPaper({ bot_id: 'own-mcp-4', side: 'long', size: 1 });
    assert.equal(out.success, false);
    assert.match(out.message, /GUARDRAIL_VIOLATION/, 'il motivo vero non deve essere riscritto');
  } finally { declareProcessRole(ROLE_EXPRESS); }
});

// ===========================================================================
// RUOLO EXPRESS — controllo di riferimento: qui la scrittura AVVIENE
// ===========================================================================

test('CONTROLLO — ruolo Express: l\'ordine si esegue in locale e NON bussa a nessuno', async () => {
  reset();
  seedBot('own-exp-1', 'OWNX-PERP');
  declareProcessRole(ROLE_EXPRESS);

  const out = await handlePlaceOrderPaper({ bot_id: 'own-exp-1', side: 'long', size: 1 });
  assert.equal(out.success, true, `esecuzione locale fallita: ${out.message}`);
  assert.notEqual(out.delegated, true);

  const after = await localPositions();
  assert.equal(after.filter(p => p.coin === 'OWNX-PERP').length, 1,
    'nel ruolo Express la posizione DEVE comparire: senza, l\'osservatorio è cieco e gli altri casi non valgono');
  assert.equal(intercepted.filter(i => i.path === ROUTE).length, 0,
    'Express non deve bussare a sé stesso');
});

// ===========================================================================
// LA ROTTA di Express: esegue davvero, e non delega a sua volta
// ===========================================================================

function route(method, p) {
  const layer = app._router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${p} non trovata nel router`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeRes() {
  const out = { statusCode: 200, body: null };
  out.status = (c) => { out.statusCode = c; return out; };
  out.json = (b) => { out.body = b; return out; };
  return out;
}

test('ROTTA: esegue l\'ordine in locale anche se il ruolo dichiarato è MCP', async () => {
  // Il punto: la rotta chiama `placeOrderPaperLocal`, non il guscio. Se chiamasse
  // il guscio, con il ruolo MCP dichiarato si metterebbe a bussare a sé stessa —
  // un anello chiuso che dipenderebbe dal default di `processRole` per non
  // chiudersi. Qui il ruolo è forzato a MCP proprio per provarlo.
  reset();
  seedBot('own-route-1', 'OWNR-PERP');
  declareProcessRole(ROLE_MCP_STDIO);
  try {
    const res = fakeRes();
    await route('post', ROUTE)(
      { ip: '127.0.0.1', body: { bot_id: 'own-route-1', side: 'long', size: 1 } }, res
    );
    assert.equal(res.body.success, true, `la rotta non ha eseguito: ${JSON.stringify(res.body)}`);
    assert.equal(intercepted.filter(i => i.path === ROUTE).length, 0,
      'la rotta ha delegato a sé stessa: anello chiuso');
    const after = await localPositions();
    assert.equal(after.filter(p => p.coin === 'OWNR-PERP').length, 1,
      'la rotta deve scrivere davvero sul paperBroker di questo processo');
  } finally { declareProcessRole(ROLE_EXPRESS); }
});

test('ROTTA: chiusa agli IP non loopback, come le altre /internal/*', async () => {
  const res = fakeRes();
  await route('post', ROUTE)({ ip: '8.8.8.8', body: { bot_id: 'x', side: 'long', size: 1 } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test('ROTTA: i guardrail restano applicati — non è una scorciatoia che li salta', async () => {
  // Un bot inesistente è il rifiuto più semplice da provocare senza dipendere
  // dalla configurazione di blacklist/velocity: basta a dimostrare che la rotta
  // passa dai controlli di `placeOrderPaperLocal` invece di scrivere diretto.
  reset();
  const res = fakeRes();
  await route('post', ROUTE)({ ip: '127.0.0.1', body: { bot_id: 'non-esiste', side: 'long', size: 1 } }, res);
  assert.equal(res.statusCode, 200, 'un guardrail che rifiuta è una risposta valida, non un guasto HTTP');
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Bot non trovato/i);
});

test('ROTTA: `placeOrderPaperLocal` è esportata e non è il guscio', async () => {
  assert.equal(typeof placeOrderPaperLocal, 'function');
  assert.notEqual(placeOrderPaperLocal, handlePlaceOrderPaper,
    'se fossero la stessa funzione la rotta potrebbe delegare a sé stessa');
});
