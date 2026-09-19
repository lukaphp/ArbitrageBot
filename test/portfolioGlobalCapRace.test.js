/**
 * CAP GLOBALE POSIZIONI — race fra COIN DIVERSE dello stesso wallet.
 * ==================================================================
 *
 * CRIT-03 ha chiuso la race fra due bot sullo STESSO (master, coin). Resta
 * aperta quella fra coin DIVERSE: `portfolio.canOpen()` conta
 * `account.positions` di uno snapshot letto a inizio tick, e il lock di
 * apertura è per (master, coin) — due bot su mercati diversi non si incrociano
 * mai. Con 2 posizioni già aperte e un cap di 3, entrambi leggono "2 su 3,
 * posso aprire" e aprono: 4 posizioni su un limite di 3.
 *
 * Misurato in produzione il 17/09/2026 sulla flotta paper: SOL ed ETH aperte a
 * 686 ms di distanza con BTC e BNB già aperte.
 *
 * Seam: lo stesso di `botOpenLock.test.js` — paperBroker con `setLeverage`
 * dietro un cancello, così il primo bot resta dentro la finestra critica
 * mentre il secondo tenta di entrare. La finestra reale è l'attesa di rete.
 *
 * Il test speculare ("margine ampio") esiste per non barattare la correttezza
 * con la concorrenza: sotto il cap, due bot su coin diverse devono continuare
 * ad aprire IN PARALLELO. È la ragione per cui il cancello non è stato
 * allargato a lock di wallet intero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';
import execQueue from '../src/perps/execQueue.js';
import portfolio from '../src/perps/portfolio.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-capglobale-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => true;

// Cap esplicito: il test non deve dipendere dal default né dall'esposizione.
portfolio.setLimits({ maxConcurrentPositions: 3, maxTotalExposureUsd: 1e9, maxConsecutiveLosses: 99 });

const CONFIG = {
  paper: true,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  sl: { enabled: true, mode: 'percent', value: 5 }
};
const SNAPSHOT = { price: 100, candles: [] };

/** Account con N posizioni già aperte su altri mercati (esposizione trascurabile). */
function accountWith(n) {
  const positions = [];
  for (let i = 0; i < n; i++) positions.push({ coin: `OLD${i}-PERP`, positionValue: 10 });
  return { equity: 10000, positions };
}

function makeBot(id, coin, master) {
  return new PerpsBot({
    id, name: `Cap ${id}`, coin, network: 'testnet',
    master_address: master, config_json: JSON.stringify(CONFIG)
  }, () => {});
}

/**
 * Cede l'event loop abbastanza a lungo perché entrambi i bot arrivino al punto
 * in cui si fermano (il cancello per chi procede, l'uscita per chi è bloccato).
 * `_openPosition` ha diversi `await` prima di `setLeverage` (conferma MTF, gate
 * ML): un assert sincrono subito dopo la chiamata misurerebbe solo il primo.
 */
async function settle(turns = 5) {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve));
}

function gatedBroker(counters) {
  const gate = {};
  gate.promise = new Promise(resolve => { gate.open = resolve; });
  const broker = Object.create(paperBroker);
  broker.setLeverage = async () => {
    counters.leverage++;
    await gate.promise;
    return { ok: true };
  };
  broker.placeMarketOrder = async (params, network) => {
    counters.market++;
    return paperBroker.placeMarketOrder(params, network);
  };
  return { broker, gate };
}

test('due bot su COIN DIVERSE non possono superare insieme il cap globale', async () => {
  const master = '0xCAP1';
  const counters = { leverage: 0, market: 0 };
  const { broker, gate } = gatedBroker(counters);

  // 2 posizioni già aperte, cap 3: c'è spazio per UNA sola apertura.
  const account = accountWith(2);

  const a = makeBot('cap-a', 'CAPA-PERP', master);
  const b = makeBot('cap-b', 'CAPB-PERP', master);
  a.broker = broker;
  b.broker = broker;

  const pA = a._openPosition('long', SNAPSHOT, account);
  // Il secondo bot valuta mentre il primo è dentro la finestra critica: il suo
  // snapshot `account` è lo stesso e non contiene ancora la posizione dell'altro.
  const pB = b._openPosition('long', SNAPSHOT, account);
  await settle();
  assert.equal(counters.leverage, 1,
    'il secondo bot esce PRIMA di toccare la leva, mentre il primo è ancora nella finestra critica');
  gate.open();
  await Promise.all([pA, pB]);

  assert.equal(counters.market, 1, 'un solo ordine market: 2 posizioni + 1 = cap 3 raggiunto');
  const opened = [a, b].filter(bot => bot.position);
  assert.equal(opened.length, 1, 'una sola nuova posizione aperta (3 in totale, non 4)');
  const blocked = [a, b].find(bot => !bot.position);
  assert.equal(blocked.lastEval.action, 'hold');
  assert.match(blocked.lastEval.reason, /Max posizioni concorrenti/i,
    'il bot bloccato lo dice nel suo stato, con la ragione del limite di portafoglio');
});

test('con margine ampio sotto il cap, due bot su coin diverse aprono ancora IN PARALLELO', async () => {
  const master = '0xCAP2';
  const counters = { leverage: 0, market: 0 };
  const { broker, gate } = gatedBroker(counters);

  // Nessuna posizione aperta, cap 3: due aperture concorrenti sono legittime.
  const account = accountWith(0);

  const a = makeBot('cap-c', 'CAPC-PERP', master);
  const b = makeBot('cap-d', 'CAPD-PERP', master);
  a.broker = broker;
  b.broker = broker;

  const pA = a._openPosition('long', SNAPSHOT, account);
  const pB = b._openPosition('long', SNAPSHOT, account);
  // Entrambi devono essere ENTRATI nella finestra critica prima che il cancello
  // si apra: se il fix avesse serializzato le aperture del wallet, il secondo
  // non avrebbe ancora toccato la leva e questo assert cadrebbe.
  await settle();
  assert.equal(counters.leverage, 2,
    'i due bot procedono in parallelo: nessuna serializzazione per wallet intero');
  gate.open();
  await Promise.all([pA, pB]);

  assert.equal(counters.market, 2, 'entrambe le aperture eseguite');
  assert.ok(a.position && b.position, 'entrambe le posizioni aperte');
  assert.equal(execQueue.reservedOpenSlots(master), 0, 'nessuno slot resta riservato a fine apertura');
});

test('la riserva di slot si rilascia anche se l\'apertura fallisce a metà', async () => {
  const master = '0xCAP3';
  const bot = makeBot('cap-e', 'CAPE-PERP', master);

  const boom = Object.create(paperBroker);
  boom.setLeverage = async () => { throw new Error('rete giù a metà apertura'); };
  bot.broker = boom;

  await assert.rejects(() => bot._openPosition('long', SNAPSHOT, accountWith(2)), /rete giù/);
  assert.equal(execQueue.reservedOpenSlots(master), 0,
    'slot rilasciato: uno slot trattenuto restringerebbe il cap per sempre');
  assert.equal(execQueue.isOpenLocked(master, 'CAPE-PERP'), false, 'e con lui il lock CRIT-03');

  // E infatti la volta dopo si apre.
  bot.broker = Object.create(paperBroker);
  await bot._openPosition('long', SNAPSHOT, accountWith(2));
  assert.ok(bot.position, 'apertura possibile dopo il fallimento precedente');
});

test('canOpen conta gli slot riservati insieme alle posizioni dello snapshot', () => {
  // Livello puro: la decisione resta tutta in portfolio.js, testabile senza I/O.
  const account = accountWith(2);
  assert.equal(portfolio.canOpen({ account, botId: 'cap-pure', consecutiveLosses: 0 }).ok, true,
    'senza riserve pendenti, 2 su 3 lascia spazio');

  const withReserve = portfolio.canOpen({ account, botId: 'cap-pure', consecutiveLosses: 0, reservedSlots: 1 });
  assert.equal(withReserve.ok, false, 'con una riserva pendente il cap è già raggiunto');
  assert.match(withReserve.reason, /in apertura/i,
    'la ragione distingue le posizioni aperte da quelle in corso di apertura');

  // Nessuna scrittura: canOpen resta pura (QUAL-01 item 2).
  assert.equal(portfolio.canOpen({ account, botId: 'cap-pure', consecutiveLosses: 0 }).ok, true);
});

test('la riserva di slot è per wallet e insensibile al case dell\'indirizzo', () => {
  assert.equal(execQueue.reservedOpenSlots('0xAbCd'), 0);
  execQueue.reserveOpenSlot('0xAbCd');
  assert.equal(execQueue.reservedOpenSlots('0xABCD'), 1, 'stesso wallet scritto in altro case = stesso contatore');
  execQueue.reserveOpenSlot('0xabcd');
  assert.equal(execQueue.reservedOpenSlots('0xAbCd'), 2);
  execQueue.releaseOpenSlot('0xABCD');
  execQueue.releaseOpenSlot('0xabcd');
  assert.equal(execQueue.reservedOpenSlots('0xAbCd'), 0);
  // Non scende mai sotto zero: un rilascio in più non deve "regalare" slot.
  execQueue.releaseOpenSlot('0xAbCd');
  assert.equal(execQueue.reservedOpenSlots('0xAbCd'), 0);
  // Wallet diversi hanno contatori indipendenti.
  execQueue.reserveOpenSlot('0xOther');
  assert.equal(execQueue.reservedOpenSlots('0xAbCd'), 0);
  execQueue.releaseOpenSlot('0xOther');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
