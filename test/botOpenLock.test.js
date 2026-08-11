/**
 * CRIT-03 — lock di apertura per (masterAddress, coin).
 * ====================================================
 *
 * `placeMarketOrder` È già serializzato per wallet da `execQueue.run()`: le firme
 * non collidono mai. Il problema è a monte — `checkLimits()`, `portfolio.canOpen()`
 * e `_cooldownBlock()` girano PRIMA della coda, su uno snapshot `account` letto
 * all'inizio del tick. Due bot diversi sullo stesso (master, coin) possono
 * superarli entrambi nello stesso istante (nessuno dei due vede ancora la
 * posizione dell'altro) e arrivare entrambi a firmare: `execQueue` li serializza,
 * non li ferma. `insertPositionIfNoneOpen` intercetta il doppione in DB, ma solo
 * DOPO che i due ordini sono già sull'exchange — e comunque non lo intercetta
 * affatto quando i due bot hanno `bot_id` diversi, che è proprio questo caso.
 *
 * Il lock vive accanto a `execQueue` (stessa istanza singleton, un `Set` di
 * chiavi — non una seconda coda di Promise) e si acquisisce/rilascia nello stesso
 * blocco `_opening` già presente da SEC-08: un solo punto di gestione.
 *
 * Seam: paperBroker con `setLeverage` messo dietro un cancello, per tenere il
 * primo bot dentro la finestra critica mentre il secondo tenta di entrare. È la
 * riproduzione fedele della race: la finestra reale è l'attesa di rete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';
import execQueue from '../src/perps/execQueue.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-openlock-'));
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
const ACCOUNT = { equity: 10000, positions: [] };
const SNAPSHOT = { price: 100, candles: [] };

function makeBot(id, coin, master) {
  return new PerpsBot({
    id, name: `Lock ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(CONFIG)
  }, () => {});
}

/**
 * Broker condiviso dai bot del test: conta le chiamate a placeMarketOrder e
 * tiene `setLeverage` sospeso finché il cancello non viene aperto.
 */
function gatedBroker(counters) {
  const gate = {};
  gate.promise = new Promise(resolve => { gate.open = resolve; });
  const broker = Object.create(paperBroker);
  broker.setLeverage = async () => {
    counters.leverage++;
    await gate.promise;
    return { ok: true };
  };
  broker.placeMarketOrder = async (params, network) => {
    counters.market++;
    return paperBroker.placeMarketOrder(params, network);
  };
  return { broker, gate };
}

test('due bot sullo stesso (master, coin): solo uno arriva a firmare', async () => {
  const master = '0xLOCK1';
  const coin = 'LOCK1-PERP';
  const counters = { leverage: 0, market: 0 };
  const { broker, gate } = gatedBroker(counters);

  const a = makeBot('lock-a', coin, master);
  const b = makeBot('lock-b', coin, master);
  a.broker = broker;
  b.broker = broker;

  const pA = a._openPosition('long', SNAPSHOT, ACCOUNT);
  // Il secondo bot entra mentre il primo è dentro la finestra critica.
  const pB = b._openPosition('long', SNAPSHOT, ACCOUNT);
  gate.open();
  await Promise.all([pA, pB]);

  assert.equal(counters.market, 1, 'un solo ordine market inviato per i due bot');
  assert.equal(counters.leverage, 1, 'il secondo bot esce PRIMA di toccare la leva, non dopo');
  const opened = [a, b].filter(bot => bot.position);
  assert.equal(opened.length, 1, 'una sola posizione aperta');
  const blocked = [a, b].find(bot => !bot.position);
  assert.equal(blocked.lastEval.action, 'hold');
  assert.match(blocked.lastEval.reason, /apertura/i,
    'il bot bloccato lo dice nel suo stato, come per un canOpen() fallito');
});

test('coin diverse sullo stesso master non si bloccano a vicenda', async () => {
  const master = '0xLOCK2';
  const counters = { leverage: 0, market: 0 };
  const { broker, gate } = gatedBroker(counters);

  const a = makeBot('lock-c', 'LOCKA-PERP', master);
  const b = makeBot('lock-d', 'LOCKB-PERP', master);
  a.broker = broker;
  b.broker = broker;

  const pA = a._openPosition('long', SNAPSHOT, ACCOUNT);
  const pB = b._openPosition('long', SNAPSHOT, ACCOUNT);
  gate.open();
  await Promise.all([pA, pB]);

  assert.equal(counters.market, 2, 'il lock è per coppia (master, coin), non per wallet intero');
  assert.ok(a.position && b.position, 'entrambe le posizioni aperte');
});

test('il lock si rilascia anche se l\'apertura fallisce a metà', async () => {
  const master = '0xLOCK3';
  const coin = 'LOCK3-PERP';
  const bot = makeBot('lock-e', coin, master);

  const boom = Object.create(paperBroker);
  boom.setLeverage = async () => { throw new Error('rete giù a metà apertura'); };
  bot.broker = boom;

  await assert.rejects(() => bot._openPosition('long', SNAPSHOT, ACCOUNT), /rete giù/);
  assert.equal(bot._opening, false, 'il flag SEC-08 è rilasciato');
  assert.equal(execQueue.isOpenLocked(master, coin), false,
    'il lock è rilasciato: un lock trattenuto bloccherebbe il mercato per sempre');

  // E infatti la volta dopo si apre.
  bot.broker = Object.create(paperBroker);
  await bot._openPosition('long', SNAPSHOT, ACCOUNT);
  assert.ok(bot.position, 'apertura possibile dopo il fallimento precedente');
});

test('il lock è insensibile alla forma dell\'indirizzo (case)', () => {
  assert.equal(execQueue.acquireOpenLock('0xAbCd', 'X-PERP'), true);
  assert.equal(execQueue.acquireOpenLock('0xabcd', 'X-PERP'), false,
    'stesso wallet scritto in altro case = stesso lock');
  execQueue.releaseOpenLock('0xABCD', 'X-PERP');
  assert.equal(execQueue.isOpenLocked('0xabcd', 'X-PERP'), false);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
