/**
 * SIZING DINAMICO ATR — cablaggio in bot.js
 * =========================================
 *
 * `riskManager.sizePosition` sa calcolare la size dinamica ma non ha modo di
 * procurarsi l'ATR: è `bot.js` che possiede le candele. Questo file verifica il
 * pezzo che i test puri di riskManager non possono coprire — cioè che l'ATR
 * passato sia quello GIUSTO (periodo del sizing, non quello di TP/SL) e che il
 * degrado sia visibile PRIMA di aprire, nella diagnostica di warmup, non solo
 * nel log a posteriori.
 *
 * Seam: paperBroker e DB singleton su file temporaneo (mai data/perps.db),
 * stesso impianto di test/botFillSize.test.js. Le candele sono costruite a
 * mano con un true range noto, così la size attesa è un numero esatto e non
 * "quello che è uscito".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import marketData from '../src/perps/marketData.js';
import * as ind from '../src/perps/indicators.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-dynsize-'));
db.dbPath = path.join(tempDir, 'perps.db');

const MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => true;

/**
 * Serie con true range COSTANTE `tr`: l'ATR di qualunque periodo vale
 * esattamente `tr` (la media mobile di una costante è la costante). Serve a
 * rendere la size attesa un numero esatto.
 */
function flatCandles(n, tr = 2, close = MID) {
  return Array.from({ length: n }, (_, i) => ({
    t: i, o: close, h: close + tr / 2, l: close - tr / 2, c: close, v: 1
  }));
}

/**
 * Serie in cui la volatilità RECENTE è più alta: ATR(breve) ≠ ATR(lungo).
 * Serve a distinguere davvero quale periodo è stato usato — con candele piatte
 * i due periodi darebbero lo stesso numero e il test passerebbe comunque.
 */
function candlesWithVolatilitySpike(nCalm = 40, nSpike = 6) {
  const calm = flatCandles(nCalm, 1);
  const spike = Array.from({ length: nSpike }, (_, i) => ({
    t: nCalm + i, o: MID, h: MID + 5, l: MID - 5, c: MID, v: 1
  }));
  return [...calm, ...spike];
}

const BASE_CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 }, // statico: 100$ × leva 1 @ 100 → 1 coin
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'percent', value: 5 }
};

function makeBot(id, coin, master, config) {
  return new PerpsBot({
    id, name: `Bot ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify({ ...BASE_CONFIG, ...config })
  }, () => {});
}

const ACCOUNT = { equity: 10000, positions: [] };

test('bot con sizing dinamico: la size viene dall\'ATR, non dal sizing statico', async () => {
  const bot = makeBot('bot-dyn-1', 'DYN1-PERP', '0xDYN1', {
    risk: { useDynamicSizing: true, riskPerTradePct: 1, atrMultiplier: 2, maxPositionUsd: 100000 }
  });
  const candles = flatCandles(30, 2); // ATR = 2

  await bot._openPosition('long', { price: MID, candles }, ACCOUNT);

  // 10.000$ × 1% = 100$ di rischio / (ATR 2 × 2) = 25 coin — non 1 (statico).
  assert.ok(bot.position, 'posizione aperta');
  assert.equal(bot.position.size, 25);
  assert.equal(db.getOpenPositionByBot(bot.id).size, 25);
});

test('bot con sizing dinamico e candele insufficienti: fallback statico, nessuna eccezione', async () => {
  const bot = makeBot('bot-dyn-2', 'DYN2-PERP', '0xDYN2', {
    risk: { useDynamicSizing: true, riskPerTradePct: 1, atrMultiplier: 2, maxPositionUsd: 100000 }
  });
  // 5 candele con ATR(14): ind.atr ritorna null. È il caso reale del bot appena
  // avviato — deve aprire con il sizing statico, non fallire e non aprire a NaN.
  await bot._openPosition('long', { price: MID, candles: flatCandles(5, 2) }, ACCOUNT);

  assert.ok(bot.position, 'la posizione viene comunque aperta');
  assert.equal(bot.position.size, 1, 'size del sizing statico (100$ × leva 1 @ 100)');
});

test('bot senza sizing dinamico: comportamento invariato anche con candele disponibili', async () => {
  const bot = makeBot('bot-dyn-3', 'DYN3-PERP', '0xDYN3', {});
  await bot._openPosition('long', { price: MID, candles: flatCandles(30, 2) }, ACCOUNT);
  assert.equal(bot.position.size, 1);
});

test('_dynamicSizingAtrPeriod: risk.atrPeriod ha la precedenza, poi config.atrPeriod, poi 14', () => {
  const con = (config) => makeBot('bot-dyn-p', 'DYNP-PERP', '0xDYNP', config)._dynamicSizingAtrPeriod();
  assert.equal(con({ risk: { useDynamicSizing: true, atrPeriod: 30 }, atrPeriod: 20 }), 30);
  assert.equal(con({ risk: { useDynamicSizing: true }, atrPeriod: 20 }), 20);
  assert.equal(con({ risk: { useDynamicSizing: true } }), 14);
});

test('risk.atrPeriod vale SOLO per il sizing: TP/SL restano sul periodo della strategia', async () => {
  const candles = candlesWithVolatilitySpike();
  const atrCorto = ind.atr(candles, 14);
  const atrLungo = ind.atr(candles, 40);
  assert.ok(Math.abs(atrCorto - atrLungo) > 0.1,
    'presupposto del test: i due periodi devono dare ATR diversi, altrimenti non distinguerebbe nulla');

  const bot = makeBot('bot-dyn-4', 'DYN4-PERP', '0xDYN4', {
    atrPeriod: 14,
    sl: { enabled: true, mode: 'atr', value: 1 },
    tp: { enabled: false },
    risk: { useDynamicSizing: true, riskPerTradePct: 1, atrMultiplier: 1, atrPeriod: 40, maxPositionUsd: 100000 }
  });

  await bot._openPosition('long', { price: MID, candles }, ACCOUNT);

  // Lo stop usa l'ATR(14) della strategia (a partire dall'entry REALE del
  // fill simulato, che non coincide col mid: il paper broker applica slippage).
  assert.ok(Math.abs(bot.position.slPx - (bot.position.entryPx - atrCorto)) < 1e-9,
    'lo SL ATR deve restare sul periodo di config.atrPeriod');
  // …mentre la size usa l'ATR(40) del sizing.
  const attesa = Math.floor((10000 * 0.01 / atrLungo) * 1000) / 1000;
  assert.equal(bot.position.size, attesa);
});

test('warmup: candlesNeed tiene conto del periodo ATR del sizing dinamico', async () => {
  const bot = makeBot('bot-dyn-5', 'DYN5-PERP', '0xDYN5', {
    atrPeriod: 14,
    risk: { useDynamicSizing: true, atrPeriod: 50 },
    entryRules: [{ type: 'price', op: '>', value: 1 }]
  });
  const originale = marketData.getSnapshot;
  marketData.getSnapshot = async () => ({ price: MID, candles: flatCandles(20, 1), funding: null });
  try {
    const mon = await bot.getMonitor();
    assert.equal(mon.warmingUp.candlesNeed, 51, 'periodo del sizing (50) + 1');
    assert.equal(mon.warmingUp.ready, false,
      'con 20 candele il bot non è pronto: il sizing ricadrebbe su quello statico senza dirlo qui');
  } finally {
    marketData.getSnapshot = originale;
  }
});

test('warmup: senza sizing dinamico il conteggio resta quello di prima', async () => {
  const bot = makeBot('bot-dyn-6', 'DYN6-PERP', '0xDYN6', {
    atrPeriod: 14,
    sl: { enabled: true, mode: 'atr', value: 1 },
    entryRules: [{ type: 'price', op: '>', value: 1 }]
  });
  const originale = marketData.getSnapshot;
  marketData.getSnapshot = async () => ({ price: MID, candles: flatCandles(20, 1), funding: null });
  try {
    const mon = await bot.getMonitor();
    assert.equal(mon.warmingUp.candlesNeed, 15, 'solo l\'ATR di TP/SL: 14 + 1');
  } finally {
    marketData.getSnapshot = originale;
  }
});
