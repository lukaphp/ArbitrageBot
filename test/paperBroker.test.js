import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import paperBroker, { PaperBroker } from '../src/perps/paperBroker.js';

// QUAL-01 item 3: da quando il paperBroker PERSISTE il suo stato in `settings`,
// questo file tocca il DB → file temporaneo, mai data/perps.db.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-paper-'));
db.dbPath = path.join(tempDir, 'perps.db');

// Mock del prezzo live: il paperBroker usa client.getMid per i fill.
let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const M = '0xPAPER1';

test('apertura simulata crea posizione con fee dedotta', async () => {
  MID = 100;
  const r = await paperBroker.placeMarketOrder({ masterAddress: M, coin: 'X-PERP', isBuy: true, size: 1 });
  assert.equal(r.error, null);
  assert.ok(r.avgPx >= 100); // long: mid + slippage
  const acc = await paperBroker.getAccount(M);
  const pos = acc.positions.find(p => p.coin === 'X-PERP');
  assert.ok(pos && pos.side === 'long' && pos.size === 1);
  assert.ok(acc.accountValue < 10000); // fee di apertura dedotta
});

test('SL trigger: la posizione si chiude quando il prezzo lo colpisce', async () => {
  const M2 = '0xPAPER2';
  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: M2, coin: 'Y-PERP', isBuy: true, size: 1 });
  await paperBroker.placeTriggerOrder({ masterAddress: M2, coin: 'Y-PERP', isBuy: false, size: 1, triggerPx: 95, tpsl: 'sl' });
  // prezzo scende sotto lo stop
  MID = 94;
  const acc = await paperBroker.getAccount(M2); // valuta i trigger
  assert.equal(acc.positions.length, 0, 'posizione chiusa dallo SL');
  const real = await paperBroker.getRealizedPnl(M2, 'Y-PERP', 0);
  assert.ok(real && real.closedPnl < 0, 'PnL realizzato negativo (stop in perdita)');
  assert.ok(real.fee > 0, 'fee registrate');
});

test('getFrontendOpenOrders riporta i trigger come stop', async () => {
  const M3 = '0xPAPER3';
  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: M3, coin: 'Z-PERP', isBuy: true, size: 1 });
  await paperBroker.placeTriggerOrder({ masterAddress: M3, coin: 'Z-PERP', isBuy: false, size: 1, triggerPx: 90, tpsl: 'sl' });
  const orders = await paperBroker.getFrontendOpenOrders(M3);
  const sl = orders.find(o => o.isTrigger && /stop/i.test(o.orderType));
  assert.ok(sl && sl.triggerPx === 90);
});

test('chiusura simulata realizza il PnL in profitto su un long', async () => {
  const M4 = '0xPAPER4';
  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: M4, coin: 'W-PERP', isBuy: true, size: 2 });
  MID = 110; // prezzo sale
  await paperBroker.closePosition({ masterAddress: M4, coin: 'W-PERP' });
  const real = await paperBroker.getRealizedPnl(M4, 'W-PERP', 0);
  assert.ok(real.closedPnl > 0, 'profitto realizzato');
});

// ---- QUAL-01 item 3: lo stato del forward-test sopravvive al riavvio ----

test('lo stato simulato sopravvive a un riavvio del processo', async () => {
  const M = '0xPAPERPERSIST';
  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: M, coin: 'P-PERP', isBuy: true, size: 2 });
  const trigger = await paperBroker.placeTriggerOrder(
    { masterAddress: M, coin: 'P-PERP', isBuy: false, size: 2, triggerPx: 90, tpsl: 'sl' });
  const before = await paperBroker.getAccount(M);

  // "Riavvio": istanza nuova, stesso DB. Prima di questo fix ripartiva a
  // PAPER_START_EQUITY senza posizioni: un forward-test in corso era perso.
  const restarted = new PaperBroker();
  const after = await restarted.getAccount(M);

  assert.equal(after.positions.length, 1, 'posizione simulata ripristinata');
  assert.equal(after.positions[0].coin, 'P-PERP');
  assert.equal(after.positions[0].size, 2);
  assert.equal(after.positions[0].entryPx, before.positions[0].entryPx);
  assert.equal(after.accountValue, before.accountValue, 'equity simulata ripristinata (fee incluse)');

  const orders = await restarted.getFrontendOpenOrders(M);
  assert.equal(orders.length, 1, 'anche i trigger virtuali sono ripristinati');
  assert.equal(orders[0].oid, trigger.oid);

  // Gli oid non ripartono da 1: coinciderebbero con quelli già tracciati in
  // trailing_json e attribuirebbero una chiusura all'ordine sbagliato.
  const next = await restarted.placeTriggerOrder(
    { masterAddress: M, coin: 'P-PERP', isBuy: false, size: 2, triggerPx: 80, tpsl: 'sl' });
  assert.ok(next.oid > trigger.oid, `oid monotono tra i riavvii (${next.oid} > ${trigger.oid})`);
});

test('i fill restano leggibili dopo il riavvio (PnL realizzato simulato)', async () => {
  const M = '0xPAPERFILLS';
  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: M, coin: 'Q-PERP', isBuy: true, size: 1 });
  MID = 110;
  await paperBroker.closePosition({ masterAddress: M, coin: 'Q-PERP' });

  const restarted = new PaperBroker();
  const real = await restarted.getRealizedPnl(M, 'Q-PERP', 0);
  assert.ok(real && real.closedPnl > 0, 'il PnL realizzato del forward-test non si perde al riavvio');
});

test('DB non scrivibile: la simulazione continua in memoria', async () => {
  const realSetSetting = db.setSetting.bind(db);
  db.setSetting = () => { throw new Error('DB in sola lettura'); };
  try {
    const M = '0xPAPERNOWRITE';
    MID = 100;
    const r = await paperBroker.placeMarketOrder({ masterAddress: M, coin: 'R-PERP', isBuy: true, size: 1 });
    assert.equal(r.error, null, 'nessun errore propagato al bot per un problema di persistenza');
    const acc = await paperBroker.getAccount(M);
    assert.equal(acc.positions.length, 1);
  } finally {
    db.setSetting = realSetSetting;
  }
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
