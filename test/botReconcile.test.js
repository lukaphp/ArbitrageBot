/**
 * SEC-08: `_reconcile()` non duplica la posizione, e l'adozione legittima resta.
 * ============================================================================
 *
 * Il bug, riprodotto su dati reali sul VPS il 9 agosto: `_reconcile()` trattava
 * OGNI posizione live senza `this.position` come "posizione estranea da
 * adottare" e ne inseriva una SECONDA riga in `positions` con tp_px/sl_px nulli
 * — anche quando quella posizione era la stessa che il bot stava aprendo (o
 * aveva già registrato) in quel momento. Risultato osservato: due righe per una
 * sola posizione da 1.31 SOL e tre trigger reduce-only vivi (1 TP + 2 SL).
 *
 * Quattro casi, che coprono i due lati del criterio: la race NON deve creare un
 * duplicato, e l'adozione legittima DEVE continuare a funzionare.
 *
 *  1. riga `open` già in DB + posizione live + `this.position === null`
 *     (istanza sostituita a metà tick, es. botManager.updateBot) → nessun
 *     duplicato, si riprende la riga esistente con i suoi TP/SL;
 *  2. apertura in corso nella stessa istanza (`_opening === true`), fill già
 *     avvenuto ma riga non ancora scritta → nessuna riga inserita affatto;
 *  3. adozione legittima (nessuna riga, nessuna apertura in corso): riga creata,
 *     TP/SL propri calcolati e persistiti, e i trigger stale preesistenti
 *     cancellati DOPO il piazzamento dei nuovi (place-then-cancel);
 *  4. la posizione adottata resta chiudibile: sparita dall'exchange, la riga
 *     passa a `closed` (il ramo di chiusura non è stato rotto dal fix).
 *
 * Seam di test: paperBroker + singleton DB redirezionato su file temporaneo,
 * come test/botDca.test.js. `_reconcile` è invocato direttamente con la
 * posizione live che `tick()` gli passerebbe: non si passa da `tick()` perché
 * quello orchestra marketData/predictor/portfolio (singleton con polling di
 * rete). Cosa NON è coperto: l'interleaving reale tra due istanze di PerpsBot
 * (vedi nota su botManager.updateBot nel report) — qui è riprodotto lo STATO
 * che quell'interleaving produce, non lo scheduling che lo genera.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';
import db from '../src/db/database.js';
import riskManager from '../src/perps/riskManager.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-reconcile-'));
db.dbPath = path.join(tempDir, 'perps.db');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'percent', value: 5 }
};

function makeBot(id, coin, master) {
  return new PerpsBot({
    id, name: `Bot ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(CONFIG)
  }, () => {});
}

const openRows = (botId, coin) => db.db
  .prepare(`SELECT * FROM positions WHERE bot_id = ? AND coin = ? AND status = 'open' ORDER BY id`)
  .all(botId, coin);

test('race: riga già in DB e this.position nullo → nessun duplicato, si riprende la riga esistente', async () => {
  const master = '0xREC1';
  const coin = 'REC1-PERP';
  const bot = makeBot('bot-rec-1', coin, master);

  // Stato lasciato da un'apertura andata a buon fine: fill sull'exchange + riga
  // in DB con TP/SL. `this.position` viene poi azzerato per riprodurre l'istanza
  // sostituita a metà tick (quella nuova nasce con position = null).
  MID = 100;
  const order = await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const entryPx = order.avgPx;
  const { tpPx, slPx } = riskManager.computeTpSl(entryPx, 'long', CONFIG);
  const posId = db.insertPosition({ botId: bot.id, coin, side: 'long', size: 1, entryPx, leverage: 1, tpPx, slPx });
  bot.position = null;

  const account = await paperBroker.getAccount(master, 'testnet');
  const livePos = account.positions.find(p => p.coin === coin);
  assert.ok(livePos, 'posizione live presente sul broker simulato');

  await bot._reconcile(livePos, { price: MID, candles: [] });

  const rows = openRows(bot.id, coin);
  assert.equal(rows.length, 1, 'una sola riga aperta: nessun duplicato inserito da _reconcile');
  assert.equal(rows[0].id, posId, 'è la riga originale, non una nuova');
  assert.equal(bot.position.id, posId, 'lo stato in memoria è riagganciato alla riga esistente');
  assert.ok(Math.abs(bot.position.tpPx - tpPx) < 1e-9, 'TP della riga originale conservato (mai azzerato a null)');
  assert.ok(Math.abs(bot.position.slPx - slPx) < 1e-9, 'SL della riga originale conservato (mai azzerato a null)');
  assert.equal(bot.position.size, livePos.size, 'size allineata alla posizione live');
});

test('race: apertura in corso nella stessa istanza (_opening) → nessuna riga inserita', async () => {
  const master = '0xREC2';
  const coin = 'REC2-PERP';
  const bot = makeBot('bot-rec-2', coin, master);

  // Finestra interna a `_openPosition`: l'ordine si è riempito sull'exchange ma
  // né la riga in DB né `this.position` esistono ancora.
  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  bot.position = null;
  bot._opening = true;

  const account = await paperBroker.getAccount(master, 'testnet');
  const livePos = account.positions.find(p => p.coin === coin);

  await bot._reconcile(livePos, { price: MID, candles: [] });

  assert.equal(openRows(bot.id, coin).length, 0, 'nessuna riga creata: l\'apertura in corso è la proprietaria dello stato');
  assert.equal(bot.position, null, 'nessuna posizione adottata a metà apertura');
});

test('adozione legittima: riga creata con TP/SL propri e trigger stale cancellati dopo i nuovi', async () => {
  const master = '0xREC3';
  const coin = 'REC3-PERP';
  const bot = makeBot('bot-rec-3', coin, master);

  // Posizione aperta fuori dal bot (o ritrovata al riavvio senza stato locale),
  // con un trigger stale già sul book piazzato da chi l'ha aperta.
  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const stale = await paperBroker.placeTriggerOrder(
    { masterAddress: master, coin, isBuy: false, size: 1, triggerPx: 80, tpsl: 'sl' }, 'testnet');

  const account = await paperBroker.getAccount(master, 'testnet');
  const livePos = account.positions.find(p => p.coin === coin);
  assert.equal(bot.position, null, 'nessuno stato locale: è il caso di adozione');

  await bot._reconcile(livePos, { price: MID, candles: [] });

  const rows = openRows(bot.id, coin);
  assert.equal(rows.length, 1, 'la posizione non tracciata è stata adottata (funzionalità preservata)');
  assert.ok(bot.position, 'stato in memoria popolato');
  assert.equal(bot.position.side, 'long');
  assert.equal(bot.position.size, livePos.size);

  const expected = riskManager.computeTpSl(livePos.entryPx, 'long', CONFIG);
  assert.ok(Math.abs(bot.position.tpPx - expected.tpPx) < 1e-9, 'TP proprio calcolato all\'adozione');
  assert.ok(Math.abs(bot.position.slPx - expected.slPx) < 1e-9, 'SL proprio calcolato all\'adozione');
  assert.ok(rows[0].tp_px != null && rows[0].sl_px != null, 'TP/SL persistiti: mai null permanente sulla riga adottata');
  assert.ok(Math.abs(rows[0].tp_px - expected.tpPx) < 1e-9);
  assert.ok(Math.abs(rows[0].sl_px - expected.slPx) < 1e-9);

  const trailing = JSON.parse(rows[0].trailing_json || '{}');
  assert.equal(trailing.originalEntryPx, livePos.entryPx, 'originalEntryPx persistito (soglie DCA ancorate all\'ingresso)');
  assert.equal(trailing.dcaCount, 0);

  const orders = await paperBroker.getFrontendOpenOrders(master);
  const tps = orders.filter(o => /take profit/i.test(o.orderType));
  const sls = orders.filter(o => /stop/i.test(o.orderType));
  assert.equal(tps.length, 1, 'un solo TP attivo sul book');
  assert.equal(sls.length, 1, 'un solo SL attivo sul book: nessun ordine orfano');
  assert.ok(!orders.some(o => o.oid === stale.oid), 'il trigger stale preesistente è stato cancellato');
  assert.equal(sls[0].oid, bot.position.slOid, 'l\'SL vivo è quello nuovo, tracciato in memoria');
  assert.equal(sls[0].triggerPx, client.roundPx(expected.slPx));
  assert.equal(tps[0].sz, livePos.size, 'trigger dimensionati sulla size reale della posizione');
  assert.equal(sls[0].sz, livePos.size);
});

test('SL orfani: due stop loss vivi per una sola posizione → resta solo quello tracciato', async () => {
  const master = '0xREC5';
  const coin = 'REC5-PERP';
  const bot = makeBot('bot-rec-5', coin, master);

  // Stato osservato sul VPS: posizione tracciata regolarmente e DUE SL vivi
  // sull'exchange (il secondo lasciato indietro da un ri-piazzamento).
  MID = 100;
  const order = await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const entryPx = order.avgPx;
  const { tpPx, slPx } = riskManager.computeTpSl(entryPx, 'long', CONFIG);
  const posId = db.insertPosition({ botId: bot.id, coin, side: 'long', size: 1, entryPx, leverage: 1, tpPx, slPx });
  bot.position = {
    id: posId, side: 'long', size: 1, entryPx,
    originalEntryPx: entryPx, dcaCount: 0, tpPx, slPx, slOid: null, openedAt: Date.now()
  };
  await bot._placeTpSl();
  const trackedOid = bot.position.slOid;
  const orphan = await paperBroker.placeTriggerOrder(
    { masterAddress: master, coin, isBuy: false, size: 1, triggerPx: slPx - 0.002, tpsl: 'sl' }, 'testnet');
  assert.equal((await paperBroker.getFrontendOpenOrders(master)).filter(o => /stop/i.test(o.orderType)).length, 2,
    'punto di partenza: due SL vivi');

  await bot._ensureStopLoss();

  const orders = await paperBroker.getFrontendOpenOrders(master);
  const sls = orders.filter(o => /stop/i.test(o.orderType));
  assert.equal(sls.length, 1, 'un solo SL resta vivo');
  assert.equal(sls[0].oid, trackedOid, 'è quello tracciato in memoria, non l\'orfano');
  assert.ok(!orders.some(o => o.oid === orphan.oid), 'l\'SL orfano è stato cancellato');
  assert.equal(orders.filter(o => /take profit/i.test(o.orderType)).length, 1,
    'il TP non viene toccato dalla pulizia degli SL');
  assert.equal(bot.position.slOid, trackedOid, 'lo stato in memoria continua a puntare all\'SL vivo');
});

test('posizione adottata poi sparita dall\'exchange → riga chiusa (ramo di chiusura intatto)', async () => {
  const master = '0xREC4';
  const coin = 'REC4-PERP';
  const bot = makeBot('bot-rec-4', coin, master);

  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  let account = await paperBroker.getAccount(master, 'testnet');
  await bot._reconcile(account.positions.find(p => p.coin === coin), { price: MID, candles: [] });
  const adoptedId = bot.position.id;

  // Chiusura esterna alla logica del bot (TP/SL scattati o chiusura manuale).
  await paperBroker.closePosition({ masterAddress: master, coin }, 'testnet');
  account = await paperBroker.getAccount(master, 'testnet');
  assert.equal(account.positions.find(p => p.coin === coin), undefined, 'posizione non più live');

  await bot._reconcile(undefined, { price: MID, candles: [] });

  assert.equal(bot.position, null, 'stato locale azzerato dopo la chiusura');
  const row = db.getPosition(adoptedId);
  assert.equal(row.status, 'closed', 'la riga adottata viene chiusa, non resta aperta per sempre');
  assert.equal(openRows(bot.id, coin).length, 0);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
