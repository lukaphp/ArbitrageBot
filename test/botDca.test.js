/**
 * SEC-01: TP/SL ri-piazzati dopo un'aggiunta DCA.
 * ================================================
 *
 * Copertura: apertura posizione → 2 aggiunte DCA → verifica che size, entry
 * medio e prezzi dei trigger TP/SL risultanti sul book siano corretti, e che
 * le soglie progressive del DCA restino ancorate all'ingresso ORIGINALE (non
 * al prezzo medio via via aggiornato).
 *
 * Seam di test: paperBroker (già usato in produzione per il forward-test,
 * vedi test/paperBroker.test.js) al posto di Hyperliquid reale, e il
 * singleton DB di default redirezionato su un file SQLite temporaneo (mai
 * data/perps.db) — stesso approccio di test/riskPersistence.test.js.
 *
 * NOTA su cosa NON copre questo test: non passa da `PerpsBot.tick()`/
 * `_openPosition()` (che orchestrano marketData/predictor/portfolio, tutti
 * singleton con polling di rete o notifiche reali). L'apertura iniziale della
 * posizione è simulata manualmente riproducendo esattamente lo stato che
 * `_openPosition` lascerebbe (stesso paperBroker.placeMarketOrder + stesso
 * riskManager.computeTpSl + stesso db.insertPosition), poi si esercitano i
 * metodi reali `_maybeDca` e `_repriceTpSlAfterDca` così come li chiamerebbe
 * `_manageOpen` durante un tick vero. Il calcolo puro (media ponderata +
 * ricalcolo TP/SL) è testato anche in isolamento in test/riskManager.test.js.
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

// Isola il DB su un file temporaneo per questo processo di test (node:test
// esegue ogni file .test.js in un processo separato, quindi questa
// redirezione del singleton non trapela verso le altre suite).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-dca-'));
db.dbPath = path.join(tempDir, 'perps.db');

// Prezzo live mockato (stesso pattern di test/paperBroker.test.js): sia
// paperBroker sia il roundPx del trailing dipendono da client.getMid/roundPx.
let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

test('DCA: due aggiunte ricalcolano entry medio e ri-piazzano TP/SL sulla size totale', async () => {
  const master = '0xDCA1';
  const coin = 'DCA-PERP';
  const config = {
    paper: true,
    sizing: { mode: 'fixed', value: 100 },
    leverage: 1,
    tp: { enabled: true, mode: 'percent', value: 10 },
    sl: { enabled: true, mode: 'percent', value: 5 },
    dca: { steps: 3, stepPercent: 2, sizeMultiplier: 1 }
  };
  const record = {
    id: 'bot-dca-1', name: 'DCA Test Bot', coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config)
  };
  const bot = new PerpsBot(record, () => {});

  // --- Apertura posizione (equivalente allo stato lasciato da _openPosition,
  // senza passare per i gate MTF/ML/portafoglio che non sono oggetto di SEC-01) ---
  MID = 100;
  const openOrder = await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const entryPx = openOrder.avgPx;
  const { tpPx, slPx } = riskManager.computeTpSl(entryPx, 'long', config);
  const posId = db.insertPosition({ botId: bot.id, coin, side: 'long', size: 1, entryPx, leverage: 1, tpPx, slPx });
  bot.position = {
    id: posId, side: 'long', size: 1, entryPx,
    originalEntryPx: entryPx, dcaCount: 0, tpPx, slPx, slOid: null, openedAt: Date.now()
  };
  await bot._placeTpSl();

  // --- DCA #1: prezzo scende del ~2.55% dall'originale (supera la soglia 1×2%) ---
  MID = 97.5;
  await bot._maybeDca({ price: MID, candles: [] });
  assert.equal(bot.position.dcaCount, 1, 'primo step DCA eseguito');
  assert.equal(bot.position.size, 2, 'size raddoppiata (sizeMultiplier=1)');
  assert.equal(bot.position.originalEntryPx, entryPx, 'ingresso originale invariato dopo il DCA');
  assert.notEqual(bot.position.entryPx, entryPx, 'entry "ufficiale" aggiornato al prezzo medio');

  // --- DCA #2: prezzo scelto apposta in una fascia che supera la soglia 2×2%=4%
  // calcolata sull'ORIGINALE ma la mancherebbe se il codice (per bug) la
  // calcolasse sul prezzo medio dopo il DCA #1 — così il test fallirebbe se
  // qualcuno reintroducesse quel bug. ---
  const avgAfterStep1 = bot.position.entryPx;
  const adverseFromOriginal = (entryPx - 96.0) / entryPx * 100;
  const adverseFromAvg = (avgAfterStep1 - 96.0) / avgAfterStep1 * 100;
  assert.ok(adverseFromOriginal >= 4 && adverseFromAvg < 4,
    'il prezzo di test deve discriminare soglia-su-originale da soglia-su-medio');

  MID = 96.0;
  await bot._maybeDca({ price: MID, candles: [] });
  assert.equal(bot.position.dcaCount, 2, 'secondo step DCA eseguito (soglia calcolata sull\'originale)');
  assert.equal(bot.position.size, 4, 'size raddoppiata di nuovo: 2 + 2');
  assert.equal(bot.position.originalEntryPx, entryPx, 'ingresso originale ancora invariato dopo il secondo DCA');

  // --- Verifica finale: TP/SL sul book coerenti con la size totale e col nuovo entry medio ---
  const expected = riskManager.computeTpSl(bot.position.entryPx, 'long', config);
  assert.ok(Math.abs(bot.position.tpPx - expected.tpPx) < 1e-9, 'TP ricalcolato sul nuovo prezzo medio');
  assert.ok(Math.abs(bot.position.slPx - expected.slPx) < 1e-9, 'SL ricalcolato sul nuovo prezzo medio');

  const orders = await paperBroker.getFrontendOpenOrders(master);
  const tps = orders.filter(o => /take profit/i.test(o.orderType));
  const sls = orders.filter(o => /stop/i.test(o.orderType));
  assert.equal(tps.length, 1, 'un solo TP attivo sul book: i vecchi sono stati cancellati (place-then-cancel)');
  assert.equal(sls.length, 1, 'un solo SL attivo sul book: i vecchi sono stati cancellati (place-then-cancel)');
  assert.equal(tps[0].sz, 4, 'TP piazzato con la size TOTALE aggiornata, non quella originale');
  assert.equal(sls[0].sz, 4, 'SL piazzato con la size TOTALE aggiornata, non quella originale');
  assert.equal(tps[0].triggerPx, client.roundPx(bot.position.tpPx));
  assert.equal(sls[0].triggerPx, client.roundPx(bot.position.slPx));

  // --- Persistenza: la riga DB riflette size/entry/tp/sl aggiornati ---
  const row = db.db.prepare('SELECT * FROM positions WHERE id = ?').get(posId);
  assert.equal(row.size, 4);
  assert.ok(Math.abs(row.entry_px - bot.position.entryPx) < 1e-9);
  assert.ok(Math.abs(row.tp_px - bot.position.tpPx) < 1e-9);
  assert.ok(Math.abs(row.sl_px - bot.position.slPx) < 1e-9);
  const trailing = JSON.parse(row.trailing_json);
  assert.equal(trailing.originalEntryPx, entryPx, 'originalEntryPx persistito per sopravvivere a un riavvio');
  assert.equal(trailing.dcaCount, 2);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
