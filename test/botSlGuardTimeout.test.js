/**
 * P0 2026-09-24 — la guardia dello stop loss chiudeva le posizioni per un TIMEOUT.
 * ==============================================================================
 *
 * Incidente: 23 chiusure su 24 in 23 minuti (08:21-08:44 UTC su AVAX/SOL/ETH) con
 * `close_reason: "errore verifica SL (chiusura di sicurezza)"`, alcune a meno di
 * 60 secondi dall'apertura. Nei log, la causa quasi sempre:
 *
 *     timeout dopo 10000ms (getFrontendOpenOrders)   → 29 volte in 5h
 *     timeout dopo 10000ms (getUserFills)            → 19 volte in 5h
 *
 * `_ensureStopLoss` aveva un try/catch attorno all'INTERA funzione: qualunque
 * eccezione — timeout compreso — finiva su `_closeNow('errore verifica SL')`.
 * Cioè il codice trattava «non sono riuscito a verificare» e «ho verificato che
 * lo stop loss non c'è» come la stessa informazione. Non lo sono: la prima è
 * assenza di conoscenza, la seconda è conoscenza di un'assenza. Solo la seconda
 * giustifica una chiusura.
 *
 * Due difetti distinti, due gruppi di test:
 *
 *  1. SICUREZZA — un timeout nel RIVERIFICARE uno stop loss già piazzato e
 *     confermato (`position.slOid` valorizzato) non deve chiudere nulla: quello
 *     SL vive sull'exchange e continua a proteggere anche se noi siamo ciechi.
 *     Resta invariata la chiusura quando il broker risponde in modo CONCLUSIVO
 *     che l'ordine non è stato accettato (`res.oid` nullo).
 *
 *  2. CARICO — nello stesso tick `_manageOpen` faceva DUE letture indipendenti di
 *     `getFrontendOpenOrders` sullo stesso mercato (una per la guardia SL, una
 *     per lo sweep dei TP). È la chiamata più cara che l'SDK conosca (peso 20 su
 *     un secchiello da 100 token con refill 10/s, misurato sull'SDK installata):
 *     raddoppiarla per ogni bot con posizione aperta a ogni tick è la pressione
 *     che generava i timeout in primo luogo.
 *
 * Seam: paperBroker + singleton DB su file temporaneo, come test/botTpSweep.js.
 * Il broker viene avvolto in un Proxy che conta le chiamate e può farle fallire:
 * è l'unico modo onesto di riprodurre un timeout senza rete.
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
import { TimeoutError } from '../src/perps/retry.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-slguard-'));
db.dbPath = path.join(tempDir, 'perps.db');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

const notified = [];
notifier.notify = async (text) => { notified.push(text); };

const BASE_CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'percent', value: 5 }
};

/** Bot con posizione long aperta e TP/SL già piazzati e confermati. */
async function botWithOpenPosition(id, coin, master, config = BASE_CONFIG) {
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
    originalEntryPx: entryPx, dcaCount: 0, tpPx, slPx, slOid: null, openedAt: Date.now()
  };
  await bot._placeTpSl();
  return bot;
}

/**
 * Avvolge `bot.broker` per contare le chiamate e iniettare guasti.
 * `faults.getFrontendOpenOrders` è una funzione `(n) => Error|null` chiamata con
 * il numero progressivo della chiamata: restituire un Error la fa fallire.
 */
function instrument(bot, faults = {}) {
  const real = bot.broker;
  const calls = {};
  bot.broker = new Proxy(real, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        calls[prop] = (calls[prop] || 0) + 1;
        const fault = faults[prop]?.(calls[prop]);
        if (fault) return Promise.reject(fault);
        return value.apply(target, args);
      };
    }
  });
  return calls;
}

const ordersOf = async (master) => paperBroker.getFrontendOpenOrders(master);
const slsOf = (orders) => orders.filter(o => /stop/i.test(o.orderType));
/** Tick su posizione aperta senza segnale di uscita. */
const manage = (bot) => bot._manageOpen({ price: MID, candles: [] }, {}, { action: 'hold' });
const timeout = () => new TimeoutError('getFrontendOpenOrders', 10000);

// ---------------------------------------------------------------------------
// 1. SICUREZZA: un timeout non è una prova
// ---------------------------------------------------------------------------

test('timeout nel verificare uno SL già confermato: la posizione NON viene chiusa', async () => {
  const master = '0xSLG1';
  const coin = 'SLG1-PERP';
  const bot = await botWithOpenPosition('bot-slg-1', coin, master);
  const posId = bot.position.id;
  const slOid = bot.position.slOid;
  assert.ok(slOid, 'punto di partenza: uno SL è stato piazzato e confermato');

  instrument(bot, { getFrontendOpenOrders: () => timeout() });
  notified.length = 0;

  await manage(bot);

  assert.ok(bot.position, 'la posizione resta aperta: il timeout non prova che lo SL sia sparito');
  const row = db.getPosition(posId);
  assert.equal(row.status, 'open', 'nessuna chiusura scritta in DB');
  assert.equal(row.close_reason, null, 'nessun close_reason di sicurezza');
  assert.equal(bot.position.slOid, slOid, 'lo SL tracciato resta quello confermato');
  assert.equal(slsOf(await ordersOf(master)).length, 1, 'lo SL sull\'exchange non viene toccato');
});

test('il fallimento è rumoroso, non silenzioso: loggato E notificato', async () => {
  const master = '0xSLG2';
  const coin = 'SLG2-PERP';
  const bot = await botWithOpenPosition('bot-slg-2', coin, master);

  instrument(bot, { getFrontendOpenOrders: () => timeout() });
  notified.length = 0;

  await manage(bot);

  assert.ok(notified.some(t => /stop loss/i.test(t) && /SLG2-PERP/.test(t)),
    'l\'operatore deve sapere che la guardia è cieca su questo mercato');
  assert.ok(!notified.some(t => /chiud/i.test(t)),
    'nessuna notifica di chiusura: non stiamo chiudendo niente');
});

test('una notifica per EPISODIO, non una per tentativo', async () => {
  const master = '0xSLG3';
  const coin = 'SLG3-PERP';
  const bot = await botWithOpenPosition('bot-slg-3', coin, master);

  instrument(bot, { getFrontendOpenOrders: () => timeout() });
  notified.length = 0;

  await manage(bot);
  await manage(bot);
  await manage(bot);

  const alerts = notified.filter(t => /verificare|cieca|verifica/i.test(t));
  assert.equal(alerts.length, 1,
    'tre tick ciechi di fila = un episodio = una notifica (altrimenti Telegram diventa rumore)');
  assert.ok(bot.position, 'e dopo tre timeout consecutivi la posizione è ancora aperta');
  // Guardia SL e sweep TP condividono la lettura fallita: è UN guasto, non due.
  // Senza il dedup il contatore direbbe 6 dopo tre tick, e chi legge il log o la
  // metrica crederebbe a un'incidenza doppia di quella reale.
  assert.equal(bot._slVerifyFailures, 3, 'tre tick ciechi = tre fallimenti contati, non sei');
});

test('quando la verifica torna a funzionare, l\'episodio si chiude e viene notificato il rientro', async () => {
  const master = '0xSLG4';
  const coin = 'SLG4-PERP';
  const bot = await botWithOpenPosition('bot-slg-4', coin, master);

  let broken = true;
  instrument(bot, { getFrontendOpenOrders: () => (broken ? timeout() : null) });
  notified.length = 0;

  await manage(bot);
  broken = false;
  await manage(bot);

  assert.ok(notified.some(t => /ripristinat|di nuovo|rientr/i.test(t)),
    'il rientro dall\'episodio va detto, altrimenti resta un allarme aperto per sempre');
  assert.ok(bot.position);

  // E l'episodio successivo torna a notificare (il contatore si è azzerato).
  broken = true;
  notified.length = 0;
  await manage(bot);
  assert.equal(notified.filter(t => /verificare|cieca|verifica/i.test(t)).length, 1,
    'un nuovo episodio è un nuovo allarme');
});

// ---------------------------------------------------------------------------
// 2. I rami di chiusura LEGITTIMI restano tali
// ---------------------------------------------------------------------------

test('RAMO INVARIATO: oid nullo dal broker è conclusivo → chiusura di sicurezza', async () => {
  const master = '0xSLG5';
  const coin = 'SLG5-PERP';
  const bot = await botWithOpenPosition('bot-slg-5', coin, master);
  const posId = bot.position.id;

  // Lo SL sparisce davvero dal book e il ri-piazzamento viene RIFIUTATO
  // (risposta conclusiva del broker, non un errore di trasporto).
  for (const o of slsOf(await ordersOf(master))) {
    await paperBroker.cancelOrder({ masterAddress: master, coin, oid: o.oid }, 'testnet');
  }
  bot.broker = new Proxy(paperBroker, {
    get(target, prop) {
      if (prop === 'placeTriggerOrder') return async () => ({ oid: null });
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  notified.length = 0;

  await manage(bot);

  assert.equal(bot.position, null, 'senza SL e senza poterlo piazzare si chiude: comportamento corretto, invariato');
  assert.equal(db.getPosition(posId).close_reason, 'SL non garantito (chiusura di sicurezza)');
});

test('assenza CONFERMATA dello SL: viene ripiazzato, la posizione non si chiude', async () => {
  const master = '0xSLG6';
  const coin = 'SLG6-PERP';
  const bot = await botWithOpenPosition('bot-slg-6', coin, master);
  const oldOid = bot.position.slOid;

  for (const o of slsOf(await ordersOf(master))) {
    await paperBroker.cancelOrder({ masterAddress: master, coin, oid: o.oid }, 'testnet');
  }
  assert.equal(slsOf(await ordersOf(master)).length, 0, 'punto di partenza: nessuno SL vivo');

  await manage(bot);

  assert.ok(bot.position, 'la posizione resta aperta');
  const sls = slsOf(await ordersOf(master));
  assert.equal(sls.length, 1, 'lo SL è stato ripiazzato');
  assert.notEqual(bot.position.slOid, oldOid, 'ed è un ordine nuovo, tracciato');
});

test('assenza confermata + ripiazzamento che fallisce ripetutamente → chiusura dopo N tentativi CONSECUTIVI, non al primo', async () => {
  const master = '0xSLG7';
  const coin = 'SLG7-PERP';
  const bot = await botWithOpenPosition('bot-slg-7', coin, master);
  const posId = bot.position.id;

  for (const o of slsOf(await ordersOf(master))) {
    await paperBroker.cancelOrder({ masterAddress: master, coin, oid: o.oid }, 'testnet');
  }
  // La lettura RIESCE (assenza confermata), ma il piazzamento del rimpiazzo
  // fallisce per errore di trasporto: non sappiamo se è passato o no.
  instrument(bot, { placeTriggerOrder: () => new TimeoutError('placeTriggerOrder', 30000) });

  await manage(bot);
  assert.ok(bot.position, 'un solo tentativo fallito non basta per chiudere');
  await manage(bot);
  assert.ok(bot.position, 'nemmeno due');
  await manage(bot);

  assert.equal(bot.position, null, 'al terzo tentativo consecutivo fallito si chiude per sicurezza');
  assert.match(db.getPosition(posId).close_reason, /SL/i);
});

test('il contatore dei tentativi è CONSECUTIVO: un successo in mezzo lo azzera', async () => {
  const master = '0xSLG8';
  const coin = 'SLG8-PERP';
  const bot = await botWithOpenPosition('bot-slg-8', coin, master);

  for (const o of slsOf(await ordersOf(master))) {
    await paperBroker.cancelOrder({ masterAddress: master, coin, oid: o.oid }, 'testnet');
  }
  let failPlace = true;
  instrument(bot, { placeTriggerOrder: () => (failPlace ? new TimeoutError('placeTriggerOrder', 30000) : null) });

  await manage(bot);
  await manage(bot);
  assert.ok(bot.position, 'due fallimenti');

  failPlace = false;
  await manage(bot);            // successo: SL ripiazzato, contatore azzerato
  assert.ok(bot.position);
  assert.equal(slsOf(await ordersOf(master)).length, 1);

  // Ora lo SL sparisce di nuovo e il piazzamento ricomincia a fallire: servono
  // altri 3 fallimenti pieni, non 1 (il contatore non si è portato dietro i vecchi).
  for (const o of slsOf(await ordersOf(master))) {
    await paperBroker.cancelOrder({ masterAddress: master, coin, oid: o.oid }, 'testnet');
  }
  failPlace = true;
  await manage(bot);
  assert.ok(bot.position, 'il contatore era stato azzerato dal successo');
});

// ---------------------------------------------------------------------------
// 3. CARICO: una sola lettura pesante per tick
// ---------------------------------------------------------------------------

test('un tick su posizione aperta fa UNA sola getFrontendOpenOrders, non due', async () => {
  const master = '0xSLG9';
  const coin = 'SLG9-PERP';
  const bot = await botWithOpenPosition('bot-slg-9', coin, master);
  const calls = instrument(bot);

  await manage(bot);

  assert.equal(calls.getFrontendOpenOrders, 1,
    'guardia SL e sweep TP leggono lo stesso book: una lettura di peso 20, non due');
});

test('la lettura condivisa è la stessa istantanea per SL e TP (nessuna seconda chiamata nemmeno con un TP in eccesso)', async () => {
  const master = '0xSLGA';
  const coin = 'SLGA-PERP';
  const bot = await botWithOpenPosition('bot-slg-a', coin, master);
  const legit = (await ordersOf(master)).filter(o => /take profit/i.test(o.orderType))[0];
  // TP residuo di un ri-piazzamento andato a metà: lo sweep deve comunque agire.
  await paperBroker.placeTriggerOrder(
    { masterAddress: master, coin, isBuy: false, size: 0.6, triggerPx: bot.position.tpPx - 1, tpsl: 'tp' }, 'testnet');
  assert.equal((await ordersOf(master)).filter(o => /take profit/i.test(o.orderType)).length, 2);
  const calls = instrument(bot);

  await manage(bot);

  assert.equal(calls.getFrontendOpenOrders, 1, 'sempre una sola lettura pesante per tick');
  const after = await ordersOf(master);
  assert.equal(after.filter(o => /take profit/i.test(o.orderType)).length, 1,
    'e lo sweep dei TP in eccesso continua a funzionare sulla lettura condivisa');
  // Il criterio resta «tieni i più recenti»: a cadere è il TP con oid più basso.
  assert.ok(!after.some(o => o.oid === legit.oid), 'il TP più vecchio è quello cancellato');
});

test('anche quando la lettura pesante FALLISCE, il tick non la ritenta una seconda volta', async () => {
  const master = '0xSLGB';
  const coin = 'SLGB-PERP';
  const bot = await botWithOpenPosition('bot-slg-b', coin, master);
  const calls = instrument(bot, { getFrontendOpenOrders: () => timeout() });

  await manage(bot);

  // Nota di onestà: prima del fix questo conteggio era 1 anche col bug, ma per
  // il motivo sbagliato — la prima lettura fallita chiudeva la posizione e lo
  // sweep dei TP non veniva mai raggiunto. L'assert sulla posizione ancora
  // aperta è ciò che rende il test falsificabile.
  assert.ok(bot.position, 'la posizione è ancora aperta: siamo davvero passati da entrambe le guardie');
  assert.equal(calls.getFrontendOpenOrders, 1,
    'sotto pressione il tick non deve amplificare la pressione: un solo tentativo, non uno per consumatore');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
