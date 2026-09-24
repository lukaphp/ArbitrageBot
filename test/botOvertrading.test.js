/**
 * OVERTRADING GATE — freno sulla FREQUENZA di apertura, non sulle perdite.
 * ======================================================================
 *
 * I due cooldown esistenti guardano entrambi le PERDITE: `_cooldownBlock()`
 * (N perdite consecutive dello stesso bot) e il cooldown di portafoglio
 * (persistito, dopo una perdita). Nessuno dei due guarda quante volte un bot
 * entra a mercato quando le operazioni chiudono in pari o in guadagno: un bot
 * che apre e chiude 4 volte in 30 minuti su un mercato laterale paga 8 fee e
 * 8 slippage senza che niente lo fermi.
 *
 * Proprietà che questi test fissano, in ordine di importanza:
 *
 *  1. Il conteggio viene dal DB (`positions.opened_at`), non da un contatore in
 *     memoria: una nuova istanza `PerpsBot` sullo stesso DB è bloccata al primo
 *     tentativo, senza nessuno stato da risincronizzare. È il requisito che
 *     aveva già rotto il cooldown di portafoglio prima che fosse persistito.
 *  2. Il gate blocca SOLO le nuove aperture. Il bot resta `running` e continua
 *     a gestire TP/SL/trailing delle posizioni già aperte — un freno che
 *     spegnesse il bot lascerebbe una posizione viva senza chi la governa.
 *  3. Si auto-risolve: la finestra è scorrevole, quando l'apertura più vecchia
 *     ne esce il conteggio scende e il bot riapre da solo. Nessun `pausedUntil`
 *     da tenere sincronizzato, nessun timer.
 *  4. Una notifica per EPISODIO (blocco) e una di rientro, mai una per tick —
 *     stesso principio del cooldown di portafoglio (incidente 9-10 agosto).
 *
 * Le posizioni di storia sono chiuse in GUADAGNO di proposito: è la
 * dimostrazione che questo gate copre il caso che gli altri due non vedono.
 *
 * Seam: paperBroker (stato reale dei trigger) + DB singleton su file
 * temporaneo, mai data/perps.db. Stesso impianto di test/botFillSize.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import riskManager, {
  OVERTRADING_DEFAULTS,
  resolveOvertradingLimits,
  checkOvertrading
} from '../src/perps/riskManager.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-overtrading-'));
db.dbPath = path.join(tempDir, 'perps.db');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

const BASE_CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 }, // 100$ × leva 1 @ 100 → size 1
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'percent', value: 5 }
};

const ACCOUNT = { equity: 10000, positions: [] };
const MIN = 60000;

function makeBot(id, coin, master, config = BASE_CONFIG) {
  const bot = new PerpsBot({
    id, name: `Bot ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config)
  }, () => {});
  bot.broker = Object.create(paperBroker);
  return bot;
}

/**
 * Aperture già avvenute, chiuse IN GUADAGNO e retrodatate di `minutesAgo`.
 * `opened_at` è scrivibile via `updatePosition` (colonna ammessa), quindi la
 * storia si costruisce senza toccare il codice di produzione.
 * @returns gli id delle righe, per poterne spostare una fuori dalla finestra.
 */
function seedOpens(botId, coin, minutesAgo = []) {
  db.ensure(); // `insertPosition` non fa init lazy e qui può essere il primo accesso
  const now = Date.now();
  return minutesAgo.map(min => {
    const id = db.insertPosition({ botId, coin, side: 'long', size: 1, entryPx: 100, leverage: 1 });
    db.updatePosition(id, {
      status: 'closed', pnl: +3,
      opened_at: now - min * MIN,
      closed_at: now - Math.max(0, min - 1) * MIN
    });
    return id;
  });
}

const blockNotices = () => notified.filter(t => /troppe aperture/i.test(t));
const backNotices = () => notified.filter(t => /rientrat/i.test(t));

// ---------------------------------------------------------------------------
// Calcolo puro (riskManager): limiti risolti e verdetto, senza DB né I/O.
// ---------------------------------------------------------------------------

test('limiti: default applicati quando il bot non dichiara nulla', () => {
  const limits = resolveOvertradingLimits({});
  assert.equal(limits.enabled, true, 'il freno è attivo di default, non opt-in');
  assert.equal(limits.maxOpensPerWindow, OVERTRADING_DEFAULTS.maxOpensPerWindow);
  assert.equal(limits.windowMinutes, OVERTRADING_DEFAULTS.windowMinutes);
  assert.deepEqual(limits.ignored, []);
});

test('limiti: sovrascrivibili per bot', () => {
  const limits = resolveOvertradingLimits({ overtrading: { maxOpensPerWindow: 2, windowMinutes: 10 } });
  assert.equal(limits.maxOpensPerWindow, 2);
  assert.equal(limits.windowMinutes, 10);
});

test('limiti: opt-out esplicito', () => {
  assert.equal(resolveOvertradingLimits({ overtrading: { enabled: false } }).enabled, false);
});

test('limiti: un valore inservibile NON disattiva il freno (fail-closed)', () => {
  const limits = resolveOvertradingLimits({ overtrading: { maxOpensPerWindow: 'molte', windowMinutes: -5 } });
  assert.equal(limits.enabled, true, 'una config sbagliata non vale come "nessun limite"');
  assert.equal(limits.maxOpensPerWindow, OVERTRADING_DEFAULTS.maxOpensPerWindow, 'resta il default');
  assert.equal(limits.windowMinutes, OVERTRADING_DEFAULTS.windowMinutes);
  assert.equal(limits.ignored.length, 2, 'e la config ignorata viene segnalata, non nascosta');
});

test('verdetto: sotto soglia passa, alla soglia blocca e dice quanto manca', () => {
  const limits = resolveOvertradingLimits({});
  const now = Date.now();

  const ok = checkOvertrading(limits, { opens: 3, oldestOpenedAt: now - 10 * MIN, now });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);

  const ko = checkOvertrading(limits, { opens: 4, oldestOpenedAt: now - 10 * MIN, now });
  assert.equal(ko.ok, false, 'blocco quando il conteggio RAGGIUNGE la soglia');
  assert.match(ko.reason, /4/, 'il motivo riporta le aperture contate');
  assert.match(ko.reason, /30/, 'e la finestra');
  // La più vecchia è entrata 10 min fa: esce dalla finestra di 30 fra ~20 min.
  assert.equal(Math.round((ko.retryAt - now) / MIN), 20, 'lo sblocco è derivato dal DB, non da un timer');
  assert.match(ko.reason, /20/, 'e il motivo lo dice all\'operatore');
});

test('verdetto: senza la data della più vecchia non si inventa un orario di sblocco', () => {
  const ko = checkOvertrading(resolveOvertradingLimits({}), { opens: 9, oldestOpenedAt: null, now: Date.now() });
  assert.equal(ko.ok, false, 'il blocco resta: il conteggio basta a decidere');
  assert.equal(ko.retryAt, null, '"non so quando" non diventa un orario finto');
});

test('il singleton espone gli stessi calcoli (chiamanti che hanno già riskManager)', () => {
  assert.equal(riskManager.resolveOvertradingLimits({}).maxOpensPerWindow, OVERTRADING_DEFAULTS.maxOpensPerWindow);
  assert.equal(riskManager.checkOvertrading(resolveOvertradingLimits({}), { opens: 0 }).ok, true);
});

// ---------------------------------------------------------------------------
// Conteggio dal DB
// ---------------------------------------------------------------------------

test('il conteggio guarda opened_at, non lo stato della riga', () => {
  const botId = 'ot-count';
  const ids = seedOpens(botId, 'OTC-PERP', [5, 20, 90]);
  db.insertPosition({ botId, coin: 'OTC-PERP', side: 'long', size: 1, entryPx: 100, leverage: 1 });

  const now = Date.now();
  assert.equal(db.countOpensSince(botId, now - 30 * MIN), 3,
    'due chiuse nella finestra + quella ancora aperta: anche una posizione aperta è un ingresso');
  assert.equal(db.countOpensSince(botId, now - 120 * MIN), 4);
  assert.equal(db.countOpensSince('bot-che-non-esiste', 0), 0);

  assert.equal(db.oldestOpenedAtSince(botId, now - 30 * MIN), db.getPosition(ids[1]).opened_at,
    'la più vecchia DENTRO la finestra (20 min fa), non la più vecchia in assoluto (90)');
  assert.equal(db.oldestOpenedAtSince('bot-che-non-esiste', 0), null, 'nessuna riga → null, non 0');
});

// ---------------------------------------------------------------------------
// Gate in `_openPosition`
// ---------------------------------------------------------------------------

test('sotto soglia: il bot apre normalmente e nessuno lo notifica', async () => {
  const master = '0xOT1';
  const coin = 'OT1-PERP';
  const bot = makeBot('ot-under', coin, master);
  seedOpens(bot.id, coin, [2, 9, 25]); // 3 aperture nella finestra, soglia 4

  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.ok(bot.position, 'apertura consentita');
  assert.equal(blockNotices().length, 0, 'nessun allarme di frequenza');
  assert.equal(backNotices().length, 0, 'e nessun "rientro" da un episodio mai iniziato');
});

test('alla soglia: apertura bloccata, motivo in lastEval, UNA notifica', async () => {
  const master = '0xOT2';
  const coin = 'OT2-PERP';
  const bot = makeBot('ot-block', coin, master);
  seedOpens(bot.id, coin, [3, 8, 15, 22]); // 4 aperture in 30 min = soglia

  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.equal(bot.position, null, 'nessuna posizione aperta');
  assert.equal(db.getOpenPositionByBot(bot.id), undefined, 'nessuna riga nuova in DB');
  assert.equal(db.listTradesBy({ botId: bot.id }).length, 0, 'nessun ordine mandato al broker');
  assert.deepEqual(await paperBroker.getFrontendOpenOrders(master), [], 'nessun trigger sul book');

  assert.equal(bot.lastEval.action, 'hold');
  assert.match(bot.lastEval.reason, /apertur/i, 'il motivo dice perché è fermo');
  assert.match(bot.lastEval.reason, /4/);
  assert.equal(blockNotices().length, 1, 'una notifica per l\'episodio');
});

test('stesso episodio al tick successivo: nessuna notifica ripetuta', async () => {
  const master = '0xOT3';
  const coin = 'OT3-PERP';
  const bot = makeBot('ot-repeat', coin, master);
  seedOpens(bot.id, coin, [1, 4, 7, 11]);

  notified.length = 0;
  MID = 100;
  for (let i = 0; i < 5; i++) {
    await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);
  }

  assert.equal(bot.position, null, 'resta bloccato a ogni tentativo');
  assert.equal(blockNotices().length, 1,
    'cinque tick nello stesso episodio, una sola notifica (Telegram non deve diventare rumore)');
});

test('la finestra scorre: il bot si sblocca da solo e notifica il rientro', async () => {
  const master = '0xOT4';
  const coin = 'OT4-PERP';
  const bot = makeBot('ot-slide', coin, master);
  const ids = seedOpens(bot.id, coin, [5, 12, 18, 26]);

  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);
  assert.equal(bot.position, null, 'bloccato con 4 aperture nella finestra');
  assert.equal(blockNotices().length, 1);

  // Nessuna azione esterna sul bot: si muove solo il tempo. La più vecchia
  // esce dalla finestra scorrevole → il conteggio scende a 3.
  db.updatePosition(ids[3], { opened_at: Date.now() - 45 * MIN });

  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.ok(bot.position, 'riapre da solo, senza che nessuno lo sblocchi');
  assert.equal(backNotices().length, 1, 'e dice che è rientrato');
  assert.equal(blockNotices().length, 1, 'il blocco non è stato ri-notificato');
});

test('bloccato ma vivo: TP/SL e trailing della posizione aperta continuano', async () => {
  const master = '0xOT5';
  const coin = 'OT5-PERP';
  const bot = makeBot('ot-manage', coin, master, {
    ...BASE_CONFIG,
    trailing: { enabled: true, mode: 'percent', value: 2 }
  });

  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);
  assert.ok(bot.position, 'posizione aperta prima che scatti il freno');
  const slPrima = bot.position.slPx;

  // Altre 4 aperture nella finestra (fatte prima): il bot è ora in regime bloccato.
  seedOpens(bot.id, coin, [2, 6, 10, 14]);
  assert.ok(bot._overtradingBlock(), 'il gate blocca: siamo nel caso che ci interessa');

  let stopChiamato = false;
  bot.stop = () => { stopChiamato = true; };

  notified.length = 0;
  MID = 110; // prezzo a favore → il trailing deve alzare lo stop
  await bot._manageOpen({ price: MID, candles: [] }, ACCOUNT, { action: 'hold' });

  assert.equal(stopChiamato, false, 'il bot NON viene fermato: gestisce ancora i suoi trigger');
  assert.ok(bot.position, 'la posizione è ancora tracciata');
  assert.ok(bot.position.slPx > slPrima, `trailing applicato (${slPrima} → ${bot.position.slPx})`);

  const orders = await paperBroker.getFrontendOpenOrders(master);
  const sl = orders.filter(o => /stop/i.test(o.orderType));
  assert.equal(sl.length, 1, 'un solo stop attivo (place-then-cancel)');
  assert.equal(sl[0].triggerPx, bot.position.slPx, 'ed è quello nuovo, davvero sul book');

  // E la chiusura su segnale resta possibile: il freno non intrappola la posizione.
  await bot._manageOpen({ price: MID, candles: [] }, ACCOUNT, { action: 'close', reason: 'uscita su regola' });
  assert.equal(bot.position, null, 'uscita eseguita anche a bot bloccato');
});

test('riavvio: una nuova istanza è bloccata al primo tentativo, senza stato in memoria', async () => {
  const master = '0xOT6';
  const coin = 'OT6-PERP';
  const botId = 'ot-restart';
  seedOpens(botId, coin, [2, 5, 9, 13]); // storia già su disco, nessuna istanza viva

  const bot = makeBot(botId, coin, master); // "processo riavviato"
  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.equal(bot.position, null,
    'il conteggio non riparte da zero dopo un riavvio (errore già commesso col cooldown di portafoglio)');
  assert.equal(db.listTradesBy({ botId }).length, 0);
  assert.equal(blockNotices().length, 1);
});

test('opt-out: un bot che dichiara enabled:false non viene mai frenato', async () => {
  const master = '0xOT7';
  const coin = 'OT7-PERP';
  const bot = makeBot('ot-optout', coin, master, {
    ...BASE_CONFIG, overtrading: { enabled: false }
  });
  seedOpens(bot.id, coin, [1, 2, 3, 4, 5, 6]);

  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.ok(bot.position, 'apertura consentita');
  assert.equal(blockNotices().length, 0);
});

test('soglia personalizzata: un bot può essere più severo del default', async () => {
  const master = '0xOT8';
  const coin = 'OT8-PERP';
  const bot = makeBot('ot-strict', coin, master, {
    ...BASE_CONFIG, overtrading: { maxOpensPerWindow: 2, windowMinutes: 15 }
  });
  seedOpens(bot.id, coin, [3, 10, 40]); // 2 dentro la finestra di 15 min

  notified.length = 0;
  MID = 100;
  await bot._openPosition('long', { price: MID, candles: [] }, ACCOUNT);

  assert.equal(bot.position, null, 'bloccato sulla soglia del bot, non su quella globale');
  assert.match(bot.lastEval.reason, /15/, 'e la finestra citata è la sua');
});

// ---------------------------------------------------------------------------
// Metriche esposte al frontend
// ---------------------------------------------------------------------------

test('getState espone il ritmo di apertura su 1h e 4h', () => {
  const botId = 'ot-state';
  const coin = 'OT9-PERP';
  seedOpens(botId, coin, [5, 40, 120, 500]);
  const bot = makeBot(botId, coin, '0xOT9');

  const state = bot.getState();
  assert.ok(state.openRate, 'campo presente per la UI');
  assert.equal(state.openRate.lastHour, 2, 'due aperture nell\'ultima ora');
  assert.equal(state.openRate.last4h, 3, 'tre nelle ultime quattro ore (quella di 500 min fa è fuori)');
  assert.equal(state.openRate.maxOpensPerWindow, OVERTRADING_DEFAULTS.maxOpensPerWindow,
    'la soglia viaggia col dato: il badge non deve indovinarla');
  assert.equal(state.openRate.windowMinutes, OVERTRADING_DEFAULTS.windowMinutes);
});

test('metriche non disponibili: null, non zero (un guasto non è "nessuna apertura")', () => {
  const bot = makeBot('ot-state-err', 'OT10-PERP', '0xOT10');
  const vero = db.countOpensSince.bind(db);
  db.countOpensSince = () => { throw new Error('DB illeggibile'); };
  try {
    assert.equal(bot.getState().openRate, null);
  } finally {
    db.countOpensSince = vero;
  }
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
