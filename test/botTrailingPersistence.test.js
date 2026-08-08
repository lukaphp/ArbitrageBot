/**
 * TRAIL-01: `trailing_json` va in MERGE, non in overwrite.
 * =======================================================
 *
 * Tre punti di bot.js scrivevano `trailing_json` col solo `{ slOid }`,
 * cancellando `originalEntryPx` e `dcaCount` che il fix di SEC-01 salva nello
 * stesso campo. A runtime non si vedeva nulla (i valori restano corretti in
 * memoria); il guaio arrivava al RIAVVIO su una posizione che aveva già mediato:
 * `dcaCount` tornava a 0 e il bot poteva eseguire più step di DCA di quanti
 * configurati, impegnando capitale non previsto.
 *
 * Il test riproduce esattamente quella sequenza: apertura → DCA → aggiornamento
 * di trailing stop → **nuovo** PerpsBot sullo stesso DB (il riavvio) → verifica
 * che `dcaCount`/`originalEntryPx` siano sopravvissuti, e che un ulteriore step
 * di DCA oltre il limite configurato NON venga eseguito dopo il riavvio.
 *
 * Seam di test: paperBroker + singleton DB redirezionato su file temporaneo
 * (mai data/perps.db), stesso approccio di test/botDca.test.js.
 *
 * NOTA su cosa NON copre: come in test/botDca.test.js non si passa da
 * `tick()`/`_openPosition()` (marketData/predictor/portfolio sono singleton con
 * rete e notifiche reali). L'apertura è riprodotta con gli stessi passi che
 * `_openPosition` esegue; da lì in poi si esercitano i metodi reali
 * (`_maybeDca`, `_manageOpen`, `_ensureStopLoss`, `_placeTpSl`).
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-trail-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

/** Apre una posizione long riproducendo lo stato lasciato da _openPosition. */
async function openLong(bot, config, master, coin) {
  const order = await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const entryPx = order.avgPx;
  const { tpPx, slPx } = riskManager.computeTpSl(entryPx, 'long', config);
  const posId = db.insertPosition({ botId: bot.id, coin, side: 'long', size: 1, entryPx, leverage: 1, tpPx, slPx });
  bot.position = {
    id: posId, side: 'long', size: 1, entryPx,
    originalEntryPx: entryPx, dcaCount: 0, tpPx, slPx, slOid: null, openedAt: Date.now()
  };
  await bot._placeTpSl();
  return { posId, entryPx };
}

test('trailing dopo un DCA: originalEntryPx e dcaCount sopravvivono al riavvio', async () => {
  const master = '0xTRAIL1';
  const coin = 'TRAIL-PERP';
  const config = {
    paper: true,
    sizing: { mode: 'fixed', value: 100 },
    leverage: 1,
    tp: { enabled: true, mode: 'percent', value: 10 },
    sl: { enabled: true, mode: 'percent', value: 5 },
    trailing: { enabled: true, mode: 'percent', value: 3 },
    dca: { steps: 1, stepPercent: 2, sizeMultiplier: 1 }
  };
  const record = {
    id: 'bot-trail-1', name: 'Trailing Test Bot', coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config)
  };

  MID = 100;
  const bot = new PerpsBot(record, () => {});
  const { posId, entryPx } = await openLong(bot, config, master, coin);

  // --- DCA #1: prezzo sotto la soglia del 2% sull'ingresso originale ---
  MID = 97.5;
  await bot._maybeDca({ price: MID, candles: [] });
  assert.equal(bot.position.dcaCount, 1, 'precondizione: un DCA eseguito');
  const avgEntry = bot.position.entryPx;

  // Dopo _repriceTpSlAfterDca il campo è già scritto correttamente (SEC-01).
  let trailing = JSON.parse(db.getPosition(posId).trailing_json);
  assert.equal(trailing.dcaCount, 1);
  assert.equal(trailing.originalEntryPx, entryPx);

  // --- Aggiornamento di trailing stop: il prezzo risale, lo stop sale con lui.
  // È il percorso che PRIMA sovrascriveva trailing_json col solo { slOid }. ---
  MID = 100;
  const slBefore = bot.position.slPx;
  await bot._manageOpen({ price: MID, candles: [] }, {}, { action: 'hold' });
  assert.ok(bot.position.slPx > slBefore, 'precondizione: il trailing stop si è alzato');
  assert.equal(bot.position.dcaCount, 1, 'il trailing non tocca dcaCount in memoria');

  const row = db.getPosition(posId);
  trailing = JSON.parse(row.trailing_json);
  assert.ok(Math.abs(row.sl_px - bot.position.slPx) < 1e-9, 'sl_px persistito');
  assert.equal(trailing.slOid, bot.position.slOid, 'slOid persistito (serve al place-then-cancel)');
  assert.equal(trailing.dcaCount, 1,
    'dcaCount NON azzerato dalla scrittura del trailing (era il bug TRAIL-01)');
  assert.equal(trailing.originalEntryPx, entryPx,
    'originalEntryPx NON perso dalla scrittura del trailing');

  // --- RIAVVIO: nuovo PerpsBot sullo stesso DB ---
  const rebooted = new PerpsBot(record, () => {});
  assert.ok(rebooted.position, 'la posizione aperta viene ricaricata');
  assert.equal(rebooted.position.dcaCount, 1, 'dcaCount corretto dopo il riavvio');
  assert.equal(rebooted.position.originalEntryPx, entryPx,
    'originalEntryPx corretto dopo il riavvio (non ripiega sul prezzo medio)');
  assert.ok(Math.abs(rebooted.position.entryPx - avgEntry) < 1e-9, 'entry medio ricaricato');
  assert.equal(rebooted.position.slOid, bot.position.slOid, 'slOid ricaricato');

  // Conseguenza concreta del bug, non solo il campo: con steps=1 già consumato,
  // dopo il riavvio nessun ulteriore DCA deve partire nemmeno su un movimento
  // avverso ben oltre la soglia (prima ne partiva uno, capitale non previsto).
  const sizeBefore = rebooted.position.size;
  MID = 90;
  await rebooted._maybeDca({ price: MID, candles: [] });
  assert.equal(rebooted.position.dcaCount, 1, 'nessun DCA extra dopo il riavvio');
  assert.equal(rebooted.position.size, sizeBefore, 'size invariata: nessun capitale aggiuntivo impegnato');
});

test('trailing senza alcun DCA: nessuna regressione, slOid persistito e dcaCount a 0', async () => {
  const master = '0xTRAIL2';
  const coin = 'TRAILB-PERP';
  const config = {
    paper: true,
    sizing: { mode: 'fixed', value: 100 },
    leverage: 1,
    tp: { enabled: true, mode: 'percent', value: 10 },
    sl: { enabled: true, mode: 'percent', value: 5 },
    trailing: { enabled: true, mode: 'percent', value: 3 }
  };
  const record = {
    id: 'bot-trail-2', name: 'Trailing Plain Bot', coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config)
  };

  MID = 200;
  const bot = new PerpsBot(record, () => {});
  const { posId, entryPx } = await openLong(bot, config, master, coin);
  const firstSlOid = bot.position.slOid;
  assert.ok(firstSlOid, 'SL piazzato all\'apertura');

  MID = 210;
  await bot._manageOpen({ price: MID, candles: [] }, {}, { action: 'hold' });
  assert.ok(bot.position.slPx > entryPx * 0.95, 'il trailing stop si è alzato');
  assert.notEqual(bot.position.slOid, firstSlOid, 'nuovo trigger SL (place-then-cancel)');

  const trailing = JSON.parse(db.getPosition(posId).trailing_json);
  assert.equal(trailing.slOid, bot.position.slOid);
  assert.equal(trailing.dcaCount, 0);
  assert.equal(trailing.originalEntryPx, entryPx);

  // Un solo SL attivo sul book: il vecchio è stato cancellato DOPO il nuovo.
  const orders = await paperBroker.getFrontendOpenOrders(master);
  const sls = orders.filter(o => /stop/i.test(o.orderType));
  assert.equal(sls.length, 1, 'un solo SL attivo (nessuna finestra senza protezione, nessun doppione)');

  const rebooted = new PerpsBot(record, () => {});
  assert.equal(rebooted.position.dcaCount, 0);
  assert.equal(rebooted.position.slOid, bot.position.slOid);
});

test('_trailingJson: preserva le chiavi sconosciute già persistite', () => {
  // Il merge non deve buttare via campi che non conosce (retrocompatibilità e
  // futuri campi scritti da altrove nello stesso blob).
  const posId = db.insertPosition({
    botId: 'bot-trail-3', coin: 'X-PERP', side: 'long', size: 1, entryPx: 10, leverage: 1, tpPx: 11, slPx: 9
  });
  db.updatePosition(posId, {
    trailing_json: JSON.stringify({ slOid: 1, originalEntryPx: 10, dcaCount: 2, campoFuturo: 'da preservare' })
  });
  const bot = new PerpsBot({
    id: 'bot-trail-3', name: 'Merge Bot', coin: 'X-PERP', network: 'testnet',
    master_address: '0xTRAIL3', config_json: '{"paper":true}'
  }, () => {});
  assert.equal(bot.position.dcaCount, 2, 'stato ricaricato dal DB');

  bot.position.slOid = 42;
  const merged = JSON.parse(bot._trailingJson());
  assert.equal(merged.slOid, 42, 'lo stato in memoria vince sul persistito');
  assert.equal(merged.dcaCount, 2);
  assert.equal(merged.originalEntryPx, 10);
  assert.equal(merged.campoFuturo, 'da preservare', 'chiave sconosciuta preservata');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
