/**
 * OPS-FLEET-02 — lato BOT: la config canonica e la diagnostica che la racconta.
 * ============================================================================
 *
 * `test/strategyRuleShape.test.js` copre il motore. Qui si copre la ragione per
 * cui la normalizzazione sta nel costruttore di `PerpsBot` e non solo dentro
 * `strategyEngine.evaluate`: il bot legge le proprie regole anche fuori dalla
 * valutazione, e con la forma sbagliata ognuna di quelle letture sbagliava in
 * modo diverso — in particolare `getMonitor()`, che esiste apposta «per capire
 * perché è fermo» e sul caso reale non diceva niente.
 *
 * Config di produzione testuale (BTC-PERP "JEV Verified Bot"): `type` assente,
 * `signal: 'open_long'`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import marketData from '../src/perps/marketData.js';
import strategyEngine from '../src/perps/strategyEngine.js';
import notifier from '../src/perps/notifier.js';
import db from '../src/db/database.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-ruleshape-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

/** Discesa monotona: RSI(14) → 0, quindi sotto la soglia 30 senza ambiguità. */
const giu = (() => {
  const out = [];
  let px = 100;
  for (let i = 0; i < 60; i++) { const o = px; px *= 0.995; out.push({ t: i * 60000, o: String(o), h: String(o), l: String(px), c: String(px), v: '1' }); }
  return out;
})();

marketData.getSnapshot = async () => ({ coin: 'RS-PERP', price: parseFloat(giu[giu.length - 1].c), candles: giu, funding: null });
marketData.getMid = () => parseFloat(giu[giu.length - 1].c);
marketData.getMarkets = () => [];

const PROD_ENTRY_RULES = [
  { indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'open_long' },
  { indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'open_short' }
];

function bot(config) {
  return new PerpsBot({
    id: `rs-${Math.random().toString(36).slice(2)}`, name: 'RuleShape', coin: 'RS-PERP', network: 'testnet',
    master_address: '0xRULESHAPE', config_json: JSON.stringify({ paper: true, ...config })
  }, () => {});
}

test('la config del bot è canonica già in memoria (senza riscrivere il DB)', () => {
  const b = bot({ logic: 'any', entryRules: PROD_ENTRY_RULES });
  assert.equal(b.config.entryRules[0].type, 'indicator');
  assert.equal(b.config.entryRules[0].signal, 'long');
  assert.equal(b.config.entryRules[1].signal, 'short');
  assert.equal(b._unevaluableRules.length, 0);
  assert.ok(b._configChanges.length >= 2, 'le correzioni devono essere tracciate per poterle dichiarare');
});

test('con la config reale di produzione il bot decide open_long', () => {
  const b = bot({ logic: 'any', entryRules: PROD_ENTRY_RULES });
  const snapshot = { coin: 'RS-PERP', price: parseFloat(giu[giu.length - 1].c), candles: giu };
  const dec = strategyEngine.evaluate(b.config, snapshot, { inPosition: false });
  assert.equal(dec.action, 'open_long', `atteso open_long, ottenuto ${dec.action} (${dec.reason})`);
});

test('getMonitor: warmup e card della regola tornano a dire la verità', async () => {
  const b = bot({ logic: 'any', entryRules: PROD_ENTRY_RULES });
  const m = await b.getMonitor();

  // Prima del fix `requiredCandles` vedeva `type !== 'indicator'` e tornava 0:
  // `ready: true` su un bot che non poteva aprire.
  assert.equal(m.warmingUp.candlesNeed, 15, 'RSI(14) richiede 15 candele, non 0');
  assert.equal(m.warmingUp.ready, true);

  // Prima del fix `_diagRule` cadeva sul ramo finale: label `undefined`, hint ''.
  const r = m.entryRules[0];
  assert.equal(r.label, 'RSI(14)');
  assert.equal(r.type, 'indicator');
  assert.equal(r.met, true, `la regola è soddisfatta (RSI ~0 < 30), monitor dice: ${JSON.stringify(r)}`);
  assert.match(r.hint, /condizione soddisfatta/);
});

test('regola inservibile: all\'avvio il bot lo dice a voce alta (log E notifica)', () => {
  const inviate = [];
  const originale = notifier.notify;
  notifier.notify = (msg) => { inviate.push(msg); };
  try {
    const b = bot({ logic: 'any', entryRules: [{ type: 'pinco', op: '<', value: 1, signal: 'long' }] });
    assert.equal(b._unevaluableRules.length, 1);
    // `start()` avvia anche il loop: qui interessa solo che la segnalazione sia
    // cablata sull'avvio, non far girare un tick di trading.
    b.tick = () => Promise.resolve();
    b.start();
    b.stop();
  } finally {
    notifier.notify = originale;
  }
  assert.equal(inviate.length, 1, 'una notifica per avvio, non una per tick');
  assert.match(inviate[0], /pinco/);
  assert.match(inviate[0], /non aprirà né chiuderà nulla/);
});

test('un bot con config canonica non genera nessun allarme', () => {
  const inviate = [];
  const originale = notifier.notify;
  notifier.notify = (msg) => { inviate.push(msg); };
  try {
    const b = bot({ logic: 'any', entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }] });
    b.tick = () => Promise.resolve();
    b.start();
    b.stop();
  } finally {
    notifier.notify = originale;
  }
  assert.equal(inviate.length, 0);
});
