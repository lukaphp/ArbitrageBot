/**
 * Righe `positions` orfane: chiuse sull'exchange mentre il bot era FERMO.
 * ======================================================================
 *
 * `bot._reconcile()` chiude in DB una posizione sparita dall'exchange, ma gira
 * dentro `_runTick`: esiste solo finché il bot è `running`. Un bot fermo con una
 * riga ancora `open`, la cui posizione viene chiusa nel frattempo (TP/SL,
 * chiusura manuale), non viene riconciliato da nessuno — la riga resta `open`
 * per sempre e continua a comparire ovunque si legga "posizioni aperte".
 *
 * Il presidio nuovo sta in `/api/perps/account`, che l'account live ce l'ha già
 * in mano. Due cose che questo file verifica più delle altre:
 *
 *  - **non compete con il percorso del tick**: un bot `running` NON viene
 *    toccato qui, perché due percorsi che chiudono la stessa riga sono peggio di
 *    uno solo;
 *  - **non tocca i wallet altrui**: la GET riguarda un indirizzo, e le righe dei
 *    bot di altri indirizzi restano dove sono — l'assenza dalle posizioni live
 *    di QUESTO account non dice nulla su di loro.
 *
 * Il PnL di queste chiusure è `null` e non 0: la posizione può essersi chiusa
 * molto prima e non c'è modo di attribuirle un PnL reale a posteriori. Zero
 * significherebbe "chiusa in pari", che è un'affermazione, non un'assenza —
 * stessa disciplina di `computeSlippage`, che torna `null` e non 0.
 *
 * Seam: DB su file temporaneo e handler REALE della rotta preso dal router stack
 * (nessun listen, nessuna rete), come test/perfAggregations.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-stale-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: hyperliquid } = await import('../src/perps/hyperliquidClient.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { findOrphanPositions, CLOSE_REASON_STALE_ORPHAN } = await import('../src/perps/reconciler.js');

botManager.bots.clear();

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

const ADDR = '0xStaleMaster';
const OTHER_ADDR = '0xAltroWallet';

const BOT_FERMO = 'bot-stale-fermo';
const BOT_RUNNING = 'bot-stale-running';
const BOT_ALTRO = 'bot-stale-altro';

for (const [id, name, coin, master] of [
  [BOT_FERMO, 'Bot Fermo', 'STALE-PERP', ADDR],
  [BOT_RUNNING, 'Bot Running', 'RUN-PERP', ADDR],
  [BOT_ALTRO, 'Bot Altro Wallet', 'OTHER-PERP', OTHER_ADDR]
]) {
  db.insertBot({ id, name, coin, network: 'testnet', masterAddress: master, config: {}, status: 'stopped' });
}

// Il bot "running" esiste in botManager con quello stato. Basta l'oggetto con
// `status`: costruire un PerpsBot vero e avviarlo farebbe partire il suo loop
// (e la sua rete) dentro il test, senza aggiungere nulla a ciò che si verifica.
botManager.bots.set(BOT_RUNNING, { id: BOT_RUNNING, status: 'running' });

const apri = (botId, coin, side = 'long') =>
  db.insertPosition({ botId, coin, side, size: 1, entryPx: 100, leverage: 1 });

const POS_ORFANA = apri(BOT_FERMO, 'STALE-PERP');
const POS_ANCORA_VIVA = apri(BOT_FERMO, 'LIVE-PERP');
const POS_BOT_RUNNING = apri(BOT_RUNNING, 'RUN-PERP');
const POS_ALTRO_WALLET = apri(BOT_ALTRO, 'OTHER-PERP');

// L'account live conosce solo LIVE (senza suffisso, come lo restituisce
// Hyperliquid): tutte le altre righe non hanno riscontro sull'exchange.
hyperliquid.getAccount = async () => ({
  equity: 1000,
  accountValue: 1000,
  positions: [{ coin: 'LIVE', side: 'long', size: 1, entryPx: 100, unrealizedPnl: 5 }]
});

function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function callAccount(address = ADDR) {
  const handler = routeHandler('get', '/api/perps/account');
  const captured = { statusCode: 200, body: null };
  await handler({ query: { address }, params: {}, body: {} }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  return captured;
}

const rowOf = (id) => db.getPosition(id);

// ---- selezione delle righe orfane (funzione pura) ----

const righe = [
  { id: 1, bot_id: BOT_FERMO, coin: 'STALE-PERP', side: 'long', status: 'open' },
  { id: 2, bot_id: BOT_FERMO, coin: 'LIVE-PERP', side: 'long', status: 'open' },
  { id: 3, bot_id: BOT_RUNNING, coin: 'RUN-PERP', side: 'long', status: 'open' },
  { id: 4, bot_id: BOT_ALTRO, coin: 'OTHER-PERP', side: 'long', status: 'open' }
];
const bots = [
  { id: BOT_FERMO, name: 'Bot Fermo', master_address: ADDR },
  { id: BOT_RUNNING, name: 'Bot Running', master_address: ADDR },
  { id: BOT_ALTRO, name: 'Bot Altro Wallet', master_address: OTHER_ADDR }
];
const live = [{ coin: 'LIVE', side: 'long' }];

test('findOrphanPositions: solo le righe senza riscontro live, di bot fermi, su questo indirizzo', () => {
  const orfane = findOrphanPositions({
    openRows: righe, livePositions: live, bots, runningBotIds: new Set([BOT_RUNNING]), address: ADDR
  });
  assert.deepEqual(orfane.map(o => o.row.id), [1]);
  assert.equal(orfane[0].bot.name, 'Bot Fermo');
});

test('findOrphanPositions: il match coin tollera il suffisso -PERP', () => {
  // La riga in DB è 'LIVE-PERP', l'exchange dice 'LIVE': è la stessa posizione,
  // e chiuderla sarebbe il danno peggiore possibile — una posizione VERA
  // dichiarata chiusa in DB.
  const orfane = findOrphanPositions({
    openRows: [righe[1]], livePositions: live, bots, runningBotIds: new Set(), address: ADDR
  });
  assert.deepEqual(orfane, []);
});

test('findOrphanPositions: stesso coin ma lato opposto è un\'altra posizione', () => {
  const short = [{ id: 9, bot_id: BOT_FERMO, coin: 'LIVE-PERP', side: 'short', status: 'open' }];
  const orfane = findOrphanPositions({
    openRows: short, livePositions: live, bots, runningBotIds: new Set(), address: ADDR
  });
  assert.deepEqual(orfane.map(o => o.row.id), [9]);
});

test('findOrphanPositions: bot running escluso (se ne occupa il suo tick)', () => {
  const orfane = findOrphanPositions({
    openRows: [righe[2]], livePositions: live, bots, runningBotIds: new Set([BOT_RUNNING]), address: ADDR
  });
  assert.deepEqual(orfane, [], 'due percorsi che chiudono la stessa riga sono peggio di uno');
});

test('findOrphanPositions: indirizzo diverso, confronto insensibile al maiuscolo', () => {
  assert.deepEqual(
    findOrphanPositions({ openRows: [righe[3]], livePositions: live, bots, runningBotIds: new Set(), address: ADDR }),
    [], 'la riga di un altro wallet non si giudica dalle posizioni di questo');
  assert.equal(
    findOrphanPositions({ openRows: [righe[3]], livePositions: live, bots, runningBotIds: new Set(), address: OTHER_ADDR.toUpperCase() }).length,
    1, 'ma sul SUO indirizzo sì, anche scritto con maiuscole diverse');
});

test('findOrphanPositions: righe senza bot noto non vengono toccate', () => {
  // Senza bot non c'è `master_address`: non si può stabilire che la riga
  // appartenga a QUESTO indirizzo, e chiuderla sarebbe un tiro a indovinare.
  const orfane = findOrphanPositions({
    openRows: [
      { id: 7, bot_id: null, coin: 'MANUAL-PERP', side: 'long', status: 'open' },
      { id: 8, bot_id: 'bot-sconosciuto', coin: 'GHOST-PERP', side: 'long', status: 'open' }
    ],
    livePositions: live, bots, runningBotIds: new Set(), address: ADDR
  });
  assert.deepEqual(orfane, []);
});

test('findOrphanPositions: righe già chiuse ignorate', () => {
  const chiusa = [{ ...righe[0], status: 'closed' }];
  assert.deepEqual(
    findOrphanPositions({ openRows: chiusa, livePositions: live, bots, runningBotIds: new Set(), address: ADDR }),
    []);
});

// ---- effetto reale attraverso la rotta ----

test('GET /api/perps/account: la riga orfana del bot fermo viene chiusa', async () => {
  notified.length = 0;
  const res = await callAccount();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);

  const row = rowOf(POS_ORFANA);
  assert.equal(row.status, 'closed');
  assert.equal(row.close_reason, CLOSE_REASON_STALE_ORPHAN);
  assert.equal(db.closeReasonBucket(row.close_reason), 'reconciliation_mismatch',
    'bucket proprio: non è un TP/SL né una chiusura esterna riconosciuta');
  assert.equal(row.pnl, null, 'PnL sconosciuto resta sconosciuto: null, non 0');
  assert.ok(row.closed_at, 'timbrata');

  const avviso = notified.find(t => /STALE-PERP/.test(t));
  assert.ok(avviso, `la riconciliazione va notificata — notifiche: ${JSON.stringify(notified)}`);
  assert.match(avviso, /Bot Fermo/);
});

test('GET /api/perps/account: bot running, posizione viva e altro wallet restano intatti', async () => {
  await callAccount();
  assert.equal(rowOf(POS_BOT_RUNNING).status, 'open', 'il tick del bot running se ne occupa già');
  assert.equal(rowOf(POS_ANCORA_VIVA).status, 'open', 'la posizione esiste davvero sull\'exchange');
  assert.equal(rowOf(POS_ALTRO_WALLET).status, 'open', 'riga di un altro indirizzo');
});

test('GET /api/perps/account: nessuna notifica ripetuta a ogni refresh', async () => {
  notified.length = 0;
  await callAccount();
  await callAccount();
  assert.deepEqual(notified, [], 'la riga è già chiusa: niente da riconciliare, niente rumore');
});

test('GET /api/perps/account: l\'arricchimento delle posizioni live continua a funzionare', async () => {
  const res = await callAccount();
  const live0 = res.body.data.positions[0];
  assert.equal(live0.coin, 'LIVE');
  assert.equal(live0.botName, 'Bot Fermo', 'la posizione viva resta attribuita al suo bot');
  assert.ok(live0.openedAt, 'e conserva la data di apertura dalla riga DB');
});
