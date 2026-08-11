/**
 * QUAL-01 item 2, lato integrazione — chi attiva il cooldown, ora che
 * `canOpen()` è pura?
 * ==================================================================
 *
 * Spostare la scrittura fuori da `canOpen()` è utile solo se qualcuno la fa
 * davvero: la protezione non deve allentarsi. Il punto è `bot._registerClose()`,
 * dove la perdita è CONFERMATA (PnL reale dai fill, non l'unrealized di un tick),
 * subito dopo che la riga è passata a `closed` — così `getConsecutiveLosses()`
 * conta anche questa chiusura.
 *
 * Nota su chi altro chiamava `canOpen()`: `agents/riskAgent.evaluate()`, il gate
 * delle proposte dell'Analyst. Prima, VALUTARE una proposta poteva avviare un'ora
 * di cooldown su un bot; ora no.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';
import db from '../src/db/database.js';
import portfolio from '../src/perps/portfolio.js';
import notifier from '../src/perps/notifier.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-recordloss-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => true;

const CONFIG = { paper: true, sizing: { mode: 'fixed', value: 100 }, leverage: 1 };

/** Bot con `n` chiusure in perdita già nello storico e una posizione aperta. */
function botWithHistory(id, coin, losses) {
  const bot = new PerpsBot({
    id, name: `RL ${id}`, coin, network: 'testnet',
    master_address: '0xRECORDLOSS', config_json: JSON.stringify(CONFIG)
  }, () => {});
  bot.broker = Object.create(paperBroker);
  bot.broker.getRealizedPnl = async () => null; // nessun fill visibile → si usa il fallback
  for (let i = 0; i < losses; i++) {
    const pid = db.insertPosition({ botId: id, coin, side: 'long', size: 1, entryPx: 100, leverage: 1 });
    db.updatePosition(pid, { status: 'closed', pnl: -10, closed_at: Date.now() - (losses - i) * 60000 });
  }
  const openId = db.insertPosition({ botId: id, coin, side: 'long', size: 1, entryPx: 100, leverage: 1 });
  bot.position = {
    id: openId, side: 'long', size: 1, entryPx: 100, originalEntryPx: 100,
    dcaCount: 0, tpPx: null, slPx: null, slOid: null, tpOids: [], openedAt: Date.now()
  };
  return bot;
}

test('la terza perdita consecutiva attiva il cooldown alla chiusura', async () => {
  portfolio.setLimits({ maxConsecutiveLosses: 3, cooldownMinutes: 60 });
  const bot = botWithHistory('rl-3', 'RL3-PERP', 2); // 2 già chiuse + questa = 3

  assert.equal(portfolio.cooldownInfo(bot.id), null, 'nessun cooldown prima della chiusura');
  await bot._registerClose('uscita su regola', -5);

  const until = portfolio.cooldownInfo(bot.id);
  assert.ok(until > Date.now(), 'cooldown attivo dopo la perdita confermata');
  const verdict = portfolio.canOpen({ account: { positions: [] }, botId: bot.id, consecutiveLosses: 3 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.cooldownUntil, until, 'e bot.js può distinguere l\'episodio per la notifica');
});

test('sotto la soglia: nessun cooldown (la protezione non diventa più aggressiva)', async () => {
  portfolio.setLimits({ maxConsecutiveLosses: 3, cooldownMinutes: 60 });
  const bot = botWithHistory('rl-1', 'RL1-PERP', 0); // questa è la prima perdita
  await bot._registerClose('uscita su regola', -5);
  assert.equal(portfolio.cooldownInfo(bot.id), null);
});

test('chiusura in profitto: nessun cooldown, anche con perdite pregresse', async () => {
  portfolio.setLimits({ maxConsecutiveLosses: 3, cooldownMinutes: 60 });
  const bot = botWithHistory('rl-win', 'RLW-PERP', 5);
  await bot._registerClose('take profit', +12);
  assert.equal(portfolio.cooldownInfo(bot.id), null,
    'una chiusura positiva interrompe la serie: non è il momento di bloccare');
});

test('il cooldown attivato dalla chiusura è già persistito (sopravvive al riavvio)', async () => {
  portfolio.setLimits({ maxConsecutiveLosses: 3, cooldownMinutes: 60 });
  const bot = botWithHistory('rl-persist', 'RLP-PERP', 4);
  await bot._registerClose('stop loss eseguito', -20);

  const persisted = JSON.parse(db.getSetting('portfolio_cooldowns') || '{}');
  assert.ok(persisted[bot.id] > Date.now(),
    'CRIT-02 e QUAL-01 item 2 insieme: attivato al punto giusto e su disco');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
