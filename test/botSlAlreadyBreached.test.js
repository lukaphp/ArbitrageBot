/**
 * CRIT-SLSTALE-25 — la guardia SL non ri-piazza un trigger che il mercato ha
 * già superato.
 * ==========================================================================
 *
 * Caso reale (NEAR-PERP, 2026-09-25, testnet). Uno stop market su un book
 * sottile TRIGGERA correttamente — direzione giusta, `side: "B"`, fill "Close
 * Short" — ma riempie solo una frazione della size (2,1 unità su 99,9); il
 * resto viene scartato e la posizione resta aperta e senza protezione. Al tick
 * successivo `_ensureStopLoss` non trova nessuno stop sul book e lo ri-piazza
 * allo STESSO `slPx`, che ormai il prezzo si è lasciato alle spalle.
 *
 * Il ciclo si è ripetuto quattro volte in 51 secondi (oid 60957635783 →
 * 61011448838 → 61011476752 → 61011487298) e si è fermato su un trigger a
 * 5,0417 rimasto inerte per oltre 4 ore con il mark a 5,3586: la guardia
 * contava la posizione come "protezione ripristinata" mentre non lo era.
 *
 * La proprietà verificata qui è una sola: quando la condizione di stop è GIÀ
 * soddisfatta al prezzo corrente, l'azione corretta non è piazzare un trigger
 * (che al massimo resterà inerte) ma fare subito ciò che quel trigger avrebbe
 * dovuto fare — chiudere. E dirlo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import riskManager, { isStopBreached } from '../src/perps/riskManager.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-slstale-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

const CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  sl: { enabled: true, mode: 'percent', value: 5 }
};

/** Broker senza trigger sul book: ogni chiamata è contata. */
function brokerVuoto(calls) {
  return {
    async getFrontendOpenOrders() { calls.readOrders++; return []; },
    async placeTriggerOrder() { calls.placeTrigger++; return { oid: 4242 }; },
    async cancelOrder() { calls.cancel++; return { ok: true }; },
    async closePosition() { calls.close++; return { oid: 999, avgPx: 0 }; },
    async getRealizedPnl() { return null; },
    async setLeverage() { return { ok: true }; }
  };
}

function botConPosizione(id, side, slPx, calls) {
  const coin = `${id.toUpperCase()}-PERP`;
  const bot = new PerpsBot({
    id, name: `SLStale ${id}`, coin, network: 'testnet',
    master_address: '0xSLSTALE', config_json: JSON.stringify(CONFIG)
  }, () => {});
  bot.broker = brokerVuoto(calls);
  const entryPx = side === 'short' ? 100 : 100;
  const posId = db.insertPosition({
    botId: id, coin, side, size: 10, entryPx, leverage: 1, tpPx: null, slPx
  });
  bot.position = {
    id: posId, side, size: 10, entryPx, originalEntryPx: entryPx,
    dcaCount: 0, tpPx: null, slPx, slOid: null, tpOids: [], openedAt: Date.now()
  };
  return bot;
}

// ---- Calcolo puro -------------------------------------------------------

test('isStopBreached: short superato sopra soglia, long superato sotto soglia', () => {
  assert.equal(isStopBreached({ side: 'short', price: 5.3586, slPx: 5.0417 }).breached, true);
  assert.equal(isStopBreached({ side: 'short', price: 4.9, slPx: 5.0417 }).breached, false);
  assert.equal(isStopBreached({ side: 'long', price: 2500, slPx: 2619 }).breached, true);
  assert.equal(isStopBreached({ side: 'long', price: 2700, slPx: 2619 }).breached, false);
  // Il contatto esatto con la soglia è già un superamento: è la condizione con
  // cui Hyperliquid stessa fa scattare il trigger ("Price above/below X").
  assert.equal(isStopBreached({ side: 'short', price: 5.0417, slPx: 5.0417 }).breached, true);
  assert.equal(isStopBreached({ side: 'long', price: 2619, slPx: 2619 }).breached, true);
});

test('isStopBreached: ingressi inservibili → non si dichiara "non superato"', () => {
  for (const input of [
    { side: 'short', price: NaN, slPx: 5 },
    { side: 'short', price: 5, slPx: undefined },
    { side: undefined, price: 5, slPx: 4 },
    { side: 'short', price: 0, slPx: 4 }
  ]) {
    const v = isStopBreached(input);
    assert.equal(v.known, false, `known deve essere false per ${JSON.stringify(input)}`);
    assert.equal(v.breached, false);
    assert.match(v.reason, /non verificabile/);
  }
  // Disponibile anche dal singleton, come gli altri calcoli di rischio.
  assert.equal(riskManager.isStopBreached({ side: 'short', price: 6, slPx: 5 }).breached, true);
});

// ---- Orchestrazione nella guardia SL ------------------------------------

test('short con prezzo oltre lo SL: chiude, NON piazza un trigger inerte', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botConPosizione('slstale-short', 'short', 105, calls);
  notified.length = 0;

  await bot._ensureStopLoss(null, 112);

  assert.equal(calls.placeTrigger, 0, 'nessun trigger dietro al mercato');
  assert.equal(calls.close, 1, 'la posizione va chiusa subito');
  assert.equal(bot.position, null, 'posizione non più tracciata');
  assert.ok(
    notified.some(t => /superato/i.test(t)),
    `la notifica deve dire che lo stop era già superato — ricevute: ${JSON.stringify(notified)}`
  );
});

test('long con prezzo sotto lo SL: chiude, NON piazza un trigger inerte', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botConPosizione('slstale-long', 'long', 95, calls);
  notified.length = 0;

  await bot._ensureStopLoss(null, 90);

  assert.equal(calls.placeTrigger, 0);
  assert.equal(calls.close, 1);
  assert.equal(bot.position, null);
});

test('prezzo ancora dentro la soglia: la guardia ri-piazza come sempre', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botConPosizione('slstale-ok', 'short', 105, calls);
  notified.length = 0;

  await bot._ensureStopLoss(null, 101);

  assert.equal(calls.placeTrigger, 1, 'lo SL mancante va ripiazzato');
  assert.equal(calls.close, 0, 'nessuna chiusura: il mercato non ha superato la soglia');
  assert.equal(bot.position.slOid, 4242);
});

test('prezzo non disponibile (percorso di riconciliazione): comportamento invariato', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botConPosizione('slstale-noprice', 'short', 105, calls);
  notified.length = 0;

  await bot._ensureStopLoss();

  assert.equal(calls.placeTrigger, 1, 'senza prezzo non si può sapere: si ripiazza come prima');
  assert.equal(calls.close, 0);
});

// ---- Il caso reale: lo stop c'è ANCORA, solo che è inerte ----------------
//
// NEAR, 2026-09-25: il trigger a 5,0417 non è mai sparito dal book — è
// rimasto lì, PRESENTE, per 4+ ore mentre il prezzo saliva a 5,3586. La FASE 1
// (`if (stops.length)`) lo trova, lo conta come "protezione tracciata" e
// ritorna PRIMA di arrivare al controllo di superamento della FASE 2 — che
// quindi non scatta mai finché un trigger, per quanto morto, resta sul book.
// Un trigger presente ma dietro al mercato è protezione tanto quanto uno
// assente: nessuno dei due fermerà la perdita.

/** Broker con UN trigger già sul book, con lo stesso side/prezzo del caso reale. */
function brokerConStopPresente(calls, { oid = 61011497599, triggerPx, coin } = {}) {
  return {
    async getFrontendOpenOrders() {
      calls.readOrders++;
      return [{ coin, isTrigger: true, orderType: 'Stop Market', oid, triggerPx }];
    },
    async placeTriggerOrder() { calls.placeTrigger++; return { oid: 4242 }; },
    async cancelOrder() { calls.cancel++; return { ok: true }; },
    async closePosition() { calls.close++; return { oid: 999, avgPx: 0 }; },
    async getRealizedPnl() { return null; },
    async setLeverage() { return { ok: true }; }
  };
}

test('SICUREZZA · short: lo stop è ANCORA SUL BOOK ma il prezzo l\'ha già superato — chiude comunque', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botConPosizione('slstale-present-short', 'short', 105, calls);
  bot.broker = brokerConStopPresente(calls, { triggerPx: 105, coin: bot.coin });
  bot.position.slOid = 61011497599;
  notified.length = 0;

  await bot._ensureStopLoss(null, 112); // ben oltre 105

  assert.equal(calls.close, 1,
    'un trigger presente ma superato non protegge nulla: va chiuso, non lasciato "tracciato"');
  assert.equal(bot.position, null, 'posizione non più tracciata');
});

test('SICUREZZA · long: lo stop è ANCORA SUL BOOK ma il prezzo l\'ha già superato — chiude comunque', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botConPosizione('slstale-present-long', 'long', 95, calls);
  bot.broker = brokerConStopPresente(calls, { triggerPx: 95, coin: bot.coin });
  bot.position.slOid = 61011497599;
  notified.length = 0;

  await bot._ensureStopLoss(null, 90); // ben sotto 95

  assert.equal(calls.close, 1);
  assert.equal(bot.position, null);
});

test('lo stop è presente e ancora davanti al mercato: nessuna chiusura, comportamento di sempre', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botConPosizione('slstale-present-ok', 'short', 105, calls);
  bot.broker = brokerConStopPresente(calls, { triggerPx: 105, coin: bot.coin });
  bot.position.slOid = 61011497599;
  notified.length = 0;

  await bot._ensureStopLoss(null, 101); // sotto la soglia: lo stop è ancora valido

  assert.equal(calls.close, 0, 'lo stop c\'è ed è ancora davanti al prezzo: non tocca nulla');
  assert.ok(bot.position, 'posizione ancora tracciata');
});
