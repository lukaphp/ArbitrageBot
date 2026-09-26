/**
 * ISSUE #55 — la stessa chiusura fittizia di CRIT-CLOSEFAKE-25, negli ALTRI chiamanti.
 * ===================================================================================
 *
 * PR #54 ha corretto `bot._closeNow`, l'unico chiamante coinvolto nell'incidente
 * NEAR-PERP del 25/09/2026, introducendo `riskManager.interpretCloseResult`. Gli
 * altri punti che chiamano `closePosition` non erano stati toccati e avevano la
 * stessa classe di difetto: dare per eseguita una chiusura che l'exchange ha
 * rifiutato, perché su un book sottile il limit IoC non LANCIA — RISOLVE con
 * `{status:'ok', oid:null, totalSz:null, error:'could not immediately match…'}`.
 *
 * I punti coperti qui sono CINQUE, non i quattro elencati nell'issue: il percorso
 * kill-switch di `POST /api/perps/killswitch` è un quinto chiamante con lo stesso
 * difetto (`ok: !r.error`), trovato leggendo il file.
 *
 *  A. `POST /api/perps/positions/:coin/close`  — pannello di chiusura manuale
 *  B. `POST /api/perps/agents/:agent_id/panic` — panic / Safe-Exit
 *  C. `POST /api/perps/killswitch`             — kill-switch con closePositions
 *  D. `executionAgent._close`                  — proposta `close` approvata
 *  E. `telegramControl._cmdCloseAll`           — comando /chiuditutto
 *
 * COSA SI OSSERVA, per ciascuno: non «interpretCloseResult è stata chiamata», ma
 * l'ARTEFATTO che una persona o la dashboard poi legge — il codice HTTP e il
 * campo `success`, gli eventi socket emessi (`perps:position {closed:true}` è
 * l'evento che fa sparire la riga dalla dashboard), il bucket in cui finisce la
 * posizione nella risposta del panic, l'eccezione che `execute()` trasforma in
 * `ORDER_ERROR`, il testo che arriva su Telegram.
 *
 * IL CONTRAPPESO che rende i casi falsificabili: ogni sito ha anche il caso di
 * SUCCESSO PIENO, dove il comportamento deve restare identico a prima. Senza, un
 * fix che rifiutasse tutto sarebbe verde.
 *
 * COSA NON COPRE. Non c'è nessun book vero: la risposta di rifiuto è quella
 * letterale registrata il 25/09, iniettata sostituendo `closePosition`. E non
 * copre il percorso PAPER del pannello manuale (issue #35, instradamento), che è
 * un'altra proprietà dello stesso handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERPS_LOOPBACK_PUSH = '0';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-closecallers-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app, serverInstance } = await import('../src/server.js');
const { default: hyperliquid } = await import('../src/perps/hyperliquidClient.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: riskAgent } = await import('../src/agents/riskAgent.js');
const { default: executionAgent } = await import('../src/agents/executionAgent.js');
const { default: telegramControl } = await import('../src/perps/telegramControl.js');

marketData.getSnapshot = async () => { throw new Error('mercato non disponibile nel test'); };

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

/** La risposta ESATTA arrivata da Hyperliquid il 25/09 su NEAR-PERP. */
const RIFIUTO_REALE = {
  status: 'ok', oid: null, avgPx: null, totalSz: null,
  error: 'Order could not immediately match against any resting orders',
  requestedSz: 99.9
};
/** Rifiuto MUTO: accettato, oid nullo, nessun messaggio. `!r.error` non lo vede. */
const RIFIUTO_MUTO = { status: 'ok', oid: null, avgPx: null, totalSz: null, error: null, requestedSz: 99.9 };
/** Riempimento parziale: lo stesso già misurato sui trigger (2,1 su 99,9). */
const PARZIALE = { status: 'ok', oid: 777, avgPx: 4.1, totalSz: 2.1, error: null, requestedSz: 99.9 };
/** Chiusura piena. */
const PIENA = { status: 'ok', oid: 778, avgPx: 4.1, totalSz: 99.9, error: null, requestedSz: 99.9 };

// --- Handler REALI dal router stack: nessun listen, nessun HTTP ---
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

/**
 * Cattura gli emit socket, che sono l'effetto visibile all'operatore:
 * `perps:position {closed:true}` è ciò che fa sparire la riga dalla dashboard.
 * Il vero `io` (Socket.IO senza client collegati) non è osservabile.
 */
const socketEvents = [];
serverInstance.io = { emit: (name, payload) => socketEvents.push({ name, payload }) };

// ===========================================================================
// A. Pannello di chiusura manuale
// ===========================================================================

async function callManualClose(closeImpl) {
  const orig = hyperliquid.closePosition;
  const origNet = hyperliquid.getNetwork;
  hyperliquid.closePosition = closeImpl;
  hyperliquid.getNetwork = () => 'testnet';
  socketEvents.length = 0;
  try {
    const handler = route('post', '/api/perps/positions/:coin/close');
    const res = fakeRes();
    await handler({ body: { masterAddress: '0xabc' }, params: { coin: 'NEAR-PERP' } }, res);
    return res;
  } finally {
    hyperliquid.closePosition = orig;
    hyperliquid.getNetwork = origNet;
  }
}

test('A · pannello manuale: rifiuto dell\'exchange → NON risponde success, e non dice alla dashboard che è chiusa', async () => {
  const res = await callManualClose(async () => RIFIUTO_REALE);

  assert.equal(res.body.success, false, 'un ordine rifiutato non è un successo');
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /ancora aperta/i, `messaggio: ${res.body.error}`);
  assert.match(res.body.error, /could not immediately match/, 'il motivo VERO va riportato, non uno generico');
  assert.equal(res.body.data?.outcome, 'rejected');
  // L'evento che fa sparire la riga dalla dashboard non deve partire.
  assert.equal(socketEvents.filter(e => e.name === 'perps:position' && e.payload?.closed).length, 0,
    'emesso `perps:position {closed:true}` su una posizione ancora aperta');
  // …ma un refresh sì: l'operatore deve rivedere la posizione ancora là.
  assert.ok(socketEvents.some(e => e.name === 'perps:dashboardRefresh'),
    'nessun refresh: la dashboard resterebbe con il dato vecchio');
});

test('A · pannello manuale: rifiuto MUTO (oid nullo, nessun messaggio) è comunque un rifiuto', async () => {
  const res = await callManualClose(async () => RIFIUTO_MUTO);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /oid nullo/i, `messaggio: ${res.body.error}`);
});

test('A · pannello manuale: riempimento PARZIALE non è una chiusura, e dice quanto resta', async () => {
  const res = await callManualClose(async () => PARZIALE);
  assert.equal(res.body.success, false);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.data?.outcome, 'partial');
  assert.ok(Math.abs(res.body.data.remaining - 97.8) < 1e-9,
    `residuo ${res.body.data.remaining}, atteso 97.8`);
  assert.match(res.body.error, /97\.8/, 'il residuo deve essere nel messaggio per l\'operatore');
});

test('A · CONTRAPPESO — chiusura piena: risposta di successo invariata', async () => {
  const res = await callManualClose(async () => PIENA);
  assert.equal(res.body.success, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.oid, 778);
});

test('A · CONTRAPPESO — un\'eccezione resta un 400 con il suo messaggio', async () => {
  const res = await callManualClose(async () => { throw new Error('Nessuna posizione aperta su NEAR-PERP'); });
  assert.equal(res.body.success, false);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Nessuna posizione aperta/);
});

test('A · CONTRAPPESO — chiusura piena: emette `closed:true`, che è ciò che aggiorna la dashboard', async () => {
  await callManualClose(async () => PIENA);
  assert.ok(socketEvents.some(e => e.name === 'perps:position' && e.payload?.closed === true),
    'su una chiusura vera l\'evento deve partire: senza, il fix avrebbe rotto il caso buono');
});

// ===========================================================================
// B. Panic / Safe-Exit
// ===========================================================================

async function callPanic(closeImpl) {
  const orig = hyperliquid.closePosition;
  const origNet = hyperliquid.getNetwork;
  hyperliquid.closePosition = closeImpl;
  hyperliquid.getNetwork = () => 'testnet';
  // Un bot finto con una posizione aperta, registrato nella Map di botManager.
  const fakeBot = {
    id: 'panic-bot', coin: 'NEAR-PERP', masterAddress: '0xabc', status: 'stopped',
    linked_agent_id: 'agent-x', position: { size: 99.9, entryPx: 4.1, side: 'short' },
    stop() { this.status = 'stopped'; }
  };
  botManager.bots.set(fakeBot.id, fakeBot);
  try {
    const handler = route('post', '/api/perps/kill-switch');
    const res = fakeRes();
    // `size_threshold_usd: 0` = nessuna soglia, chiudi tutto: senza questo la
    // posizione (99.9 × 4.1 = 409 USD) finirebbe fra le `skippedPositions` per
    // il default di 500 e il ramo di chiusura non verrebbe esercitato affatto.
    await handler({ body: { agent_id: 'agent-x', size_threshold_usd: 0 } }, res);
    return res;
  } finally {
    botManager.bots.delete(fakeBot.id);
    hyperliquid.closePosition = orig;
    hyperliquid.getNetwork = origNet;
  }
}

test('B · panic: una chiusura rifiutata NON entra fra le "posizioni messe in sicurezza"', async () => {
  const res = await callPanic(async () => RIFIUTO_REALE);
  const d = res.body.data || res.body;
  assert.equal((d.closedPositions || []).length, 0,
    'contata come chiusa una posizione che l\'exchange non ha toccato — proprio premendo il panic button');
  const err = (d.errors || []).find(e => e.action === 'close_position');
  assert.ok(err, `il rifiuto deve comparire fra gli errori: ${JSON.stringify(d.errors)}`);
  assert.equal(err.outcome, 'rejected');
  assert.match(err.error, /ancora aperta/i);
});

test('B · panic: una chiusura PARZIALE va fra gli errori, non fra le chiusure', async () => {
  const res = await callPanic(async () => PARZIALE);
  const d = res.body.data || res.body;
  assert.equal((d.closedPositions || []).length, 0, 'mezza posizione chiusa non è messa in sicurezza');
  const err = (d.errors || []).find(e => e.action === 'close_position');
  assert.equal(err.outcome, 'partial');
  assert.match(err.error, /97\.8/, 'il residuo serve a chi deve intervenire');
});

test('B · CONTRAPPESO — panic con chiusura vera: la posizione è fra le chiuse e non fra gli errori', async () => {
  const res = await callPanic(async () => PIENA);
  const d = res.body.data || res.body;
  assert.equal((d.closedPositions || []).length, 1);
  assert.equal((d.errors || []).filter(e => e.action === 'close_position').length, 0);
});

// ===========================================================================
// C. Kill-switch
// ===========================================================================

async function callKillSwitch(closeImpl, positions) {
  const orig = hyperliquid.closePosition;
  const origAcc = hyperliquid.getAccount;
  const origKs = riskAgent.setKillSwitch;
  hyperliquid.closePosition = closeImpl;
  hyperliquid.getAccount = async () => ({ positions });
  riskAgent.setKillSwitch = () => {};
  notified.length = 0;
  try {
    const handler = route('post', '/api/perps/killswitch');
    const res = fakeRes();
    await handler({ body: { closePositions: true, masterAddress: '0xabc' } }, res);
    return res;
  } finally {
    hyperliquid.closePosition = orig;
    hyperliquid.getAccount = origAcc;
    riskAgent.setKillSwitch = origKs;
  }
}

test('C · kill-switch: una posizione rifiutata NON è "chiusa" e la notifica non la conta', async () => {
  const res = await callKillSwitch(async () => RIFIUTO_MUTO, [{ coin: 'NEAR-PERP', size: 99.9 }]);
  const closed = res.body.data.closed;
  assert.equal(closed.length, 1, 'la riga del tentativo resta, è il suo esito che cambia');
  assert.equal(closed[0].ok, false, '`ok: !r.error` non vedeva un oid nullo senza messaggio');
  assert.equal(closed[0].outcome, 'rejected');

  const msg = notified.find(t => /KILL-SWITCH/.test(t));
  assert.ok(msg, 'nessuna notifica di kill-switch');
  assert.match(msg, /0\/1/, `la notifica deve dire 0 su 1, non "posizioni chiuse: 1": ${msg}`);
  assert.match(msg, /INTERVENTO MANUALE/i, 'il testo deve dire che serve una persona');
});

test('C · CONTRAPPESO — kill-switch con chiusure vere: conta quelle e non allarma', async () => {
  const res = await callKillSwitch(async () => PIENA, [{ coin: 'A-PERP', size: 99.9 }, { coin: 'B-PERP', size: 99.9 }]);
  const closed = res.body.data.closed;
  assert.deepEqual(closed.map(c => c.ok), [true, true]);
  const msg = notified.find(t => /KILL-SWITCH/.test(t));
  assert.match(msg, /2\/2/);
  assert.doesNotMatch(msg, /INTERVENTO MANUALE/i);
});

test('C · kill-switch: chiusura parziale segnalata come NON chiusa', async () => {
  const res = await callKillSwitch(async () => PARZIALE, [{ coin: 'NEAR-PERP', size: 99.9 }]);
  const c = res.body.data.closed[0];
  assert.equal(c.ok, false, 'mezza posizione chiusa non è una posizione chiusa');
  assert.equal(c.outcome, 'partial');
  assert.ok(Math.abs(c.remaining - 97.8) < 1e-9);
});

// ===========================================================================
// D. executionAgent — proposta `close` approvata
// ===========================================================================

test('D · executionAgent._close: rifiuto → LANCIA, così `execute` non annuncia un ordine riempito', async () => {
  const orig = hyperliquid.closePosition;
  hyperliquid.closePosition = async () => RIFIUTO_REALE;
  try {
    await assert.rejects(
      () => executionAgent._close({ masterAddress: '0xabc', coin: 'NEAR-PERP', network: 'testnet' }),
      /NON eseguita/i
    );
  } finally { hyperliquid.closePosition = orig; }
});

test('D · executionAgent._close: rifiuto MUTO → LANCIA (prima passava per successo)', async () => {
  const orig = hyperliquid.closePosition;
  hyperliquid.closePosition = async () => RIFIUTO_MUTO;
  try {
    await assert.rejects(
      () => executionAgent._close({ masterAddress: '0xabc', coin: 'NEAR-PERP', network: 'testnet' }),
      /oid nullo/i
    );
  } finally { hyperliquid.closePosition = orig; }
});

test('D · executionAgent._close: parziale → LANCIA e dice il residuo', async () => {
  const orig = hyperliquid.closePosition;
  hyperliquid.closePosition = async () => PARZIALE;
  try {
    await assert.rejects(
      () => executionAgent._close({ masterAddress: '0xabc', coin: 'NEAR-PERP', network: 'testnet' }),
      /PARZIALE.*97\.8/s
    );
  } finally { hyperliquid.closePosition = orig; }
});

test('D · CONTRAPPESO — chiusura piena: ritorna l\'esito, nessuna eccezione', async () => {
  const orig = hyperliquid.closePosition;
  hyperliquid.closePosition = async () => PIENA;
  try {
    const r = await executionAgent._close({ masterAddress: '0xabc', coin: 'NEAR-PERP', network: 'testnet' });
    assert.equal(r.closed, 'NEAR-PERP');
    assert.ok(Math.abs(r.filled - 99.9) < 1e-9);
  } finally { hyperliquid.closePosition = orig; }
});

test('D · il rifiuto arriva a `execute` come ORDER_ERROR, non come ordine riempito', async () => {
  const orig = hyperliquid.closePosition;
  hyperliquid.closePosition = async () => RIFIUTO_REALE;
  const { default: bus, EVENTS } = await import('../src/agents/bus.js');
  const seen = [];
  const offFilled = bus.on(EVENTS.ORDER_FILLED, (p) => seen.push(['filled', p]));
  const offError = bus.on(EVENTS.ORDER_ERROR, (p) => seen.push(['error', p]));
  try {
    const out = await executionAgent.execute({ type: 'close', masterAddress: '0xabc', coin: 'NEAR-PERP', network: 'testnet' });
    assert.equal(out.ok, false, 'un\'esecuzione che non ha chiuso niente non è ok');
    assert.equal(seen.filter(([k]) => k === 'filled').length, 0,
      'ORDER_FILLED pubblicato su una posizione ancora aperta');
    assert.equal(seen.filter(([k]) => k === 'error').length, 1);
  } finally {
    hyperliquid.closePosition = orig;
    if (typeof offFilled === 'function') offFilled();
    if (typeof offError === 'function') offError();
  }
});

// ===========================================================================
// E. /chiuditutto su Telegram
// ===========================================================================

async function callCloseAll(closeImpl, positions) {
  const origClose = hyperliquid.closePosition;
  const origAcc = hyperliquid.getAccount;
  const origCtx = telegramControl._context;
  const origSend = telegramControl._send;
  const sent = [];
  hyperliquid.closePosition = closeImpl;
  hyperliquid.getAccount = async () => ({ positions });
  telegramControl._context = () => ({ masterAddress: '0xabc', network: 'testnet' });
  telegramControl._send = async (t) => { sent.push(t); };
  try {
    await telegramControl._cmdCloseAll();
    return sent.join('\n');
  } finally {
    hyperliquid.closePosition = origClose;
    hyperliquid.getAccount = origAcc;
    telegramControl._context = origCtx;
    telegramControl._send = origSend;
  }
}

test('E · /chiuditutto: nessuna spunta verde su una chiusura rifiutata', async () => {
  const text = await callCloseAll(async () => RIFIUTO_MUTO, [{ coin: 'NEAR-PERP', size: 99.9 }]);
  assert.doesNotMatch(text, /✅/, `✅ su una posizione ancora aperta: ${text}`);
  assert.match(text, /NON chiusa/i);
  assert.match(text, /0\/1/);
  assert.match(text, /ANCORA APERTE/i, 'chi legge su Telegram non ha altro modo di accorgersene');
});

test('E · /chiuditutto: parziale distinto sia dal successo sia dal rifiuto', async () => {
  const text = await callCloseAll(async () => PARZIALE, [{ coin: 'NEAR-PERP', size: 99.9 }]);
  assert.doesNotMatch(text, /✅/);
  assert.match(text, /PARZIALE/);
  assert.match(text, /97\.8/, 'il residuo è il dato che serve per decidere');
});

test('E · CONTRAPPESO — /chiuditutto con chiusure vere: ✅ e nessun allarme', async () => {
  const text = await callCloseAll(async () => PIENA, [{ coin: 'A-PERP', size: 99.9 }, { coin: 'B-PERP', size: 99.9 }]);
  assert.equal((text.match(/✅/g) || []).length, 2);
  assert.match(text, /2\/2/);
  assert.doesNotMatch(text, /ANCORA APERTE/i);
});

// ===========================================================================
// Contratto condiviso: la size richiesta arriva al chiamante
// ===========================================================================

test('closePosition espone `requestedSz`: senza, il parziale è indistinguibile dal pieno', async () => {
  // Senza `requestedSz` (o una size passata a mano) `interpretCloseResult` ha
  // `expected == null` e classifica `closed` — riconosce il rifiuto ma NON il
  // riempimento parziale, e lo dichiara nel `reason`.
  const { interpretCloseResult } = await import('../src/perps/riskManager.js');
  const senza = interpretCloseResult({ ...PARZIALE, requestedSz: undefined }, undefined);
  assert.equal(senza.outcome, 'closed');
  assert.match(senza.reason, /size della posizione non nota/i);

  const con = interpretCloseResult(PARZIALE, PARZIALE.requestedSz);
  assert.equal(con.outcome, 'partial');
});

test('paperBroker.closePosition riporta la size richiesta come il client reale', async () => {
  const { PaperBroker } = await import('../src/perps/paperBroker.js');
  const { default: client } = await import('../src/perps/hyperliquidClient.js');
  const origMid = client.getMid;
  client.getMid = async () => 100;
  try {
    const b = new PaperBroker();
    await b.placeMarketOrder({ masterAddress: '0xREQSZ', coin: 'RQ-PERP', isBuy: true, size: 3 }, 'testnet');
    const r = await b.closePosition({ masterAddress: '0xREQSZ', coin: 'RQ-PERP' }, 'testnet');
    assert.ok(Math.abs(r.requestedSz - 3) < 1e-9, `requestedSz ${r.requestedSz}, attesa 3`);
    // `totalSz` resta assente: il paper riempie sempre tutto ed è il caso
    // `sizeKnown: false`, che `interpretCloseResult` legge come chiusura piena.
    const { interpretCloseResult } = await import('../src/perps/riskManager.js');
    assert.equal(interpretCloseResult(r, r.requestedSz).outcome, 'closed');
  } finally { client.getMid = origMid; }
});
