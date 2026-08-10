/**
 * ANA-01 extra: `close_reason` distingue TP, SL e chiusura esterna.
 * ================================================================
 *
 * Prima di questo fix, quando la posizione spariva dall'exchange il bot scriveva
 * sempre la stessa stringa — `'chiusa (TP/SL o esterna)'` — perché non guardava
 * *quale* ordine si fosse riempito. Nello stesso secchio finivano take profit,
 * stop loss, chiusura manuale dal pannello e kill-switch con `closePositions`:
 * qualunque breakdown "quanti trade chiusi da TP vs SL" era impossibile, e in
 * ANA-01 avevo scelto di non inventarlo.
 *
 * Il fix guarda l'**oid del fill di chiusura** nel momento in cui la chiusura
 * avviene, e lo confronta con gli oid dei trigger che il bot ha piazzato
 * (`slOid`, e i nuovi `tpOids`). Su Hyperliquid un ordine trigger che scatta
 * produce un fill che porta l'oid di quell'ordine: è questo che rende la
 * distinzione un FATTO e non una deduzione dal segno del PnL.
 *
 * La proprietà più importante verificata qui non è che i casi felici funzionino,
 * ma che **un dubbio non diventi mai un'etichetta**: se i fill non sono ancora
 * visibili, se non portano oid, o se il bot non ha un riferimento (posizione
 * ereditata da prima del fix, senza oid tracciati), si torna alla stringa
 * generica di sempre. Un'etichetta sbagliata su un dato di performance è peggio
 * di un'etichetta assente, perché non si distingue da un dato vero.
 *
 * Seam di test: paperBroker (che sa già quale trigger ha colpito — prima quella
 * informazione la buttava via) + singleton DB su file temporaneo, come
 * test/botReconcile.test.js. I trigger scattano davvero, passando da
 * `getAccount` → `_evaluateTriggers`, non simulando un fill a mano.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';
import db from '../src/db/database.js';
import riskManager from '../src/perps/riskManager.js';
import notifier from '../src/perps/notifier.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-closereason-'));
db.dbPath = path.join(tempDir, 'perps.db');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text) => { notified.push(text); };

const CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },  // long: TP a 110
  sl: { enabled: true, mode: 'percent', value: 5 }    // long: SL a 95
};

/** Bot con posizione long aperta e TP/SL piazzati come farebbe `_openPosition`. */
async function botWithOpenPosition(id, coin, master, config = CONFIG) {
  const bot = new PerpsBot({
    id, name: `Bot ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(config)
  }, () => {});

  MID = 100;
  const order = await paperBroker.placeMarketOrder({ masterAddress: master, coin, isBuy: true, size: 1 }, 'testnet');
  const entryPx = order.avgPx;
  const { tpPx, slPx } = riskManager.computeTpSl(entryPx, 'long', config);
  const posId = db.insertPosition({ botId: bot.id, coin, side: 'long', size: 1, entryPx, leverage: 1, tpPx, slPx });
  bot.position = {
    id: posId, side: 'long', size: 1, entryPx,
    originalEntryPx: entryPx, dcaCount: 0, tpPx, slPx,
    slOid: null, tpOids: [], openedAt: Date.now(), lastUnrealized: 0
  };
  await bot._placeTpSl();
  return bot;
}

/** Fa avanzare il prezzo e lascia che paperBroker valuti i trigger, poi riconcilia. */
async function moveAndReconcile(bot, master, coin, mid) {
  MID = mid;
  const account = await paperBroker.getAccount(master, 'testnet');
  const livePos = account.positions.find(p => p.coin === coin);
  await bot._reconcile(livePos, { price: MID, candles: [] });
  return livePos;
}

const rowOf = (id) => db.getPosition(id);

test('gli oid dei TP vengono tracciati come già succedeva per lo SL', async () => {
  const master = '0xCR0';
  const coin = 'CR0-PERP';
  const bot = await botWithOpenPosition('bot-cr-0', coin, master);

  assert.ok(bot.position.slOid, 'oid dello SL tracciato (era già così)');
  assert.equal(bot.position.tpOids.length, 1, 'oid del TP ora tracciato');

  const orders = await paperBroker.getFrontendOpenOrders(master);
  const tp = orders.find(o => /take profit/i.test(o.orderType));
  const sl = orders.find(o => /stop/i.test(o.orderType));
  assert.equal(bot.position.tpOids[0], tp.oid, 'è l\'oid del TP realmente sul book');
  assert.equal(bot.position.slOid, sl.oid);

  // Persistito: dopo un riavvio il bot deve ancora saper riconoscere i suoi trigger.
  const trailing = JSON.parse(rowOf(bot.position.id).trailing_json || '{}');
  assert.deepEqual(trailing.tpOids, [tp.oid], 'tpOids persistito in trailing_json');
  assert.equal(trailing.slOid, sl.oid);
  assert.equal(trailing.originalEntryPx, bot.position.entryPx,
    'il merge di trailing_json non ha perso le chiavi di SEC-01');
  assert.equal(trailing.dcaCount, 0);

  const rehydrated = bot._hydratePosition(rowOf(bot.position.id));
  assert.deepEqual(rehydrated.tpOids, [tp.oid], 'e viene riletto al riavvio');
  assert.equal(rehydrated.slOid, sl.oid);
});

test('TAKE PROFIT scattato → close_reason "take profit eseguito", bucket tp', async () => {
  const master = '0xCR1';
  const coin = 'CR1-PERP';
  const bot = await botWithOpenPosition('bot-cr-1', coin, master);
  const posId = bot.position.id;

  // Prezzo sopra il TP (110) e ben sopra lo SL (95): scatta solo il TP.
  await moveAndReconcile(bot, master, coin, 111);

  assert.equal(bot.position, null, 'stato locale azzerato');
  const row = rowOf(posId);
  assert.equal(row.status, 'closed');
  assert.equal(row.close_reason, 'take profit eseguito');
  assert.equal(db.closeReasonBucket(row.close_reason), 'tp');
  assert.ok(row.pnl > 0, 'PnL reale positivo, coerente con un TP');
  assert.deepEqual(db.getBotPerformance(bot.id).closeReasons, { tp: 1 });
});

test('STOP LOSS scattato → close_reason "stop loss eseguito", bucket sl', async () => {
  const master = '0xCR2';
  const coin = 'CR2-PERP';
  const bot = await botWithOpenPosition('bot-cr-2', coin, master);
  const posId = bot.position.id;

  // Prezzo sotto lo SL (95) e lontano dal TP: scatta solo lo SL.
  await moveAndReconcile(bot, master, coin, 94);

  const row = rowOf(posId);
  assert.equal(row.status, 'closed');
  assert.equal(row.close_reason, 'stop loss eseguito');
  assert.equal(db.closeReasonBucket(row.close_reason), 'sl');
  assert.ok(row.pnl < 0, 'PnL reale negativo, coerente con uno SL');
  assert.deepEqual(db.getBotPerformance(bot.id).closeReasons, { sl: 1 });
});

test('chiusura ESTERNA (manuale o kill-switch) → bucket manual_or_external, non tp/sl', async () => {
  const master = '0xCR3';
  const coin = 'CR3-PERP';
  const bot = await botWithOpenPosition('bot-cr-3', coin, master);
  const posId = bot.position.id;

  // Nessun trigger colpito: chiude un ordine di mercato esterno al bot, come fa
  // il pulsante del pannello o il kill-switch con closePositions.
  MID = 101;
  await paperBroker.closePosition({ masterAddress: master, coin }, 'testnet');
  await bot._reconcile(undefined, { price: MID, candles: [] });

  const row = rowOf(posId);
  assert.equal(row.status, 'closed');
  assert.equal(row.close_reason, 'chiusura manuale o esterna');
  assert.equal(db.closeReasonBucket(row.close_reason), 'manual_or_external');
  assert.deepEqual(db.getBotPerformance(bot.id).closeReasons, { manual_or_external: 1 });
});

test('partialTp: scatta uno dei TP della scala → sempre bucket tp', async () => {
  const master = '0xCR4';
  const coin = 'CR4-PERP';
  const config = { ...CONFIG, partialTp: [{ portion: 0.5, atPercent: 5 }, { portion: 0.5, atPercent: 10 }] };
  const bot = await botWithOpenPosition('bot-cr-4', coin, master, config);
  const posId = bot.position.id;

  assert.equal(bot.position.tpOids.length, 2, 'entrambi i gradini della scala sono tracciati');

  // Il primo gradino (a +5%) viene colpito: paperBroker chiude tutto al primo hit.
  await moveAndReconcile(bot, master, coin, 106);

  const row = rowOf(posId);
  assert.equal(row.close_reason, 'take profit eseguito',
    'un TP è un TP anche se è un gradino della scala');
  assert.equal(db.closeReasonBucket(row.close_reason), 'tp');
});

test('DUBBIO: fill di chiusura non ancora visibili → si torna alla stringa generica', async () => {
  const master = '0xCR5';
  const coin = 'CR5-PERP';
  const bot = await botWithOpenPosition('bot-cr-5', coin, master);
  const posId = bot.position.id;

  // Scenario reale già gestito dal codice: la posizione non è più sull'exchange
  // ma i fill non sono ancora arrivati (getRealizedPnl → null). Riprodotto
  // spostando openedAt nel futuro, così nessun fill rientra nella finestra.
  await paperBroker.closePosition({ masterAddress: master, coin }, 'testnet');
  bot.position.openedAt = Date.now() + 60_000;
  bot.position.lastUnrealized = -3;

  await bot._reconcile(undefined, { price: MID, candles: [] });

  const row = rowOf(posId);
  assert.equal(row.close_reason, 'chiusa (TP/SL o esterna)',
    'senza il dato non si etichetta: resta la stringa generica di sempre');
  assert.equal(db.closeReasonBucket(row.close_reason), 'trigger_or_external');
  assert.equal(row.pnl, -3, 'il PnL ripiega sull\'unrealized noto, come prima');
});

test('DUBBIO: posizione ereditata da prima del fix (nessun oid tracciato) → generica', async () => {
  const master = '0xCR6';
  const coin = 'CR6-PERP';
  const bot = await botWithOpenPosition('bot-cr-6', coin, master);
  const posId = bot.position.id;

  // Riga aperta prima di questo fix: trailing_json senza slOid/tpOids. Il bot
  // non ha alcun riferimento con cui riconoscere i propri trigger, quindi
  // etichettare "manuale" sarebbe inventare.
  bot.position.slOid = null;
  bot.position.tpOids = [];

  await moveAndReconcile(bot, master, coin, 111);

  const row = rowOf(posId);
  assert.equal(row.close_reason, 'chiusa (TP/SL o esterna)',
    'senza riferimento non si deduce nulla: nessuna etichetta inventata');
  assert.equal(db.closeReasonBucket(row.close_reason), 'trigger_or_external');
});

test('i motivi espliciti del bot passano intatti (nessuna regressione)', async () => {
  const master = '0xCR7';
  const coin = 'CR7-PERP';
  const bot = await botWithOpenPosition('bot-cr-7', coin, master);
  const posId = bot.position.id;

  // `_closeNow` passa una motivazione precisa: non va "risolta", va rispettata.
  MID = 101;
  await bot._closeNow('Regola di uscita: indicator rsi');

  const row = rowOf(posId);
  assert.equal(row.close_reason, 'Regola di uscita: indicator rsi');
  assert.equal(db.closeReasonBucket(row.close_reason), 'strategy');
});

test('anche la chiusura di sicurezza resta nel suo bucket (ordine dei match)', () => {
  // 'SL non garantito (chiusura di sicurezza)' contiene "SL": se il match su
  // stop loss venisse prima, una chiusura di sicurezza verrebbe contata come SL
  // scattato — cioè come un evento normale invece di un guasto.
  assert.equal(db.closeReasonBucket('SL non garantito (chiusura di sicurezza)'), 'safety');
  assert.equal(db.closeReasonBucket('errore verifica SL (chiusura di sicurezza)'), 'safety');
});

test('classificatore DB: i bucket nuovi e quelli vecchi convivono', () => {
  assert.equal(db.closeReasonBucket('take profit eseguito'), 'tp');
  assert.equal(db.closeReasonBucket('stop loss eseguito'), 'sl');
  assert.equal(db.closeReasonBucket('chiusura manuale o esterna'), 'manual_or_external');
  assert.equal(db.closeReasonBucket('chiusa da più trigger (TP e SL)'), 'trigger_or_external');
  // Legacy: lo storico chiuso prima del fix non cambia bucket.
  assert.equal(db.closeReasonBucket('chiusa (TP/SL o esterna)'), 'trigger_or_external');
  assert.equal(db.closeReasonBucket('Regola di uscita: indicator rsi'), 'strategy');
  assert.equal(db.closeReasonBucket('Segnale esterno: close'), 'strategy');
  assert.equal(db.closeReasonBucket(null), 'other');
});

test('lo storico precedente NON viene riscritto: bucket vecchi e nuovi affiancati', () => {
  const botId = 'bot-cr-mix';
  const mk = (pnl, reason) => {
    const id = db.insertPosition({ botId, coin: 'MIX-PERP', side: 'long', size: 1, entryPx: 100, leverage: 1 });
    db.updatePosition(id, { status: 'closed', pnl, fee: 0, close_reason: reason, closed_at: Date.now() });
  };
  mk(10, 'chiusa (TP/SL o esterna)');   // prima del fix
  mk(-5, 'chiusa (TP/SL o esterna)');   // prima del fix
  mk(12, 'take profit eseguito');       // dopo il fix
  mk(-7, 'stop loss eseguito');         // dopo il fix

  const perf = db.getBotPerformance(botId);
  assert.deepEqual(perf.closeReasons, { trigger_or_external: 2, tp: 1, sl: 1 },
    'il pregresso resta dov\'è: ricostruirlo sarebbe un dato inventato');
  assert.deepEqual(perf.closeReasonDetail.trigger_or_external, { trades: 2, wins: 1, losses: 1, pnl: 5 },
    'per il pregresso resta il dettaglio utile/perdita, che è l\'unico fatto disponibile');
  assert.deepEqual(perf.closeReasonDetail.tp, { trades: 1, wins: 1, losses: 0, pnl: 12 });
  assert.deepEqual(perf.closeReasonDetail.sl, { trades: 1, wins: 0, losses: 1, pnl: -7 });
});

test('la notifica di chiusura riporta il motivo risolto, non quello generico', async () => {
  const master = '0xCR8';
  const coin = 'CR8-PERP';
  const bot = await botWithOpenPosition('bot-cr-8', coin, master);
  notified.length = 0;

  await moveAndReconcile(bot, master, coin, 111);

  const msg = notified.find(t => /ha chiuso/.test(t));
  assert.ok(msg, 'la notifica di chiusura c\'è');
  assert.match(msg, /take profit eseguito/, 'chi legge Telegram sa quale trigger è scattato');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
