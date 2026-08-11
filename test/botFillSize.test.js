/**
 * CRIT-01 — la size che il bot registra deve essere quella DAVVERO riempita.
 * =========================================================================
 *
 * `_openPosition()` scriveva `plan.size` (la size PIANIFICATA) in
 * `this.position`, nella riga `positions`, nel trade e nei trigger TP/SL, senza
 * mai leggere `order.totalSz` — che la risposta dell'exchange contiene già
 * (`hyperliquidClient._parseOrderResult`). Due conseguenze diverse:
 *
 *  1. FILL PARZIALE (`0 < totalSz < plan.size`): TP/SL vengono piazzati su una
 *     size maggiore di quella esistente. Su Hyperliquid sono reduce-only, quindi
 *     non aprono nulla al contrario — ma tutto il resto del sistema (DCA,
 *     statistiche, `_reconcile`) ragiona su una posizione più grande del vero.
 *  2. FILL NULLO (`totalSz` null/0, un IOC che non trova liquidità): il bot
 *     scriveva una posizione FANTASMA, mai esistita sull'exchange, con i suoi
 *     trigger. Caso trovato in fase di planning, non citato dall'audit.
 *
 * Lo stesso vale per il percorso DCA, dove un fill nullo faceva avanzare
 * `dcaCount` e spostare l'entry medio per un'aggiunta mai avvenuta.
 *
 * Seam di test: paperBroker (stato reale dei trigger) con il solo
 * `placeMarketOrder` sostituito da un fill parziale/nullo — l'unica cosa che un
 * broker simulato non può produrre da sé. DB singleton su file temporaneo, mai
 * data/perps.db. Stesso impianto di test/botTpSweep.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-fillsize-'));
db.dbPath = path.join(tempDir, 'perps.db');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

const BASE_CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 }, // 100$ × leva 1 @ 100 → size pianificata 1
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'percent', value: 5 }
};

/**
 * Broker che riempie `filledSz` invece della size richiesta.
 * `filledSz === null` = nessun fill (IOC senza liquidità): non tocca lo stato
 * del paper account, esattamente come un ordine mai eseguito sull'exchange.
 */
function brokerWithFill(filledSz) {
  const broker = Object.create(paperBroker); // eredita stato e resto dell'interfaccia
  broker.placeMarketOrder = async (params, network) => {
    if (filledSz == null || filledSz <= 0) {
      return { oid: null, avgPx: null, totalSz: filledSz, error: null, paper: true };
    }
    const real = await paperBroker.placeMarketOrder({ ...params, size: filledSz }, network);
    return { ...real, totalSz: filledSz };
  };
  return broker;
}

function makeBot(id, coin, master, config = BASE_CONFIG) {
  const bot = new PerpsBot({
    id, name: `Bot ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config)
  }, () => {});
  return bot;
}

const ACCOUNT = { equity: 10000, positions: [] };
const ordersOf = async (master) => paperBroker.getFrontendOpenOrders(master);
const tpsOf = (o) => o.filter(x => /take profit/i.test(x.orderType));
const slsOf = (o) => o.filter(x => /stop/i.test(x.orderType));

test('fill pieno: comportamento identico a prima (nessuna regressione)', async () => {
  const master = '0xFILL1';
  const coin = 'FILL1-PERP';
  const bot = makeBot('bot-fill-1', coin, master);
  bot.broker = brokerWithFill(1);

  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.ok(bot.position, 'posizione aperta');
  assert.equal(bot.position.size, 1, 'size = fill pieno');
  assert.equal(db.getOpenPositionByBot(bot.id).size, 1, 'riga DB con la size reale');
  const orders = await ordersOf(master);
  assert.equal(tpsOf(orders)[0].sz, 1, 'TP sulla size reale');
  assert.equal(slsOf(orders)[0].sz, 1, 'SL sulla size reale');
  assert.equal(notified.filter(t => /parzial|nessun fill/i.test(t)).length, 0,
    'nessuna notifica di anomalia su un fill pieno');
});

test('fill parziale: posizione, riga DB e TP/SL usano totalSz, non plan.size', async () => {
  const master = '0xFILL2';
  const coin = 'FILL2-PERP';
  const bot = makeBot('bot-fill-2', coin, master);
  bot.broker = brokerWithFill(0.4); // pianificata 1, riempita 0.4

  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.ok(bot.position, 'la posizione esiste: un fill parziale è comunque una posizione reale');
  assert.equal(bot.position.size, 0.4, 'stato in memoria sulla size riempita');
  assert.equal(db.getOpenPositionByBot(bot.id).size, 0.4, 'riga DB sulla size riempita');

  const orders = await ordersOf(master);
  assert.equal(tpsOf(orders).length, 1);
  assert.equal(tpsOf(orders)[0].sz, 0.4, 'TP dimensionato sul fill reale');
  assert.equal(slsOf(orders)[0].sz, 0.4, 'SL dimensionato sul fill reale');

  const trade = db.listTrades(1)[0];
  assert.equal(trade.sz, 0.4, 'il trade registra la size eseguita');

  const partial = notified.find(t => /parzial/i.test(t));
  assert.ok(partial, 'un fill parziale non passa in silenzio: notificato');
  assert.match(partial, /1/, 'la notifica riporta la size pianificata');
  assert.match(partial, /0\.4/, 'e quella riempita');
});

test('fill nullo: nessuna posizione fantasma in memoria, in DB o sul book', async () => {
  const master = '0xFILL3';
  const coin = 'FILL3-PERP';
  const bot = makeBot('bot-fill-3', coin, master);
  bot.broker = brokerWithFill(null); // IOC senza riempimento

  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.equal(bot.position, null, 'nessuna posizione in memoria');
  assert.equal(db.getOpenPositionByBot(bot.id), undefined, 'nessuna riga aperta in DB');
  assert.deepEqual(await ordersOf(master), [], 'nessun TP/SL per una posizione inesistente');
  assert.equal(db.listTradesBy({ botId: bot.id }).length, 0, 'nessun trade registrato');
  assert.ok(notified.some(t => /nessun fill/i.test(t)), 'notifica dedicata al fill nullo');
  assert.equal(bot._opening, false, 'il flag di apertura è rilasciato comunque');
});

test('DCA con fill parziale: entry medio e TP/SL sulla size davvero aggiunta', async () => {
  const master = '0xFILL4';
  const coin = 'FILL4-PERP';
  const config = { ...BASE_CONFIG, dca: { steps: 2, stepPercent: 2, sizeMultiplier: 1 } };
  const bot = makeBot('bot-fill-4', coin, master, config);

  MID = 100;
  bot.broker = brokerWithFill(1);
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);
  assert.equal(bot.position.size, 1);
  const entryBefore = bot.position.entryPx;

  // Prezzo contro del 3% (soglia step 1 = 2%): il DCA scatta con addSize 1,
  // ma l'exchange riempie solo 0.5.
  MID = 97;
  bot.broker = brokerWithFill(0.5);
  notified.length = 0;
  await bot._maybeDca({ price: MID, candles: [] });

  assert.equal(bot.position.dcaCount, 1, 'lo step di DCA è stato consumato');
  assert.equal(bot.position.size, 1.5, 'size totale = 1 + 0.5 riempita (non 1 + 1 pianificata)');
  assert.ok(bot.position.entryPx < entryBefore, 'entry medio abbassato dal fill a prezzo inferiore');
  // Media ponderata sulla size REALE: (entryBefore*1 + fillPx*0.5) / 1.5
  const fillPx = db.listTradesBy({ botId: bot.id, limit: 1 })[0].px;
  assert.ok(Math.abs(bot.position.entryPx - (entryBefore * 1 + fillPx * 0.5) / 1.5) < 1e-9,
    'entry medio calcolato sulla size aggiunta reale');

  const orders = await ordersOf(master);
  assert.equal(slsOf(orders)[0].sz, 1.5, 'SL ri-piazzato sulla size totale reale');
  assert.equal(tpsOf(orders)[0].sz, 1.5, 'TP ri-piazzato sulla size totale reale');
});

test('DCA con fill nullo: nessuna aggiunta registrata, nessuno step consumato', async () => {
  const master = '0xFILL5';
  const coin = 'FILL5-PERP';
  const config = { ...BASE_CONFIG, dca: { steps: 2, stepPercent: 2, sizeMultiplier: 1 } };
  const bot = makeBot('bot-fill-5', coin, master, config);

  MID = 100;
  bot.broker = brokerWithFill(1);
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);
  const sizeBefore = bot.position.size;
  const entryBefore = bot.position.entryPx;
  const tradesBefore = db.listTradesBy({ botId: bot.id }).length;

  MID = 97;
  bot.broker = brokerWithFill(null);
  notified.length = 0;
  await bot._maybeDca({ price: MID, candles: [] });

  assert.equal(bot.position.dcaCount, 0, 'nessuno step di DCA consumato per un\'aggiunta mai avvenuta');
  assert.equal(bot.position.size, sizeBefore, 'size invariata');
  assert.equal(bot.position.entryPx, entryBefore, 'entry medio invariato');
  assert.equal(db.listTradesBy({ botId: bot.id }).length, tradesBefore, 'nessun trade fantasma');
  assert.ok(notified.some(t => /nessun fill/i.test(t)), 'il DCA non riempito viene notificato');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
