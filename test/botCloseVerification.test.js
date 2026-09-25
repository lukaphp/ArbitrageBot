/**
 * CRIT-CLOSEFAKE-25 — una chiusura "riuscita" che non ha chiuso niente.
 * =====================================================================
 *
 * Caso reale (NEAR-PERP, 2026-09-25, testnet). `_closeNow` inviava il market
 * reduce-only e registrava SUBITO la chiusura: `_registerClose` scriveva la
 * riga `positions` come `closed` con un PnL preso dall'ultimo unrealized noto,
 * e `this.position` veniva azzerato. Ma su un book sottile Hyperliquid non
 * lancia nessuna eccezione — RISOLVE con l'ordine rifiutato:
 *
 *   { status: "ok", oid: null, avgPx: null, totalSz: null,
 *     error: "Order could not immediately match against any resting orders" }
 *
 * Il `try/catch` non vedeva niente. Risultato misurato: 4 chiusure FITTIZIE in
 * ~1 minuto (DB con posizione chiusa e PnL inventato, exchange con la posizione
 * intatta), ognuna seguita da `_reconcile` che ritrovava la posizione vera, la
 * adottava come "non tracciata", ri-piazzava TP/SL da zero e faceva ripartire
 * la guardia SL → di nuovo `_closeNow`.
 *
 * Le proprietà verificate qui:
 *  1. il calcolo puro che INTERPRETA la risposta (`riskManager.interpretCloseResult`);
 *  2. rifiuto totale → nessuna chiusura registrata, posizione ancora tracciata
 *     in memoria E ancora `open` in DB, log + notifica;
 *  3. ritentativo al TICK SUCCESSIVO (non in loop stretto) e notifica esplicita
 *     dopo 3 tentativi consecutivi, UNA volta sola;
 *  4. fill PARZIALE → la posizione non sparisce, resta con la size residua;
 *  5. successo pieno → comportamento invariato, PnL REALE dai fill;
 *  6. il tutto vale per OGNI chiamante di `_closeNow` (guardia SL e uscita su
 *     regola di strategia), perché il difetto era in `_closeNow`, non nel
 *     percorso CRIT-SLSTALE-25 che lo ha fatto emergere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import riskManager, { interpretCloseResult } from '../src/perps/riskManager.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-closefake-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

/** La risposta ESATTA arrivata da Hyperliquid il 25/09 su NEAR. */
const RIFIUTO_REALE = {
  status: 'ok', oid: null, avgPx: null, totalSz: null,
  error: 'Order could not immediately match against any resting orders'
};

const CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  sl: { enabled: true, mode: 'percent', value: 5 }
};

/**
 * Broker che risponde alla chiusura con quello che gli si dice.
 * `esito` può essere un valore, una funzione (nTentativo) => valore, o un
 * Error da lanciare.
 */
function brokerConEsito(calls, esito, pnlReale = { net: 8.4, fee: 0.3, closingFills: [] }) {
  return {
    async getFrontendOpenOrders() { calls.readOrders++; return []; },
    async placeTriggerOrder() { calls.placeTrigger++; return { oid: 4242 }; },
    async cancelOrder() { calls.cancel++; return { ok: true }; },
    async closePosition() {
      calls.close++;
      const r = typeof esito === 'function' ? esito(calls.close) : esito;
      if (r instanceof Error) throw r;
      return r;
    },
    async getRealizedPnl() { calls.pnl++; return pnlReale; },
    async placeMarketOrder() { calls.market++; return { oid: 1, avgPx: 100, totalSz: 0 }; },
    async setLeverage() { return { ok: true }; }
  };
}

function nuoveCalls() {
  return { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0, pnl: 0, market: 0 };
}

/**
 * Bot con una posizione short da 99.9 (la size reale del caso NEAR) e SL a 105:
 * con prezzo 112 lo stop risulta superato, che è il percorso CRIT-SLSTALE-25.
 */
function botConPosizione(id, calls, { side = 'short', size = 99.9, slPx = 105 } = {}) {
  const coin = `${id.toUpperCase()}-PERP`;
  const bot = new PerpsBot({
    id, name: `CloseFake ${id}`, coin, network: 'testnet',
    master_address: '0xCLOSEFAKE', config_json: JSON.stringify(CONFIG)
  }, () => {});
  bot.broker = brokerConEsito(calls, RIFIUTO_REALE);
  const posId = db.insertPosition({
    botId: id, coin, side, size, entryPx: 100, leverage: 1, tpPx: null, slPx
  });
  bot.position = {
    id: posId, side, size, entryPx: 100, originalEntryPx: 100, dcaCount: 0,
    tpPx: null, slPx, slOid: null, tpOids: [], openedAt: Date.now(),
    // Valore assurdo di proposito: è il numero che il bug scriveva in DB come
    // "PnL" della chiusura fittizia. Se ricompare, il fallback è ancora in uso.
    lastUnrealized: -999
  };
  return bot;
}

const SNAPSHOT = { price: 112, candles: [] };

// ---- 1) Calcolo puro ----------------------------------------------------

test('interpretCloseResult: la risposta REALE di rifiuto non è un successo', () => {
  const v = interpretCloseResult(RIFIUTO_REALE, 99.9);
  assert.equal(v.outcome, 'rejected');
  assert.match(v.reason, /could not immediately match/);
  assert.equal(v.filled, 0);
});

test('interpretCloseResult: oid nullo è conclusivo anche senza messaggio di errore', () => {
  // Stesso principio di WARN-06 su placeTriggerOrder: nessun oid = non accettato.
  assert.equal(interpretCloseResult({ status: 'ok', oid: null }, 10).outcome, 'rejected');
  assert.equal(interpretCloseResult(null, 10).outcome, 'rejected');
  assert.equal(interpretCloseResult(undefined, 10).outcome, 'rejected');
  // oid valido ma zero size riempita: l'ordine esiste e non ha chiuso nulla.
  assert.equal(interpretCloseResult({ oid: 7, totalSz: 0 }, 10).outcome, 'rejected');
});

test('interpretCloseResult: fill PARZIALE → size residua, non chiusura', () => {
  // I numeri del trigger NEAR del 25/09: 2.1 riempiti su 99.9.
  const v = interpretCloseResult({ oid: 61011448838, avgPx: 5.04, totalSz: 2.1 }, 99.9);
  assert.equal(v.outcome, 'partial');
  assert.equal(v.filled, 2.1);
  assert.equal(v.remaining, 97.8, 'la size residua non deve trascinarsi errori di virgola mobile');
});

test('interpretCloseResult: fill totale → chiusura', () => {
  const v = interpretCloseResult({ oid: 1, avgPx: 5.04, totalSz: 99.9 }, 99.9);
  assert.equal(v.outcome, 'closed');
  assert.equal(v.remaining, 0);
  // Residuo infinitesimo (arrotondamento di szDecimals): non è un fill parziale.
  assert.equal(interpretCloseResult({ oid: 1, totalSz: 99.89999999 }, 99.9).outcome, 'closed');
  // Più del richiesto non è un errore da trattare a parte.
  assert.equal(interpretCloseResult({ oid: 1, totalSz: 100 }, 99.9).outcome, 'closed');
});

test('interpretCloseResult: broker che NON riporta la size (paperBroker) → si crede all\'oid', () => {
  // `paperBroker.closePosition` ritorna { oid, avgPx, error: null }: assenza di
  // totalSz significa "non riportata", non "zero riempito".
  const v = interpretCloseResult({ oid: 55, avgPx: 100, error: null, paper: true }, 99.9);
  assert.equal(v.outcome, 'closed');
  assert.equal(v.sizeKnown, false);
  // Disponibile anche dal singleton, come gli altri calcoli di rischio.
  assert.equal(riskManager.interpretCloseResult(RIFIUTO_REALE, 99.9).outcome, 'rejected');
});

// ---- 2) Rifiuto totale, percorso guardia SL (CRIT-SLSTALE-25) -----------

test('RIFIUTO · guardia SL: nessuna chiusura registrata, posizione ancora tracciata', async () => {
  const calls = nuoveCalls();
  const bot = botConPosizione('closefake-sl', calls);
  const posId = bot.position.id;
  notified.length = 0;

  await bot._ensureStopLoss(null, SNAPSHOT.price);

  assert.equal(calls.close, 1, 'la chiusura va tentata');
  assert.ok(bot.position, 'la posizione NON deve sparire dalla memoria: sull\'exchange è ancora aperta');
  assert.equal(bot.position.size, 99.9, 'size invariata: non è stato riempito nulla');

  const row = db.getPosition(posId);
  assert.equal(row.status, 'open', 'la riga in DB deve restare aperta, non "closed" con un PnL inventato');
  assert.equal(row.pnl, 0);
  assert.equal(row.close_reason, null);
  assert.equal(calls.pnl, 0, '_registerClose non deve nemmeno essere chiamato');

  const avviso = notified.filter(t => /NON eseguita/i.test(t));
  assert.equal(avviso.length, 1, `serve una notifica di chiusura fallita — ricevute: ${JSON.stringify(notified)}`);
  assert.match(avviso[0], /could not immediately match/, 'la notifica deve riportare il motivo vero del rifiuto');
  assert.ok(!notified.some(t => /ha chiuso/.test(t)), 'nessuna notifica di chiusura avvenuta');
});

// ---- 3) Rifiuto totale, percorso USCITA SU REGOLA (chiamante diverso) ---

test('RIFIUTO · uscita su regola di strategia: stesso comportamento (il fix è in _closeNow)', async () => {
  const calls = nuoveCalls();
  const bot = botConPosizione('closefake-rule', calls);
  const posId = bot.position.id;
  notified.length = 0;

  await bot._manageOpen(SNAPSHOT, {}, { action: 'close', reason: 'regola di uscita: rsi > 70' });

  assert.equal(calls.close, 1);
  assert.ok(bot.position, 'anche l\'uscita "normale" non può dare per chiusa una posizione che non lo è');
  assert.equal(db.getPosition(posId).status, 'open');
  assert.equal(calls.readOrders, 0, 'l\'uscita su regola non passa dalla guardia SL: è un chiamante distinto');
  assert.ok(notified.some(t => /NON eseguita/i.test(t)));
});

// ---- 4) Ritentativo al tick successivo + escalation dopo 3 tentativi ----

test('RITENTATIVO: al tick successivo si riprova, e dopo 3 tentativi consecutivi si avvisa UNA volta', async () => {
  const calls = nuoveCalls();
  const bot = botConPosizione('closefake-retry', calls);
  notified.length = 0;

  // Prezzo DENTRO la soglia di stop (105): la guardia SL qui non chiuderebbe
  // niente — si limiterebbe a ri-piazzare il trigger mancante. Se i tentativi
  // successivi al primo avvengono lo stesso, è perché l'INTENZIONE di chiudere
  // è rimasta pendente, non perché un altro guardiano l'ha richiesta di nuovo.
  const snapshotSenzaBreach = { price: 101, candles: [] };

  // Tick 1: uscita su regola di strategia.
  await bot._manageOpen(snapshotSenzaBreach, {}, { action: 'close', reason: 'regola di uscita: rsi > 70' });
  assert.equal(calls.close, 1);

  // Tick 2 e 3: la strategia dice "hold", ma la chiusura decisa e mai eseguita
  // va ritentata comunque — una volta per tick, non in loop stretto.
  await bot._manageOpen(snapshotSenzaBreach, {}, { action: 'hold' });
  assert.equal(calls.close, 2, 'il ritentativo non dipende dal chiamante che aveva chiesto la chiusura');
  await bot._manageOpen(snapshotSenzaBreach, {}, { action: 'hold' });
  assert.equal(calls.close, 3);
  assert.equal(calls.readOrders, 0,
    'nessun altro guardiano è intervenuto: i tentativi vengono tutti dalla chiusura pendente');
  assert.equal(calls.placeTrigger, 0,
    'e su una posizione che stiamo chiudendo non si piazzano trigger nuovi');

  assert.ok(bot.position, 'dopo tre rifiuti la posizione è ancora lì, e il bot deve saperlo');

  const escalation = notified.filter(t => /3 tentativi consecutivi/.test(t));
  assert.equal(escalation.length, 1,
    `una sola notifica di escalation dopo 3 tentativi — ricevute: ${JSON.stringify(notified)}`);
  assert.match(escalation[0], /manualmente/i, 'deve dire chiaramente che serve un intervento');

  // Una notifica per EPISODIO, non per tentativo: il primo rifiuto + l'escalation.
  const perTentativo = notified.filter(t => /NON eseguita/i.test(t));
  assert.equal(perTentativo.length, 1, 'il messaggio del primo rifiuto non va ripetuto a ogni tick');

  // Tick 4: si continua a ritentare, ma senza aggiungere altro rumore.
  await bot._manageOpen(snapshotSenzaBreach, {}, { action: 'hold' });
  assert.equal(calls.close, 4, 'si continua a riprovare');
  assert.equal(notified.filter(t => /tentativi consecutivi/.test(t)).length, 1,
    'l\'escalation non si ripete a ogni tick successivo');
});

// ---- 5) Fill parziale ---------------------------------------------------

test('PARZIALE: la posizione resta tracciata con la size RESIDUA, non sparisce', async () => {
  const calls = nuoveCalls();
  const bot = botConPosizione('closefake-partial', calls);
  const posId = bot.position.id;
  bot.broker = brokerConEsito(calls, { oid: 61011448838, avgPx: 5.04, totalSz: 2.1, error: null });
  notified.length = 0;

  await bot._ensureStopLoss(null, SNAPSHOT.price);

  assert.ok(bot.position, 'un fill parziale NON è una chiusura');
  assert.equal(bot.position.size, 97.8, 'la size in memoria deve essere quella residua');
  const row = db.getPosition(posId);
  assert.equal(row.status, 'open');
  assert.equal(row.size, 97.8, 'anche in DB: la riga resta aperta sulla size residua');

  const avviso = notified.filter(t => /in parte/i.test(t));
  assert.equal(avviso.length, 1, `serve una notifica di fill parziale — ricevute: ${JSON.stringify(notified)}`);
  assert.match(avviso[0], /97\.8/, 'la notifica deve dire quanto resta aperto');
  assert.match(avviso[0], /2\.1/, 'e quanto è stato effettivamente chiuso');

  // E al tick successivo si riprova a chiudere il residuo.
  await bot._manageOpen(SNAPSHOT, {}, { action: 'hold' });
  assert.equal(calls.close, 2);
});

// ---- 6) Successo pieno: comportamento invariato -------------------------

test('SUCCESSO: chiusura registrata con il PnL REALE dai fill, posizione azzerata', async () => {
  const calls = nuoveCalls();
  const bot = botConPosizione('closefake-ok', calls);
  const posId = bot.position.id;
  bot.broker = brokerConEsito(calls, { oid: 61011500000, avgPx: 5.04, totalSz: 99.9, error: null });
  notified.length = 0;

  await bot._ensureStopLoss(null, SNAPSHOT.price);

  assert.equal(bot.position, null, 'chiusura vera: la posizione non è più tracciata');
  const row = db.getPosition(posId);
  assert.equal(row.status, 'closed');
  assert.equal(row.pnl, 8.4, 'PnL dai fill reali, non il lastUnrealized di fallback');
  assert.notEqual(row.pnl, -999);
  assert.ok(notified.some(t => /ha chiuso/.test(t)), 'la notifica di chiusura resta quella di sempre');
});

test('SUCCESSO dopo dei rifiuti: i contatori si azzerano (un nuovo episodio riavvisa)', async () => {
  const calls = nuoveCalls();
  const bot = botConPosizione('closefake-recover', calls);
  // Rifiuto al primo tentativo, successo al secondo.
  bot.broker = brokerConEsito(calls, (n) => (n === 1
    ? RIFIUTO_REALE
    : { oid: 9, avgPx: 5.04, totalSz: 99.9, error: null }));
  notified.length = 0;

  await bot._manageOpen(SNAPSHOT, {}, { action: 'hold' });   // rifiuto
  assert.ok(bot.position);
  await bot._manageOpen(SNAPSHOT, {}, { action: 'hold' });   // successo
  assert.equal(bot.position, null);
  assert.equal(bot._closeFailures, 0, 'contatore azzerato dopo una chiusura vera');
  assert.equal(bot._pendingClose, null, 'nessuna chiusura pendente residua');
});

// ---- 7) Eccezione del broker: resta un esito INCERTO, non una chiusura --

test('ECCEZIONE del broker: non si registra nulla, si riprova (un errore non è una chiusura)', async () => {
  const calls = nuoveCalls();
  const bot = botConPosizione('closefake-throw', calls);
  const posId = bot.position.id;
  bot.broker = brokerConEsito(calls, new Error('HTTP 502 da Hyperliquid'));
  notified.length = 0;

  await bot._ensureStopLoss(null, SNAPSHOT.price);

  assert.ok(bot.position, 'un timeout/errore non dice che la posizione è chiusa');
  assert.equal(db.getPosition(posId).status, 'open');
  assert.ok(notified.some(t => /502/.test(t)), 'il motivo va riportato all\'operatore');
});
