/**
 * Un fallimento TRANSITORIO della lettura account reale non deve inquinare
 * la curva equity persistita.
 * ===========================================================================
 *
 * INCIDENTE 2026-09-21: un blackout di 52s dell'API testnet Hyperliquid (502
 * Bad Gateway) ha fatto fallire `hyperliquid.getAccount()` mentre il broker
 * paper rispondeva regolarmente. `mergeAccountViews` (riskManager.js) somma
 * `real.equity + paper.equity`: con `real = null` quel contributo diventa
 * silenziosamente ZERO invece di "dato assente" — esattamente il difetto che
 * il commento della funzione dichiara di evitare per `positions`/`accountValue`,
 * ma non copre `equity`. Il totale deflazionato è finito in
 * `risk_equity_history` come se fosse una lettura vera, producendo un drawdown
 * di sessione fasullo (~$1.058) rimasto incollato per sempre in
 * `risk_drawdown_state` (il massimo persistito è intenzionalmente monotono).
 *
 * La rotta GET /api/perps/risk conosce già la differenza fra "reale a zero" e
 * "reale non disponibile": la porta in `sourceErrors`. Il fix è lì — non
 * scrivere il campione quando `sourceErrors` include `'account'`.
 *
 * Seam: DB su file temporaneo, `hyperliquid` sostituito, handler REALE preso
 * dal router stack — stesso pattern di test/accountPaperMerge.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-riskequityskip-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: hyperliquid } = await import('../src/perps/hyperliquidClient.js');
const { default: paperBroker } = await import('../src/perps/paperBroker.js');
const { default: notifier } = await import('../src/perps/notifier.js');

botManager.bots.clear();
notifier.notify = async () => true;

const NETWORK = 'testnet';
const ADDR = '0xRiskEquitySkip';
const BOT_ID = 'bot-riskequityskip';

db.insertBot({
  id: BOT_ID, name: 'Bot Skip', coin: 'SKIP-PERP', network: NETWORK,
  masterAddress: ADDR, config: { paper: true }, status: 'stopped'
});

let mid = 100;
hyperliquid.getMid = async () => mid;
hyperliquid.roundPx = (px) => Math.round(px * 100) / 100;
hyperliquid.getFrontendOpenOrders = async () => [];
hyperliquid.getUserFills = async () => [];
hyperliquid.getNetwork = () => NETWORK;
hyperliquid.getAccount = async () => ({
  accountValue: 1000, equity: 1000, totalMarginUsed: 0, totalNtlPos: 0,
  withdrawable: 1000, spotUsdc: 1000, spotAvailable: 1000, spotHold: 0, positions: []
});

function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function callRisk() {
  const handler = routeHandler('get', '/api/perps/risk');
  const captured = { statusCode: 200, body: null };
  await handler({ query: { address: ADDR }, params: {}, body: {} }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  return captured;
}

test('setup: posizione paper aperta, cosicché mode resti "mixed" quando il reale risponde', async () => {
  await paperBroker.setLeverage(ADDR, 'SKIP-PERP', 3);
  await paperBroker.placeMarketOrder({ masterAddress: ADDR, coin: 'SKIP-PERP', isBuy: true, size: 1 }, NETWORK);
  const acc = await paperBroker.peekAccount(ADDR, NETWORK);
  assert.equal(acc.positions.length, 1);
});

test('GET /api/perps/risk: una lettura reale riuscita registra un campione equity', async () => {
  const before = db.listRiskEquityHistory(NETWORK, ADDR).length;
  const res = await callRisk();
  assert.equal(res.body.data.account.mode, 'mixed');
  const after = db.listRiskEquityHistory(NETWORK, ADDR).length;
  assert.equal(after, before + 1, 'una lettura sana deve produrre un campione');
});

test('GET /api/perps/risk: se la lettura reale fallisce, NON scrive un campione equity deflazionato', async () => {
  const before = db.listRiskEquityHistory(NETWORK, ADDR);
  const lastGood = before[before.length - 1].value;

  hyperliquid.getAccount = async () => { throw new Error('502 Bad Gateway'); };
  const res = await callRisk();
  assert.ok(res.body.data.sourceErrors.includes('account'), 'la rotta deve sapere che il reale è mancante');
  assert.equal(res.body.data.account.mode, 'paper', 'il paper resta leggibile: non è questo il difetto');

  const after = db.listRiskEquityHistory(NETWORK, ADDR);
  assert.equal(after.length, before.length, 'nessun campione nuovo con il reale non disponibile');
  assert.equal(after[after.length - 1].value, lastGood, 'la curva non deve calare per un dato mancante');
});
