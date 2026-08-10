/**
 * DEBT-01 item 2: sweep dei TAKE PROFIT in eccesso su una posizione tracciata.
 * ===========================================================================
 *
 * SEC-08 ha aggiunto la pulizia degli SL orfani a `_ensureStopLoss` (lo stato
 * trovato sul VPS il 9 agosto era 1 TP + 2 SL vivi per una sola posizione da
 * 1.31 SOL), ma solo per gli SL: un TP lasciato indietro da un ri-piazzamento il
 * cui `cancel` non è andato a buon fine restava vivo per sempre. Non è
 * innocuo — è un ordine reduce-only dimensionato su uno stato precedente della
 * posizione, che può chiuderla a un prezzo che non è più quello previsto dalla
 * strategia.
 *
 * Due asimmetrie VOLUTE rispetto agli SL, verificate qui:
 *  - il TP mancante NON viene ri-piazzato e la posizione NON viene chiusa per
 *    sicurezza: senza TP si perde un'uscita in profitto, non la protezione. Solo
 *    l'eccesso viene rimosso;
 *  - con `partialTp` più TP sono LEGITTIMI: il riferimento è quanti ne prevede
 *    la configurazione, non "uno".
 *
 * Seam di test: paperBroker + singleton DB su file temporaneo (mai
 * data/perps.db), come test/botReconcile.test.js. Lo sweep è esercitato
 * attraverso `_manageOpen` — l'orchestrazione reale di un tick su posizione
 * aperta — e non chiamando il metodo privato direttamente, così il test copre
 * anche il fatto che sia davvero agganciato al tick.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-tpsweep-'));
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

/** Bot con posizione long già aperta e TP/SL piazzati come farebbe `_openPosition`. */
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

const ordersOf = async (master) => paperBroker.getFrontendOpenOrders(master);
const tpsOf = (orders) => orders.filter(o => /take profit/i.test(o.orderType));
const slsOf = (orders) => orders.filter(o => /stop/i.test(o.orderType));

/** Tick su posizione aperta senza segnale di uscita (il caso di gestione normale). */
const manage = (bot) => bot._manageOpen({ price: MID, candles: [] }, {}, { action: 'hold' });

test('TP orfano: due take profit vivi con un solo TP configurato → resta il più recente', async () => {
  const master = '0xTPS1';
  const coin = 'TPS1-PERP';
  const bot = await botWithOpenPosition('bot-tps-1', coin, master);

  const legit = tpsOf(await ordersOf(master))[0];
  // Residuo di un ri-piazzamento il cui cancel è fallito: stessa posizione,
  // size e prezzo di uno stato precedente. Piazzato PRIMA di quello buono per
  // riprodurre l'ordine reale degli eventi → oid più basso.
  const orphan = await paperBroker.placeTriggerOrder(
    { masterAddress: master, coin, isBuy: false, size: 0.6, triggerPx: bot.position.tpPx - 1, tpsl: 'tp' }, 'testnet');
  assert.equal(tpsOf(await ordersOf(master)).length, 2, 'punto di partenza: due TP vivi');

  notified.length = 0;
  await manage(bot);

  const orders = await ordersOf(master);
  const tps = tpsOf(orders);
  assert.equal(tps.length, 1, 'un solo TP resta vivo');
  assert.equal(tps[0].oid, Math.max(legit.oid, orphan.oid), 'resta quello piazzato per ultimo');
  assert.ok(!orders.some(o => o.oid === Math.min(legit.oid, orphan.oid)), 'il TP in eccesso è stato cancellato');
  assert.equal(slsOf(orders).length, 1, 'lo SL non viene toccato dalla pulizia dei TP');
  assert.equal(bot.position.slOid, slsOf(orders)[0].oid, 'lo SL tracciato resta quello vivo');
  assert.ok(notified.some(t => /take profit/i.test(t) && /TPS1-PERP/.test(t)),
    'un ordine in eccesso su una posizione reale non passa in silenzio: notificato');
});

test('nessun TP in eccesso: niente viene cancellato (nessun falso positivo)', async () => {
  const master = '0xTPS2';
  const coin = 'TPS2-PERP';
  const bot = await botWithOpenPosition('bot-tps-2', coin, master);

  const before = await ordersOf(master);
  assert.equal(tpsOf(before).length, 1);

  notified.length = 0;
  await manage(bot);

  const after = await ordersOf(master);
  assert.deepEqual(tpsOf(after).map(o => o.oid), tpsOf(before).map(o => o.oid),
    'gli oid dei TP sono gli stessi: nessuna cancellazione');
  assert.equal(slsOf(after).length, 1);
  assert.equal(notified.filter(t => /take profit/i.test(t)).length, 0, 'nessuna notifica senza anomalia');
});

test('partialTp: la scala di TP legittima non viene potata, solo l\'eccesso', async () => {
  const master = '0xTPS3';
  const coin = 'TPS3-PERP';
  const config = {
    ...BASE_CONFIG,
    partialTp: [{ portion: 0.5, atPercent: 5 }, { portion: 0.5, atPercent: 10 }]
  };
  const bot = await botWithOpenPosition('bot-tps-3', coin, master, config);

  const ladderOids = tpsOf(await ordersOf(master)).map(o => o.oid);
  assert.equal(ladderOids.length, 2, 'due TP legittimi dalla scala configurata');

  notified.length = 0;
  await manage(bot);
  assert.deepEqual(tpsOf(await ordersOf(master)).map(o => o.oid).sort(), [...ladderOids].sort(),
    'con 2 TP configurati e 2 vivi non si cancella nulla');
  assert.equal(notified.filter(t => /take profit/i.test(t)).length, 0);

  // Terzo TP di troppo (residuo di una scala precedente): ora l'eccesso c'è.
  const orphan = await paperBroker.placeTriggerOrder(
    { masterAddress: master, coin, isBuy: false, size: 1, triggerPx: bot.position.entryPx * 1.02, tpsl: 'tp' }, 'testnet');
  assert.equal(tpsOf(await ordersOf(master)).length, 3);

  await manage(bot);

  const tps = tpsOf(await ordersOf(master));
  assert.equal(tps.length, 2, 'si torna ai 2 TP previsti dalla configurazione');
  // L'orfano è il più recente (oid più alto): a essere cancellato è il più
  // vecchio della scala. Il criterio è "tieni i più recenti", che è ciò che
  // rispecchia lo stato corrente della posizione dopo un ri-piazzamento.
  assert.ok(tps.some(o => o.oid === orphan.oid), 'i TP tenuti sono i più recenti');
  assert.equal(tps.filter(o => ladderOids.includes(o.oid)).length, 1);
});

test('strategia senza TP: gli ordini TP estranei non vengono toccati', async () => {
  const master = '0xTPS4';
  const coin = 'TPS4-PERP';
  const config = { ...BASE_CONFIG, tp: { enabled: false } };
  const bot = await botWithOpenPosition('bot-tps-4', coin, master, config);
  assert.equal(bot.position.tpPx, null, 'nessun TP previsto dalla strategia');

  // TP piazzato a mano dall'operatore fuori dal bot: senza un riferimento
  // (quanti TP prevede la strategia) non c'è modo di dire quale sia "in
  // eccesso" — e cancellare l'ordine di qualcun altro sarebbe peggio del
  // problema. Stessa uscita anticipata di `_ensureStopLoss` senza slPx.
  const manual = await paperBroker.placeTriggerOrder(
    { masterAddress: master, coin, isBuy: false, size: 1, triggerPx: 130, tpsl: 'tp' }, 'testnet');

  await manage(bot);

  const orders = await ordersOf(master);
  assert.ok(orders.some(o => o.oid === manual.oid), 'il TP manuale resta vivo');
  assert.equal(tpsOf(orders).length, 1);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
