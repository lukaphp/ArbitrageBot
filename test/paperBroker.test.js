import { test } from 'node:test';
import assert from 'node:assert/strict';
import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';

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
