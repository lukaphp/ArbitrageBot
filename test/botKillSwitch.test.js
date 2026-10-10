/**
 * #72 — il kill switch ferma le NUOVE aperture anche dei bot a regole.
 * ===================================================================
 *
 * Prima di #72 il flag `killswitch` in `settings` lo leggevano solo il RiskAgent
 * (proposte AI) e `place_order_paper`: `PerpsBot` e `botManager` non lo
 * guardavano mai, e `/api/agents/killswitch` annunciava «nuove aperture
 * bloccate» mentre i bot in esecuzione continuavano ad aprire.
 *
 * Coperto:
 *  - kill switch ON + segnale valido → nessun ordine, motivo in `lastEval`, UNA
 *    notifica su più tick (episodio, non tick); spento → si riapre come prima
 *    e un nuovo episodio rinotifica;
 *  - kill switch OFF → il bot apre come prima;
 *  - kill switch ON con posizione aperta → la gestione continua: la guardia SL
 *    ri-piazza uno stop mancante e la chiusura su segnale passa;
 *  - `killSwitch.js` fail-closed quando la lettura del DB lancia, con UN log
 *    per episodio; il bot dice "non leggibile", non "attivo";
 *  - `botManager`: avvio con kill switch ON → il bot parte comunque (deve poter
 *    proteggere una posizione aperta), con warning nel log, nella notifica e nel
 *    risultato di `applyLifecycleLocal`.
 *
 * Seam: paperBroker (stato reale dei trigger) + DB singleton su file
 * temporaneo, mai data/perps.db. Stesso impianto di test/botOvertrading.test.js.
 * Cosa NON è coperto: il tick completo contro Hyperliquid e il DCA (#71, gated
 * separatamente su `isKillSwitchOn()`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-killswitch-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: paperBroker } = await import('../src/perps/paperBroker.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { default: logger } = await import('../src/utils/logger.js');
const { PerpsBot } = await import('../src/perps/bot.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { isKillSwitchOn, readKillSwitch } = await import('../src/perps/killSwitch.js');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
marketData.getSnapshot = async () => ({ price: MID, candles: [], funding: null });

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

const BASE_CONFIG = {
  paper: true,
  loopInterval: 3600000, // l'unico tick è quello immediato di start()
  sizing: { mode: 'fixed', value: 100 }, // 100$ × leva 1 @ 100 → size 1
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'percent', value: 5 }
};
const ACCOUNT = { equity: 10000, positions: [] };
const SNAP = () => ({ price: MID, candles: [] });

function makeBot(id, coin, master, config = BASE_CONFIG) {
  const bot = new PerpsBot({
    id, name: `Bot ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config)
  }, () => {});
  bot.broker = Object.create(paperBroker);
  return bot;
}

const setKill = (on) => db.setSetting('killswitch', on ? 'on' : 'off');
const killNotices = () => notified.filter(t => /kill switch/i.test(t));

beforeEach(() => {
  notified.length = 0;
  MID = 100;
  setKill(false);
});

// ---------------------------------------------------------------------------
// Gate in `_openPosition`
// ---------------------------------------------------------------------------

test('kill switch ON + segnale valido: nessun ordine, motivo in lastEval, una notifica su più tick', async () => {
  const master = '0xKS1';
  const coin = 'KS1-PERP';
  const bot = makeBot('ks-block', coin, master);
  setKill(true);

  for (let i = 0; i < 4; i++) {
    await bot._openPosition('long', SNAP(), ACCOUNT);
  }

  assert.equal(bot.position, null, 'nessuna posizione aperta');
  assert.equal(db.getOpenPositionByBot(bot.id), undefined, 'nessuna riga in DB');
  assert.equal(db.listTradesBy({ botId: bot.id }).length, 0, 'nessun ordine mandato al broker');
  assert.deepEqual(await paperBroker.getFrontendOpenOrders(master), [], 'nessun trigger sul book');
  assert.equal(bot.lastEval.action, 'hold');
  assert.equal(bot.lastEval.reason, 'Kill switch attivo: nuove aperture bloccate');
  assert.equal(killNotices().length, 1, 'quattro tick nello stesso episodio, una sola notifica');
  assert.match(killNotices()[0], /LONG/, 'la notifica dice quale segnale è stato scartato');

  // Kill switch spento: l'episodio si chiude e il bot apre.
  setKill(false);
  await bot._openPosition('long', SNAP(), ACCOUNT);
  assert.ok(bot.position, 'riapre appena il kill switch è spento');
  assert.equal(killNotices().length, 1, 'lo spegnimento non produce notifiche dal bot');
});

test('nuovo episodio dopo uno spegnimento: si rinotifica una volta', async () => {
  const bot = makeBot('ks-episodes', 'KS2-PERP', '0xKS2');
  // L'episodio si chiude interrogando il gate con il flag spento, senza
  // passare da un'apertura vera (che lascerebbe una posizione da gestire).
  setKill(true);
  await bot._openPosition('long', SNAP(), ACCOUNT);
  await bot._openPosition('long', SNAP(), ACCOUNT);
  assert.equal(killNotices().length, 1);

  setKill(false);
  assert.equal(bot._killSwitchBlock('long'), null, 'spento: nessun blocco, episodio azzerato');

  setKill(true);
  await bot._openPosition('short', SNAP(), ACCOUNT);
  await bot._openPosition('short', SNAP(), ACCOUNT);
  assert.equal(killNotices().length, 2, 'un episodio nuovo, una notifica nuova');
  assert.equal(bot.position, null);
});

test('kill switch OFF: il bot apre come prima, nessuna notifica di kill switch', async () => {
  const master = '0xKS3';
  const bot = makeBot('ks-off', 'KS3-PERP', master);

  await bot._openPosition('long', SNAP(), ACCOUNT);

  assert.ok(bot.position, 'apertura eseguita');
  assert.equal(bot.position.side, 'long');
  assert.ok(db.getOpenPositionByBot(bot.id), 'riga posizione in DB');
  assert.equal(killNotices().length, 0);
});

// ---------------------------------------------------------------------------
// La gestione delle posizioni aperte NON si ferma
// ---------------------------------------------------------------------------

test('kill switch ON con posizione aperta: la guardia SL ri-piazza lo stop mancante', async () => {
  const master = '0xKS4';
  const coin = 'KS4-PERP';
  const bot = makeBot('ks-manage-sl', coin, master);
  await bot._openPosition('long', SNAP(), ACCOUNT);
  assert.ok(bot.position?.slOid, 'posizione aperta con SL');

  // Lo SL sparisce dal book (cancellato fuori dal bot), poi l'operatore preme
  // il kill switch.
  await paperBroker.cancelOrder({ masterAddress: master, coin, oid: bot.position.slOid });
  setKill(true);
  const stopsBefore = (await paperBroker.getFrontendOpenOrders(master))
    .filter(o => o.isTrigger && /stop/i.test(o.orderType || ''));
  assert.equal(stopsBefore.length, 0, 'premessa: nessuno SL sul book');

  await bot._manageOpen(SNAP(), ACCOUNT, { action: 'hold' });

  const stopsAfter = (await paperBroker.getFrontendOpenOrders(master))
    .filter(o => o.isTrigger && /stop/i.test(o.orderType || ''));
  assert.equal(stopsAfter.length, 1, 'la guardia SL ha ri-piazzato lo stop nonostante il kill switch');
  assert.ok(bot.position, 'la posizione resta aperta e protetta');
});

test('kill switch ON con posizione aperta: la chiusura su segnale passa', async () => {
  const master = '0xKS5';
  const bot = makeBot('ks-manage-close', 'KS5-PERP', master);
  await bot._openPosition('long', SNAP(), ACCOUNT);
  assert.ok(bot.position);

  setKill(true);
  await bot._manageOpen(SNAP(), ACCOUNT, { action: 'close', reason: 'uscita di test' });

  assert.equal(bot.position, null, 'posizione chiusa');
  assert.equal(db.getOpenPositionByBot(bot.id), undefined, 'nessuna riga aperta in DB');
});

// ---------------------------------------------------------------------------
// killSwitch.js — fail-closed
// ---------------------------------------------------------------------------

test('killSwitch.js: lettura del DB che lancia → ATTIVO, un solo log per episodio', async () => {
  const originalGet = db.getSetting;
  const originalError = logger.error;
  const errors = [];
  logger.error = (msg) => { errors.push(String(msg)); };
  const bot = makeBot('ks-failclosed', 'KS6-PERP', '0xKS6');
  // Guasto solo sulla chiave del kill switch: il resto del DB risponde, così il
  // test isola il percorso di `killSwitch.js` invece di rompere tutto il bot.
  db.getSetting = function (key, fallback) {
    if (key === 'killswitch') throw new Error('database is locked');
    return originalGet.call(this, key, fallback);
  };
  try {
    assert.equal(isKillSwitchOn(), true, 'flag illeggibile = kill switch attivo');
    const st = readKillSwitch();
    assert.equal(st.on, true);
    assert.match(st.readError, /locked/);
    isKillSwitchOn();
    assert.equal(errors.filter(e => /kill switch/i.test(e)).length, 1, 'un log per episodio, non per lettura');

    // Il bot dice la verità: "non leggibile", non "attivo".
    await bot._openPosition('long', SNAP(), ACCOUNT);
    await bot._openPosition('long', SNAP(), ACCOUNT);
    assert.equal(bot.position, null, 'nessuna apertura con il flag illeggibile');
    assert.match(bot.lastEval.reason, /non leggibile/i);
    assert.equal(killNotices().length, 1, 'una notifica per l\'episodio');
    assert.match(killNotices()[0], /non leggibile/i);
  } finally {
    db.getSetting = originalGet;
    logger.error = originalError;
  }

  // Lettura tornata: episodio chiuso, un guasto successivo si rilogga.
  assert.equal(isKillSwitchOn(), false);
  logger.error = (msg) => { errors.push(String(msg)); };
  db.getSetting = () => { throw new Error('disk I/O error'); };
  try {
    isKillSwitchOn();
  } finally {
    db.getSetting = originalGet;
    logger.error = originalError;
  }
  assert.equal(errors.filter(e => /kill switch/i.test(e)).length, 2, 'nuovo episodio di guasto, nuovo log');
});

// ---------------------------------------------------------------------------
// botManager: avvio con kill switch attivo
// ---------------------------------------------------------------------------

test('botManager: avvio con kill switch ON → parte comunque, con warning', async () => {
  const created = botManager.createBot({
    name: 'Bot KS Start', coin: 'KS7-PERP', network: 'testnet',
    masterAddress: '0xKS7', config: BASE_CONFIG
  });
  const id = created.id;
  const warns = [];
  const originalWarn = logger.warn;
  logger.warn = (msg) => { warns.push(String(msg)); };
  setKill(true);
  try {
    const out = await botManager.applyLifecycleLocal(id, 'start');
    assert.equal(out.result, 'started', 'il bot NON è bloccato all\'avvio');
    assert.equal(out.state.status, 'running');
    assert.match(out.warning, /kill switch attivo/i, 'il risultato porta il warning al chiamante');
    assert.ok(warns.some(w => /kill switch attivo/i.test(w)), 'warning nel log');
    assert.equal(notified.filter(t => /avviato con il <b>kill switch attivo/i.test(t)).length, 1,
      'warning nella notifica di avvio');

    const bot = botManager.bots.get(id);
    bot.stop();
    await bot.whenIdle();

    notified.length = 0;
    const state = botManager.startBot(id);
    assert.equal(state.status, 'running', 'anche startBot avvia');
    assert.equal(notified.filter(t => /avviato con il <b>kill switch attivo/i.test(t)).length, 1);
    bot.stop();
    await bot.whenIdle();

    // Kill switch spento: nessun warning, risultato senza `warning`.
    setKill(false);
    notified.length = 0;
    const off = await botManager.applyLifecycleLocal(id, 'start');
    assert.equal(off.result, 'started');
    assert.equal(off.warning, undefined);
    assert.equal(notified.filter(t => /kill switch/i.test(t)).length, 0);
    bot.stop();
    await bot.whenIdle();
  } finally {
    logger.warn = originalWarn;
  }
});

test.after(() => {
  for (const bot of botManager.bots.values()) { try { bot.stop(); } catch { /* noop */ } }
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
