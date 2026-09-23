/**
 * BUG-SIZECAP-01 — il tetto per-bot deve valere DOVE È SCRITTO
 * ===========================================================
 *
 * Incidente del 2026-09-23: quattro bot della flotta OPS-FLEET-02, appena
 * tornati a produrre segnali, hanno proposto aperture da 2.700$ a 5.000$ di
 * notional con `maxPositionUsd: 500` in config. Il Budget Ceiling (che legge
 * `bots.max_allocation_usd`) li ha bloccati tutti, ma A VALLE: il bot ha
 * ritentato ogni 10s e ogni tentativo è costato una chiamata all'osservatore.
 *
 * Le config di questo file sono quelle REALI lette dal DB di produzione, non
 * parafrasi: è il punto del test. Il difetto non si vede su una config
 * "normale" (quelle scritte dalla UI hanno il tetto in `risk.maxPositionUsd`,
 * che è l'unico percorso che il motore di sizing leggeva) — si vede solo sulla
 * forma prodotta dall'agente, che scrive il tetto alla RADICE, esattamente come
 * documentato dai tool MCP.
 *
 * Seam: calcolo puro in isolamento (riskManager) + un caso di cablaggio su
 * `PerpsBot` con paperBroker e DB temporaneo, perché la proprietà che conta
 * davvero — "il Budget Ceiling non vede mai un numero abnorme" — è una
 * proprietà della catena, non della sola formula.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import riskManager, { resolveMaxPositionUsd, auditRiskConfig } from '../src/perps/riskManager.js';
import logger from '../src/utils/logger.js';
import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-sizecap-'));
db.dbPath = path.join(tempDir, 'perps.db');

const MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => true;

/** Config REALE del bot NEAR-PERP (DB di produzione, 2026-09-23). */
const NEAR_REALE = JSON.parse('{"reason":"Conferma estensione JEV auto-approval per NEAR","useJevValidation":true,"maxPositionUsd":500,"sl":{"value":1.5,"enabled":true,"mode":"percent"},"risk":{"useDynamicSizing":true,"atrPeriod":14,"maxDailyLossUsd":100},"tp":{"enabled":true,"value":3,"mode":"percent"},"leverage":2,"useJevAutoApproval":true,"strategy":"bollinger_reversion","candleInterval":"1m","entryRules":[{"indicator":"rsi","period":14,"op":"<","value":35,"signal":"long","type":"indicator"},{"indicator":"rsi","period":14,"op":">","value":65,"signal":"short","type":"indicator"}],"logic":"any"}');

/** Config REALE del bot BTC-PERP: ha in più i blocchi annidati di Hermes. */
const BTC_REALE = JSON.parse('{"useJevValidation":true,"risk":{"maxDailyLossUsd":200,"atrPeriod":10,"useDynamicSizing":true},"leverage":2,"reason":"Conferma potenziamento aggressivo profit-first per BTC","sl":{"mode":"percent","enabled":true,"value":1.5},"tp":{"enabled":true,"mode":"percent","value":3},"maxPositionUsd":500,"useJevAutoApproval":true,"strategy":"rsi_reversal","candleInterval":"1m","entryRules":[{"indicator":"rsi","period":14,"op":"<","value":30,"signal":"long","type":"indicator"},{"indicator":"rsi","period":14,"op":">","value":70,"signal":"short","type":"indicator"}],"logic":"any","sizing":{"maxPositionUsd":1000},"strategyParams":{"leverage":5,"takeProfitPct":0.04}}');

/** Config REALE del bot SOL-PERP (stessa anomalia di BTC, non ancora scattato). */
const SOL_REALE = JSON.parse('{"reason":"Conferma potenziamento aggressivo profit-first per SOL","useJevValidation":true,"tp":{"mode":"percent","enabled":true,"value":3},"maxPositionUsd":500,"risk":{"useDynamicSizing":true,"maxDailyLossUsd":200,"atrPeriod":10},"leverage":2,"sl":{"value":1.5,"enabled":true,"mode":"percent"},"useJevAutoApproval":true,"strategy":"bollinger_reversion","candleInterval":"1m","entryRules":[{"indicator":"rsi","period":14,"op":"<","value":35,"signal":"long","type":"indicator"},{"indicator":"rsi","period":14,"op":">","value":65,"signal":"short","type":"indicator"}],"logic":"any","strategyParams":{"leverage":5,"takeProfitPct":0.04},"sizing":{"maxPositionUsd":1000}}');

function captureLogs(fn) {
  const warnOrig = logger.warn;
  const errOrig = logger.error;
  const righe = [];
  logger.warn = (...a) => { righe.push(a.map(String).join(' ')); };
  logger.error = (...a) => { righe.push(a.map(String).join(' ')); };
  try {
    return { result: fn(), righe };
  } finally {
    logger.warn = warnOrig;
    logger.error = errOrig;
  }
}

function flatCandles(n, tr = 2, close = MID) {
  return Array.from({ length: n }, (_, i) => ({
    t: i, o: close, h: close + tr / 2, l: close - tr / 2, c: close, v: 1
  }));
}

// ---------------------------------------------------------------------------
// 1. Il cap scritto alla radice deve valere
// ---------------------------------------------------------------------------

test('config REALE NEAR: il sizing dinamico rispetta maxPositionUsd scritto alla radice', () => {
  // Senza cap: 10.000$ × 1% = 100$ di rischio / (ATR 2 × 1.5) = 33.33 coin
  // = 3.333$ di notional @100 — lo stesso ordine di grandezza dei 2.692$
  // osservati in produzione.
  const plan = riskManager.sizePosition(NEAR_REALE, 10000, MID, 3, { atr: 2 });
  assert.ok(plan.notionalUsd <= 500 + 1e-9,
    `notional ${plan.notionalUsd} oltre il tetto configurato di 500$`);
  assert.equal(plan.size, 5, '500$ / 100 = 5 coin');
  // Non deve essere confondibile con un fallback al ramo statico: quello
  // varrebbe 10% di 10.000$ × leva 2 = 2.000$, un numero diverso da entrambi.
  assert.notEqual(plan.notionalUsd, 2000);
});

test('config REALE BTC: cap onorato e leva presa da config.leverage, non da strategyParams', () => {
  const plan = riskManager.sizePosition(BTC_REALE, 10000, MID, 3, { atr: 2 });
  assert.ok(plan.notionalUsd <= 500 + 1e-9, `notional ${plan.notionalUsd} oltre 500$`);
  // `strategyParams.leverage: 5` NON è la leva del motore: il margine si
  // calcola sulla leva canonica (2). Se qualcuno cablasse il percorso annidato
  // qui uscirebbe 100$ invece di 250$.
  assert.equal(plan.marginUsd, plan.notionalUsd / 2);
  // `sizing.maxPositionUsd: 1000` è più PERMISSIVO del tetto reale: non deve
  // mai diventare il cap effettivo.
  assert.ok(plan.notionalUsd <= 500 + 1e-9);
});

test('config REALE SOL: stesso esito di BTC (stessa forma annidata)', () => {
  const plan = riskManager.sizePosition(SOL_REALE, 10000, MID, 3, { atr: 2 });
  assert.ok(plan.notionalUsd <= 500 + 1e-9, `notional ${plan.notionalUsd} oltre 500$`);
});

test('resolveMaxPositionUsd: vince il più restrittivo fra radice, risk e cap globale', () => {
  assert.equal(resolveMaxPositionUsd({ maxPositionUsd: 500 }).maxPositionUsd, 500);
  assert.equal(resolveMaxPositionUsd({ risk: { maxPositionUsd: 500 } }).maxPositionUsd, 500);
  // Le due forme in disaccordo: si applica la più prudente, mai la più larga.
  assert.equal(resolveMaxPositionUsd({ maxPositionUsd: 500, risk: { maxPositionUsd: 2000 } }).maxPositionUsd, 500);
  assert.equal(resolveMaxPositionUsd({ maxPositionUsd: 2000, risk: { maxPositionUsd: 500 } }).maxPositionUsd, 500);
  // Nessun tetto per-bot: resta il cap globale, non "nessun limite".
  assert.equal(resolveMaxPositionUsd({}).maxPositionUsd, 5000);
});

test('resolveMaxPositionUsd: un tetto non numerico non vale come "nessun tetto"', () => {
  for (const valore of ['abc', 0, -10, null, NaN]) {
    const { maxPositionUsd, ignored } = resolveMaxPositionUsd({ maxPositionUsd: valore, risk: {} });
    assert.equal(maxPositionUsd, 5000, `valore ${JSON.stringify(valore)} non deve togliere il cap globale`);
    if (valore !== null) {
      assert.ok(ignored.some(m => /maxPositionUsd/.test(m)),
        `il valore inservibile ${JSON.stringify(valore)} va segnalato, non ignorato in silenzio`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Il controllo a valle deve leggere lo stesso tetto del calcolo
// ---------------------------------------------------------------------------

test('checkLimits: blocca un notional oltre il tetto scritto alla radice', () => {
  const r = riskManager.checkLimits(NEAR_REALE, { equity: 10000 }, { leverage: 2, notionalUsd: 2692.91 }, 0);
  assert.equal(r.ok, false, 'un notional di 2.692$ con tetto 500$ non può risultare "OK"');
  assert.match(r.reason, /500/);
});

test('checkLimits: non-regressione sulla forma canonica risk.maxPositionUsd', () => {
  const cfg = { risk: { maxLeverage: 10, maxPositionUsd: 1000, maxDailyLossUsd: 100 } };
  assert.equal(riskManager.checkLimits(cfg, { equity: 1000 }, { leverage: 3, notionalUsd: 500 }, 0).ok, true);
  assert.equal(riskManager.checkLimits(cfg, { equity: 1000 }, { leverage: 3, notionalUsd: 1500 }, 0).ok, false);
});

// ---------------------------------------------------------------------------
// 3. Il blocco `sizing` scritto dall'agente non deve produrre una size NaN
// ---------------------------------------------------------------------------

test('fallback statico con sizing senza mode/value: size nulla e motivo esplicito, mai NaN', () => {
  // Config REALE di BTC, ATR non disponibile (warmup): il ramo dinamico cade su
  // quello statico, che trova `sizing: { maxPositionUsd: 1000 }` — nessun
  // `value`. Prima: `equity × (undefined/100)` = NaN, e NaN attraversa OGNI
  // guardia (ogni confronto con NaN è falso), fino a `placeMarketOrder`.
  const { result: plan, righe } = captureLogs(() =>
    riskManager.sizePosition(BTC_REALE, 10000, MID, 3, { atr: undefined }));

  assert.ok(!Number.isNaN(plan.size), 'la size non deve essere NaN');
  assert.ok(!Number.isNaN(plan.notionalUsd), 'il notional non deve essere NaN');
  assert.equal(plan.size, 0, 'senza una regola di sizing utilizzabile non si apre nulla');
  assert.ok(plan.blocked, 'il piano deve dire perché è a zero');
  assert.ok(righe.some(r => /sizing/i.test(r)), 'il motivo va anche nei log');
});

test('fallback statico con sizing valido: comportamento invariato', () => {
  const cfg = { leverage: 2, sizing: { mode: 'fixed', value: 100 }, risk: { useDynamicSizing: true, maxPositionUsd: 5000 } };
  const plan = riskManager.sizePosition(cfg, 10000, MID, 3, { atr: null });
  assert.equal(plan.notionalUsd, 200, '100$ di margine × leva 2');
  assert.ok(!plan.blocked);
});

// ---------------------------------------------------------------------------
// 4. I campi annidati extra si SEGNALANO, non si indovinano
// ---------------------------------------------------------------------------

test('auditRiskConfig: segnala i doppioni annidati scritti dall\'agente', () => {
  const avvisi = auditRiskConfig(BTC_REALE);
  assert.ok(avvisi.some(a => /sizing\.maxPositionUsd/.test(a)),
    'sizing.maxPositionUsd è inerte: chi l\'ha scritto deve saperlo');
  assert.ok(avvisi.some(a => /strategyParams\.leverage/.test(a)),
    'strategyParams.leverage non è la leva usata dal motore');
});

test('auditRiskConfig: nessun rumore su una config canonica', () => {
  const canonica = {
    leverage: 2,
    sizing: { mode: 'percent', value: 10 },
    risk: { maxPositionUsd: 500, maxDailyLossUsd: 100, useDynamicSizing: true }
  };
  assert.deepEqual(auditRiskConfig(canonica), []);
});

test('auditRiskConfig: segnala il disaccordo fra i due percorsi del tetto', () => {
  const avvisi = auditRiskConfig({ maxPositionUsd: 500, risk: { maxPositionUsd: 2000 } });
  assert.ok(avvisi.some(a => /500/.test(a) && /2000/.test(a)),
    'due tetti diversi per lo stesso bot vanno nominati entrambi');
});

// ---------------------------------------------------------------------------
// 5. Cablaggio: il Budget Ceiling non deve mai vedere un numero abnorme
// ---------------------------------------------------------------------------

test('bot con la config REALE di BTC: all\'avvio dice quali parametri di rischio non applica', () => {
  const bot = new PerpsBot({
    id: 'bot-sizecap-2', name: 'BTC cap', coin: 'BTCCAP-PERP', network: 'testnet',
    master_address: '0xSIZECAP2', config_json: JSON.stringify({ ...BTC_REALE, paper: true })
  }, () => {});

  const originale = notifier.notify;
  const messaggi = [];
  notifier.notify = async (m) => { messaggi.push(m); return true; };
  try {
    captureLogs(() => bot._reportConfigIssues());
  } finally {
    notifier.notify = originale;
  }

  const testo = messaggi.join('\n');
  assert.match(testo, /sizing\.maxPositionUsd/);
  assert.match(testo, /strategyParams\.leverage/);
});

test('bot con config canonica: nessuna notifica di parametri non applicati', () => {
  const bot = new PerpsBot({
    id: 'bot-sizecap-3', name: 'Canonico', coin: 'CANON-PERP', network: 'testnet',
    master_address: '0xSIZECAP3',
    config_json: JSON.stringify({
      paper: true, leverage: 2, sizing: { mode: 'percent', value: 10 },
      risk: { maxPositionUsd: 500, useDynamicSizing: true },
      entryRules: [{ type: 'price', op: '>', value: 1 }]
    })
  }, () => {});

  const originale = notifier.notify;
  const messaggi = [];
  notifier.notify = async (m) => { messaggi.push(m); return true; };
  try {
    captureLogs(() => bot._reportConfigIssues());
  } finally {
    notifier.notify = originale;
  }
  assert.deepEqual(messaggi, [], 'una config canonica non deve generare rumore all\'avvio');
});

test('sizing inservibile: il bot non apre, lo dice, e notifica UNA volta per episodio', async () => {
  const bot = new PerpsBot({
    id: 'bot-sizecap-4', name: 'BTC warmup', coin: 'BTCWARM-PERP', network: 'testnet',
    master_address: '0xSIZECAP4', max_allocation_usd: 500,
    config_json: JSON.stringify({ ...BTC_REALE, paper: true })
  }, () => {});

  const originale = notifier.notify;
  const messaggi = [];
  notifier.notify = async (m) => { messaggi.push(m); return true; };
  try {
    // Candele insufficienti per l'ATR → ramo statico → `sizing` senza `value`.
    const snapshot = { price: MID, candles: flatCandles(3, 2) };
    await bot._openPosition('long', snapshot, { equity: 10000, positions: [] });
    await bot._openPosition('long', snapshot, { equity: 10000, positions: [] });
    await bot._openPosition('long', snapshot, { equity: 10000, positions: [] });
  } finally {
    notifier.notify = originale;
  }

  assert.equal(bot.position, null, 'nessuna posizione: una size NaN non deve raggiungere il broker');
  assert.match(bot.lastEval?.reason ?? '', /sizing/i);
  assert.equal(messaggi.length, 1, 'tre tick con lo stesso motivo = una sola notifica');
});

test('bot con la config REALE di NEAR: apre entro il tetto, senza passare dal Budget Ceiling', async () => {
  const bot = new PerpsBot({
    id: 'bot-sizecap-1', name: 'NEAR cap', coin: 'NEARCAP-PERP', network: 'testnet',
    master_address: '0xSIZECAP1',
    // `max_allocation_usd` è ciò che scrive `register_bot` dal medesimo campo
    // di config: in produzione valeva 500 ed è l'unica cosa che ha fermato le
    // aperture. Qui serve a dimostrare che dopo il fix non serve più.
    max_allocation_usd: 500,
    config_json: JSON.stringify({ ...NEAR_REALE, paper: true })
  }, () => {});

  await bot._openPosition('long', { price: MID, candles: flatCandles(30, 2) }, { equity: 10000, positions: [] });

  assert.ok(bot.position, 'la posizione deve aprirsi: il notional pianificato è ora entro il tetto');
  assert.ok(bot.position.size * MID <= 500 + 1e-9,
    `notional aperto ${bot.position.size * MID}$ oltre il tetto di 500$`);
  assert.equal(bot.lastEval?.reason ?? '', '', 'nessun blocco registrato');
});
