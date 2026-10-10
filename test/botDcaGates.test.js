/**
 * #71 — ogni step DCA passa dagli stessi gate di rischio dell'apertura.
 * ====================================================================
 *
 * Prima `_maybeDca` aggiungeva `size × sizeMultiplier` senza alcun controllo:
 * niente kill switch, `checkLimits`, tetto di notional, Budget Ceiling,
 * esposizione di portafoglio né lock di esecuzione. Con steps=4 e
 * moltiplicatore 1 la posizione arrivava a 16× la size di un ingresso.
 *
 * Coperto, per ogni gate: l'ordine NON parte e `dcaCount` resta invariato
 * (lo step non viene consumato), con il motivo in `lastEval` e UNA notifica per
 * episodio su più tick. In più: NaN su prezzo/size/equity → bloccato; il
 * conteggio delle posizioni concorrenti e il cooldown di `canOpen()` NON
 * bloccano una DCA; il percorso felice aggiunge e ri-piazza TP/SL; il lock
 * preso dalla DCA viene rilasciato; lo schema rifiuta steps/moltiplicatori
 * fuori range.
 *
 * Seam: paperBroker (stato reale dei trigger) con `placeMarketOrder` contato,
 * DB singleton su file temporaneo (mai data/perps.db). L'apertura iniziale è
 * riprodotta a mano come in test/botDca.test.js, poi si esercitano i metodi
 * reali `_maybeDca` / `_manageOpen`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-dcagates-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: paperBroker } = await import('../src/perps/paperBroker.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { default: riskManager } = await import('../src/perps/riskManager.js');
const { default: execQueue } = await import('../src/perps/execQueue.js');
const { default: portfolio, checkExposure } = await import('../src/perps/portfolio.js');
const { PerpsBot } = await import('../src/perps/bot.js');
const { validateStrategyConfig, MAX_DCA_STEPS, MAX_DCA_SIZE_MULTIPLIER } = await import('../src/perps/strategySchema.js');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

const BASE_CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'percent', value: 5 },
  dca: { steps: 3, stepPercent: 2, sizeMultiplier: 1 }
};
const ACCOUNT = { equity: 10000, positions: [] };
const snap = (price = MID) => ({ price, candles: [] });

let seq = 0;
/**
 * Bot con posizione long di size 1 @ 100 già aperta e protetta (stesso stato
 * lasciato da `_openPosition`), e un broker che conta gli ordini market.
 */
async function botWithPosition(config = BASE_CONFIG, extra = {}) {
  seq++;
  const master = `0xDCAG${seq}`;
  const coin = `DCAG${seq}-PERP`;
  const bot = new PerpsBot({
    id: `bot-dcag-${seq}`, name: `DCA Gate ${seq}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config), ...extra
  }, () => {});

  MID = 100;
  const open = await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const entryPx = open.avgPx;
  const { tpPx, slPx } = riskManager.computeTpSl(entryPx, 'long', config);
  const posId = db.insertPosition({ botId: bot.id, coin, side: 'long', size: 1, entryPx, leverage: 1, tpPx, slPx });
  bot.position = {
    id: posId, side: 'long', size: 1, entryPx,
    originalEntryPx: entryPx, dcaCount: 0, tpPx, slPx, slOid: null, tpOids: [], openedAt: Date.now()
  };
  await bot._placeTpSl();

  const broker = Object.create(paperBroker);
  broker.market = [];
  broker.placeMarketOrder = async (params, network) => {
    broker.market.push(params);
    return paperBroker.placeMarketOrder(params, network);
  };
  bot.broker = broker;
  return { bot, master, coin, broker, posId };
}

const dcaNotices = () => notified.filter(t => /step DCA/.test(t));

beforeEach(() => {
  notified.length = 0;
  MID = 100;
  db.setSetting('killswitch', 'off');
  db.setSetting('portfolio_limits', '{}');
});

// ---------------------------------------------------------------------------
// a. kill switch
// ---------------------------------------------------------------------------

test('kill switch attivo: step DCA saltato, dcaCount invariato, una notifica su più tick; spento → la DCA parte', async () => {
  const { bot, broker } = await botWithPosition();
  db.setSetting('killswitch', 'on');

  MID = 97.5;
  for (let i = 0; i < 3; i++) await bot._maybeDca(snap(), ACCOUNT);

  assert.equal(broker.market.length, 0, 'nessun ordine market');
  assert.equal(bot.position.dcaCount, 0, 'lo step non è consumato');
  assert.equal(bot.position.size, 1);
  assert.equal(bot.lastEval.action, 'hold');
  assert.match(bot.lastEval.reason, /DCA #1 saltato: kill switch attivo/);
  assert.equal(dcaNotices().length, 1, 'tre tick nello stesso episodio, una notifica');
  assert.match(dcaNotices()[0], /kill switch attivo/i);
  assert.match(dcaNotices()[0], /DCA #1/, 'la notifica dice che è lo step DCA a essere saltato');

  db.setSetting('killswitch', 'off');
  await bot._maybeDca(snap(), ACCOUNT);
  assert.equal(bot.position.dcaCount, 1, 'flag spento: lo step parte');
  assert.equal(broker.market.length, 1);
});

// ---------------------------------------------------------------------------
// b. checkLimits — perdita giornaliera e leva
// ---------------------------------------------------------------------------

test('limite di perdita giornaliera raggiunto: nessuna aggiunta, una notifica su più tick', async () => {
  const config = { ...BASE_CONFIG, risk: { maxDailyLossUsd: 50 } };
  const { bot, broker } = await botWithPosition(config);
  bot.dailyPnl = -60;

  MID = 97.5;
  for (let i = 0; i < 3; i++) await bot._maybeDca(snap(), ACCOUNT);

  assert.equal(broker.market.length, 0);
  assert.equal(bot.position.dcaCount, 0);
  assert.match(bot.lastEval.reason, /perdita giornaliera/);
  assert.equal(dcaNotices().length, 1);
});

test('leva oltre il massimo: nessuna aggiunta', async () => {
  const config = { ...BASE_CONFIG, leverage: 5, risk: { maxLeverage: 2 } };
  const { bot, broker } = await botWithPosition(config);

  MID = 97.5;
  await bot._maybeDca(snap(), ACCOUNT);

  assert.equal(broker.market.length, 0);
  assert.equal(bot.position.dcaCount, 0);
  assert.match(bot.lastEval.reason, /Leva 5x oltre il massimo/);
});

// ---------------------------------------------------------------------------
// c. tetto di notional sul TOTALE post-DCA
// ---------------------------------------------------------------------------

test('steps=4 mult=1: la catena si ferma prima di superare il tetto di notional della posizione', async () => {
  const config = { ...BASE_CONFIG, dca: { steps: 4, stepPercent: 2, sizeMultiplier: 1 }, risk: { maxPositionUsd: 500 } };
  const { bot, broker } = await botWithPosition(config);

  // Soglie: 2%, 4%, 6%, 8% dall'ingresso originale (100).
  for (const px of [97.5, 95.5, 93.5, 93.4, 91.5, 91.4]) {
    MID = px;
    await bot._maybeDca(snap(), ACCOUNT);
    assert.ok(bot.position.size * px <= 500, `a ${px} il notional (${bot.position.size * px}) non supera il tetto`);
  }

  assert.equal(bot.position.dcaCount, 2, 'eseguiti solo i due step che stanno nel tetto (1 → 2 → 4)');
  assert.equal(bot.position.size, 4, 'senza gate sarebbe arrivata a 16');
  assert.equal(broker.market.length, 2);
  assert.match(bot.lastEval.reason, /DCA #3 saltato: notional post-DCA .* oltre il massimo per posizione \(500\$\)/);
  assert.equal(dcaNotices().length, 1, 'stesso step, stesso motivo su più tick e prezzi diversi: una notifica');
});

// ---------------------------------------------------------------------------
// d. Budget Ceiling sul totale post-DCA
// ---------------------------------------------------------------------------

test('Budget Ceiling: il totale post-DCA oltre il limite blocca lo step', async () => {
  const { bot, broker } = await botWithPosition(BASE_CONFIG, { max_allocation_usd: 150 });
  assert.equal(bot.maxAllocationUsd, 150, 'precondizione: budget letto dalla riga');

  MID = 97.5;
  await bot._maybeDca(snap(), ACCOUNT);

  assert.equal(broker.market.length, 0, 'ingresso da 100$ nel budget, ma 1+1 a 97.5 = 195$ no');
  assert.equal(bot.position.dcaCount, 0);
  assert.match(bot.lastEval.reason, /Budget Ceiling: notional post-DCA 195\.00\$ supera il limite di 150\$/);
});

// ---------------------------------------------------------------------------
// e. esposizione di portafoglio (sola aggiunta) — e NON gli altri rami di canOpen
// ---------------------------------------------------------------------------

test('esposizione di portafoglio oltre il limite: step saltato', async () => {
  const { bot, broker, coin } = await botWithPosition();
  db.setSetting('portfolio_limits', JSON.stringify({ maxTotalExposureUsd: 150 }));
  const account = { equity: 10000, positions: [{ coin, positionValue: 100 }] };

  MID = 97.5;
  await bot._maybeDca(snap(), account);

  assert.equal(broker.market.length, 0, '100$ già a book + 97.5$ di aggiunta > 150$');
  assert.equal(bot.position.dcaCount, 0);
  assert.match(bot.lastEval.reason, /portafoglio: Esposizione totale 198\$ oltre il limite \(150\$\)/);
});

test('posizioni concorrenti al massimo e cooldown attivo NON bloccano la DCA di una posizione già contata', async () => {
  const { bot, broker, coin } = await botWithPosition();
  db.setSetting('portfolio_limits', JSON.stringify({ maxConcurrentPositions: 1, maxConsecutiveLosses: 1 }));
  portfolio.recordLoss(bot.id, 5);
  const account = { equity: 10000, positions: [{ coin, positionValue: 100 }] };
  assert.equal(portfolio.canOpen({ account, plannedNotional: 97.5, botId: bot.id }).ok, false,
    'precondizione: canOpen() negherebbe una nuova apertura');

  MID = 97.5;
  await bot._maybeDca(snap(), account);

  assert.equal(bot.position.dcaCount, 1, 'la DCA passa: conta solo l\'esposizione');
  assert.equal(broker.market.length, 1);
});

// ---------------------------------------------------------------------------
// f. lock di esecuzione
// ---------------------------------------------------------------------------

test('lock (master, coin) tenuto da un altro bot: step saltato, lock altrui intatto; poi la DCA lo prende e lo rilascia', async () => {
  const { bot, broker, master, coin } = await botWithPosition();
  assert.ok(execQueue.acquireOpenLock(master, coin), 'un altro bot prende il lock');

  MID = 97.5;
  await bot._maybeDca(snap(), ACCOUNT);
  assert.equal(broker.market.length, 0);
  assert.equal(bot.position.dcaCount, 0);
  assert.match(bot.lastEval.reason, /un altro bot ha il lock/);
  assert.ok(execQueue.isOpenLocked(master, coin), 'il lock dell\'altro bot NON viene rilasciato dal blocco');

  execQueue.releaseOpenLock(master, coin);
  await bot._maybeDca(snap(), ACCOUNT);
  assert.equal(bot.position.dcaCount, 1);
  assert.equal(execQueue.isOpenLocked(master, coin), false, 'il lock preso dalla DCA è rilasciato a fine operazione');
  assert.equal(execQueue.reservedOpenSlots(master), 0, 'nessuno slot di apertura impegnato da una DCA');
});

// ---------------------------------------------------------------------------
// Dati non validi → fail-closed
// ---------------------------------------------------------------------------

test('prezzo NaN: nessuna DCA (prima la soglia NaN la faceva partire)', async () => {
  const { bot, broker } = await botWithPosition();
  await bot._maybeDca(snap(NaN), ACCOUNT);
  assert.equal(broker.market.length, 0);
  assert.equal(bot.position.dcaCount, 0);
});

test('size di posizione NaN: step bloccato con motivo, una notifica su più tick', async () => {
  const { bot, broker } = await botWithPosition();
  bot.position.size = NaN;

  MID = 97.5;
  for (let i = 0; i < 3; i++) await bot._maybeDca(snap(), ACCOUNT);

  assert.equal(broker.market.length, 0);
  assert.equal(bot.position.dcaCount, 0);
  assert.match(bot.lastEval.reason, /dati non validi/);
  assert.equal(dcaNotices().length, 1);
});

test('account senza equity leggibile: step bloccato (fail-closed)', async () => {
  const { bot, broker } = await botWithPosition();
  MID = 97.5;
  await bot._maybeDca(snap(), {});
  await bot._maybeDca(snap(), undefined);
  assert.equal(broker.market.length, 0);
  assert.equal(bot.position.dcaCount, 0);
  assert.match(bot.lastEval.reason, /equity/);
});

// ---------------------------------------------------------------------------
// Percorso felice, attraverso `_manageOpen`
// ---------------------------------------------------------------------------

test('percorso felice via _manageOpen: aggiunge, ri-piazza TP/SL sulla size totale, nessuna notifica di blocco', async () => {
  const { bot, broker, master } = await botWithPosition();

  MID = 97.5;
  await bot._manageOpen(snap(), ACCOUNT, { action: 'hold' });

  assert.equal(bot.position.dcaCount, 1);
  assert.equal(bot.position.size, 2);
  assert.equal(broker.market.length, 1);
  const expected = riskManager.computeTpSl(bot.position.entryPx, 'long', BASE_CONFIG);
  assert.ok(Math.abs(bot.position.tpPx - expected.tpPx) < 1e-9);
  const orders = await paperBroker.getFrontendOpenOrders(master);
  const tps = orders.filter(o => /take profit/i.test(o.orderType));
  const sls = orders.filter(o => /stop/i.test(o.orderType));
  assert.equal(tps.length, 1);
  assert.equal(sls.length, 1);
  assert.equal(tps[0].sz, 2, 'TP sulla size totale');
  assert.equal(sls[0].sz, 2, 'SL sulla size totale');
  assert.equal(dcaNotices().length, 0);
});

// ---------------------------------------------------------------------------
// Calcoli puri
// ---------------------------------------------------------------------------

test('riskManager.checkDcaAdd: ordine dei gate e chiavi stabili per episodio', () => {
  const position = { size: 1 };
  const base = { account: ACCOUNT, position, price: 100, addSize: 1, leverage: 1, dailyPnl: 0 };
  const ok = riskManager.checkDcaAdd({}, base);
  assert.equal(ok.ok, true);
  assert.equal(ok.addNotional, 100);
  assert.equal(ok.totalNotional, 200);

  assert.equal(riskManager.checkDcaAdd({}, { ...base, addSize: Infinity }).kind, 'dati');
  assert.equal(riskManager.checkDcaAdd({}, { ...base, dailyPnl: NaN }).kind, 'dati');
  assert.equal(riskManager.checkDcaAdd({}, { ...base, maxAllocationUsd: 'abc' }).kind, 'budget',
    'un budget dichiarato ma illeggibile blocca');
  const a = riskManager.checkDcaAdd({ risk: { maxPositionUsd: 150 } }, { ...base, price: 100 });
  const b = riskManager.checkDcaAdd({ risk: { maxPositionUsd: 150 } }, { ...base, price: 99 });
  assert.equal(a.kind, 'tetto');
  assert.equal(a.kind, b.kind, 'stessa chiave a prezzi diversi');
});

test('checkExposure: estratta da canOpen, stessa decisione; un plannedNotional non finito blocca', () => {
  const positions = [{ positionValue: 100 }];
  assert.equal(checkExposure({ positions, plannedNotional: 40, maxTotalExposureUsd: 150 }).ok, true);
  assert.equal(checkExposure({ positions, plannedNotional: 60, maxTotalExposureUsd: 150 }).ok, false);
  assert.equal(checkExposure({ positions, plannedNotional: NaN, maxTotalExposureUsd: 150 }).ok, false);
  db.setSetting('portfolio_limits', JSON.stringify({ maxTotalExposureUsd: 150 }));
  const r = portfolio.canOpen({ account: { positions }, plannedNotional: 60, botId: 'x-exp' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Esposizione totale 160\$ oltre il limite \(150\$\)/, 'canOpen usa la stessa funzione, stesso messaggio');
});

// ---------------------------------------------------------------------------
// Schema (scrittura)
// ---------------------------------------------------------------------------

test('schema: dca.steps intero 0..MAX_DCA_STEPS, sizeMultiplier finito in (0, MAX]', () => {
  assert.equal(MAX_DCA_STEPS, 5);
  assert.equal(MAX_DCA_SIZE_MULTIPLIER, 2);
  const base = {
    entryRules: [{ type: 'price', op: '>', value: 1 }],
    sizing: { mode: 'fixed', value: 100 },
    leverage: 1
  };
  const dcaErrors = (dca) => validateStrategyConfig({ ...base, dca }).filter(e => /dca\./.test(e));

  assert.equal(dcaErrors({ steps: 6, stepPercent: 2, sizeMultiplier: 1 }).length, 1, 'steps=6 rifiutato');
  assert.equal(dcaErrors({ steps: 2.5, stepPercent: 2 }).length, 1, 'steps non intero rifiutato');
  for (const m of [0, 3, NaN, -1, Infinity]) {
    assert.equal(dcaErrors({ steps: 2, stepPercent: 2, sizeMultiplier: m }).length, 1, `sizeMultiplier=${m} rifiutato`);
  }
  for (const dca of [
    { steps: 0, stepPercent: 2 },
    { steps: 5, stepPercent: 2, sizeMultiplier: 2 },
    { steps: 3, stepPercent: 2, sizeMultiplier: 0.5 },
    { steps: 1, stepPercent: 2 }
  ]) {
    assert.deepEqual(dcaErrors(dca), [], `accettato: ${JSON.stringify(dca)}`);
  }
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
