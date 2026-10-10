/**
 * #79, lato bot — lo stop automatico per perdita giornaliera usa lo STESSO
 * limite effettivo del gate d'apertura.
 * ======================================================================
 *
 * `_registerClose` leggeva `config.risk?.maxDailyLossUsd ?? globale`: con un
 * override più largo del globale il gate (`checkLimits`) bloccava le aperture
 * alla soglia globale, ma il bot restava acceso fino alla soglia del bot. Ora
 * entrambi leggono `resolveRiskLimit`: globale stretto dall'override, mai
 * allargato.
 *
 * Stesso harness di `botRecordLossCooldown.test.js`: paper broker, DB su file
 * temporaneo, `stop()` sostituito da un contatore (qui interessa la decisione,
 * non lo spegnimento).
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
import { HYPERLIQUID_CONFIG } from '../src/config/config.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-dailystop79-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => true;

const GLOBAL_LOSS = Math.abs(HYPERLIQUID_CONFIG.risk.maxDailyLossUsd);

function botWithPosition(id, risk) {
  const config = { paper: true, sizing: { mode: 'fixed', value: 100 }, leverage: 1, risk };
  const bot = new PerpsBot({
    id, name: `DS ${id}`, coin: `${id.toUpperCase()}-PERP`, network: 'testnet',
    master_address: '0xDAILYSTOP', config_json: JSON.stringify(config)
  }, () => {});
  bot.broker = Object.create(paperBroker);
  bot.broker.getRealizedPnl = async () => null; // nessun fill → si usa il fallback
  const openId = db.insertPosition({ botId: id, coin: bot.coin, side: 'long', size: 1, entryPx: 100, leverage: 1 });
  bot.position = {
    id: openId, side: 'long', size: 1, entryPx: 100, originalEntryPx: 100,
    dcaCount: 0, tpPx: null, slPx: null, slOid: null, tpOids: [], openedAt: Date.now()
  };
  bot.stops = 0;
  bot.stop = () => { bot.stops++; };
  return bot;
}

test('override PIÙ LARGO del globale: il bot si ferma alla soglia globale', async () => {
  const bot = botWithPosition('ds-wide', { maxDailyLossUsd: GLOBAL_LOSS * 10 });
  bot.dailyPnl = 0;
  await bot._registerClose('stop loss eseguito', -GLOBAL_LOSS);
  assert.equal(bot.stops, 1, 'prima restava acceso fino a 10× la soglia globale');
});

test('override più stretto: il bot si ferma alla SUA soglia', async () => {
  const bot = botWithPosition('ds-tight', { maxDailyLossUsd: 50 });
  bot.dailyPnl = 0;
  await bot._registerClose('stop loss eseguito', -50);
  assert.equal(bot.stops, 1);
});

test('override non valido: vale il globale (sotto la soglia nessuno stop)', async () => {
  const bot = botWithPosition('ds-bad', { maxDailyLossUsd: 'abc' });
  bot.dailyPnl = 0;
  await bot._registerClose('uscita su regola', -(GLOBAL_LOSS / 2));
  assert.equal(bot.stops, 0, 'un valore illeggibile non diventa una soglia a zero');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
