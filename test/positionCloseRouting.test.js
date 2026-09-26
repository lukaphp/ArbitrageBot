/**
 * ISSUE #35 (parte backend) — il pulsante "Chiudi" su una posizione PAPER
 * instradava al broker REALE.
 * ======================================================================
 *
 * `POST /api/perps/positions/:coin/close` chiamava sempre
 * `hyperliquid.closePosition`. Dopo PR #33 il pannello "Posizioni attive" mostra
 * anche le righe paper, con il loro pulsante: nello scenario MISTO (un bot reale
 * e un bot paper sullo stesso wallet e sulla stessa coin) cliccare "Chiudi" su
 * una riga che l'utente vede come simulata avrebbe chiuso quella VERA.
 *
 * Oggi è innocuo solo per un accidente: l'account reale è vuoto e
 * `hyperliquid.closePosition` lancia «Nessuna posizione aperta» — fail-closed per
 * struttura, non per disegno.
 *
 * LA PROPRIETÀ CENTRALE, e il motivo per cui questo file esiste più del
 * «funziona»: la destinazione è DERIVATA dallo stato del server, non dichiarata
 * dal client. Un `isPaper` (o `source`) nel corpo della richiesta non può far
 * partire un ordine su un broker che non ha quella posizione — altrimenti un
 * client sbagliato o malevolo muoverebbe denaro vero al posto di denaro simulato.
 * Il campo `source` serve solo a DISAMBIGUARE fra candidati che esistono davvero.
 *
 * Due livelli, come da convenzione:
 *  - `riskManager.resolveCloseTarget` PURA — è lei a decidere, e i casi scomodi
 *    (ambiguità, source che mente, coin con e senza `-PERP`) si provano lì;
 *  - la rotta come orchestrazione: l'osservabile è QUALE broker ha ricevuto
 *    l'ordine, catturato sostituendo `closePosition` su entrambi.
 *
 * COSA NON COPRE. La parte UI (Maya): nascondere/rietichettare il pulsante sulle
 * righe paper. E non copre la verifica dell'esito della chiusura, che è #55 e ha
 * il suo file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERPS_LOOPBACK_PUSH = '0';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-closeroute-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app, serverInstance } = await import('../src/server.js');
const { default: hyperliquid } = await import('../src/perps/hyperliquidClient.js');
const { default: paperBroker } = await import('../src/perps/paperBroker.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { resolveCloseTarget } = await import('../src/perps/riskManager.js');

marketData.getSnapshot = async () => { throw new Error('mercato non disponibile nel test'); };

const socketEvents = [];
serverInstance.io = { emit: (name, payload) => socketEvents.push({ name, payload }) };

const PIENA = (sz) => ({ status: 'ok', oid: 1, avgPx: 100, totalSz: sz, error: null, requestedSz: sz });

// ---------------------------------------------------------------------------
// LIVELLO PURO — `resolveCloseTarget`
// ---------------------------------------------------------------------------

test('PURA: solo paper aperta → paper', () => {
  const r = resolveCloseTarget({ coin: 'SOL-PERP', paperPositions: [{ coin: 'SOL-PERP' }], realPositions: [] });
  assert.equal(r.target, 'paper');
  assert.deepEqual(r.candidates, ['paper']);
});

test('PURA: solo reale aperta → real', () => {
  const r = resolveCloseTarget({ coin: 'SOL-PERP', paperPositions: [], realPositions: [{ coin: 'SOL-PERP' }] });
  assert.equal(r.target, 'real');
});

test('PURA: nessuna delle due → rifiuto, niente ordine', () => {
  const r = resolveCloseTarget({ coin: 'SOL-PERP', paperPositions: [], realPositions: [] });
  assert.equal(r.target, null);
  assert.match(r.reason, /né reale né simulata/i);
});

test('PURA: SCENARIO MISTO senza `source` → rifiuto, non si indovina', () => {
  // È il caso dell'issue: l'endpoint «non ha modo di sapere quale delle due
  // l'utente intendeva». Chiudere quella sbagliata non è recuperabile.
  const r = resolveCloseTarget({
    coin: 'SOL-PERP',
    paperPositions: [{ coin: 'SOL-PERP' }],
    realPositions: [{ coin: 'SOL-PERP' }]
  });
  assert.equal(r.target, null, 'con due candidati non si sceglie di testa propria');
  assert.deepEqual([...r.candidates].sort(), ['paper', 'real']);
  assert.match(r.reason, /indicare quale/i);
  assert.match(r.reason, /Nessun ordine/i);
});

test('PURA: scenario misto CON `source` → disambigua fra candidati reali', () => {
  const base = {
    coin: 'SOL-PERP',
    paperPositions: [{ coin: 'SOL-PERP' }],
    realPositions: [{ coin: 'SOL-PERP' }]
  };
  assert.equal(resolveCloseTarget({ ...base, requestedSource: 'paper' }).target, 'paper');
  assert.equal(resolveCloseTarget({ ...base, requestedSource: 'real' }).target, 'real');
});

test('PURA: un `source` che MENTE non crea un candidato — e non ripiega sull\'altro broker', () => {
  // La proprietà di sicurezza: un client che dichiara `paper` su una coin dove
  // esiste solo la posizione REALE non deve poter far partire NIENTE. Se qui
  // tornasse `real`, il flag del client avrebbe instradato un ordine vero.
  const r = resolveCloseTarget({
    coin: 'SOL-PERP',
    paperPositions: [],
    realPositions: [{ coin: 'SOL-PERP' }],
    requestedSource: 'paper'
  });
  assert.equal(r.target, null, 'un source inventato non deve produrre nessun ordine');
  assert.notEqual(r.target, 'real', 'e soprattutto non deve ripiegare sul broker REALE');
  assert.match(r.reason, /nessuna posizione simulata/i);

  // …e il verso opposto, che è quello che muove denaro vero.
  const inverso = resolveCloseTarget({
    coin: 'SOL-PERP',
    paperPositions: [{ coin: 'SOL-PERP' }],
    realPositions: [],
    requestedSource: 'real'
  });
  assert.equal(inverso.target, null);
  assert.match(inverso.reason, /nessuna posizione reale/i);
});

test('PURA: un `source` non riconosciuto viene ignorato, non preso per buono', () => {
  const r = resolveCloseTarget({
    coin: 'SOL-PERP',
    paperPositions: [{ coin: 'SOL-PERP' }],
    realPositions: [],
    requestedSource: 'PAPER; DROP TABLE'
  });
  assert.equal(r.target, 'paper', 'resta il candidato unico derivato dallo stato');
});

test('PURA: coin con e senza `-PERP` sono la stessa coin', () => {
  assert.equal(resolveCloseTarget({ coin: 'SOL-PERP', paperPositions: [{ coin: 'SOL' }] }).target, 'paper');
  assert.equal(resolveCloseTarget({ coin: 'SOL', realPositions: [{ coin: 'SOL-PERP' }] }).target, 'real');
});

test('PURA: una coin diversa non è un candidato', () => {
  const r = resolveCloseTarget({ coin: 'SOL-PERP', paperPositions: [{ coin: 'ETH-PERP' }], realPositions: [] });
  assert.equal(r.target, null);
});

// ---------------------------------------------------------------------------
// ROTTA — quale broker riceve l'ordine
// ---------------------------------------------------------------------------

function handler() {
  const layer = app._router.stack.find(l => l.route
    && l.route.path === '/api/perps/positions/:coin/close' && l.route.methods.post);
  assert.ok(layer, 'rotta di chiusura non trovata nel router');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeRes() {
  const out = { statusCode: 200, body: null };
  out.status = (c) => { out.statusCode = c; return out; };
  out.json = (b) => { out.body = b; return out; };
  return out;
}

/**
 * Esegue la rotta con i due account sotto controllo e registra quale broker è
 * stato invocato. L'osservabile è proprio questo: non il codice di risposta, ma
 * DOVE è andato l'ordine.
 */
async function callClose({ realPositions = [], paperPositions = [], body = {}, realThrows = null, paperThrows = null }) {
  const orig = {
    realClose: hyperliquid.closePosition, realAcc: hyperliquid.getAccount, net: hyperliquid.getNetwork,
    paperClose: paperBroker.closePosition, paperPeek: paperBroker.peekAccount
  };
  const calls = [];
  hyperliquid.getNetwork = () => 'testnet';
  hyperliquid.getAccount = async () => {
    if (realThrows) throw new Error(realThrows);
    return { positions: realPositions };
  };
  paperBroker.peekAccount = async () => {
    if (paperThrows) throw new Error(paperThrows);
    return { positions: paperPositions };
  };
  hyperliquid.closePosition = async ({ coin }) => { calls.push({ broker: 'real', coin }); return PIENA(5); };
  paperBroker.closePosition = async ({ coin }) => { calls.push({ broker: 'paper', coin }); return PIENA(5); };
  socketEvents.length = 0;
  try {
    const res = fakeRes();
    await handler()({ body: { masterAddress: '0xabc', ...body }, params: { coin: 'SOL-PERP' } }, res);
    return { res, calls };
  } finally {
    hyperliquid.closePosition = orig.realClose;
    hyperliquid.getAccount = orig.realAcc;
    hyperliquid.getNetwork = orig.net;
    paperBroker.closePosition = orig.paperClose;
    paperBroker.peekAccount = orig.paperPeek;
  }
}

test('ROTTA: posizione PAPER → l\'ordine va al paperBroker, MAI al broker reale', async () => {
  const { res, calls } = await callClose({ paperPositions: [{ coin: 'SOL-PERP', size: 5 }] });
  assert.deepEqual(calls.map(c => c.broker), ['paper'],
    'ordine inviato al broker sbagliato: è il difetto di #35');
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.source, 'paper', 'la risposta dichiara su quale conto ha operato');
});

test('ROTTA: posizione REALE → l\'ordine va all\'exchange, comportamento invariato', async () => {
  const { res, calls } = await callClose({ realPositions: [{ coin: 'SOL-PERP', size: 5 }] });
  assert.deepEqual(calls.map(c => c.broker), ['real']);
  assert.equal(res.body.data.source, 'real');
});

test('ROTTA: `source: "paper"` su una coin dove esiste SOLO la reale → nessun ordine', async () => {
  // La prova di sicurezza sulla rotta: il flag del client non deve poter
  // instradare denaro vero.
  const { res, calls } = await callClose({
    realPositions: [{ coin: 'SOL-PERP', size: 5 }],
    body: { source: 'paper' }
  });
  assert.equal(calls.length, 0, `nessun broker doveva essere chiamato, invece: ${JSON.stringify(calls)}`);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /nessuna posizione simulata/i);
});

test('ROTTA: scenario MISTO senza `source` → nessun ordine, e la risposta dice come disambiguare', async () => {
  const { res, calls } = await callClose({
    realPositions: [{ coin: 'SOL-PERP', size: 5 }],
    paperPositions: [{ coin: 'SOL-PERP', size: 5 }]
  });
  assert.equal(calls.length, 0, 'con due posizioni omonime non si sceglie: si chiede');
  assert.equal(res.statusCode, 400);
  assert.deepEqual([...res.body.data.candidates].sort(), ['paper', 'real']);
  assert.match(res.body.error, /source/);
});

test('ROTTA: scenario MISTO con `source: "paper"` → paper, e la reale resta intatta', async () => {
  const { calls } = await callClose({
    realPositions: [{ coin: 'SOL-PERP', size: 5 }],
    paperPositions: [{ coin: 'SOL-PERP', size: 5 }],
    body: { source: 'paper' }
  });
  assert.deepEqual(calls.map(c => c.broker), ['paper']);
});

test('ROTTA: nessuna posizione da nessuna parte → 400, nessun ordine', async () => {
  const { res, calls } = await callClose({});
  assert.equal(calls.length, 0);
  assert.equal(res.statusCode, 400);
});

test('ROTTA: account reale illeggibile → NON si instrada al paper per esclusione', async () => {
  // Un fallimento di lettura non è «niente aperto qui»: instradare su
  // un'ignoranza è esattamente il modo in cui si chiude la posizione sbagliata.
  const { res, calls } = await callClose({
    paperPositions: [{ coin: 'SOL-PERP', size: 5 }],
    realThrows: 'rate limit'
  });
  assert.equal(calls.length, 0, 'ordine inviato mentre non si sapeva cosa c\'è sul conto reale');
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /Nessun ordine/i);
});

test('ROTTA: stato simulato illeggibile → NON si instrada al reale per esclusione', async () => {
  const { res, calls } = await callClose({
    realPositions: [{ coin: 'SOL-PERP', size: 5 }],
    paperThrows: 'settings corrotto'
  });
  assert.equal(calls.length, 0, 'questo è il verso che muove denaro VERO');
  assert.equal(res.statusCode, 502);
});

test('ROTTA: la lettura dello stato simulato non esegue chiusure (peekAccount, non getAccount)', async () => {
  // `getAccount` valuta i trigger TP/SL simulati come effetto collaterale: da una
  // rotta HTTP significherebbe eseguire fill che nessun tick registrerà.
  const origPeek = paperBroker.peekAccount;
  const origGet = paperBroker.getAccount;
  let getAccountCalls = 0;
  paperBroker.getAccount = async () => { getAccountCalls++; return { positions: [] }; };
  paperBroker.peekAccount = async () => ({ positions: [{ coin: 'SOL-PERP', size: 5 }] });
  try {
    await callClose({ paperPositions: [{ coin: 'SOL-PERP', size: 5 }] });
    assert.equal(getAccountCalls, 0, 'la rotta deve usare peekAccount, che non fa scattare i trigger');
  } finally {
    paperBroker.peekAccount = origPeek;
    paperBroker.getAccount = origGet;
  }
});

test('ROTTA: `masterAddress` mancante → 400 prima di qualunque lettura', async () => {
  const orig = hyperliquid.getAccount;
  let reads = 0;
  hyperliquid.getAccount = async () => { reads++; return { positions: [] }; };
  try {
    const res = fakeRes();
    await handler()({ body: {}, params: { coin: 'SOL-PERP' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(reads, 0);
  } finally { hyperliquid.getAccount = orig; }
});
