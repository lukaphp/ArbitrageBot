/**
 * CANCELLO DI SCRITTURA SULLA CONFIG INTERA — register_bot / update_strategy_params (#46)
 * ======================================================================================
 *
 * `validateStrategyConfig` esisteva già e sapeva riconoscere una regola
 * inservibile, ma era cablata SOLO sull'import di un file di strategia: i due
 * strumenti MCP che scrivono `bots.config_json` validavano leva, `maxPositionUsd`
 * e sizing dinamico come scalari isolati e non guardavano MAI la config nel suo
 * insieme. Da quel buco sono passati due incidenti veri, entrambi muti:
 *
 *  - BUG-RULESHAPE-01 (2026-09-22): `entryRules` scritte da un agente con
 *    `signal: 'open_long'` invece di `'long'` e senza `type` — `strategyEngine`
 *    ignora la regola, quindi 46 ore di flotta accesa e puntuale senza un solo
 *    segnale. La config, a guardarla, sembrava una strategia funzionante.
 *  - BUG-SIZECAP-01 (2026-09-23): `sizing.maxPositionUsd` / `strategyParams.leverage`,
 *    percorsi che nessun controllo di rischio legge — leva dichiarata 5x e
 *    applicata 2x per mesi sui bot BTC/SOL, corretta a mano il 26/09/2026.
 *
 * Qui si verifica che ORA vengano RIFIUTATI prima di toccare il DB, su due
 * livelli:
 *
 *  1. la decisione PURA (`validateConfigForWrite`), che compone le due funzioni
 *     esistenti — `validateStrategyConfig` per la FORMA e
 *     `riskManager.auditRiskConfig` per il PERCORSO — comprese le due scelte di
 *     progetto: nessuna regola d'ingresso NON blocca (è inservibile ma visibile),
 *     ogni avviso di `auditRiskConfig` blocca (anche `maxPositionUsd` dichiarato
 *     due volte, che in LETTURA ha un fallback sicuro);
 *  2. i due strumenti MCP veri, su DB temporaneo, con le candele mockate sullo
 *     stesso seam degli altri test (`client.getCandles`). Il cancello sta PRIMA
 *     del backtest gate e PRIMA della conferma a due stadi: entrambe le cose si
 *     verificano contando le candele scaricate (zero) e guardando che la risposta
 *     non sia `confirmation_required`.
 *
 * Le config di BUG-SIZECAP-01 sono quelle VERE dei bot BTC/SOL in produzione
 * (le stesse fixture di test/sizingCapFleet.test.js), non una loro imitazione.
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
import {
  handleRegisterBot,
  handleUpdateStrategyParams,
  validateConfigForWrite
} from '../src/mcp/tools.js';

// DB ISOLATO: redirezione PRIMA di qualunque ensure()/init(). Mai `data/perps.db`.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-cfggate-'));
db.dbPath = path.join(tempDir, 'perps.db');

// Nessuna POST loopback vera verso la porta 3000: i due tool bussano a
// /internal/mcp/reload e su una macchina con l'app accesa finirebbero sulla
// dashboard vera.
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
/* Candele sintetiche (solo per i casi POSITIVI: il backtest gate gira) */
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

/** 3 blocchi in salita e 1 in discesa: profit factor finito e > 1. */
const WINNING_CANDLES = candlesFromMoves(
  Array.from({ length: 220 }, (_, i) => (Math.floor(i / 8) % 4 === 3 ? -0.02 : 0.02))
);

let candleCalls = 0;
let candleSource = () => WINNING_CANDLES;
client.getCandles = async () => { candleCalls++; return candleSource(); };

/** Sorgente che ESPLODE se interrogata: è così che si verifica "nessuna candela". */
const NO_CANDLES_EXPECTED = () => { throw new Error('il backtest non deve nemmeno partire'); };

/* ------------------------------------------------------------------ */
/* Config: quella canonica e le due malformate degli incidenti         */
/* ------------------------------------------------------------------ */

/** Regola canonica, sempre vera: l'esito del backtest dipende solo dai prezzi. */
const REGOLA_CANONICA = [{ type: 'price', op: '>', value: 0, signal: 'long' }];

const CONFIG_CANONICA = () => ({
  leverage: 2,
  maxPositionUsd: 500,
  candleInterval: '1h',
  entryRules: REGOLA_CANONICA,
  sizing: { mode: 'percent', value: 10 },
  tp: { enabled: true, mode: 'percent', value: 3 },
  sl: { enabled: true, mode: 'percent', value: 1.5 }
});

/**
 * BUG-RULESHAPE-01, le due forme vere: `signal: 'open_long'` (che
 * `strategyEngine` non riconosce come direzione) e `type` assente (che lo fa
 * cadere nel ramo che ignora la regola). Entrambe scritte da un agente.
 */
const REGOLE_RULESHAPE = [
  { indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'open_long', type: 'indicator' },
  { indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'open_short' }
];
const CONFIG_RULESHAPE = () => ({ ...CONFIG_CANONICA(), entryRules: REGOLE_RULESHAPE });

/**
 * BUG-SIZECAP-01: la config REALE del bot BTC in produzione, così come
 * `update_strategy_params` l'aveva scritta — `sizing: { maxPositionUsd: 1000 }` e
 * `strategyParams: { leverage: 5 }` accanto a `leverage: 2` e `maxPositionUsd: 500`.
 * Stessa fixture di test/sizingCapFleet.test.js.
 */
const CONFIG_BTC_REALE = () => JSON.parse('{"useJevValidation":true,"risk":{"maxDailyLossUsd":200,"atrPeriod":10,"useDynamicSizing":true},"leverage":2,"sl":{"mode":"percent","enabled":true,"value":1.5},"tp":{"enabled":true,"mode":"percent","value":3},"maxPositionUsd":500,"strategy":"rsi_reversal","candleInterval":"1m","entryRules":[{"indicator":"rsi","period":14,"op":"<","value":30,"signal":"long","type":"indicator"},{"indicator":"rsi","period":14,"op":">","value":70,"signal":"short","type":"indicator"}],"logic":"any","sizing":{"maxPositionUsd":1000},"strategyParams":{"leverage":5,"takeProfitPct":0.04}}');

const auditFor = (tool) => db.listAudit(200).find(a => a.action === tool);
const auditDetail = (row) => JSON.parse(row.detail_json || '{}');

/* ================================================================== */
/* 1. LA DECISIONE PURA                                               */
/* ================================================================== */

test('validateConfigForWrite: BUG-RULESHAPE-01 — una regola che il motore ignorerebbe è un rifiuto', () => {
  const esito = validateConfigForWrite(CONFIG_RULESHAPE());
  assert.equal(esito.ok, false);
  assert.equal(esito.guardrail, 'strategy_schema');
  assert.match(esito.error, /GUARDRAIL_VIOLATION/);
  // Il messaggio dice QUALE regola e PERCHÉ: senza, chi riceve il rifiuto
  // (un agente, o chi legge l'audit fra un mese) non sa cosa correggere.
  assert.match(esito.error, /regola d'ingresso 2/);
  assert.match(esito.error, /undefined/, 'il `type` assente va nominato per quello che è');
  assert.ok(esito.issues.length >= 1);

  // `signal: 'open_long'` con `type: 'indicator'` corretto NON è riconoscibile
  // dallo schema (il campo `signal` di una regola indicator non è un enum che
  // validateStrategyConfig conosca): quello che lo schema vede è la regola 2.
  // Verifica onesta di dove si ferma questo cancello, invece di dichiarare una
  // copertura che non c'è.
  const soloOpenLong = { ...CONFIG_CANONICA(), entryRules: [REGOLE_RULESHAPE[0]] };
  assert.equal(validateConfigForWrite(soloOpenLong).ok, true,
    'lo schema non giudica il valore di `signal`: questo caso resta coperto solo da normalizeStrategyConfig a valle');
});

test('validateConfigForWrite: BUG-SIZECAP-01 — un parametro di rischio su un percorso morto è un rifiuto', () => {
  const esito = validateConfigForWrite(CONFIG_BTC_REALE());
  assert.equal(esito.ok, false);
  assert.match(esito.error, /GUARDRAIL_VIOLATION/);
  // La config BTC vera sbaglia su DUE fronti: `sizing` senza `mode`/`value`
  // (forma) e i due percorsi morti (rischio). Lo schema parla per primo.
  assert.equal(esito.guardrail, 'strategy_schema');
  assert.match(esito.error, /sizing\.value/);

  // Togliendo l'errore di forma resta quello che conta per i soldi: il tetto e
  // la leva dichiarati dove nessuno li legge.
  const soloPercorsiMorti = CONFIG_BTC_REALE();
  soloPercorsiMorti.sizing = { mode: 'percent', value: 10, maxPositionUsd: 1000 };
  const secondo = validateConfigForWrite(soloPercorsiMorti);
  assert.equal(secondo.ok, false);
  assert.equal(secondo.guardrail, 'risk_config');
  assert.match(secondo.error, /sizing\.maxPositionUsd/);
  assert.match(secondo.error, /strategyParams\.leverage/);
  assert.match(secondo.error, /campi canonici/, 'il rifiuto deve dire dove va scritto il valore');
  assert.equal(secondo.issues.length, 2);

  // Un percorso morto alla volta: nessuno dei due dipende dall'altro.
  const soloTetto = { ...CONFIG_CANONICA(), sizing: { mode: 'percent', value: 10, maxPositionUsd: 1000 } };
  assert.equal(validateConfigForWrite(soloTetto).ok, false);
  const soloLeva = { ...CONFIG_CANONICA(), strategyParams: { leverage: 5 } };
  assert.equal(validateConfigForWrite(soloLeva).ok, false);
});

test('validateConfigForWrite: maxPositionUsd dichiarato due volte con valori diversi è un rifiuto', () => {
  // In LETTURA c'è un fallback sicuro e documentato (si applica il più
  // restrittivo, `resolveMaxPositionUsd`). Quella è una disciplina per
  // interpretare config che esistono già: in una scrittura nuova il chiamante è
  // presente e può dire quale dei due numeri intendeva.
  const ambigua = { ...CONFIG_CANONICA(), maxPositionUsd: 500, risk: { maxPositionUsd: 1000 } };
  const esito = validateConfigForWrite(ambigua);
  assert.equal(esito.ok, false);
  assert.equal(esito.guardrail, 'risk_config');
  assert.match(esito.error, /due volte/);
  assert.match(esito.error, /500/);
  assert.match(esito.error, /1000/);

  // Lo STESSO valore nei due posti non è ambiguo: non c'è niente da chiedere.
  const coerente = { ...CONFIG_CANONICA(), maxPositionUsd: 500, risk: { maxPositionUsd: 500 } };
  assert.equal(validateConfigForWrite(coerente).ok, true);

  // Un valore inservibile non vale come "nessun tetto": il cap dichiarato
  // spariva restando solo quello globale.
  const inservibile = { ...CONFIG_CANONICA(), risk: { maxPositionUsd: 0 } };
  const rifiuto = validateConfigForWrite(inservibile);
  assert.equal(rifiuto.ok, false);
  assert.equal(rifiuto.guardrail, 'risk_config');
});

test('validateConfigForWrite: la config canonica passa, e le due tolleranze volute restano', () => {
  assert.deepEqual(validateConfigForWrite(CONFIG_CANONICA()), { ok: true });

  // (b) Nessuna regola d'ingresso NON blocca: è l'unico caso inservibile ma
  // VISIBILE (il bot non apre mai, la UI non mostra regole, il backtest gate
  // scrive `inconclusive` con il motivo). Ma tutto il resto viene validato lo
  // stesso, altrimenti basterebbe omettere le regole per saltare il cancello.
  const senzaRegole = CONFIG_CANONICA();
  delete senzaRegole.entryRules;
  assert.equal(validateConfigForWrite(senzaRegole).ok, true);
  assert.equal(validateConfigForWrite({ ...senzaRegole, entryRules: [] }).ok, true);
  assert.equal(
    validateConfigForWrite({ ...senzaRegole, strategyParams: { leverage: 5 } }).ok, false,
    'senza regole si valida comunque il resto'
  );
  assert.equal(
    validateConfigForWrite({ ...senzaRegole, candleInterval: '7m' }).ok, false,
    'senza regole si valida comunque il resto'
  );

  // Un blocco AZZERATO (`risk: null`) è il modo documentato di cancellarlo e per
  // il motore è indistinguibile dall'assenza: non è un errore di scrittura.
  assert.equal(validateConfigForWrite({ ...CONFIG_CANONICA(), risk: null }).ok, true);

  // La funzione non muta la config del chiamante (ci opera sopra `mergeStrategyConfig`
  // e poi ci scrive il DB: una mutazione qui sarebbe invisibile e persistente).
  const originale = CONFIG_CANONICA();
  const copia = JSON.parse(JSON.stringify(originale));
  validateConfigForWrite(originale);
  assert.deepEqual(originale, copia);

  // Ingressi degeneri: non lancia e non approva per sbaglio.
  assert.equal(validateConfigForWrite(null).ok, true, 'config vuota = bot senza strategia, caso (b)');
  assert.equal(validateConfigForWrite({ leverage: 999 }).ok, false);
});

/* ================================================================== */
/* 2. register_bot                                                    */
/* ================================================================== */

test('register_bot: la config intera passa dal cancello prima di arrivare in DB', async (t) => {
  db.ensure();
  botManager.loadFromDb();

  await t.test('BUG-RULESHAPE-01: nessun bot creato, nessuna candela scaricata', async () => {
    candleSource = NO_CANDLES_EXPECTED;
    candleCalls = 0;
    const name = 'CfgGate RuleShape ' + Date.now();

    const res = await handleRegisterBot({ name, coin: 'SOL', config: CONFIG_RULESHAPE() });

    assert.equal(res.success, false);
    assert.match(res.message, /GUARDRAIL_VIOLATION/i);
    assert.match(res.message, /regola d'ingresso 2/);
    assert.ok(res.error, 'il campo error serve a Hermes per distinguere un rifiuto da un guasto');

    // Niente in DB: il rifiuto è fail-fast, non un rollback.
    assert.equal(db.listBots().filter(b => b.name === name).length, 0);
    // E il cancello viene prima del backtest: 30 giorni di candele per una
    // config che verrà rifiutata comunque sono una chiamata di rete buttata.
    assert.equal(candleCalls, 0);

    const detail = auditDetail(auditFor('register_bot'));
    assert.equal(detail.success, false);
    assert.equal(detail.guardrail, 'strategy_schema');
    assert.ok(Array.isArray(detail.issues) && detail.issues.length >= 1,
      'i problemi trovati restano scritti nell\'audit, non solo nella risposta');
  });

  await t.test('BUG-SIZECAP-01: la config REALE dei bot BTC/SOL viene rifiutata', async () => {
    candleSource = NO_CANDLES_EXPECTED;
    candleCalls = 0;
    const name = 'CfgGate SizeCap ' + Date.now();

    const res = await handleRegisterBot({ name, coin: 'BTC', config: CONFIG_BTC_REALE() });
    assert.equal(res.success, false);
    assert.match(res.message, /GUARDRAIL_VIOLATION/i);
    assert.equal(db.listBots().filter(b => b.name === name).length, 0);
    assert.equal(candleCalls, 0);

    // Con la forma di `sizing` corretta il rifiuto resta, e parla dei percorsi
    // morti: è il pezzo che nel 2026-09 ha fatto operare i bot a leva 2 con
    // leva 5 dichiarata.
    const risanata = CONFIG_BTC_REALE();
    risanata.sizing = { mode: 'percent', value: 10, maxPositionUsd: 1000 };
    const res2 = await handleRegisterBot({ name: name + ' bis', coin: 'BTC', config: risanata });
    assert.equal(res2.success, false);
    assert.match(res2.message, /sizing\.maxPositionUsd/);
    assert.match(res2.message, /strategyParams\.leverage/);
    assert.equal(db.listBots().filter(b => b.name === name + ' bis').length, 0);

    const detail = auditDetail(auditFor('register_bot'));
    assert.equal(detail.guardrail, 'risk_config');
  });

  await t.test('config canonica: creata, con backtest gate e config intatti', async () => {
    candleSource = () => WINNING_CANDLES;
    candleCalls = 0;
    const name = 'CfgGate Canonica ' + Date.now();

    const res = await handleRegisterBot({ name, coin: 'ETH', config: CONFIG_CANONICA() });
    assert.equal(res.success, true, res.message);

    // La struttura esistente continua a funzionare: il backtest è stato eseguito
    // e il suo riassunto è allegato alla config persistita.
    assert.equal(candleCalls, 1);
    const persisted = JSON.parse(db.getBot(res.data.bot_id).config_json);
    assert.equal(persisted.backtestSummary.verdict, 'passed');
    assert.deepEqual(persisted.entryRules, REGOLA_CANONICA, 'il cancello non riscrive la strategia');
    assert.equal(persisted.leverage, 2);
    assert.equal(persisted.maxPositionUsd, 500);

    botManager.deleteBot(res.data.bot_id);
  });
});

/* ================================================================== */
/* 3. update_strategy_params                                          */
/* ================================================================== */

test('update_strategy_params: la config CANDIDATA fusa passa dal cancello, sempre', async (t) => {
  db.ensure();

  const makeBot = (suffix) => {
    const id = `test-cfggate-${suffix}-${Date.now()}`;
    db.insertBot({
      id,
      name: `CfgGate Update ${suffix}`,
      coin: 'SOL-PERP',
      network: 'testnet',
      masterAddress: '0x000000000000000000000000000000000000dEaD',
      config: CONFIG_CANONICA(),
      status: 'stopped',
      linked_agent_id: 'hermes_agent_01',
      actor_label: 'Hermes',
      actor_id: 'hermes_agent_01',
      is_managed_by_agent: 1
    });
    botManager.loadFromDb();
    return id;
  };

  await t.test('BUG-SIZECAP-01: la patch che crea il percorso morto è rifiutata PRIMA della conferma', async () => {
    const botId = makeBot('sizecap');
    candleSource = NO_CANDLES_EXPECTED;
    candleCalls = 0;

    // È la patch esatta del commit 39fec01: presa da sola sembra innocua —
    // nessuno dei cancelli scalari ha qualcosa da dire su `sizing` — ed è la
    // CONFIG RISULTANTE a dichiarare un tetto che nessun controllo leggerà.
    const params = { sizing: { maxPositionUsd: 1000 } };
    const res = await handleUpdateStrategyParams({ bot_id: botId, params });

    assert.equal(res.success, false);
    assert.notEqual(res.status, 'confirmation_required',
      'non si fa confermare all\'operatore una patch che verrà rifiutata comunque');
    assert.match(res.message, /GUARDRAIL_VIOLATION/i);
    assert.match(res.message, /sizing\.maxPositionUsd/);
    assert.match(res.message, /campi canonici/);

    // La config in DB è ancora quella di prima, intatta.
    const persisted = JSON.parse(db.getBot(botId).config_json);
    assert.deepEqual(persisted.sizing, { mode: 'percent', value: 10 });
    assert.equal(candleCalls, 0);

    const detail = auditDetail(auditFor('update_strategy_params'));
    assert.equal(detail.success, false);
    assert.equal(detail.guardrail, 'risk_config');

    botManager.deleteBot(botId);
  });

  await t.test('BUG-SIZECAP-01: anche strategyParams.leverage, e anche col token in mano', async () => {
    const botId = makeBot('leva');
    candleSource = NO_CANDLES_EXPECTED;

    const params = { strategyParams: { leverage: 5 } };
    const res = await handleUpdateStrategyParams({ bot_id: botId, params });
    assert.equal(res.success, false);
    assert.match(res.message, /strategyParams\.leverage/);
    // Il numero che il motore applicherebbe DAVVERO va detto: è la differenza
    // fra "leva 5 dichiarata" e "leva 2 eseguita" restata invisibile per mesi.
    assert.match(res.message, /leverage=2/);

    // Un token ottenuto per una patch legittima non apre una scorciatoia: il
    // cancello sta a monte della conferma, quindi vale in entrambi gli stadi.
    const prompt = await handleUpdateStrategyParams({ bot_id: botId, params: { leverage: 3 } });
    assert.equal(prompt.status, 'confirmation_required');
    const res2 = await handleUpdateStrategyParams({
      bot_id: botId, params, confirmation_token: prompt.confirmation_token
    });
    assert.equal(res2.success, false);
    assert.match(res2.message, /strategyParams\.leverage/);
    assert.equal(JSON.parse(db.getBot(botId).config_json).strategyParams, undefined);

    botManager.deleteBot(botId);
  });

  await t.test('BUG-RULESHAPE-01: le regole malformate sono rifiutate senza pagare il backtest', async () => {
    const botId = makeBot('ruleshape');
    candleSource = NO_CANDLES_EXPECTED;
    candleCalls = 0;

    const res = await handleUpdateStrategyParams({ bot_id: botId, params: { entryRules: REGOLE_RULESHAPE } });
    assert.equal(res.success, false);
    assert.notEqual(res.status, 'confirmation_required');
    assert.match(res.message, /regola d'ingresso 2/);
    // Il backtest gate è l'unico cancello che costa rete: una forma inservibile
    // si scopre gratis, e prima.
    assert.equal(candleCalls, 0);

    assert.deepEqual(JSON.parse(db.getBot(botId).config_json).entryRules, REGOLA_CANONICA);

    const detail = auditDetail(auditFor('update_strategy_params'));
    assert.equal(detail.guardrail, 'strategy_schema');

    botManager.deleteBot(botId);
  });

  await t.test('patch canonica: conferma a due stadi e scrittura invariate', async () => {
    const botId = makeBot('ok');
    candleSource = NO_CANDLES_EXPECTED; // la patch non tocca entryRules: nessun backtest
    candleCalls = 0;

    const params = { leverage: 3, maxPositionUsd: 800 };
    const prompt = await handleUpdateStrategyParams({ bot_id: botId, params });
    assert.equal(prompt.status, 'confirmation_required', 'il cancello non intercetta una patch valida');
    assert.ok(prompt.confirmation_token);

    const res = await handleUpdateStrategyParams({
      bot_id: botId, params, confirmation_token: prompt.confirmation_token
    });
    assert.equal(res.success, true, res.message);
    assert.equal(res.data.current_config.leverage, 3);
    assert.equal(res.data.current_config.maxPositionUsd, 800);
    assert.equal(candleCalls, 0, 'cambiare leva e tetto non cambia la strategia: nessun backtest');

    const persisted = JSON.parse(db.getBot(botId).config_json);
    assert.equal(persisted.leverage, 3);
    assert.equal(persisted.maxPositionUsd, 800);
    assert.deepEqual(persisted.entryRules, REGOLA_CANONICA, 'i campi non nominati restano');

    botManager.deleteBot(botId);
  });

  await t.test('patch sulle regole con forma canonica: backtest gate eseguito come prima', async () => {
    const botId = makeBot('rules');
    candleSource = () => WINNING_CANDLES;
    candleCalls = 0;

    const nuoveRegole = [{ type: 'price', op: '>', value: 1, signal: 'long' }];
    const prompt = await handleUpdateStrategyParams({ bot_id: botId, params: { entryRules: nuoveRegole } });
    const res = await handleUpdateStrategyParams({
      bot_id: botId, params: { entryRules: nuoveRegole }, confirmation_token: prompt.confirmation_token
    });

    assert.equal(res.success, true, res.message);
    assert.ok(candleCalls >= 1, 'il backtest gate non è stato scavalcato dal cancello nuovo');
    const persisted = JSON.parse(db.getBot(botId).config_json);
    assert.deepEqual(persisted.entryRules, nuoveRegole);
    assert.equal(persisted.backtestSummary.verdict, 'passed');

    botManager.deleteBot(botId);
  });

  await t.test('la config storica imperfetta di un bot NON blocca una patch che la corregge', async () => {
    // Scenario reale: i bot BTC/SOL in produzione avevano `sizing.maxPositionUsd`
    // e `strategyParams.leverage` in DB. Il cancello guarda la config CANDIDATA,
    // quindi una patch che ripulisce quei percorsi passa — mentre qualunque altra
    // patch su quel bot viene rifiutata finché restano. È voluto: il rifiuto dice
    // cosa correggere, e la correzione è ammessa.
    const botId = `test-cfggate-legacy-${Date.now()}`;
    db.insertBot({
      id: botId,
      name: 'CfgGate Legacy',
      coin: 'BTC-PERP',
      network: 'testnet',
      masterAddress: '0x000000000000000000000000000000000000dEaD',
      config: { ...CONFIG_CANONICA(), sizing: { mode: 'percent', value: 10, maxPositionUsd: 1000 }, strategyParams: { leverage: 5 } },
      status: 'stopped'
    });
    botManager.loadFromDb();
    candleSource = NO_CANDLES_EXPECTED;

    // Una patch qualunque è bloccata dalla zavorra storica…
    const bloccata = await handleUpdateStrategyParams({ bot_id: botId, params: { leverage: 3 } });
    assert.equal(bloccata.success, false);
    assert.match(bloccata.message, /sizing\.maxPositionUsd|strategyParams\.leverage/);

    // …e la patch che la rimuove passa. Nota non ovvia: `mergeStrategyConfig`
    // fonde UN livello, quindi una chiave morta DENTRO un blocco non si cancella
    // riscrivendo il blocco (`sizing: { mode, value }` lascerebbe
    // `maxPositionUsd: 1000` al suo posto) — va azzerato il blocco intero con
    // `null` e, se serve, ricostruito con una seconda patch. È il passaggio che
    // ho fatto a mano sui bot BTC/SOL.
    const pulizia = { sizing: null, strategyParams: null, leverage: 3 };
    const prompt = await handleUpdateStrategyParams({ bot_id: botId, params: pulizia });
    assert.equal(prompt.status, 'confirmation_required', prompt.message);
    const res = await handleUpdateStrategyParams({
      bot_id: botId, params: pulizia, confirmation_token: prompt.confirmation_token
    });
    assert.equal(res.success, true, res.message);

    const persisted = JSON.parse(db.getBot(botId).config_json);
    assert.equal(persisted.sizing, null);
    assert.equal(persisted.strategyParams, null);
    assert.equal(persisted.leverage, 3);

    // Seconda patch: il blocco `sizing` si ricostruisce, ora senza il campo morto.
    const params2 = { sizing: { mode: 'percent', value: 10 } };
    const prompt2 = await handleUpdateStrategyParams({ bot_id: botId, params: params2 });
    const res2 = await handleUpdateStrategyParams({
      bot_id: botId, params: params2, confirmation_token: prompt2.confirmation_token
    });
    assert.equal(res2.success, true, res2.message);
    assert.deepEqual(JSON.parse(db.getBot(botId).config_json).sizing, { mode: 'percent', value: 10 });

    botManager.deleteBot(botId);
  });
});

test.after(async () => {
  http.request = originalHttpRequest;
  await client.closeAllSdks();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
