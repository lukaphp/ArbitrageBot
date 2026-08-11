/**
 * WARN-06 (ex CRIT-04, declassato) — reazione immediata su SL non piazzabile.
 * =========================================================================
 *
 * Il claim originale dell'audit ("il bot aspetta il tick successivo, 10s") è
 * FALSO: `_ensureStopLoss()` reagisce già nello stesso tick. Il difetto reale è
 * più piccolo — quando `placeTriggerOrder` risponde `oid: null` (fallimento
 * immediato e inequivocabile), il codice faceva comunque una `_findStopOrder()`,
 * cioè un'altra chiamata di rete, prima di decidere di chiudere per sicurezza.
 * Su un mercato che si muove, quella chiamata è tempo speso con la posizione
 * completamente scoperta.
 *
 * Qui si contano le chiamate al broker: la verifica extra ha senso solo quando la
 * risposta non è già conclusiva di per sé.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-slfail-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

const CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  sl: { enabled: true, mode: 'percent', value: 5 }
};

/**
 * Broker che non ha mai trigger sul book e piazza lo SL con l'oid indicato.
 * Conta ogni lettura degli ordini aperti e ogni chiusura.
 */
function brokerWithSlOid(oid, calls) {
  return {
    async getFrontendOpenOrders() { calls.readOrders++; return []; },
    async placeTriggerOrder() { calls.placeTrigger++; return { oid }; },
    async cancelOrder() { calls.cancel++; return { ok: true }; },
    async closePosition() { calls.close++; return { oid: 999 }; },
    async getRealizedPnl() { return null; },
    async setLeverage() { return { ok: true }; }
  };
}

function botWithPosition(id, coin, calls, oid) {
  const bot = new PerpsBot({
    id, name: `SLFail ${id}`, coin, network: 'testnet',
    master_address: '0xSLFAIL', config_json: JSON.stringify(CONFIG)
  }, () => {});
  bot.broker = brokerWithSlOid(oid, calls);
  const posId = db.insertPosition({
    botId: id, coin, side: 'long', size: 1, entryPx: 100, leverage: 1, tpPx: null, slPx: 95
  });
  bot.position = {
    id: posId, side: 'long', size: 1, entryPx: 100, originalEntryPx: 100,
    dcaCount: 0, tpPx: null, slPx: 95, slOid: null, tpOids: [], openedAt: Date.now()
  };
  return bot;
}

test('oid null: chiusura di sicurezza senza la verifica intermedia sul book', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botWithPosition('sl-null', 'SLN-PERP', calls, null);
  notified.length = 0;

  await bot._ensureStopLoss();

  assert.equal(calls.placeTrigger, 1, 'un tentativo di ri-piazzamento dello SL');
  assert.equal(calls.readOrders, 1,
    'una sola lettura degli ordini (quella iniziale): nessun round-trip di verifica dopo un oid null');
  assert.equal(calls.close, 1, 'posizione chiusa per sicurezza');
  assert.equal(bot.position, null, 'stato locale ripulito dalla chiusura');
  assert.equal(db.getOpenPositionByBot('sl-null'), undefined, 'riga chiusa in DB');

  // Il testo comunicato all'utente NON cambia: cambia solo quanto in fretta arriva.
  assert.ok(notified.some(t => t === '⚠️ <b>SLFail sl-null</b>: stop loss non piazzabile su SLN-PERP → chiudo la posizione per sicurezza.'),
    `notifica invariata nel testo, trovate: ${JSON.stringify(notified)}`);
});

test('oid valorizzato: la verifica esistente resta e la posizione non viene chiusa', async () => {
  const calls = { readOrders: 0, placeTrigger: 0, cancel: 0, close: 0 };
  const bot = botWithPosition('sl-ok', 'SLO-PERP', calls, 4242);
  notified.length = 0;

  await bot._ensureStopLoss();

  assert.equal(calls.placeTrigger, 1);
  assert.equal(calls.readOrders, 2, 'lettura iniziale + verifica finale: comportamento invariato');
  assert.equal(calls.close, 0, 'con un oid valido non si chiude nulla');
  assert.ok(bot.position, 'posizione ancora aperta');
  assert.equal(bot.position.slOid, 4242, 'oid dello SL tracciato');
  assert.equal(notified.length, 0, 'nessuna notifica: non è successo niente di anomalo');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
