/**
 * WARN-03 — slippage reale calcolato, loggato e persistito.
 * =======================================================
 *
 * `bot.js` aveva già entrambi i numeri nello stesso scope al momento del fill
 * (`snapshot.price`, il prezzo su cui la decisione è stata presa, e
 * `order.avgPx`, quello davvero ottenuto) e non ne calcolava mai la differenza:
 * il costo di esecuzione non era misurabile a posteriori da nessuna parte.
 *
 * Solo visibilità: nessun blocco automatico sullo slippage alto (scelta esplicita
 * di sprint — sarebbe una nuova policy di rischio, non hardening).
 *
 * Qui si verifica il pezzo che il test puro di `riskManager.computeSlippage`
 * (test/riskManager.test.js) non può coprire: che il valore finisca davvero sul
 * record del fill, in modo ADDITIVO — le aggregazioni esistenti su
 * `positions` (`getBotStats`, `getBotPerformance`) devono continuare a funzionare.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-slippage-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => true;

const CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  sl: { enabled: true, mode: 'percent', value: 5 }
};

/** Broker che riempie al prezzo `avgPx` indicato (il resto è paperBroker vero). */
function brokerAt(avgPx) {
  const broker = Object.create(paperBroker);
  broker.placeMarketOrder = async (params, network) => {
    const real = await paperBroker.placeMarketOrder(params, network);
    return { ...real, avgPx };
  };
  return broker;
}

async function openWith({ id, coin, master, referencePx, avgPx }) {
  const bot = new PerpsBot({
    id, name: `Slip ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(CONFIG)
  }, () => {});
  bot.broker = brokerAt(avgPx);
  await bot._openPosition('long', { price: referencePx, candles: [] }, { equity: 10000, positions: [] });
  return bot;
}

test('slippage nullo: eseguito esattamente al prezzo di riferimento', async () => {
  const bot = await openWith({ id: 'slip-0', coin: 'SLIP0-PERP', master: '0xSLIP0', referencePx: 100, avgPx: 100 });
  const trade = db.listTradesBy({ botId: bot.id, limit: 1 })[0];
  assert.equal(trade.slippage_pct, 0);
});

test('slippage piccolo: persistito come frazione sul record del fill', async () => {
  const bot = await openWith({ id: 'slip-1', coin: 'SLIP1-PERP', master: '0xSLIP1', referencePx: 100, avgPx: 100.05 });
  const trade = db.listTradesBy({ botId: bot.id, limit: 1 })[0];
  assert.ok(Math.abs(trade.slippage_pct - 0.0005) < 1e-9, `atteso ~0.0005, trovato ${trade.slippage_pct}`);
});

test('slippage grande: registrato, ma l\'apertura NON viene bloccata', async () => {
  const bot = await openWith({ id: 'slip-2', coin: 'SLIP2-PERP', master: '0xSLIP2', referencePx: 100, avgPx: 103 });
  const trade = db.listTradesBy({ botId: bot.id, limit: 1 })[0];
  assert.ok(Math.abs(trade.slippage_pct - 0.03) < 1e-9);
  assert.ok(bot.position, 'nessuna azione automatica sullo slippage alto in questo sprint');
});

test('la colonna è additiva: le aggregazioni esistenti non cambiano forma', () => {
  // getBotStats/getBotPerformance leggono `positions`, non `trades`: il campo
  // nuovo non può romperle, ma la verifica esplicita costa poco e documenta il
  // vincolo del criterio di accettazione.
  const stats = db.getBotStats('slip-1');
  assert.deepEqual(Object.keys(stats).sort(),
    ['avgPnl', 'profitFactor', 'totalFees', 'totalPnl', 'trades', 'winRate', 'wins'].sort());
  const perf = db.getBotPerformance('slip-1');
  assert.equal(typeof perf.expectancy, 'number');
  assert.ok('closeReasons' in perf);
});

test('fill senza prezzo di riferimento: slippage NULL, non 0', () => {
  // Un fill registrato senza confronto possibile (es. posizione adottata) non
  // deve sembrare "eseguito al prezzo perfetto".
  db.insertTrade({ botId: 'slip-null', coin: 'SLIPN-PERP', side: 'long', px: 100, sz: 1, hlOid: 1 });
  const trade = db.listTradesBy({ botId: 'slip-null', limit: 1 })[0];
  assert.equal(trade.slippage_pct, null);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
