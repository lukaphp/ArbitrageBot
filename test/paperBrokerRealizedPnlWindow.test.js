/**
 * ISSUE #18 — `getRealizedPnl` sommava la chiusura della posizione PRECEDENTE.
 * ===========================================================================
 *
 * La finestra era `sinceTs - 1000`. Il margine di un secondo serve a un motivo
 * reale: `bot._registerClose` passa `position.openedAt`, cioè il `Date.now()`
 * scritto in DB DOPO che il fill di apertura è già avvenuto, quindi con una
 * finestra esatta il fill di apertura (e la sua fee) cadrebbe fuori.
 *
 * Il margine però è cieco su cosa lascia entrare: se sulla STESSA coin una
 * posizione riapre entro un secondo dalla chiusura della precedente, dentro la
 * finestra finisce anche il fill di CHIUSURA di quella precedente, e il suo
 * `closedPnl` viene sommato al PnL della posizione corrente.
 *
 * Riscontro in produzione: riga 46 di `positions` della flotta OPS-FLEET-02,
 * `pnl -22.95` dove il trade valeva `-11.6` — il doppio, cioè due chiusure
 * contate come una.
 *
 * LA CORREZIONE è un'invariante sulla forma della sequenza, non un margine più
 * stretto (che sarebbe solo una race più difficile da riprodurre): la vita di una
 * posizione COMINCIA per definizione con un fill di apertura, quindi qualunque
 * fill che nella finestra precede il PRIMO fill di apertura appartiene alla
 * storia e non a questa posizione.
 *
 * COSA VERIFICA QUESTO FILE. Il calcolo puro `fillsOfCurrentPosition` sui casi di
 * confine, e il broker vero end-to-end sullo scenario dell'issue (chiudi e riapri
 * nello stesso istante). Include i casi di NON-regressione che il margine deve
 * continuare a coprire: fee di apertura contata, DCA, TP parziale.
 *
 * COSA NON COPRE. Non copre `hyperliquidClient.getRealizedPnl`, che ha la stessa
 * forma ma legge i fill dall'exchange: lì la finestra è un parametro della
 * chiamata REST e il difetto, se c'è, è un'altra storia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import { PaperBroker, fillsOfCurrentPosition } from '../src/perps/paperBroker.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-pnlwin-'));
db.dbPath = path.join(tempDir, 'perps.db');

let MID = 100;
client.getMid = async () => MID;

const broker = new PaperBroker();

// ---------------------------------------------------------------------------
// LIVELLO PURO — quali fill appartengono alla posizione corrente
// ---------------------------------------------------------------------------

const f = (dir, closedPnl, sz = 1, fee = 0.1) => ({ dir, closedPnl, sz, fee, time: 0 });
const pnlOf = (list) => list.reduce((s, x) => s + x.closedPnl, 0);

// --- PASSO 1: la coda orfana della posizione precedente ---

test('PASSO 1: la chiusura precedente in testa alla finestra viene scartata', () => {
  // La forma di produzione: la posizione precedente era aperta da molto (il suo
  // `Open` è fuori finestra) e si è chiusa dentro.
  const rel = [f('Close Long', -11.6), f('Open Long', 0), f('Close Long', -11.35)];
  const out = fillsOfCurrentPosition(rel);
  assert.equal(out.length, 2);
  assert.equal(out[0].dir, 'Open Long', 'la sequenza deve cominciare con l\'apertura');
  assert.equal(pnlOf(out), -11.35, 'un solo closedPnl, non due');
});

test('PASSO 1: scarta TUTTA la coda orfana, non solo il primo fill', () => {
  const rel = [f('Close Long', -1, 0.5), f('Close Long', -2, 0.5), f('Open Long', 0), f('Close Long', -3)];
  const out = fillsOfCurrentPosition(rel);
  assert.equal(out.length, 2);
  assert.equal(pnlOf(out), -3);
});

test('PASSO 1: senza nessuna apertura nella finestra NON si taglia niente', () => {
  // Posizione ADOTTATA da `_reconcile`: `openedAt` molto posteriore ai fill veri.
  // Qui la coda È la posizione corrente. Tagliare butterebbe via un PnL misurato
  // per sostituirlo con il fallback dell'unrealized, cioè un numero inventato.
  const rel = [f('Close Long', -7, 0.5), f('Close Long', -3, 0.5)];
  assert.deepEqual(fillsOfCurrentPosition(rel), rel, 'due chiusure parziali della STESSA posizione');
  assert.equal(pnlOf(fillsOfCurrentPosition(rel)), -10);
});

// --- PASSO 2: la posizione precedente contenuta INTERA nella finestra ---

test('PASSO 2: posizione precedente intera nella finestra — il primo `Open` è il SUO', () => {
  // Questo caso il passo 1 NON lo vede: non c'è nessuna coda orfana da tagliare
  // perché la finestra comincia già con un'apertura. Serve la size netta.
  const rel = [f('Open Long', 0), f('Close Long', -10), f('Open Long', 0), f('Close Long', -5)];
  const out = fillsOfCurrentPosition(rel);
  assert.equal(out.length, 2, `atteso l'ultimo segmento, ottenuto ${JSON.stringify(out.map(x => x.dir))}`);
  assert.equal(pnlOf(out), -5, 'il -10 della posizione precedente non va sommato');
});

test('PASSO 2: tre posizioni di fila nella finestra → solo l\'ultima', () => {
  const rel = [
    f('Open Long', 0), f('Close Long', -1),
    f('Open Long', 0), f('Close Long', -2),
    f('Open Long', 0), f('Close Long', -3)
  ];
  assert.equal(pnlOf(fillsOfCurrentPosition(rel)), -3);
});

test('PASSO 2: posizione ancora APERTA dopo una chiusura precedente', () => {
  const rel = [f('Open Long', 0), f('Close Long', -10), f('Open Long', 0)];
  const out = fillsOfCurrentPosition(rel);
  assert.equal(out.length, 1);
  assert.equal(pnlOf(out), 0, 'nessuna chiusura da attribuire alla posizione viva');
});

// --- Non-regressione del calcolo puro ---

test('un DCA non è un confine: la size cresce, il segmento è lo stesso', () => {
  const rel = [f('Open Short', 0), f('Open Short', 0), f('Close Short', 4, 2)];
  assert.deepEqual(fillsOfCurrentPosition(rel), rel, 'nessun DCA va perso');
});

test('un TP PARZIALE non è un confine: la size scende ma non a zero', () => {
  const rel = [f('Open Long', 0, 2), f('Close Long', 1.5, 1), f('Close Long', 0.5, 1)];
  assert.deepEqual(fillsOfCurrentPosition(rel), rel);
  assert.equal(pnlOf(fillsOfCurrentPosition(rel)), 2, 'i due gradini della scala si sommano');
});

test('residuo di arrotondamento sui float: conta come chiusura piena', () => {
  // 0.1 + 0.2 - 0.3 lascia 5.5e-17: senza tolleranza relativa il segmento non si
  // chiuderebbe mai e la posizione successiva resterebbe attaccata a questa.
  const rel = [
    f('Open Long', 0, 0.1), f('Open Long', 0, 0.2), f('Close Long', -1, 0.3),
    f('Open Long', 0, 0.1), f('Close Long', -2, 0.1)
  ];
  assert.equal(pnlOf(fillsOfCurrentPosition(rel)), -2);
});

test('finestra vuota resta vuota, input non valido non esplode', () => {
  assert.deepEqual(fillsOfCurrentPosition([]), []);
  assert.deepEqual(fillsOfCurrentPosition(null), []);
  assert.deepEqual(fillsOfCurrentPosition(undefined), []);
});

test('un `dir` illeggibile non viene preso per un\'apertura', () => {
  const rel = [f(null, -5), f('', -4), f('Open Long', 0), f('Close Long', -1)];
  const out = fillsOfCurrentPosition(rel);
  assert.equal(out.length, 2);
  assert.equal(out[0].dir, 'Open Long');
});

test('size illeggibili non fanno sparire la finestra intera', () => {
  // Senza la guardia `peak > 0` una fila di size a zero sarebbe letta come una
  // fila di posizioni chiuse e verrebbe tagliata tutta, PnL compreso.
  const rel = [f('Open Long', 0, NaN), f('Close Long', -6, undefined)];
  const out = fillsOfCurrentPosition(rel);
  assert.equal(out.length, 2);
  assert.equal(pnlOf(out), -6);
});

// ---------------------------------------------------------------------------
// BROKER VERO — lo scenario dell'issue
// ---------------------------------------------------------------------------

test('riapertura entro 1s sulla stessa coin: il PnL non include la chiusura precedente', async () => {
  const M = '0xPNLWIN1';
  const COIN = 'WIN1-PERP';

  // --- Posizione 1: long a 100, chiusa a 90 (perdita netta ~10) ---
  MID = 100;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: true, size: 1 }, 'testnet');
  MID = 90;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: false, size: 1, reduceOnly: true }, 'testnet');

  const first = await broker.getRealizedPnl(M, COIN, 0);
  assert.ok(first.closedPnl < -9 && first.closedPnl > -11,
    `la prima chiusura vale ${first.closedPnl}, attesa ~-10`);
  const firstPnl = first.closedPnl;

  // --- Posizione 2: riaperta SUBITO (stesso istante, come in produzione) ---
  // `openedAt` è il Date.now() che `bot._openPosition` scrive in DB dopo il fill:
  // lo stesso valore che arriva a `getRealizedPnl`.
  const openedAt = Date.now();
  MID = 100;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: true, size: 1 }, 'testnet');
  MID = 95;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: false, size: 1, reduceOnly: true }, 'testnet');

  const second = await broker.getRealizedPnl(M, COIN, openedAt);
  assert.ok(second, 'la seconda chiusura deve essere vista');
  assert.equal(second.closingFills.length, 1,
    `un solo fill di chiusura, non ${second.closingFills.length} (dentro: ${JSON.stringify(second.closingFills.map(x => x.closedPnl))})`);
  assert.ok(second.closedPnl < -4 && second.closedPnl > -6,
    `PnL della seconda posizione ${second.closedPnl}, atteso ~-5`);
  // Il difetto: -5 + (-10) = -15, "esattamente il doppio meno le fee" dell'issue.
  assert.ok(second.closedPnl > firstPnl,
    `il PnL della seconda posizione (${second.closedPnl}) ha assorbito la prima (${firstPnl})`);
});

test('NON-REGRESSIONE: la fee del fill di APERTURA resta dentro la finestra', async () => {
  // È il motivo per cui il margine di 1s esiste. Se il fix lo avesse solo
  // stretto, questa fee sparirebbe e il `net` sarebbe migliore del vero.
  const M = '0xPNLWIN2';
  const COIN = 'WIN2-PERP';

  const openedAt = Date.now();
  MID = 100;
  const open = await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: true, size: 1 }, 'testnet');
  MID = 100;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: false, size: 1, reduceOnly: true }, 'testnet');

  const r = await broker.getRealizedPnl(M, COIN, openedAt);
  assert.equal(r.fills, 2, 'apertura + chiusura: due fill nella finestra');
  const openFee = open.avgPx * 1 * 0.00035;
  assert.ok(r.fee > openFee, `fee ${r.fee} non comprende quella di apertura (${openFee})`);
  assert.ok(Math.abs(r.net - (r.closedPnl - r.fee)) < 1e-12);
});

test('NON-REGRESSIONE: un DCA dopo l\'apertura resta nella posizione corrente', async () => {
  const M = '0xPNLWIN3';
  const COIN = 'WIN3-PERP';

  const openedAt = Date.now();
  MID = 100;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: true, size: 1 }, 'testnet');
  MID = 98;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: true, size: 1 }, 'testnet');
  MID = 101;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: false, size: 2, reduceOnly: true }, 'testnet');

  const r = await broker.getRealizedPnl(M, COIN, openedAt);
  assert.equal(r.fills, 3, 'apertura + DCA + chiusura');
  assert.equal(r.closingFills.length, 1);
  assert.ok(r.closedPnl > 0, `chiusura a 101 su ingresso medio 99: PnL ${r.closedPnl} atteso positivo`);
});

test('NON-REGRESSIONE: sinceTs = 0 continua a restituire tutta la storia', async () => {
  const M = '0xPNLWIN4';
  const COIN = 'WIN4-PERP';
  MID = 100;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: true, size: 1 }, 'testnet');
  MID = 90;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: false, size: 1, reduceOnly: true }, 'testnet');
  MID = 100;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: true, size: 1 }, 'testnet');
  MID = 95;
  await broker.placeMarketOrder({ masterAddress: M, coin: COIN, isBuy: false, size: 1, reduceOnly: true }, 'testnet');

  // Con `sinceTs` 0 la finestra parte da zero e il PRIMO fill è già un'apertura:
  // il taglio non interviene e le due chiusure si sommano, che è ciò che serve
  // ai chiamanti che chiedono l'aggregato (i test di `paperBrokerPartialTp`).
  const r = await broker.getRealizedPnl(M, COIN, 0);
  assert.equal(r.closingFills.length, 2, 'la storia completa resta completa');
});
