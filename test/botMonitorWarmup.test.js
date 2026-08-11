/**
 * QUAL-01 item 4 (+ item 1 lato diagnostica) — perché il bot è fermo.
 * ================================================================
 *
 * Un bot con meno candele di quante ne serve il suo indicatore più lungo resta
 * su `hold` per sempre: `ind.rsi()` & co. tornano `null` in warmup, nessuna regola
 * risulta soddisfatta, e la diagnostica non diceva da nessuna parte che il
 * problema era la quantità di dati. `getMonitor()` ora dichiara quante candele ha
 * e quante gliene servono.
 *
 * Nello stesso posto: il segnale esterno in coda diventa visibile alla
 * diagnostica (prima dichiarava sempre "in attesa di un segnale webhook", anche
 * con un segnale valido appena arrivato) — e viene letto in modo PURO, senza
 * toccare la coda del loop di trading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import marketData from '../src/perps/marketData.js';
import strategyEngine from '../src/perps/strategyEngine.js';
import db from '../src/db/database.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-warmup-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

/** Candele finte: per il warmup conta solo quante sono. */
const candles = (n) => Array.from({ length: n }, (_, i) => ({
  t: i, o: '100', h: '101', l: '99', c: '100', v: '1'
}));

let CANDLES = [];
marketData.getSnapshot = async () => ({ coin: 'WU-PERP', price: 100, candles: CANDLES, funding: null });
marketData.getMarkets = () => [];

function bot(config, coin = 'WU-PERP') {
  return new PerpsBot({
    id: `wu-${Math.random().toString(36).slice(2)}`, name: 'Warmup', coin, network: 'testnet',
    master_address: '0xWARMUP', config_json: JSON.stringify({ paper: true, ...config })
  }, () => {});
}

test('RSI(14): servono 15 candele, e il monitor lo dice', async () => {
  const b = bot({ entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }] });

  CANDLES = candles(10);
  let m = await b.getMonitor();
  assert.deepEqual(m.warmingUp, { candlesHave: 10, candlesNeed: 15, ready: false },
    'in warmup: il bot non può aprire e ora si vede perché');

  CANDLES = candles(20);
  m = await b.getMonitor();
  assert.deepEqual(m.warmingUp, { candlesHave: 20, candlesNeed: 15, ready: true });
});

test('la soglia rispecchia l\'indicatore più lungo tra entry ed exit', async () => {
  const b = bot({
    entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }],
    exitRules: [{ type: 'indicator', indicator: 'adx', period: 14, op: '<', value: 20, signal: 'close' }]
  });
  CANDLES = candles(20);
  const m = await b.getMonitor();
  assert.equal(m.warmingUp.candlesNeed, 28, 'ADX(14) ne richiede 28: vince sul RSI(14) che ne chiede 15');
  assert.equal(m.warmingUp.ready, false);
});

test('MACD e stop ATR sono contati nel warmup', async () => {
  const macdBot = bot({ entryRules: [{ type: 'indicator', indicator: 'macd', cond: 'bullish', signal: 'long' }] });
  CANDLES = candles(10);
  assert.equal((await macdBot.getMonitor()).warmingUp.candlesNeed, 35, 'default 26 + 9');

  const atrBot = bot({
    entryRules: [{ type: 'price', op: '>', value: 1, signal: 'long' }],
    sl: { enabled: true, mode: 'atr', value: 2 }, atrPeriod: 20
  });
  assert.equal((await atrBot.getMonitor()).warmingUp.candlesNeed, 21,
    'anche gli stop adattivi restano muti senza candele: ATR(20) → 21');
});

test('strategia che non dipende dalle candele: nessun warmup da attendere', async () => {
  const b = bot({ entryRules: [{ type: 'price', op: '>', value: 50, signal: 'long' }] });
  CANDLES = [];
  const m = await b.getMonitor();
  assert.deepEqual(m.warmingUp, { candlesHave: 0, candlesNeed: 0, ready: true });
});

test('il segnale esterno in coda è visibile alla diagnostica e NON viene consumato', async () => {
  const coin = 'WUEXT-PERP';
  marketData.getSnapshot = async () => ({ coin, price: 100, candles: CANDLES, funding: null });
  const b = bot({ entryRules: [{ type: 'external', signal: 'long' }] }, coin);
  strategyEngine.pushExternalSignal(coin, 'long');

  const m = await b.getMonitor();
  assert.equal(m.externalSignal, 'long', 'la diagnostica dice cosa c\'è in coda');
  const rule = m.entryRules[0];
  assert.equal(rule.met, true, 'e che la regola è soddisfatta, invece di "in attesa" a prescindere');
  assert.match(rule.current, /long/);

  // Due letture diagnostiche di seguito non cambiano ciò che vedrà il loop.
  await b.getMonitor();
  assert.equal(strategyEngine._checkExternal(coin), 'long', 'segnale ancora in coda per il tick reale');
});

test('segnale in coda diverso da quello atteso: lo dice, senza dichiararlo soddisfatto', async () => {
  const coin = 'WUEXT2-PERP';
  marketData.getSnapshot = async () => ({ coin, price: 100, candles: CANDLES, funding: null });
  const b = bot({ entryRules: [{ type: 'external', signal: 'long' }] }, coin);
  strategyEngine.pushExternalSignal(coin, 'short');

  const rule = (await b.getMonitor()).entryRules[0];
  assert.equal(rule.met, false);
  assert.match(rule.hint, /short/, 'l\'operatore capisce perché il suo webhook non ha aperto niente');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
