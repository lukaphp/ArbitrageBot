/**
 * CRIT #16 (difetto secondario) — la leva della posizione simulata.
 * ================================================================
 *
 * `paperBroker.placeMarketOrder` scriveva `leverage: 1` fisso nella posizione
 * paper, qualunque fosse la leva configurata sul bot (la flotta OPS-FLEET-02 gira
 * a 3x), e `setLeverage()` era un no-op che buttava via il valore ricevuto.
 * Conseguenza: `getAccount()` riportava `marginUsed` sbagliato di un fattore pari
 * alla leva reale — cioè il margine usato appariva 3 volte più grande del vero,
 * su un numero che alimenta i controlli di esposizione.
 *
 * La leva su Hyperliquid è stato di account per coin, non un campo dell'ordine:
 * qui si verifica che il paperBroker la ricordi da `setLeverage` (che è ciò che
 * `bot._openPosition` chiama prima di ogni apertura) e la applichi al fill.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import { PaperBroker } from '../src/perps/paperBroker.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-paperlev-'));
db.dbPath = path.join(tempDir, 'perps.db');

let MID = 100;
client.getMid = async () => MID;

const broker = new PaperBroker();

test('la leva impostata prima dell\'apertura finisce nella posizione e nel margine', async () => {
  const M = '0xLEV3';
  MID = 100;
  // Stessa chiamata, stessi argomenti posizionali di `bot._openPosition`.
  await broker.setLeverage(M, 'LEV-PERP', 3, 'cross', 'testnet');
  const order = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'LEV-PERP', isBuy: true, size: 2 }, 'testnet');

  const acc = await broker.getAccount(M, 'testnet');
  const pos = acc.positions.find(p => p.coin === 'LEV-PERP');
  assert.equal(pos.leverage, 3, 'leva reale del bot, non 1 fisso');
  const expectedMargin = (2 * order.avgPx) / 3;
  assert.ok(Math.abs(pos.marginUsed - expectedMargin) < 1e-9,
    `marginUsed ${pos.marginUsed}, atteso ${expectedMargin} (nozionale / leva)`);
});

test('la leva è per coin: un altro mercato dello stesso account non la eredita', async () => {
  const M = '0xLEVMIX';
  MID = 100;
  await broker.setLeverage(M, 'A-PERP', 5, 'cross', 'testnet');
  await broker.setLeverage(M, 'B-PERP', 2, 'cross', 'testnet');
  await broker.placeMarketOrder({ masterAddress: M, coin: 'A-PERP', isBuy: true, size: 1 }, 'testnet');
  await broker.placeMarketOrder({ masterAddress: M, coin: 'B-PERP', isBuy: false, size: 1 }, 'testnet');

  const acc = await broker.getAccount(M, 'testnet');
  assert.equal(acc.positions.find(p => p.coin === 'A-PERP').leverage, 5);
  assert.equal(acc.positions.find(p => p.coin === 'B-PERP').leverage, 2);
});

test('senza setLeverage resta 1: nessuna leva inventata', async () => {
  const M = '0xLEVNONE';
  MID = 100;
  await broker.placeMarketOrder({ masterAddress: M, coin: 'NOLEV-PERP', isBuy: true, size: 1 }, 'testnet');
  const acc = await broker.getAccount(M, 'testnet');
  assert.equal(acc.positions.find(p => p.coin === 'NOLEV-PERP').leverage, 1);
});

test('un\'aggiunta DCA non riporta la leva a 1', async () => {
  const M = '0xLEVDCA';
  MID = 100;
  await broker.setLeverage(M, 'DCALEV-PERP', 4, 'cross', 'testnet');
  await broker.placeMarketOrder({ masterAddress: M, coin: 'DCALEV-PERP', isBuy: true, size: 1 }, 'testnet');
  // Il DCA non ripassa da setLeverage: la leva deve restare quella dell'apertura.
  await broker.placeMarketOrder({ masterAddress: M, coin: 'DCALEV-PERP', isBuy: true, size: 1 }, 'testnet');

  const acc = await broker.getAccount(M, 'testnet');
  const pos = acc.positions.find(p => p.coin === 'DCALEV-PERP');
  assert.equal(pos.size, 2);
  assert.equal(pos.leverage, 4, 'la leva sopravvive alla mediazione');
  assert.ok(Math.abs(pos.marginUsed - (2 * pos.entryPx) / 4) < 1e-9, 'margine ricalcolato sulla size nuova');
});

test('la leva sopravvive al riavvio del processo', async () => {
  const M = '0xLEVPERSIST';
  MID = 100;
  await broker.setLeverage(M, 'PERSISTLEV-PERP', 3, 'cross', 'testnet');
  const restarted = new PaperBroker();
  await restarted.placeMarketOrder(
    { masterAddress: M, coin: 'PERSISTLEV-PERP', isBuy: true, size: 1 }, 'testnet');
  const acc = await restarted.getAccount(M, 'testnet');
  assert.equal(acc.positions.find(p => p.coin === 'PERSISTLEV-PERP').leverage, 3,
    'la leva impostata prima di un riavvio non si perde (è stato di account, come sull\'exchange)');
});

test('una leva non valida non sporca lo stato', async () => {
  const M = '0xLEVBAD';
  MID = 100;
  await broker.setLeverage(M, 'BAD-PERP', 0, 'cross', 'testnet');
  await broker.setLeverage(M, 'BAD-PERP', undefined, 'cross', 'testnet');
  await broker.placeMarketOrder({ masterAddress: M, coin: 'BAD-PERP', isBuy: true, size: 1 }, 'testnet');
  const acc = await broker.getAccount(M, 'testnet');
  const pos = acc.positions.find(p => p.coin === 'BAD-PERP');
  assert.equal(pos.leverage, 1);
  assert.ok(Number.isFinite(pos.marginUsed) && pos.marginUsed > 0, 'nessuna divisione per zero nel margine');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
