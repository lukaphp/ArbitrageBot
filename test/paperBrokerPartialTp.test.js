/**
 * ISSUE #17 — il take profit PARZIALE non era modellato nel paperBroker.
 * ======================================================================
 *
 * `bot._placeTpSl` piazza una scala di TP quando `config.partialTp` è definita:
 * un trigger per gradino, ognuno con la SUA size (`position.size * portion`).
 * `paperBroker._evaluateTriggers` però passava a `_fillClose` solo prezzo e oid,
 * e `_fillClose` chiudeva SEMPRE `pos.size` — l'intera posizione — buttando via
 * `t.size` del trigger scattato.
 *
 * Conseguenza: sulla flotta OPS-FLEET-02 (`partialTp: [{portion: 0.5,
 * atPercent: 1.5}]` + trailing sul resto) il forward-test simulava una strategia
 * DIVERSA da quella configurata — un'uscita totale a +1.5% invece di
 * un'alleggerita del 50% con il residuo lasciato correre dietro al trailing.
 * Nessuna perdita diretta, ma ogni statistica di performance del paper trading
 * su quei bot era inattendibile.
 *
 * I test sono scritti sul BROKER (dove sta il difetto) più un caso sul percorso
 * reale bot → paperBroker, che è l'unico che dimostra che la scala di TP e il
 * trailing sul residuo funzionano insieme.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import notifier from '../src/perps/notifier.js';
import marketData from '../src/perps/marketData.js';
import paperBroker, { PaperBroker } from '../src/perps/paperBroker.js';
import { PerpsBot } from '../src/perps/bot.js';

// Il paperBroker persiste lo stato in `settings` → DB temporaneo, mai data/perps.db.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-partialtp-'));
db.dbPath = path.join(tempDir, 'perps.db');

let MID = 100;
client.getMid = async () => MID;
// `roundPx` resta quello vero: i prezzi del test sono quelli di produzione.

const TAKER_FEE_PCT = 0.00035;
const broker = new PaperBroker();

// ---- Difetto centrale: un trigger parziale riduce, non azzera ----

test('TP parziale al 50%: la posizione resta aperta con metà size', async () => {
  const M = '0xPARTIAL1';
  MID = 100;
  const open = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'PT1-PERP', isBuy: true, size: 2 }, 'testnet');
  // Scala della flotta: un solo gradino, 50% della size a +1.5%.
  const tp = await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT1-PERP', isBuy: false, size: 1, triggerPx: open.avgPx * 1.015, tpsl: 'tp' },
    'testnet');
  await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT1-PERP', isBuy: false, size: 2, triggerPx: open.avgPx * 0.985, tpsl: 'sl' },
    'testnet');

  MID = open.avgPx * 1.02; // oltre il TP parziale, lontano dallo SL
  const acc = await broker.getAccount(M, 'testnet');

  const pos = acc.positions.find(p => p.coin === 'PT1-PERP');
  assert.ok(pos, 'la posizione NON deve sparire: il trigger chiudeva solo metà size (issue #17)');
  assert.ok(Math.abs(pos.size - 1) < 1e-9, `size residua ${pos.size}, attesa 1`);
  assert.ok(Math.abs(pos.entryPx - open.avgPx) < 1e-9,
    'il prezzo di ingresso del residuo non cambia: una riduzione non media niente');

  // Il fill di chiusura porta l'oid del TRIGGER scattato (serve a
  // `bot._classifyCloseFills`) e la size della sola porzione chiusa.
  const real = await broker.getRealizedPnl(M, 'PT1-PERP', 0);
  const closing = real.closingFills;
  assert.equal(closing.length, 1);
  assert.equal(closing[0].oid, tp.oid, 'oid del trigger parziale, non uno nuovo');
  assert.ok(Math.abs(closing[0].sz - 1) < 1e-9, `fill di ${closing[0].sz}, atteso 1`);
});

test('il trigger scattato è consumato, gli altri restano vivi sul residuo', async () => {
  const M = '0xPARTIAL2';
  MID = 100;
  const open = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'PT2-PERP', isBuy: true, size: 2 }, 'testnet');
  const tp = await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT2-PERP', isBuy: false, size: 1, triggerPx: open.avgPx * 1.015, tpsl: 'tp' },
    'testnet');
  const sl = await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT2-PERP', isBuy: false, size: 2, triggerPx: open.avgPx * 0.985, tpsl: 'sl' },
    'testnet');

  MID = open.avgPx * 1.02;
  await broker.getAccount(M, 'testnet');

  const orders = await broker.getFrontendOpenOrders(M);
  const live = orders.filter(o => o.coin === 'PT2-PERP');
  assert.equal(live.length, 1, 'resta solo lo SL: il TP eseguito è un ordine consumato');
  assert.equal(live[0].oid, sl.oid);

  // Secondo giro a prezzo invariato: se il TP non fosse stato consumato
  // ri-scatterebbe e mangerebbe un altro 50% del residuo, all'infinito.
  const acc = await broker.getAccount(M, 'testnet');
  const pos = acc.positions.find(p => p.coin === 'PT2-PERP');
  assert.ok(Math.abs(pos.size - 1) < 1e-9,
    `size ${pos.size} dopo un secondo tick: il TP già eseguito è ri-scattato`);
  const real = await broker.getRealizedPnl(M, 'PT2-PERP', 0);
  assert.equal(real.closingFills.length, 1, 'un solo fill di chiusura, non uno per tick');
  assert.equal(tp.oid > 0, true);
});

test('PnL e fee del parziale sono proporzionali alla sola porzione chiusa', async () => {
  const M = '0xPARTIAL3';
  MID = 1000;
  const open = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'PT3-PERP', isBuy: true, size: 4 }, 'testnet');
  const triggerPx = client.roundPx(open.avgPx * 1.01);
  await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT3-PERP', isBuy: false, size: 1, triggerPx, tpsl: 'tp' }, 'testnet');

  const before = (await broker.getAccount(M, 'testnet')).accountValue;
  MID = open.avgPx * 1.02;
  await broker.getAccount(M, 'testnet');

  const real = await broker.getRealizedPnl(M, 'PT3-PERP', 0);
  const fill = real.closingFills[0];
  // Il fill avviene ESATTAMENTE a triggerPx (modello già in essere, nessun gap).
  const expectedPnl = (triggerPx - open.avgPx) * 1;
  const expectedFee = triggerPx * 1 * TAKER_FEE_PCT;
  assert.ok(Math.abs(fill.closedPnl - expectedPnl) < 1e-9,
    `PnL ${fill.closedPnl}, atteso ${expectedPnl} (su 1 unità, non su 4)`);
  assert.ok(Math.abs(fill.fee - expectedFee) < 1e-9,
    `fee ${fill.fee}, attesa ${expectedFee} (sul nozionale della porzione chiusa)`);

  const after = (await broker.getAccount(M, 'testnet')).accountValue;
  assert.ok(Math.abs((after - before) - (expectedPnl - expectedFee)) < 1e-9,
    'equity mossa esattamente del PnL netto della porzione chiusa');
});

// ---- Il comportamento pieno non deve regredire ----

test('un trigger dimensionato sull\'intera posizione la chiude tutta (nessuna regressione)', async () => {
  const M = '0xPARTIAL4';
  MID = 100;
  const open = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'PT4-PERP', isBuy: true, size: 2 }, 'testnet');
  await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT4-PERP', isBuy: false, size: 2, triggerPx: open.avgPx * 0.985, tpsl: 'sl' },
    'testnet');

  MID = open.avgPx * 0.98;
  const acc = await broker.getAccount(M, 'testnet');
  assert.equal(acc.positions.filter(p => p.coin === 'PT4-PERP').length, 0, 'posizione chiusa per intero');
  const orders = await broker.getFrontendOpenOrders(M);
  assert.equal(orders.filter(o => o.coin === 'PT4-PERP').length, 0, 'i trigger residui spariscono con la posizione');
});

test('trigger senza size (percorso storico) chiude comunque tutta la posizione', async () => {
  const M = '0xPARTIAL5';
  MID = 100;
  const open = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'PT5-PERP', isBuy: true, size: 2 }, 'testnet');
  await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT5-PERP', isBuy: false, size: undefined, triggerPx: open.avgPx * 0.985, tpsl: 'sl' },
    'testnet');

  MID = open.avgPx * 0.98;
  const acc = await broker.getAccount(M, 'testnet');
  assert.equal(acc.positions.filter(p => p.coin === 'PT5-PERP').length, 0,
    'size assente = "chiudi tutto": è lo stato salvato prima di questo fix');
});

test('lo SL sovradimensionato dopo un parziale chiude il residuo, non di più', async () => {
  // Fra il TP parziale e il primo aggiornamento del trailing, lo SL sul book ha
  // ancora la size PIENA. Su Hyperliquid è reduce-only e chiude solo ciò che
  // resta: il paper deve fare lo stesso, non aprire uno short fantasma.
  const M = '0xPARTIAL6';
  MID = 100;
  const open = await broker.placeMarketOrder(
    { masterAddress: M, coin: 'PT6-PERP', isBuy: true, size: 2 }, 'testnet');
  await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT6-PERP', isBuy: false, size: 1, triggerPx: open.avgPx * 1.015, tpsl: 'tp' },
    'testnet');
  await broker.placeTriggerOrder(
    { masterAddress: M, coin: 'PT6-PERP', isBuy: false, size: 2, triggerPx: open.avgPx * 0.985, tpsl: 'sl' },
    'testnet');

  MID = open.avgPx * 1.02;
  await broker.getAccount(M, 'testnet'); // TP parziale: residuo 1, SL ancora da 2
  MID = open.avgPx * 0.98;
  const acc = await broker.getAccount(M, 'testnet');

  assert.equal(acc.positions.filter(p => p.coin === 'PT6-PERP').length, 0, 'residuo chiuso dallo SL');
  const real = await broker.getRealizedPnl(M, 'PT6-PERP', 0);
  const slFill = real.closingFills[real.closingFills.length - 1];
  assert.ok(Math.abs(slFill.sz - 1) < 1e-9,
    `lo SL ha chiuso ${slFill.sz} su un residuo di 1: la size del trigger non è stata limitata`);
});

// ---- Percorso reale: bot con la configurazione della flotta OPS-FLEET-02 ----

test('bot → paperBroker: partialTp 50% + trailing sul residuo', async () => {
  notifier.notify = async () => true;
  // `_placeTpSl` legge szDecimals da qui per arrotondare la size dei gradini.
  marketData.getMarkets = () => [{ coin: 'SOL-PERP', szDecimals: 2 }];

  const master = '0xFLEETPARTIAL';
  const bot = new PerpsBot({
    id: 'fleet-partial', name: 'SOL Partial TP', coin: 'SOL-PERP', network: 'testnet',
    master_address: master,
    config_json: JSON.stringify({
      paper: true, leverage: 2,
      sizing: { mode: 'percent', value: 20 },
      tp: { enabled: true, mode: 'percent', value: 3 },
      sl: { enabled: true, mode: 'percent', value: 1.5 },
      // Config della flotta: metà posizione a +1.5%, trailing sul resto.
      partialTp: [{ portion: 0.5, atPercent: 1.5 }],
      trailing: { enabled: true, mode: 'percent', value: 1.5 },
      risk: { maxPositionUsd: 2000, maxDailyLossUsd: 500 }
    })
  }, () => {});

  MID = 200;
  await bot._openPosition('long', { price: MID, candles: [] }, { equity: 10000, positions: [] });
  assert.ok(bot.position, 'posizione aperta');
  const openedSize = bot.position.size;
  const entryPx = bot.position.entryPx;
  assert.equal(bot.position.tpOids.length, 1, 'un trigger per gradino della scala');

  const tpOrders = (await paperBroker.getFrontendOpenOrders(master))
    .filter(o => o.coin === 'SOL-PERP' && !/stop/i.test(o.orderType));
  assert.ok(Math.abs(tpOrders[0].sz - openedSize * 0.5) < 0.01,
    `il TP è piazzato su ${tpOrders[0].sz}, atteso il 50% di ${openedSize}`);

  // Il prezzo raggiunge il gradino: metà posizione esce.
  MID = entryPx * 1.016;
  const account = await paperBroker.getAccount(master, 'testnet');
  const livePos = account.positions.find(p => p.coin === 'SOL-PERP');
  assert.ok(livePos, 'dopo il TP parziale la posizione del bot è ancora viva');
  assert.ok(Math.abs(livePos.size - openedSize * 0.5) < 0.01,
    `size residua ${livePos.size}, attesa la metà di ${openedSize}`);

  // Tick del bot sul residuo: riallinea la size e sposta il trailing stop.
  await bot._reconcile(livePos, { price: MID, candles: [] });
  assert.ok(bot.position, 'il bot non registra una chiusura: la posizione esiste ancora');
  const slPrima = bot.position.slPx;
  await bot._manageOpen({ price: MID, candles: [] }, account, { action: 'hold' });

  assert.ok(bot.position.slPx > slPrima, 'il trailing ha alzato lo stop sul residuo');
  const stops = (await paperBroker.getFrontendOpenOrders(master))
    .filter(o => o.coin === 'SOL-PERP' && /stop/i.test(o.orderType));
  assert.equal(stops.length, 1, 'un solo SL vivo (place-then-cancel)');
  assert.ok(Math.abs(stops[0].sz - openedSize * 0.5) < 0.01,
    `lo SL del trailing copre ${stops[0].sz}, atteso il residuo ${openedSize * 0.5}`);

  // La posizione a DB è ancora aperta: nessun `_registerClose` spurio.
  assert.equal(db.getOpenPositionByBot('fleet-partial')?.id, bot.position.id);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
