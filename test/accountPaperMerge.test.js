/**
 * Le posizioni PAPER non compaiono nella vista "account unico"
 * ============================================================
 *
 * `GET /api/perps/account` e `GET /api/perps/risk` leggono soltanto
 * `hyperliquid.getAccount()`, cioè l'account REALE sull'exchange. Con una flotta
 * interamente `paper: true` (OPS-FLEET-02) quell'account ha zero posizioni: il
 * pannello "Posizioni attive" resta vuoto e il tab Rischio descrive il wallet
 * reale (fermo) invece della flotta che sta davvero producendo esposizione.
 *
 * Tre cose che questo file verifica più delle altre:
 *
 *  1. **le due fonti si sommano senza sovrapporsi**: una posizione reale e una
 *     paper sulla stessa coin restano DUE righe distinte, etichettate — non una
 *     fusa che conterebbe due volte la stessa esposizione, e non una che
 *     nasconde l'altra. È il requisito per il giorno in cui sullo stesso
 *     indirizzo convivranno bot live e bot paper;
 *  2. **coerenza interna degli alert**: `deriveRiskAlerts` calcola RAPPORTI
 *     (margine/equity, esposizione/cap). Posizioni di una fonte ed equity di
 *     un'altra producono percentuali inventate, quindi equity, margine,
 *     notional e posizioni devono venire tutti dallo stesso aggregato;
 *  3. **la lettura non muove denaro simulato**: `paperBroker.getAccount()` fa
 *     scattare i trigger e non è una query. Chiamarla da una rotta HTTP
 *     significherebbe eseguire TP/SL simulati al ritmo del refresh della
 *     dashboard, anche per un bot FERMO — che non ha nessun tick per registrare
 *     la chiusura. Le rotte usano `peekAccount()`, che non scrive niente.
 *
 * Seam: DB su file temporaneo, `client.getMid` sostituito (nessuna rete) e
 * handler REALE delle rotte preso dal router stack, come test/staleReconcile.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-papermerge-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: hyperliquid } = await import('../src/perps/hyperliquidClient.js');
const { default: paperBroker } = await import('../src/perps/paperBroker.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { mergeAccountViews } = await import('../src/perps/riskManager.js');

botManager.bots.clear();
const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

const ADDR = '0xPaperMaster';
const BOT_PAPER = 'bot-paper-fermo';

db.insertBot({
  id: BOT_PAPER, name: 'Bot Paper', coin: 'PAPER-PERP', network: 'testnet',
  masterAddress: ADDR, config: { paper: true }, status: 'stopped'
});

// Prezzi finti: il paper broker riempie al mid, e `_snapshot` marca a mercato.
const MID = 100;
let mid = MID;
hyperliquid.getMid = async () => mid;
hyperliquid.roundPx = (px) => Math.round(px * 100) / 100;
hyperliquid.getFrontendOpenOrders = async () => [];
hyperliquid.getUserFills = async () => [];
hyperliquid.getNetwork = () => 'testnet';

// Account REALE vuoto: è la situazione di produzione con flotta tutta paper.
hyperliquid.getAccount = async () => ({
  accountValue: 0, equity: 500, totalMarginUsed: 0, totalNtlPos: 0,
  withdrawable: 0, spotUsdc: 500, spotAvailable: 500, spotHold: 0, positions: []
});

function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function callRoute(routePath, query) {
  const handler = routeHandler('get', routePath);
  const captured = { statusCode: 200, body: null };
  await handler({ query, params: {}, body: {} }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  return captured;
}

// ---------------------------------------------------------------------------
// 1. Funzione pura di merge (riskManager)
// ---------------------------------------------------------------------------

const realView = {
  accountValue: 300, equity: 1000, totalMarginUsed: 100, totalNtlPos: 300,
  withdrawable: 200, spotUsdc: 700, spotAvailable: 700, spotHold: 0,
  positions: [{ coin: 'BTC', side: 'long', size: 1, entryPx: 50, positionValue: 300, marginUsed: 100, unrealizedPnl: 5 }]
};
const paperView = {
  accountValue: 9000, equity: 9500, totalMarginUsed: 0, totalNtlPos: 0,
  withdrawable: 9500, spotUsdc: 0,
  positions: [
    { coin: 'BTC-PERP', side: 'short', size: 2, entryPx: 60, positionValue: 120, marginUsed: 40, unrealizedPnl: -3 },
    { coin: 'SOL-PERP', side: 'short', size: 5, entryPx: 20, positionValue: 100, marginUsed: 33, unrealizedPnl: 2 }
  ]
};

test('mergeAccountViews: le posizioni delle due fonti coesistono, etichettate', () => {
  const m = mergeAccountViews({ real: realView, paper: paperView });
  assert.equal(m.positions.length, 3, 'nessuna posizione persa e nessuna fusa');
  assert.deepEqual(m.positions.map(p => p.isPaper), [false, true, true]);
  assert.deepEqual(m.positions.map(p => p.source), ['real', 'paper', 'paper']);
  // Stessa coin sulle due fonti: due esposizioni diverse, non una da sommare.
  const btc = m.positions.filter(p => p.coin.startsWith('BTC'));
  assert.equal(btc.length, 2);
  assert.deepEqual(btc.map(p => p.side), ['long', 'short']);
});

test('mergeAccountViews: equity ed esposizione sono l\'aggregato delle fonti', () => {
  const m = mergeAccountViews({ real: realView, paper: paperView });
  assert.equal(m.equity, 10500, '1000 reali + 9500 simulati');
  assert.equal(m.unrealizedPnl, 4, '5 - 3 + 2');
  assert.equal(m.mode, 'mixed');
});

test('mergeAccountViews: i totali mancanti del paper si ricavano dalle posizioni', () => {
  // Il paper broker non tiene un margin summary e riporta 0: con posizioni
  // aperte quello zero è un campo ASSENTE, non una misura. Lasciarlo passare
  // darebbe "margine 0%" con la flotta a leva 3x.
  const m = mergeAccountViews({ real: realView, paper: paperView });
  assert.equal(m.sources.paper.totalMarginUsed, 73, '40 + 33 dalle posizioni');
  assert.equal(m.sources.paper.totalNtlPos, 220, '120 + 100 dalle posizioni');
  assert.equal(m.totalMarginUsed, 173, 'reale 100 + simulato 73');
  assert.equal(m.totalNtlPos, 520);
});

test('mergeAccountViews: i fatti del wallet restano quelli REALI', () => {
  // `accountValue` alimenta il badge del faucet, `spotUsdc` il trasferimento
  // Spot→Perp, `withdrawable` il prelievo: sommarci dentro denaro simulato
  // direbbe all'utente che ha fondi che non può muovere.
  const m = mergeAccountViews({ real: realView, paper: paperView });
  assert.equal(m.accountValue, 300);
  assert.equal(m.withdrawable, 200);
  assert.equal(m.spotUsdc, 700);
  assert.equal(m.sources.paper.equity, 9500, 'la parte simulata resta leggibile a parte');
  assert.equal(m.sources.real.equity, 1000);
});

test('mergeAccountViews: senza paper la vista è identica a quella reale', () => {
  const m = mergeAccountViews({ real: realView, paper: null });
  assert.equal(m.mode, 'real');
  assert.equal(m.equity, realView.equity);
  assert.equal(m.totalMarginUsed, realView.totalMarginUsed);
  assert.equal(m.positions.length, 1);
  assert.equal(m.positions[0].isPaper, false);
  assert.equal(m.sources.paper, null);
});

test('mergeAccountViews: senza account reale resta la sola parte simulata', () => {
  const m = mergeAccountViews({ real: null, paper: paperView });
  assert.equal(m.mode, 'paper');
  assert.equal(m.equity, 9500);
  assert.equal(m.sources.real, null, 'la fonte mancante si dichiara, non si finge a zero');
  assert.equal(mergeAccountViews({}).mode, 'none');
});

// ---------------------------------------------------------------------------
// 2. Lettura pura dello stato simulato
// ---------------------------------------------------------------------------

test('peekAccount: un indirizzo sconosciuto non diventa un conto da 10.000$', async () => {
  // `_acc()` crea l'account al primo accesso: usarlo in lettura inventerebbe
  // un'equity simulata per qualunque wallet ci si colleghi.
  assert.equal(await paperBroker.peekAccount('0xMaiVisto', 'testnet'), null);
});

test('peekAccount: NON fa scattare i trigger (getAccount sì)', async () => {
  const MASTER = '0xTriggerProbe';
  mid = 100;
  await paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'TRIG-PERP', isBuy: true, size: 1 }, 'testnet');
  await paperBroker.placeTriggerOrder({
    masterAddress: MASTER, coin: 'TRIG-PERP', isBuy: false, size: 1, triggerPx: 90, tpsl: 'sl'
  }, 'testnet');

  mid = 80; // stop loss ampiamente superato
  const peek = await paperBroker.peekAccount(MASTER, 'testnet');
  assert.equal(peek.positions.length, 1, 'una lettura non chiude una posizione');
  assert.ok(peek.positions[0].unrealizedPnl < 0, 'ma la marca a mercato');

  const real = await paperBroker.getAccount(MASTER, 'testnet');
  assert.equal(real.positions.length, 0, 'il percorso del tick, quello sì, esegue lo stop');
  mid = MID;
});

// ---------------------------------------------------------------------------
// 3. Le due rotte aggregate
// ---------------------------------------------------------------------------

const POS_ROW = db.insertPosition({ botId: BOT_PAPER, coin: 'PAPER-PERP', side: 'long', size: 2, entryPx: 100, leverage: 3 });

test('setup: il bot paper ha una posizione simulata aperta', async () => {
  mid = MID;
  await paperBroker.setLeverage(ADDR, 'PAPER-PERP', 3);
  await paperBroker.placeMarketOrder({ masterAddress: ADDR, coin: 'PAPER-PERP', isBuy: true, size: 2 }, 'testnet');
  const acc = await paperBroker.peekAccount(ADDR, 'testnet');
  assert.equal(acc.positions.length, 1);
});

test('GET /api/perps/account: la posizione paper compare fra le posizioni attive', async () => {
  const res = await callRoute('/api/perps/account', { address: ADDR });
  assert.equal(res.statusCode, 200);
  const data = res.body.data;
  assert.equal(data.positions.length, 1, 'con l\'account reale vuoto restava vuoto anche il pannello');
  const p = data.positions[0];
  assert.equal(p.coin, 'PAPER-PERP');
  assert.equal(p.isPaper, true, 'etichettata: il pulsante "Chiudi" parla con l\'exchange reale');
  assert.equal(p.botName, 'Bot Paper', 'attribuita al suo bot come le posizioni reali');
  assert.ok(p.openedAt, 'e con la data di apertura dalla riga DB');
});

test('GET /api/perps/account: i fatti del wallet reale non vengono gonfiati', async () => {
  const data = (await callRoute('/api/perps/account', { address: ADDR })).body.data;
  assert.equal(data.accountValue, 0, 'il perp reale è davvero vuoto');
  assert.equal(data.spotUsdc, 500);
  assert.equal(data.mode, 'mixed');
  assert.ok(data.sources.paper.equity > 9000, 'la parte simulata è leggibile a parte');
});

test('GET /api/perps/account: la riga del bot paper FERMO non viene riconciliata', async () => {
  // Senza le posizioni paper fra le "live", la riconciliazione delle orfane
  // vedeva una riga `open` senza riscontro e la chiudeva con PnL sconosciuto:
  // una posizione simulata viva dichiarata chiusa in database.
  notified.length = 0;
  await callRoute('/api/perps/account', { address: ADDR });
  const row = db.getPosition(POS_ROW);
  assert.equal(row.status, 'open', 'la posizione simulata esiste davvero');
  assert.deepEqual(notified, [], 'e nessuno annuncia una chiusura mai avvenuta');
});

test('GET /api/perps/risk: equity, margine e posizioni vengono dallo stesso aggregato', async () => {
  const data = (await callRoute('/api/perps/risk', { address: ADDR })).body.data;
  assert.equal(data.account.positions.length, 1, 'il tab Rischio ignorava del tutto la flotta paper');
  assert.ok(data.account.equity > 9000, `equity della flotta, non del wallet fermo (${data.account.equity})`);
  assert.ok(data.account.totalMarginUsed > 0, 'margine impegnato dalla posizione simulata');
  assert.equal(data.account.mode, 'mixed');
  assert.ok(data.account.sources.real, 'con la parte reale sempre leggibile a parte');
  assert.ok(Number.isFinite(data.pnl.unrealized), 'e il PnL non realizzato della flotta');
});
