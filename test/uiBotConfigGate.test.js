/**
 * #78 — CREAZIONE E MODIFICA DI UN BOT DALLA DASHBOARD PASSANO DAI CANCELLI DI MCP
 * ===============================================================================
 *
 * `POST /api/perps/bots` e `PATCH /api/perps/bots/:id` scrivevano la config
 * senza `validateConfigForWrite` e senza il backtest gate: dalla UI si poteva
 * salvare un DCA a 50 step, un tetto su un percorso morto, una strategia che il
 * backtest dà in perdita netta. Qui si verifica, sulle rotte REALI dell'app
 * Express, che:
 *
 *  1. una config che il cancello rifiuta → 400 con gli errori leggibili, e
 *     NIENTE scritto (né bot nuovo, né config modificata);
 *  2. il backtest gate in perdita → 409 `BACKTEST_GATE` col riassunto, niente
 *     scritto; con `confirmBacktestOverride: true` → scritto, riassunto salvato
 *     sul bot, riga di audit;
 *  3. senza dati (candele insufficienti, rete giù) si fa ciò che fa MCP: si
 *     scrive e l'incertezza resta nel riassunto (`inconclusive`);
 *  4. una PATCH che non porta `config` (nome, budget) passa com'era, senza
 *     backtest; una PATCH che non cambia le regole d'ingresso non riesegue il
 *     backtest e conserva il verdetto salvato.
 *
 * Seam di test, gli stessi dei file vicini: DB su file temporaneo prima di ogni
 * import (mai data/perps.db); handler presi dal router stack di Express con
 * req/res finti (test/advisorRoutes.test.js), nessun listen; candele mockate su
 * `client.getCandles` (test/mcpBacktestGate.test.js) — `runBacktest` gira
 * DAVVERO, sullo stesso motore dei bot live. Bot sempre fermi: nessun tick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-uigate-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { validateConfigForWrite: fromTools } = await import('../src/mcp/tools.js');
const { validateConfigForWrite: fromGate } = await import('../src/perps/configGate.js');

notifier.notify = async () => {};
botManager.bots.clear();

/* ------------------------------------------------------------------ */
/* Candele sintetiche (stesse serie di test/mcpBacktestGate.test.js)    */
/* ------------------------------------------------------------------ */

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function candlesFromMoves(moves, start = 100) {
  const out = [];
  let px = start;
  for (let i = 0; i < moves.length; i++) {
    const o = px;
    const c = px * (1 + moves[i]);
    out.push({ t: T0 + i * HOUR, o: String(o), h: String(Math.max(o, c)), l: String(Math.min(o, c)), c: String(c) });
    px = c;
  }
  return out;
}

/** Mercato che scende sempre: ogni trade long chiude in stop. */
const LOSING_CANDLES = candlesFromMoves(Array.from({ length: 220 }, () => -0.02));
/** 3 blocchi su 4 in salita: profit factor finito e > 1. */
const WINNING_CANDLES = candlesFromMoves(
  Array.from({ length: 220 }, (_, i) => (Math.floor(i / 8) % 4 === 3 ? -0.02 : 0.02))
);
/** Meno di 60 barre: `runBacktest` risponde con `error`. */
const TOO_FEW_CANDLES = candlesFromMoves(Array.from({ length: 20 }, () => 0.01));

let candleCalls = [];
let candleSource = () => LOSING_CANDLES;
client.getCandles = async (coin, interval, lookbackMs) => {
  candleCalls.push({ coin, interval, lookbackMs });
  return candleSource();
};

/* ------------------------------------------------------------------ */
/* Config e richieste                                                   */
/* ------------------------------------------------------------------ */

const ALWAYS_LONG = [{ type: 'price', op: '>', value: 0, signal: 'long' }];
const OTHER_LONG = [{ type: 'price', op: '>', value: 1, signal: 'long' }];
const MASTER = '0x1111111111111111111111111111111111111111';

/** Config come la costruisce il form avanzato (`_buildAdvancedConfig`). */
const formConfig = (over = {}) => ({
  direction: 'long',
  leverage: 2,
  sizing: { mode: 'fixed', value: 100 },
  candleInterval: '1h',
  logic: 'all',
  entryRules: ALWAYS_LONG,
  exitRules: [],
  tp: { enabled: true, mode: 'percent', value: 1 },
  sl: { enabled: true, mode: 'percent', value: 1 },
  trailing: { enabled: false, mode: 'percent', value: 1 },
  risk: { maxDailyLossUsd: 50, maxPositionUsd: 500 },
  paper: true,
  ...over
});

function handlerFor(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function call(method, routePath, { body, params = {} } = {}) {
  const captured = { statusCode: 200, body: null };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; }
  };
  await handlerFor(method, routePath)({ body, params, query: {} }, res);
  return captured;
}

const createBot = (body) => call('post', '/api/perps/bots', { body: { masterAddress: MASTER, coin: 'SOL-PERP', ...body } });
const patchBot = (id, body) => call('patch', '/api/perps/bots/:id', { body, params: { id } });
const botsNamed = (name) => db.listBots().filter(b => b.name === name);
const configOf = (id) => JSON.parse(db.getBot(id).config_json);
const overrideAudits = () => db.listAudit(500).filter(a => a.action === 'bots.backtest_override');

/** Crea un bot "buono" (backtest superato) da usare come base per le PATCH. */
async function seedBot(name) {
  candleSource = () => WINNING_CANDLES;
  const res = await createBot({ name, config: formConfig() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data.id;
}

/* ================================================================== */
/* 0. Un solo cancello                                                 */
/* ================================================================== */

test('validateConfigForWrite: tools.js ri-esporta la STESSA funzione di configGate.js', () => {
  assert.equal(fromTools, fromGate);
});

/* ================================================================== */
/* 1. POST /api/perps/bots                                             */
/* ================================================================== */

test('POST: config che il cancello rifiuta → 400 con gli errori, nessun bot e nessun backtest', async () => {
  for (const [label, config, pattern, guardrail] of [
    ['DCA oltre il massimo', formConfig({ dca: { steps: 50, stepPercent: 2, sizeMultiplier: 1 } }), /dca\.steps/, 'strategy_schema'],
    ['moltiplicatore DCA oltre 2', formConfig({ dca: { steps: 2, stepPercent: 2, sizeMultiplier: 3 } }), /sizeMultiplier/, 'strategy_schema'],
    ['regola che il motore ignora', formConfig({ entryRules: [{ signal: 'open_long' }] }), /regola d'ingresso 1/, 'strategy_schema'],
    ['tetto su un percorso morto', formConfig({ sizing: { mode: 'fixed', value: 100, maxPositionUsd: 900 } }), /sizing\.maxPositionUsd/, 'risk_config']
  ]) {
    candleCalls = [];
    const name = `Gate400 ${label}`;
    const res = await createBot({ name, config });

    assert.equal(res.statusCode, 400, label);
    assert.equal(res.body.success, false, label);
    assert.equal(res.body.guardrail, guardrail, label);
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0, `${label}: errors è una lista`);
    assert.ok(res.body.errors.some(e => pattern.test(e)), `${label}: ${JSON.stringify(res.body.errors)}`);
    assert.equal(botsNamed(name).length, 0, `${label}: nessun bot scritto`);
    assert.equal(candleCalls.length, 0, `${label}: il cancello gratuito viene prima del backtest`);
  }
});

test('POST: config non oggetto → 400, nessun bot', async () => {
  const res = await createBot({ name: 'Gate config stringa', config: 'leverage=50' });
  assert.equal(res.statusCode, 400);
  assert.equal(botsNamed('Gate config stringa').length, 0);
});

test('POST: config valida e backtest superato → bot creato, riassunto salvato', async () => {
  candleSource = () => WINNING_CANDLES;
  candleCalls = [];
  const res = await createBot({ name: 'Gate ok', config: formConfig() });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(candleCalls.length, 1);
  assert.equal(candleCalls[0].coin, 'SOL-PERP');
  assert.equal(candleCalls[0].interval, '1h');

  const cfg = configOf(res.body.data.id);
  assert.equal(cfg.backtestSummary.verdict, 'passed');
  assert.equal(cfg.backtestSummary.coin, 'SOL-PERP');
  assert.deepEqual(cfg.entryRules, ALWAYS_LONG, 'la strategia non viene toccata');
  assert.equal(overrideAudits().filter(a => JSON.parse(a.detail_json).botId === res.body.data.id).length, 0,
    'nessun override da tracciare quando il backtest passa');
});

test('POST: un backtestSummary mandato dal client non viene creduto', async () => {
  candleSource = () => LOSING_CANDLES;
  const forged = { verdict: 'passed', reason: 'fidati', profitFactor: 9 };
  const res = await createBot({ name: 'Gate forgiato', config: formConfig({ backtestSummary: forged }) });

  // Il verdetto vero (blocked) prevale: 409, e nessun bot col verdetto finto.
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.backtestSummary.verdict, 'blocked');
  assert.equal(botsNamed('Gate forgiato').length, 0);
});

test('POST: backtest in perdita → 409 BACKTEST_GATE col riassunto, nessun bot', async () => {
  candleSource = () => LOSING_CANDLES;
  for (const override of [undefined, false, 'true', 1]) {
    const name = `Gate409 ${String(override)}`;
    const body = { name, config: formConfig() };
    if (override !== undefined) body.confirmBacktestOverride = override;
    const res = await createBot(body);

    assert.equal(res.statusCode, 409, `override=${String(override)}: solo true esplicito forza il cancello`);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'BACKTEST_GATE');
    assert.match(res.body.error, /profit factor/i);
    const s = res.body.backtestSummary;
    assert.equal(s.verdict, 'blocked');
    assert.ok(s.trades >= 10);
    assert.ok(s.profitFactor < 1);
    assert.ok(s.totalPnl < 0);
    assert.equal(botsNamed(name).length, 0, 'nessuna scrittura');
  }
});

test('POST: backtest in perdita + confirmBacktestOverride → bot creato, riassunto salvato, audit', async () => {
  candleSource = () => LOSING_CANDLES;
  const res = await createBot({ name: 'Gate override', config: formConfig(), confirmBacktestOverride: true });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const id = res.body.data.id;
  const cfg = configOf(id);
  assert.equal(cfg.backtestSummary.verdict, 'blocked', 'il verdetto vero resta sul bot');
  assert.ok(cfg.backtestSummary.profitFactor < 1);

  const audit = overrideAudits().find(a => JSON.parse(a.detail_json).botId === id);
  assert.ok(audit, 'la forzatura del cancello è nell\'audit');
  assert.equal(audit.actor, 'human');
  const detail = JSON.parse(audit.detail_json);
  assert.equal(detail.operation, 'create');
  assert.equal(detail.coin, 'SOL-PERP');
  assert.equal(detail.backtestSummary.verdict, 'blocked');
  assert.equal(detail.backtestSummary.trades, cfg.backtestSummary.trades);
});

test('POST: senza dati il backtest non blocca (come MCP) e l\'incertezza resta scritta', async () => {
  for (const [label, source] of [
    ['candele insufficienti', () => TOO_FEW_CANDLES],
    ['rete giù', () => { throw new Error('ECONNRESET simulato'); }]
  ]) {
    candleSource = source;
    const name = `Gate nodata ${label}`;
    const res = await createBot({ name, config: formConfig() });

    assert.equal(res.statusCode, 200, `${label}: ${JSON.stringify(res.body)}`);
    const cfg = configOf(res.body.data.id);
    assert.equal(cfg.backtestSummary.verdict, 'inconclusive', label);
    assert.match(cfg.backtestSummary.reason, /NON verificato/, label);
  }
});

/* ================================================================== */
/* 2. PATCH /api/perps/bots/:id                                        */
/* ================================================================== */

test('PATCH senza config (nome, budget): passa com\'era, nessun backtest, config intatta', async () => {
  const id = await seedBot('Patch base 1');
  const before = db.getBot(id).config_json;
  candleCalls = [];

  const res = await patchBot(id, { name: 'Patch base 1 rinominato', max_allocation_usd: 250 });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const row = db.getBot(id);
  assert.equal(row.name, 'Patch base 1 rinominato');
  assert.equal(row.max_allocation_usd, 250);
  assert.equal(row.config_json, before);
  assert.equal(candleCalls.length, 0);
});

test('PATCH con config che il cancello rifiuta → 400, config in DB invariata', async () => {
  const id = await seedBot('Patch base 2');
  const before = db.getBot(id).config_json;
  candleCalls = [];

  const res = await patchBot(id, { name: 'Patch base 2', config: formConfig({ dca: { steps: 9, stepPercent: 2, sizeMultiplier: 1 } }) });

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.some(e => /dca\.steps/.test(e)), JSON.stringify(res.body.errors));
  assert.equal(db.getBot(id).config_json, before, 'nulla scritto');
  assert.equal(candleCalls.length, 0);
});

test('PATCH che non cambia le regole d\'ingresso: niente backtest, verdetto salvato conservato', async () => {
  const id = await seedBot('Patch base 3');
  const summaryBefore = configOf(id).backtestSummary;
  candleSource = () => LOSING_CANDLES; // se rieseguisse, bloccherebbe
  candleCalls = [];

  // Il form non conosce backtestSummary: la config arriva senza.
  const res = await patchBot(id, { name: 'Patch base 3', config: formConfig({ tp: { enabled: true, mode: 'percent', value: 2 } }) });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(candleCalls.length, 0);
  const cfg = configOf(id);
  assert.equal(cfg.tp.value, 2);
  assert.deepEqual(cfg.backtestSummary, summaryBefore);
});

test('PATCH che cambia le regole d\'ingresso, backtest in perdita → 409, nulla scritto; con override → scritto + audit', async () => {
  const id = await seedBot('Patch base 4');
  const before = db.getBot(id).config_json;
  candleSource = () => LOSING_CANDLES;

  const refused = await patchBot(id, { name: 'Patch base 4', config: formConfig({ entryRules: OTHER_LONG }) });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.code, 'BACKTEST_GATE');
  assert.equal(refused.body.backtestSummary.verdict, 'blocked');
  assert.equal(db.getBot(id).config_json, before, 'nulla scritto');

  const forced = await patchBot(id, { name: 'Patch base 4', config: formConfig({ entryRules: OTHER_LONG }), confirmBacktestOverride: true });
  assert.equal(forced.statusCode, 200, JSON.stringify(forced.body));
  const cfg = configOf(id);
  assert.deepEqual(cfg.entryRules, OTHER_LONG);
  assert.equal(cfg.backtestSummary.verdict, 'blocked');
  assert.equal(cfg.confirmBacktestOverride, undefined, 'il flag non finisce nella config');

  const audit = overrideAudits().find(a => JSON.parse(a.detail_json).botId === id);
  assert.ok(audit);
  assert.equal(audit.actor, 'human');
  assert.equal(JSON.parse(audit.detail_json).operation, 'update');
});

test('PATCH che cambia le regole d\'ingresso, backtest superato → scritto col riassunto nuovo', async () => {
  const id = await seedBot('Patch base 5');
  candleSource = () => WINNING_CANDLES;
  candleCalls = [];

  const res = await patchBot(id, { name: 'Patch base 5', config: formConfig({ entryRules: OTHER_LONG }) });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(candleCalls.length, 1);
  const cfg = configOf(id);
  assert.deepEqual(cfg.entryRules, OTHER_LONG);
  assert.equal(cfg.backtestSummary.verdict, 'passed');
});

test('PATCH su bot inesistente → 400', async () => {
  const res = await patchBot('non-esiste', { config: formConfig() });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /non trovato/i);
});
