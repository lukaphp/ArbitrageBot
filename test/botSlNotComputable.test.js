/**
 * #76 — posizione aperta senza stop-loss se il calcolo ATR fallisce.
 * =================================================================
 *
 * Con `sl.mode: 'atr'` e candele non scaricate (`marketData.getSnapshot`
 * ingoia l'errore e restituisce `[]`) l'ATR era null, `computeTpSl` dava
 * `slPx: null` e `_ensureStopLoss` usciva subito (`!slPx` → «SL non
 * previsto»): la posizione restava aperta SENZA stop e nessuno se ne
 * accorgeva.
 *
 * Coperto:
 *  - apertura con SL ATR e candele vuote → nessun ordine, motivo in
 *    `lastEval`, UNA notifica su più tick; candele tornate → apre normalmente
 *    con lo SL calcolato sullo stesso ATR verificato;
 *  - SL percentuale valido → comportamento invariato;
 *  - SL non abilitato → apre (policy), UN avviso per posizione;
 *  - `sl.value` NaN / 0 → apertura bloccata;
 *  - posizione aperta con SL configurato e `slPx` null: candele disponibili →
 *    SL ricalcolato, persistito e piazzato; candele non disponibili → allarme
 *    urgente UNA volta, nessuna chiusura, nuovo tentativo a ogni tick;
 *  - difesa post-fill: SL non valido sull'entry eseguito → allarme urgente,
 *    nessuna chiusura, la guardia ritenta;
 *  - `_replaceTpSl` con il nuovo SL non calcolabile (DCA, adozione): lo stop
 *    precedente NON viene cancellato, `slPx`/`slOid` restano, allarme urgente
 *    una volta; al primo ricalcolo riuscito la guardia lo sostituisce
 *    (place-then-cancel) sulla size corrente. Percorso felice invariato;
 *  - la funzione pura `stopLossUncomputableReason`.
 *
 * Seam: paperBroker (stato reale dei trigger) e DB singleton su file
 * temporaneo, mai data/perps.db. `marketData.getCandles` è sostituita: è la
 * fonte di dati freschi che la guardia usa per il ricalcolo.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-slnocalc-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: paperBroker } = await import('../src/perps/paperBroker.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { default: riskManager } = await import('../src/perps/riskManager.js');
const { PerpsBot } = await import('../src/perps/bot.js');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text, opts) => { notified.push({ text, urgent: !!opts?.urgent }); return true; };

/** Candele con true range costante `tr`: ATR(14) vale esattamente `tr`. */
function flatCandles(n, tr = 2, close = MID) {
  return Array.from({ length: n }, (_, i) => ({
    t: i, o: close, h: close + tr / 2, l: close - tr / 2, c: close, v: 1
  }));
}

// Fonte delle candele "fresche" per la guardia: o un array, o un errore.
let candleSource = { candles: [] };
let candleCalls = 0;
marketData.getCandles = async () => {
  candleCalls++;
  if (candleSource.error) throw new Error(candleSource.error);
  return candleSource.candles;
};

const ATR_CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 }, // 100$ × leva 1 @ 100 → size 1
  leverage: 1,
  atrPeriod: 14,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'atr', value: 1.5 }
};
const PERCENT_CONFIG = { ...ATR_CONFIG, sl: { enabled: true, mode: 'percent', value: 5 } };
const NO_SL_CONFIG = { ...ATR_CONFIG, sl: undefined };

const ACCOUNT = { equity: 10000, positions: [] };
const snap = (candles = []) => ({ price: MID, candles });

let seq = 0;
function makeBot(config) {
  seq++;
  const master = `0xSLNC${seq}`;
  const coin = `SLNC${seq}-PERP`;
  const bot = new PerpsBot({
    id: `bot-slnc-${seq}`, name: `SLNC ${seq}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config)
  }, () => {});
  bot.broker = Object.create(paperBroker);
  return { bot, master, coin };
}

/** Posizione long size 1 @ 100 già aperta sull'exchange simulato, con `slPx` null. */
async function botWithNakedPosition(config) {
  const { bot, master, coin } = makeBot(config);
  const open = await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const entryPx = open.avgPx;
  const posId = db.insertPosition({ botId: bot.id, coin, side: 'long', size: 1, entryPx, leverage: 1, tpPx: null, slPx: null });
  bot.position = {
    id: posId, side: 'long', size: 1, entryPx, originalEntryPx: entryPx,
    dcaCount: 0, tpPx: null, slPx: null, slOid: null, tpOids: [], openedAt: Date.now()
  };
  bot.broker.closePosition = async (...args) => { bot.closeCalls = (bot.closeCalls || 0) + 1; return paperBroker.closePosition(...args); };
  return { bot, master, coin, posId, entryPx };
}

const stopsOnBook = async (master) =>
  (await paperBroker.getFrontendOpenOrders(master)).filter(o => o.isTrigger && /stop/i.test(o.orderType || ''));
const texts = (re) => notified.filter(n => re.test(n.text));

beforeEach(() => {
  notified.length = 0;
  MID = 100;
  candleSource = { candles: [] };
  candleCalls = 0;
  db.setSetting('killswitch', 'off');
  db.setSetting('portfolio_limits', '{}');
});

// ---------------------------------------------------------------------------
// Apertura (fail-closed)
// ---------------------------------------------------------------------------

test('SL ATR con candele vuote: nessun ordine, motivo in lastEval, una notifica su più tick; candele tornate → apre', async () => {
  const { bot, master } = makeBot(ATR_CONFIG);

  for (let i = 0; i < 3; i++) await bot._openPosition('long', snap([]), ACCOUNT);

  assert.equal(bot.position, null, 'nessuna posizione aperta');
  assert.equal(db.getOpenPositionByBot(bot.id), undefined, 'nessuna riga in DB');
  assert.equal(db.listTradesBy({ botId: bot.id }).length, 0, 'nessun ordine mandato al broker');
  assert.deepEqual(await paperBroker.getFrontendOpenOrders(master), [], 'nessun trigger sul book');
  assert.equal(bot.lastEval.action, 'hold');
  assert.match(bot.lastEval.reason, /^SL configurato ma non calcolabile: ATR non disponibile/);
  const notices = texts(/non calcolabile/);
  assert.equal(notices.length, 1, 'tre tick nello stesso episodio, una notifica');
  assert.match(notices[0].text, /LONG/);

  // Le candele tornano: l'apertura passa, con lo SL sullo STESSO ATR verificato.
  await bot._openPosition('long', snap(flatCandles(30, 2)), ACCOUNT);
  assert.ok(bot.position, 'apre appena lo SL è calcolabile');
  assert.ok(Math.abs(bot.position.slPx - (bot.position.entryPx - 1.5 * 2)) < 1e-9, `SL = entry − 1.5×ATR, trovato ${bot.position.slPx}`);
  assert.equal((await stopsOnBook(master)).length, 1, 'SL piazzato sul book');
  assert.equal(bot._slUncomputableEpisode, null, 'episodio chiuso dall\'apertura riuscita');
  assert.equal(texts(/non calcolabile/).length, 1, 'nessuna nuova notifica di blocco');
});

test('SL percentuale valido: apertura invariata, nessun avviso', async () => {
  const { bot, master } = makeBot(PERCENT_CONFIG);
  await bot._openPosition('long', snap([]), ACCOUNT);

  assert.ok(bot.position, 'aperta anche senza candele: lo SL percentuale non ne ha bisogno');
  assert.ok(Math.abs(bot.position.slPx - bot.position.entryPx * 0.95) < 1e-9);
  assert.equal((await stopsOnBook(master)).length, 1);
  assert.equal(texts(/non calcolabile|SENZA stop-loss|per configurazione/).length, 0);
});

test('SL non abilitato: apre (policy), un solo avviso per la posizione anche su più tick', async () => {
  const { bot, master } = makeBot(NO_SL_CONFIG);
  await bot._openPosition('long', snap([]), ACCOUNT);

  assert.ok(bot.position, 'il bot senza SL per configurazione non viene bloccato');
  assert.equal(bot.position.slPx, null);
  for (let i = 0; i < 3; i++) await bot._ensureStopLoss(null, MID);

  assert.equal((await stopsOnBook(master)).length, 0, 'nessuno SL inventato');
  const warns = texts(/per configurazione/);
  assert.equal(warns.length, 1, 'un avviso per posizione, non per tick');
  assert.equal(warns[0].urgent, false, 'è una scelta di policy, non un allarme');
  assert.equal(texts(/non calcolabile|SENZA stop-loss/).length, 0);
});

test('sl.value NaN o 0: apertura bloccata', async () => {
  for (const [mode, value] of [['percent', NaN], ['percent', 0], ['atr', 0], ['absolute', NaN]]) {
    const { bot, master } = makeBot(ATR_CONFIG);
    bot.config.sl = { enabled: true, mode, value };
    await bot._openPosition('long', snap(flatCandles(30, 2)), ACCOUNT);
    assert.equal(bot.position, null, `${mode}/${value}: nessuna apertura`);
    assert.deepEqual(await paperBroker.getFrontendOpenOrders(master), []);
    assert.match(bot.lastEval.reason, /^SL configurato ma non calcolabile: sl\.value non valido/, `${mode}/${value}`);
  }
});

// ---------------------------------------------------------------------------
// Guardia su posizione già aperta
// ---------------------------------------------------------------------------

test('posizione con SL configurato e slPx null, candele disponibili: SL ricalcolato, persistito e piazzato', async () => {
  const { bot, master, posId, entryPx } = await botWithNakedPosition(ATR_CONFIG);
  candleSource = { candles: flatCandles(30, 2) };

  await bot._ensureStopLoss(null, MID);

  const expected = entryPx - 1.5 * 2;
  assert.ok(Math.abs(bot.position.slPx - expected) < 1e-9, `slPx ricalcolato dall'entry, trovato ${bot.position.slPx}`);
  assert.ok(Math.abs(db.getPosition(posId).sl_px - expected) < 1e-9, 'sl_px persistito in DB');
  const stops = await stopsOnBook(master);
  assert.equal(stops.length, 1, 'SL piazzato dalla guardia');
  assert.equal(bot.position.slOid, stops[0].oid);
  assert.equal(texts(/SENZA stop-loss/).length, 0, 'nessun allarme: il ricalcolo è riuscito subito');
});

test('posizione con SL configurato e slPx null, candele non disponibili: allarme urgente una volta, nessuna chiusura, ritenta', async () => {
  const { bot, master, posId } = await botWithNakedPosition(ATR_CONFIG);
  candleSource = { error: 'timeout candleSnapshot' };

  for (let i = 0; i < 3; i++) await bot._ensureStopLoss(null, MID);

  assert.ok(bot.position, 'la posizione NON viene chiusa');
  assert.equal(bot.closeCalls || 0, 0, 'nessuna chiusura tentata');
  assert.equal(db.getOpenPositionByBot(bot.id)?.id, posId);
  assert.equal(candleCalls, 3, 'un tentativo di ricalcolo per tick');
  const alarms = texts(/SENZA stop-loss/);
  assert.equal(alarms.length, 1, 'un allarme per episodio, non per tick');
  assert.equal(alarms[0].urgent, true);
  assert.match(alarms[0].text, /timeout candleSnapshot/, 'l\'errore delle candele è nel motivo');
  assert.equal((await stopsOnBook(master)).length, 0);

  // Le candele tornano: SL ricalcolato e piazzato, rientro notificato.
  candleSource = { candles: flatCandles(30, 2) };
  await bot._ensureStopLoss(null, MID);
  assert.ok(riskManager.isValidStopPx(bot.position.slPx));
  assert.equal((await stopsOnBook(master)).length, 1);
  assert.equal(texts(/di nuovo calcolabile/).length, 1);
  assert.equal(bot._slMissingEpisode, null);
});

test('difesa post-fill: SL non valido sull\'entry eseguito → allarme urgente, nessuna chiusura', async () => {
  // Il controllo pre-ordine passa sul prezzo del tick; l'entry eseguito è
  // assurdo (negativo) e lo SL percentuale che ne deriva non è un prezzo.
  const { bot } = makeBot(PERCENT_CONFIG);
  bot.broker.placeMarketOrder = async () => ({ oid: 777, totalSz: 1, avgPx: -1 });
  bot.broker.closePosition = async () => { bot.closeCalls = (bot.closeCalls || 0) + 1; return { oid: 1 }; };

  await bot._openPosition('long', snap([]), ACCOUNT);

  assert.ok(bot.position, 'posizione tracciata');
  assert.equal(bot.position.slPx, null, 'nessuno slPx non valido nello stato');
  assert.equal(db.getOpenPositionByBot(bot.id).sl_px, null, 'nessun NaN/negativo in DB');
  assert.equal(bot.closeCalls || 0, 0, 'nessuna chiusura');
  const alarms = texts(/SENZA stop-loss/);
  assert.equal(alarms.length, 1, 'un allarme (post-fill), non ripetuto dalla guardia nello stesso episodio');
  assert.equal(alarms[0].urgent, true);

  await bot._ensureStopLoss(null, MID);
  assert.equal(texts(/SENZA stop-loss/).length, 1, 'la guardia ritenta senza rinotificare');
});

// ---------------------------------------------------------------------------
// `_replaceTpSl`: nuovo SL non piazzabile → lo stop precedente resta
// ---------------------------------------------------------------------------

const DCA_ATR_CONFIG = { ...ATR_CONFIG, dca: { steps: 3, stepPercent: 2, sizeMultiplier: 1 } };

/** Posizione long size 1 @ 100 con SL ATR (ATR 2 → soglia 97) già sul book. */
async function botWithAtrStop() {
  const { bot, master, coin } = makeBot(DCA_ATR_CONFIG);
  const open = await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const entryPx = open.avgPx;
  const { tpPx, slPx } = riskManager.computeTpSl(entryPx, 'long', DCA_ATR_CONFIG, { atr: 2 });
  const posId = db.insertPosition({ botId: bot.id, coin, side: 'long', size: 1, entryPx, leverage: 1, tpPx, slPx });
  bot.position = {
    id: posId, side: 'long', size: 1, entryPx, originalEntryPx: entryPx,
    dcaCount: 0, tpPx, slPx, slOid: null, tpOids: [], openedAt: Date.now()
  };
  await bot._placeTpSl();
  bot.broker.closePosition = async (...args) => { bot.closeCalls = (bot.closeCalls || 0) + 1; return paperBroker.closePosition(...args); };
  return { bot, master, coin, posId, slPx };
}

test('DCA con candele assenti su SL ATR: lo SL precedente NON viene cancellato, stato invariato, un allarme; candele tornate → sostituito sulla size nuova', async () => {
  const { bot, master, posId, slPx } = await botWithAtrStop();
  const oldOid = bot.position.slOid;
  assert.ok(oldOid != null);

  MID = 97.95; // −2.05%: scatta lo step DCA, ancora sopra la soglia 97
  candleSource = { error: 'timeout candleSnapshot' };
  await bot._maybeDca(snap([]), ACCOUNT);

  assert.equal(bot.position.dcaCount, 1, 'la DCA è stata eseguita');
  assert.equal(bot.position.size, 2);
  let stops = await stopsOnBook(master);
  assert.deepEqual(stops.map(o => o.oid), [oldOid], 'lo SL precedente è ancora sul book, nessuno nuovo');
  assert.equal(bot.position.slOid, oldOid, 'slOid invariato');
  assert.equal(bot.position.slPx, slPx, 'slPx invariato');
  assert.equal(db.getPosition(posId).sl_px, slPx, 'nessun sl_px null scritto in DB');
  assert.ok(bot.position.slStale, 'posizione marcata: stop da ricalcolare');
  assert.match(JSON.parse(db.getPosition(posId).trailing_json).slStale, /DCA #1/, 'marcatura persistita');
  let alarms = texts(/non ricalcolabile/);
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].urgent, true);
  assert.match(alarms[0].text, /size PRECEDENTE/, 'il messaggio dice che lo stop copre solo la size precedente');

  // Tick successivi con candele ancora assenti: niente chiusura, niente raffica.
  for (let i = 0; i < 3; i++) await bot._ensureStopLoss(null, MID);
  assert.ok(bot.position);
  assert.equal(bot.closeCalls || 0, 0, 'nessuna chiusura');
  assert.deepEqual((await stopsOnBook(master)).map(o => o.oid), [oldOid], 'lo stop vecchio resta sorvegliato');
  assert.equal(texts(/non ricalcolabile|SENZA stop-loss/).length, 1, 'un allarme per episodio');

  // Candele tornate: nuovo SL sull'entry medio e sulla size corrente, poi via il vecchio.
  candleSource = { candles: flatCandles(30, 2) };
  await bot._ensureStopLoss(null, MID);
  stops = await stopsOnBook(master);
  assert.equal(stops.length, 1, 'un solo SL');
  assert.notEqual(stops[0].oid, oldOid, 'il vecchio è stato sostituito');
  assert.equal(stops[0].sz, 2, 'il nuovo copre la size corrente');
  assert.ok(Math.abs(bot.position.slPx - (bot.position.entryPx - 1.5 * 2)) < 1e-4);
  assert.equal(bot.position.slOid, stops[0].oid);
  assert.equal(bot.position.slStale, null);
  assert.equal(JSON.parse(db.getPosition(posId).trailing_json).slStale, null);
  assert.equal(texts(/di nuovo calcolabile/).length, 1);
});

test('DCA con candele presenti su SL ATR: percorso invariato (vecchio SL sostituito, nessun allarme)', async () => {
  const { bot, master } = await botWithAtrStop();
  const oldOid = bot.position.slOid;

  MID = 97.95;
  await bot._maybeDca(snap(flatCandles(30, 2)), ACCOUNT);

  const stops = await stopsOnBook(master);
  assert.equal(stops.length, 1);
  assert.notEqual(stops[0].oid, oldOid, 'vecchio SL cancellato dopo il piazzamento del nuovo');
  assert.equal(stops[0].sz, 2);
  assert.equal(bot.position.slOid, stops[0].oid);
  assert.equal(bot.position.slStale, null);
  assert.equal(texts(/non ricalcolabile|SENZA stop-loss/).length, 0);
});

test('adozione con SL non calcolabile: lo stop già sul book NON viene cancellato; candele tornate → sostituito', async () => {
  const { bot, master, coin } = makeBot(ATR_CONFIG);
  await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  // Stop piazzato a mano da chi ha aperto la posizione fuori dal bot.
  const manual = await paperBroker.placeTriggerOrder({ masterAddress: master, coin, isBuy: false, size: 1, triggerPx: 90, tpsl: 'sl' }, 'testnet');
  candleSource = { error: 'timeout candleSnapshot' };
  const livePos = { coin, side: 'long', size: 1, entryPx: MID, leverage: 1, unrealizedPnl: 0 };

  await bot._reconcile(livePos, snap([]));

  assert.ok(bot.position, 'posizione adottata');
  assert.deepEqual((await stopsOnBook(master)).map(o => o.oid), [manual.oid], 'lo stop esistente resta sul book');
  assert.ok(bot.position.slStale, 'marcata per il ricalcolo');
  assert.equal(bot.closeCalls || 0, 0);
  const alarms = texts(/non ricalcolabile|SENZA stop-loss/);
  assert.equal(alarms.length, 1, 'un allarme, anche se guardia e adozione passano entrambe dal ricalcolo');
  assert.equal(alarms[0].urgent, true);
  assert.match(alarms[0].text, /mantengo lo SL precedente/);

  await bot._ensureStopLoss(null, MID);
  assert.deepEqual((await stopsOnBook(master)).map(o => o.oid), [manual.oid], 'ancora protetta dallo stop esistente');
  assert.equal(texts(/non ricalcolabile|SENZA stop-loss/).length, 1);

  candleSource = { candles: flatCandles(30, 2) };
  await bot._ensureStopLoss(null, MID);
  const stops = await stopsOnBook(master);
  assert.equal(stops.length, 1, 'un solo SL');
  assert.notEqual(stops[0].oid, manual.oid, 'sostituito dallo SL del bot');
  assert.ok(Math.abs(stops[0].triggerPx - (MID - 1.5 * 2)) < 1e-4);
  assert.equal(bot.position.slStale, null);
});

// ---------------------------------------------------------------------------
// Funzione pura
// ---------------------------------------------------------------------------

test('stopLossUncomputableReason: null se calcolabile o non configurato, motivo altrimenti', () => {
  const r = (sl, atr, px = 100) => riskManager.stopLossUncomputableReason(px, 'long', { sl }, { atr });
  assert.equal(r(undefined, null), null, 'SL non configurato: niente da calcolare');
  assert.equal(r({ enabled: false, mode: 'atr', value: 1 }, null), null);
  assert.equal(r({ enabled: true, mode: 'percent', value: 5 }, null), null);
  assert.equal(r({ enabled: true, mode: 'absolute', value: 90 }, null), null);
  assert.equal(r({ enabled: true, mode: 'atr', value: 1 }, 2), null);
  assert.match(r({ enabled: true, mode: 'atr', value: 1 }, null), /ATR non disponibile/);
  assert.match(r({ enabled: true, mode: 'atr', value: 1 }, NaN), /ATR non disponibile/);
  assert.match(r({ enabled: true, mode: 'atr', value: 1 }, 0), /ATR non disponibile/);
  assert.match(r({ enabled: true, mode: 'percent', value: NaN }, null), /sl\.value non valido/);
  assert.match(r({ enabled: true, mode: 'percent', value: -1 }, null), /sl\.value non valido/);
  assert.match(r({ enabled: true, mode: 'absolute' }, null), /sl\.value non valido/);
  assert.match(r({ enabled: true, mode: 'percent', value: 100 }, null), /non è un prezzo valido/, 'SL a prezzo zero');
  assert.match(r({ enabled: true, mode: 'atr', value: 100 }, 2), /non è un prezzo valido/, 'SL ATR sotto zero');
  // Il motivo è stabile tra tick con prezzi diversi: è la chiave dell'episodio.
  assert.equal(r({ enabled: true, mode: 'atr', value: 1 }, null, 100), r({ enabled: true, mode: 'atr', value: 1 }, null, 101));
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
