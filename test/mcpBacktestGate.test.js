/**
 * BACKTEST GATE SUL PERCORSO MCP (register_bot / update_strategy_params)
 * ======================================================================
 *
 * Un bot creato o modificato da Hermes non passava MAI da un backtest: i
 * guardrail esistenti guardano leva, sizing e blacklist — cioè QUANTO si
 * rischia — ma nessuno guardava SE la strategia abbia mai avuto un edge. Una
 * entryRules qualunque arrivava in DB e da lì in produzione.
 *
 * Qui si verifica il cancello nuovo, su due livelli:
 *
 *  1. la decisione PURA (`evaluateBacktestGate`): soglia, casi limite e — cosa
 *     che conta quanto la soglia — i casi in cui NON si decide (pochi trade,
 *     dati insufficienti, numeri non finiti). Indovinare "buona o cattiva" su
 *     dieci trade è l'errore opposto a non guardare affatto.
 *  2. l'orchestrazione nei due tool MCP, con le candele mockate su
 *     `client.getCandles` (stesso seam usato da test/analystToolsReadonly.test.js):
 *     `runBacktest` gira DAVVERO, sullo stesso strategyEngine/riskManager dei
 *     bot live. Mockare `runBacktest` renderebbe i verdi di questo file
 *     dipendenti da una finta che nessuno esegue in produzione.
 *
 * Le serie di candele sono costruite perché l'esito di ogni trade sia
 * deterministico: con TP +1% / SL -1% una barra a +2% chiude in TP e una a -2%
 * chiude in SL, sempre.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db from '../src/db/database.js';
import botManager from '../src/perps/botManager.js';
import client from '../src/perps/hyperliquidClient.js';
import { handleRegisterBot, handleUpdateStrategyParams } from '../src/mcp/tools.js';
import { evaluateBacktestGate, GUARDRAILS_CONFIG } from '../src/mcp/guardrails.js';

// DB ISOLATO: redirezione PRIMA di qualunque ensure()/init(). Gli import sopra
// sono lazy sul file SQLite. Mai `data/perps.db`.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-btgate-'));
db.dbPath = path.join(tempDir, 'perps.db');

// Nessuna POST loopback vera verso la porta 3000: `register_bot` e
// `update_strategy_params` bussano a /internal/mcp/reload, e su una macchina con
// l'app accesa finirebbero sulla dashboard vera.
const originalHttpRequest = http.request;
http.request = function (options, ...rest) {
  const isInternal = options && typeof options === 'object' && String(options.path || '').startsWith('/internal/');
  if (!isInternal) return originalHttpRequest.call(this, options, ...rest);
  const cb = rest.find(a => typeof a === 'function');
  const req = {
    on: () => req,
    destroy: () => req,
    end: () => { if (cb) setImmediate(() => cb({ statusCode: 200, resume: () => {} })); return req; }
  };
  return req;
};

/* ------------------------------------------------------------------ */
/* Candele sintetiche                                                   */
/* ------------------------------------------------------------------ */

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

/**
 * Costruisce candele da una lista di variazioni percentuali (frazioni).
 * `o` = chiusura precedente, `h`/`l` = estremi della barra: una barra positiva
 * non tocca mai lo stop sotto l'ingresso, una negativa non tocca mai il TP.
 * Valori in stringa come li restituisce l'API Hyperliquid.
 */
function candlesFromMoves(moves, start = 100) {
  const out = [];
  let px = start;
  for (let i = 0; i < moves.length; i++) {
    const o = px;
    const c = px * (1 + moves[i]);
    out.push({
      t: T0 + i * HOUR,
      o: String(o), h: String(Math.max(o, c)), l: String(Math.min(o, c)), c: String(c)
    });
    px = c;
  }
  return out;
}

/** Mercato che scende sempre: ogni trade long chiude in stop. */
const LOSING_CANDLES = candlesFromMoves(Array.from({ length: 220 }, () => -0.02));

/**
 * Mercato a blocchi di 8 barre: 3 blocchi in salita e 1 in discesa. Serve un
 * profit factor FINITO e > 1 — una serie solo in salita darebbe Infinity, cioè
 * il ramo "nessuna perdita", che è un caso limite e non il caso normale.
 */
const WINNING_CANDLES = candlesFromMoves(
  Array.from({ length: 220 }, (_, i) => (Math.floor(i / 8) % 4 === 3 ? -0.02 : 0.02))
);

/** Meno di 60 barre: `runBacktest` risponde con `error`, non con statistiche. */
const TOO_FEW_CANDLES = candlesFromMoves(Array.from({ length: 20 }, () => 0.01));

/* ------------------------------------------------------------------ */
/* Seam sulle candele                                                   */
/* ------------------------------------------------------------------ */

let candleCalls = [];
/** Sorgente corrente: array di candele oppure funzione (per simulare un guasto). */
let candleSource = () => LOSING_CANDLES;

client.getCandles = async (coin, interval, lookbackMs) => {
  candleCalls.push({ coin, interval, lookbackMs });
  return candleSource();
};

const resetCandleCalls = () => { candleCalls = []; };

/* ------------------------------------------------------------------ */
/* Config di strategia                                                  */
/* ------------------------------------------------------------------ */

/** Regola d'ingresso sempre vera: l'esito dipende solo dalla serie di prezzi. */
const ALWAYS_LONG = [{ type: 'price', op: '>', value: 0, signal: 'long' }];
/** Regola d'ingresso mai vera: zero trade, quindi nessuna prova su cui decidere. */
const NEVER = [{ type: 'price', op: '<', value: 0, signal: 'long' }];

const strategyConfig = (entryRules) => ({
  leverage: 2,
  maxPositionUsd: 500,
  candleInterval: '1h',
  direction: 'both',
  entryRules,
  tp: { enabled: true, mode: 'percent', value: 1 },
  sl: { enabled: true, mode: 'percent', value: 1 }
});

const auditFor = (tool) => db.listAudit(200).find(a => a.action === tool);
const auditDetail = (row) => JSON.parse(row.detail_json || '{}');

/* ================================================================== */
/* 1. LA DECISIONE PURA                                                */
/* ================================================================== */

test('evaluateBacktestGate: blocca solo con edge negativo E abbastanza trade', () => {
  const stats = (over) => ({
    trades: 20, winRate: 0.3, profitFactor: 0.5, expectancy: -2.5,
    totalPnl: -50, maxDrawdownPct: 8, ...over
  });

  // Perdita netta su un campione non trascurabile: si blocca.
  const bad = evaluateBacktestGate({ stats: stats() });
  assert.equal(bad.blocked, true);
  assert.equal(bad.verdict, 'blocked');
  assert.match(bad.reason, /profit factor/i);
  // I numeri VERI nel messaggio: chi riceve il rifiuto deve poter capire perché.
  assert.match(bad.reason, /0\.5/);
  assert.match(bad.reason, /20/);
  assert.match(bad.reason, /30/);   // win rate in percentuale

  // Esattamente sulla soglia dei trade: si blocca (>= 10).
  assert.equal(evaluateBacktestGate({ stats: stats({ trades: 10 }) }).blocked, true);

  // Un trade sotto la soglia: NON si blocca, ma nemmeno si dichiara buona.
  const thin = evaluateBacktestGate({ stats: stats({ trades: 9 }) });
  assert.equal(thin.blocked, false);
  assert.equal(thin.verdict, 'inconclusive');
  assert.match(thin.reason, /9/);

  // Profit factor esattamente 1: non è una perdita, passa.
  assert.equal(evaluateBacktestGate({ stats: stats({ profitFactor: 1 }) }).verdict, 'passed');
  assert.equal(evaluateBacktestGate({ stats: stats({ profitFactor: 1.8 }) }).verdict, 'passed');

  // Nessuna perdita nel periodo: profitFactor === Infinity.
  const perfect = evaluateBacktestGate({ stats: stats({ profitFactor: Infinity }) });
  assert.equal(perfect.verdict, 'passed');
  assert.equal(perfect.summary.profitFactor, null, 'Infinity non sopravvive a JSON.stringify: si salva null…');
  assert.match(perfect.summary.reason, /∞|infinit/i, '…e il testo dice cos\'era davvero');

  // La soglia è quella dichiarata, non un numero scritto a mano qui.
  assert.equal(GUARDRAILS_CONFIG.BACKTEST_MIN_TRADES, 10);
  assert.equal(GUARDRAILS_CONFIG.BACKTEST_MIN_PROFIT_FACTOR, 1);
});

test('evaluateBacktestGate: senza prove non si decide, ma si dice', () => {
  for (const [label, result] of [
    ['risultato assente', null],
    ['errore del backtest', { error: 'Dati storici insufficienti per il backtest', candles: 12 }],
    ['statistiche assenti', {}],
    ['zero trade', { stats: { trades: 0, winRate: 0, profitFactor: 0, expectancy: 0 } }],
    // Un NaN attraversa ogni confronto: `NaN < 1` è falso, quindi senza un ramo
    // dedicato una strategia non misurabile passerebbe come "buona".
    ['profit factor NaN', { stats: { trades: 40, winRate: 0.5, profitFactor: NaN, expectancy: 0 } }]
  ]) {
    const gate = evaluateBacktestGate(result);
    assert.equal(gate.blocked, false, `${label}: l'incertezza non blocca`);
    assert.equal(gate.verdict, 'inconclusive', label);
    assert.ok(gate.reason && gate.reason.length > 10, `${label}: il motivo va scritto, non sottinteso`);
    assert.equal(gate.summary.verdict, 'inconclusive', label);
  }
});

test('evaluateBacktestGate: il riassunto è serializzabile e conserva i numeri', () => {
  const gate = evaluateBacktestGate({
    stats: { trades: 33, winRate: 0.4242, profitFactor: 0.77, expectancy: -1.234, totalPnl: -40.7, maxDrawdownPct: 12.5 },
    period: { from: T0, to: T0 + 100 * HOUR, candles: 220, interval: '1h', days: 30 }
  });
  const roundTrip = JSON.parse(JSON.stringify(gate.summary));
  assert.equal(roundTrip.trades, 33);
  assert.equal(roundTrip.profitFactor, 0.77);
  assert.equal(roundTrip.verdict, 'blocked');
  assert.ok(roundTrip.winRate > 0.42 && roundTrip.winRate < 0.43);
  assert.ok(typeof roundTrip.checkedAt === 'number' && roundTrip.checkedAt > 0);
});

/* ================================================================== */
/* 2. register_bot                                                     */
/* ================================================================== */

test('register_bot: cancello di backtest', async (t) => {
  db.ensure();
  botManager.loadFromDb();

  await t.test('edge storico negativo: nessun bot creato, e il rifiuto porta i numeri', async () => {
    candleSource = () => LOSING_CANDLES;
    resetCandleCalls();
    const name = 'Backtest Gate Losing ' + Date.now();

    const res = await handleRegisterBot({
      name, coin: 'SOL', config: strategyConfig(ALWAYS_LONG)
    });

    assert.equal(res.success, false);
    assert.match(res.message, /GUARDRAIL_VIOLATION/i);
    assert.match(res.message, /backtest/i);
    assert.match(res.message, /profit factor/i);
    assert.match(res.message, /trade/i);
    assert.match(res.message, /win rate/i);
    assert.ok(res.error, 'il campo error serve a Hermes per distinguere un rifiuto da un guasto');

    // Il backtest è stato eseguito sulla coin normalizzata e sull'intervallo della config.
    assert.equal(candleCalls.length, 1);
    assert.equal(candleCalls[0].coin, 'SOL-PERP');
    assert.equal(candleCalls[0].interval, '1h');
    assert.equal(candleCalls[0].lookbackMs, 30 * 24 * HOUR);

    // Nessun bot in DB: il rifiuto è fail-fast, non un rollback.
    assert.equal(db.listBots().filter(b => b.name === name).length, 0);

    const detail = auditDetail(auditFor('register_bot'));
    assert.equal(detail.success, false);
    assert.equal(detail.guardrail, 'backtest');
    assert.equal(detail.backtest.verdict, 'blocked');
    assert.equal(detail.backtest.trades >= 10, true);
    assert.ok(detail.backtest.profitFactor < 1);
  });

  await t.test('edge storico positivo: bot creato, riassunto allegato e recuperabile', async () => {
    candleSource = () => WINNING_CANDLES;
    resetCandleCalls();
    const name = 'Backtest Gate Winning ' + Date.now();

    const res = await handleRegisterBot({
      name, coin: 'ETH', config: strategyConfig(ALWAYS_LONG)
    });

    assert.equal(res.success, true, res.message);
    assert.equal(candleCalls.length, 1);

    // Il dato è SUL BOT, non solo nel log: domani la UI deve poterlo mostrare
    // senza rifare il backtest.
    const row = db.getBot(res.data.bot_id);
    const persisted = JSON.parse(row.config_json).backtestSummary;
    assert.ok(persisted, 'il riassunto del backtest deve essere persistito nella config');
    assert.equal(persisted.verdict, 'passed');
    assert.ok(persisted.trades >= 10);
    assert.ok(persisted.profitFactor > 1);
    assert.equal(persisted.coin, 'ETH-PERP');
    assert.equal(persisted.interval, '1h');
    assert.equal(persisted.lookbackDays, 30);

    // La strategia NON è stata toccata dal cancello.
    assert.deepEqual(JSON.parse(row.config_json).entryRules, ALWAYS_LONG);

    const detail = auditDetail(auditFor('register_bot'));
    assert.equal(detail.success, true);
    assert.equal(detail.backtest.verdict, 'passed');

    botManager.deleteBot(res.data.bot_id);
  });

  await t.test('pochi trade o dati insufficienti: il bot si crea, l\'incertezza resta scritta', async () => {
    for (const [label, source, coin] of [
      ['zero trade', () => WINNING_CANDLES, 'AVAX'],
      ['candele insufficienti', () => TOO_FEW_CANDLES, 'ARB']
    ]) {
      candleSource = source;
      resetCandleCalls();
      const entryRules = label === 'zero trade' ? NEVER : ALWAYS_LONG;
      const res = await handleRegisterBot({
        name: `Backtest Gate ${label} ${Date.now()}`, coin, config: strategyConfig(entryRules)
      });

      assert.equal(res.success, true, `${label}: ${res.message}`);
      const persisted = JSON.parse(db.getBot(res.data.bot_id).config_json).backtestSummary;
      assert.equal(persisted.verdict, 'inconclusive', label);
      assert.ok(persisted.reason && persisted.reason.length > 10, `${label}: il motivo va scritto`);

      const detail = auditDetail(auditFor('register_bot'));
      assert.equal(detail.backtest.verdict, 'inconclusive', label);

      botManager.deleteBot(res.data.bot_id);
    }
  });

  await t.test('config senza entryRules: nessuna candela scaricata, ma il verdetto è scritto', async () => {
    // Una strategia senza regole d'ingresso non può produrre UN SOLO trade:
    // l'esito del backtest è noto prima di eseguirlo. Scaricare 30 giorni di
    // candele per confermarlo sarebbe una chiamata di rete a vuoto su OGNI
    // `register_bot` — compresi quelli delle altre suite, che non mockano
    // `getCandles` e finirebbero sull'endpoint Hyperliquid vero.
    candleSource = () => { throw new Error('non deve essere chiamato'); };
    resetCandleCalls();

    const res = await handleRegisterBot({
      name: 'Backtest Gate NoRules ' + Date.now(), coin: 'DOGE', config: strategyConfig(undefined)
    });

    assert.equal(res.success, true, res.message);
    assert.equal(candleCalls.length, 0, 'senza regole d\'ingresso non si scarica niente');

    // Il silenzio non è un verdetto: l'incertezza resta scritta come in ogni
    // altro caso non concludente.
    const persisted = JSON.parse(db.getBot(res.data.bot_id).config_json).backtestSummary;
    assert.equal(persisted.verdict, 'inconclusive');
    assert.match(persisted.reason, /entryRules|regola di ingresso/i);

    botManager.deleteBot(res.data.bot_id);
    candleSource = () => LOSING_CANDLES;
  });

  await t.test('backtest in errore: un guardrail guasto non blocca la creazione', async () => {
    candleSource = () => { throw new Error('rete ko simulata'); };
    resetCandleCalls();

    const res = await handleRegisterBot({
      name: 'Backtest Gate Boom ' + Date.now(), coin: 'OP', config: strategyConfig(ALWAYS_LONG)
    });

    assert.equal(res.success, true, res.message);
    const persisted = JSON.parse(db.getBot(res.data.bot_id).config_json).backtestSummary;
    assert.equal(persisted.verdict, 'inconclusive');
    assert.match(persisted.reason, /rete ko simulata/, 'l\'errore vero, non un generico "non disponibile"');

    const detail = auditDetail(auditFor('register_bot'));
    assert.equal(detail.backtest.verdict, 'inconclusive');
    assert.match(detail.backtest.reason, /rete ko simulata/);

    botManager.deleteBot(res.data.bot_id);
    candleSource = () => LOSING_CANDLES;
  });
});

/* ================================================================== */
/* 3. update_strategy_params                                           */
/* ================================================================== */

test('update_strategy_params: il cancello scatta solo quando cambia la strategia', async (t) => {
  db.ensure();

  const makeBot = (suffix) => {
    const id = `test-btgate-${suffix}-${Date.now()}`;
    db.insertBot({
      id,
      name: `Backtest Gate Update ${suffix}`,
      coin: 'SOL-PERP',
      network: 'testnet',
      masterAddress: '0x000000000000000000000000000000000000dEaD',
      config: strategyConfig(ALWAYS_LONG),
      status: 'stopped',
      linked_agent_id: 'hermes_agent_01',
      actor_label: 'Hermes',
      actor_id: 'hermes_agent_01',
      is_managed_by_agent: 1
    });
    botManager.loadFromDb();
    return id;
  };

  await t.test('una modifica che non tocca entryRules non esegue nessun backtest', async () => {
    const botId = makeBot('lev');
    candleSource = () => LOSING_CANDLES; // se girasse, bloccherebbe: il verde dipende dal non girare
    resetCandleCalls();

    const prompt = await handleUpdateStrategyParams({ bot_id: botId, params: { leverage: 3 } });
    assert.equal(prompt.status, 'confirmation_required');

    const res = await handleUpdateStrategyParams({
      bot_id: botId, params: { leverage: 3 }, confirmation_token: prompt.confirmation_token
    });
    assert.equal(res.success, true, res.message);
    assert.equal(res.data.current_config.leverage, 3);
    assert.equal(candleCalls.length, 0, 'cambiare la leva non cambia la strategia: nessun backtest');
    assert.equal(JSON.parse(db.getBot(botId).config_json).backtestSummary, undefined);

    botManager.deleteBot(botId);
  });

  await t.test('nuove entryRules con edge negativo: modifica rifiutata, config intatta', async () => {
    const botId = makeBot('bad');
    candleSource = () => LOSING_CANDLES;
    resetCandleCalls();

    const nuoveRegole = [{ type: 'price', op: '>', value: 1, signal: 'long' }];
    const prompt = await handleUpdateStrategyParams({ bot_id: botId, params: { entryRules: nuoveRegole } });
    assert.equal(prompt.status, 'confirmation_required');

    const res = await handleUpdateStrategyParams({
      bot_id: botId, params: { entryRules: nuoveRegole }, confirmation_token: prompt.confirmation_token
    });
    assert.equal(res.success, false);
    assert.match(res.message, /GUARDRAIL_VIOLATION/i);
    assert.match(res.message, /profit factor/i);
    assert.match(res.message, /win rate/i);
    assert.ok(candleCalls.length >= 1, 'il backtest deve essere stato eseguito');

    // La config in DB è ancora quella di prima: niente scrittura parziale.
    assert.deepEqual(JSON.parse(db.getBot(botId).config_json).entryRules, ALWAYS_LONG);

    const detail = auditDetail(auditFor('update_strategy_params'));
    assert.equal(detail.success, false);
    assert.equal(detail.guardrail, 'backtest');
    assert.equal(detail.backtest.verdict, 'blocked');

    botManager.deleteBot(botId);
  });

  await t.test('nuove entryRules con edge positivo: applicate, con il riassunto allegato', async () => {
    const botId = makeBot('good');
    candleSource = () => WINNING_CANDLES;
    resetCandleCalls();

    const nuoveRegole = [{ type: 'price', op: '>', value: 2, signal: 'long' }];
    const prompt = await handleUpdateStrategyParams({ bot_id: botId, params: { entryRules: nuoveRegole } });
    const res = await handleUpdateStrategyParams({
      bot_id: botId, params: { entryRules: nuoveRegole }, confirmation_token: prompt.confirmation_token
    });

    assert.equal(res.success, true, res.message);
    const persisted = JSON.parse(db.getBot(botId).config_json);
    assert.deepEqual(persisted.entryRules, nuoveRegole);
    assert.equal(persisted.backtestSummary.verdict, 'passed');
    assert.equal(persisted.backtestSummary.coin, 'SOL-PERP');

    const detail = auditDetail(auditFor('update_strategy_params'));
    assert.equal(detail.backtest.verdict, 'passed');

    botManager.deleteBot(botId);
  });

  await t.test('backtest in errore su una modifica di strategia: passa, segnalato', async () => {
    const botId = makeBot('boom');
    candleSource = () => { throw new Error('rete ko simulata'); };
    resetCandleCalls();

    const nuoveRegole = [{ type: 'price', op: '>', value: 3, signal: 'long' }];
    const prompt = await handleUpdateStrategyParams({ bot_id: botId, params: { entryRules: nuoveRegole } });
    const res = await handleUpdateStrategyParams({
      bot_id: botId, params: { entryRules: nuoveRegole }, confirmation_token: prompt.confirmation_token
    });

    assert.equal(res.success, true, res.message);
    const persisted = JSON.parse(db.getBot(botId).config_json);
    assert.deepEqual(persisted.entryRules, nuoveRegole);
    assert.equal(persisted.backtestSummary.verdict, 'inconclusive');
    assert.match(persisted.backtestSummary.reason, /rete ko simulata/);

    botManager.deleteBot(botId);
    candleSource = () => LOSING_CANDLES;
  });
});

test.after(async () => {
  http.request = originalHttpRequest;
  await client.closeAllSdks();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
