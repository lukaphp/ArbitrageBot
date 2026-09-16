/**
 * CRIT #16 — il fill simulato non può costare la TOLLERANZA di slippage.
 * =====================================================================
 *
 * `hyperliquidClient.placeMarketOrder` non ha veri ordini market: costruisce un
 * limit IoC aggressivo a `mid ± slippage`, dove `slippage` è la TOLLERANZA (il
 * prezzo PEGGIORE accettabile), non il costo atteso. Sull'exchange vero il fill
 * arriva dal book, a pochi punti base dal mid, e `avgPx` lo riporta.
 *
 * `paperBroker.placeMarketOrder` usava la stessa formula come prezzo di FILL:
 * con la tolleranza che `bot._openPosition` passa di default (`config.slippage
 * ?? 0.02`, cioè 2%) ogni posizione paper nasceva 2% oltre il mid. Con uno SL
 * all'1.5% — la configurazione della flotta OPS-FLEET-02 — la posizione nasceva
 * GIÀ OLTRE IL PROPRIO STOP e moriva alla prima valutazione dei trigger, in
 * entrambe le direzioni, a mercato fermo (18 trade su 18 in perdita, ~218 USD).
 *
 * I due test di scenario qui sotto sono la riproduzione numerica dell'incidente
 * (BNB long 727, BTC short 75913/77462): con il difetto rimesso fallirebbero
 * entrambi, perché la posizione risulta chiusa senza che il mid si sia mosso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import riskManager from '../src/perps/riskManager.js';
import paperBroker, { PaperBroker } from '../src/perps/paperBroker.js';
import { PerpsBot } from '../src/perps/bot.js';

// Il paperBroker persiste lo stato in `settings` → DB temporaneo, mai data/perps.db.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-paperslip-'));
db.dbPath = path.join(tempDir, 'perps.db');

// Solo il prezzo è finto: `roundPx` resta quello vero (5 cifre significative),
// così i prezzi del test sono quelli che si otterrebbero in produzione.
let MID = 100;
client.getMid = async () => MID;

// La tolleranza che `bot._openPosition` e `bot._maybeDca` passano davvero
// (`this.config.slippage ?? 0.02`): è l'input che ha prodotto l'incidente.
const BOT_TOLERANCE = 0.02;
// Configurazione di rischio della flotta OPS-FLEET-02.
const FLEET_CONFIG = {
  tp: { enabled: true, mode: 'percent', value: 3 },
  sl: { enabled: true, mode: 'percent', value: 1.5 }
};

const broker = new PaperBroker();

/** Apre come fa il bot e piazza i TP/SL calcolati da riskManager sull'entry ottenuta. */
async function openLikeBot({ master, coin, side, mid }) {
  MID = mid;
  const isBuy = side === 'long';
  const order = await broker.placeMarketOrder(
    { masterAddress: master, coin, isBuy, size: 1, slippage: BOT_TOLERANCE }, 'testnet');
  assert.equal(order.error, null);
  const { tpPx, slPx } = riskManager.computeTpSl(order.avgPx, side, FLEET_CONFIG);
  await broker.placeTriggerOrder(
    { masterAddress: master, coin, isBuy: !isBuy, size: 1, triggerPx: slPx, tpsl: 'sl' }, 'testnet');
  await broker.placeTriggerOrder(
    { masterAddress: master, coin, isBuy: !isBuy, size: 1, triggerPx: tpPx, tpsl: 'tp' }, 'testnet');
  return { entryPx: order.avgPx, tpPx, slPx };
}

test('long: a mercato fermo la posizione NON nasce già oltre il proprio stop', async () => {
  const M = '0xFLEETBNB';
  const { entryPx, slPx } = await openLikeBot({ master: M, coin: 'BNB-PERP', side: 'long', mid: 727 });

  assert.ok(entryPx < 727 * (1 + 0.015),
    `entry ${entryPx} oltre lo SL dell'1.5% rispetto al mid 727: la posizione nasce morta`);
  assert.ok(MID > slPx, `mid ${MID} già sotto lo SL ${slPx} nell'istante dell'apertura`);

  // Nessun movimento di prezzo: il tick successivo del bot (getAccount valuta i
  // trigger) non deve chiudere nulla.
  const acc = await broker.getAccount(M, 'testnet');
  assert.equal(acc.positions.length, 1,
    'posizione chiusa dallo SL senza che il mercato si sia mosso (difetto CRIT #16)');
});

test('short: stesso esito nella direzione opposta (BTC della flotta)', async () => {
  const M = '0xFLEETBTC';
  const { entryPx, slPx } = await openLikeBot({ master: M, coin: 'BTC-PERP', side: 'short', mid: 77462 });

  assert.ok(entryPx > 77462 * (1 - 0.015),
    `entry ${entryPx} oltre lo SL dell'1.5% rispetto al mid 77462`);
  assert.ok(MID < slPx, `mid ${MID} già sopra lo SL ${slPx} nell'istante dell'apertura`);

  const acc = await broker.getAccount(M, 'testnet');
  assert.equal(acc.positions.length, 1,
    'short chiuso dallo SL al primo tick a mercato fermo (difetto CRIT #16)');
});

test('la tolleranza del chiamante non è il costo di esecuzione simulato', async () => {
  const M = '0xPAPERTOL';
  MID = 1000;
  const long = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'TOL1-PERP', isBuy: true, size: 1, slippage: BOT_TOLERANCE }, 'testnet');
  const short = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'TOL2-PERP', isBuy: false, size: 1, slippage: BOT_TOLERANCE }, 'testnet');

  // Il modello di costo è lo stesso del backtester: 0.05% per lato.
  assert.ok(Math.abs(long.avgPx - 1000.5) < 1e-9, `long riempito a ${long.avgPx}, atteso 1000.5`);
  assert.ok(Math.abs(short.avgPx - 999.5) < 1e-9, `short riempito a ${short.avgPx}, atteso 999.5`);
});

test('una tolleranza più stretta del modello resta il limite del fill', async () => {
  const M = '0xPAPERTIGHT';
  MID = 1000;
  // Un IoC con tolleranza 0.01% non può riempirsi peggio del proprio limit price.
  const r = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'TIGHT-PERP', isBuy: true, size: 1, slippage: 0.0001 }, 'testnet');
  assert.ok(Math.abs(r.avgPx - 1000.1) < 1e-9, `atteso 1000.1, trovato ${r.avgPx}`);
});

test('anche il DCA usa il costo simulato, non la tolleranza', async () => {
  const M = '0xPAPERDCA';
  MID = 1000;
  await broker.placeMarketOrder(
    { masterAddress: M, coin: 'DCA-PERP', isBuy: true, size: 1, slippage: BOT_TOLERANCE }, 'testnet');
  // Prezzo invariato: mediare non deve spostare l'ingresso di un 2% fantasma.
  await broker.placeMarketOrder(
    { masterAddress: M, coin: 'DCA-PERP', isBuy: true, size: 1, slippage: BOT_TOLERANCE }, 'testnet');
  const acc = await broker.getAccount(M, 'testnet');
  const pos = acc.positions.find(p => p.coin === 'DCA-PERP');
  assert.equal(pos.size, 2);
  assert.ok(Math.abs(pos.entryPx - 1000.5) < 1e-9, `entry media ${pos.entryPx}, atteso 1000.5`);
});

/**
 * Percorso reale: è `bot._openPosition` a passare la tolleranza al broker
 * (`this.config.slippage ?? 0.02`). I test qui sopra lo simulano, questo lo
 * esercita — con la configurazione della flotta, che non definisce `slippage` e
 * quindi cade sul default del 2%.
 */
test('percorso bot → paperBroker: la posizione sopravvive al tick successivo', async () => {
  notifier.notify = async () => true;
  const master = '0xFLEETBOT';
  const bot = new PerpsBot({
    id: 'fleet-bnb', name: 'BNB RSI Reversal 5m', coin: 'BNB-PERP', network: 'testnet',
    master_address: master,
    config_json: JSON.stringify({
      ...FLEET_CONFIG, paper: true, leverage: 3,
      sizing: { mode: 'percent', value: 2.5 },
      risk: { maxPositionUsd: 800, maxDailyLossUsd: 100 }
    })
  }, () => {});

  MID = 727;
  await bot._openPosition('long', { price: MID, candles: [] }, { equity: 10000, positions: [] });
  assert.ok(bot.position, 'posizione aperta');

  const trades = db.listTradesBy({ botId: 'fleet-bnb' });
  assert.equal(trades.length, 1);
  assert.ok(trades[0].slippage_pct <= 0.0005 + 1e-9,
    `slippage di apertura ${trades[0].slippage_pct}: in produzione era 0.0200, cioè la tolleranza`);

  // Tick successivo, mercato fermo: `getAccount` valuta i trigger.
  const acc = await paperBroker.getAccount(master, 'testnet');
  assert.equal(acc.positions.length, 1, 'la posizione non viene chiusa dallo SL a mercato fermo');
  assert.equal(db.getOpenPositionByBot('fleet-bnb')?.id, bot.position.id);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
