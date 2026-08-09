/**
 * Una notifica per episodio di cooldown, non per tick.
 * ======================================================
 *
 * Incidente reale (9-10 agosto): dopo 3 perdite consecutive, il cooldown di
 * portfolio.js durava un'ora, e bot.js notificava "In cooldown fino alle..."
 * a OGNI tick bloccato — con un tick ogni 10s, centinaia di messaggi
 * identici su Telegram nell'arco dell'ora, fino a costringere l'utente a
 * chiudere tutte le posizioni solo per far smettere il flusso.
 *
 * Isolamento: stesso approccio di test/botDca.test.js (DB singleton
 * redirezionato su file temporaneo, client.getMid mockato). portfolio.canOpen
 * e notifier.notify sono mockati direttamente sui rispettivi singleton, come
 * client.getMid altrove.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-cooldown-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

function makeBot() {
  const config = {
    paper: true,
    sizing: { mode: 'fixed', value: 100 },
    leverage: 1,
    entryRules: [{ type: 'price', op: '>', value: 0 }] // sempre vero: non serve per questo test
  };
  const record = {
    id: `cd-${Math.random().toString(36).slice(2)}`,
    name: 'CooldownTest', coin: 'CD-PERP', network: 'testnet',
    master_address: '0xCOOLDOWN', config_json: JSON.stringify(config), status: 'stopped'
  };
  return new PerpsBot(record, () => {});
}

test('cooldown: una sola notifica per episodio, non una per tick', async () => {
  const bot = makeBot();
  let notifyCount = 0;
  const originalNotify = notifier.notify;
  const originalCanOpen = portfolio.canOpen;
  notifier.notify = async () => { notifyCount++; };

  const until = Date.now() + 60 * 60000;
  portfolio.canOpen = () => ({
    ok: false,
    reason: `In cooldown fino alle ${new Date(until).toLocaleTimeString('it-IT')}`,
    cooldownUntil: until
  });

  try {
    const account = { equity: 10000, positions: [] };
    const snapshot = { price: 100, candles: [] };
    // Simula 5 tick consecutivi bloccati dallo STESSO episodio di cooldown.
    for (let i = 0; i < 5; i++) {
      await bot._openPosition('long', snapshot, account);
    }
    assert.equal(notifyCount, 1, 'ci si aspetta una sola notifica per 5 tick sullo stesso episodio');

    // Un NUOVO episodio (until diverso) deve notificare di nuovo.
    const until2 = until + 30 * 60000;
    portfolio.canOpen = () => ({
      ok: false,
      reason: `In cooldown fino alle ${new Date(until2).toLocaleTimeString('it-IT')}`,
      cooldownUntil: until2
    });
    await bot._openPosition('long', snapshot, account);
    assert.equal(notifyCount, 2, 'un nuovo episodio di cooldown deve produrre una nuova notifica');
  } finally {
    notifier.notify = originalNotify;
    portfolio.canOpen = originalCanOpen;
  }
});

test('portfolio.canOpen espone cooldownUntil (timestamp grezzo) quando in cooldown', () => {
  const botId = `pf-${Math.random().toString(36).slice(2)}`;
  const r1 = portfolio.canOpen({ account: { positions: [] }, botId, consecutiveLosses: 3 });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /cooldown/i);

  const r2 = portfolio.canOpen({ account: { positions: [] }, botId, consecutiveLosses: 0 });
  assert.equal(r2.ok, false);
  assert.equal(typeof r2.cooldownUntil, 'number');
  assert.ok(r2.cooldownUntil > Date.now());
});
