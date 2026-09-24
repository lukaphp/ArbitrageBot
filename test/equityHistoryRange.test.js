/**
 * CURVA EQUITY PER FINESTRA TEMPORALE (bottoni 1G/7G/30G/90G/1A/Tutto)
 * ===========================================================================
 *
 * BUG confermato in produzione: i bottoni di intervallo sui grafici "Portfolio
 * Performance" e "Performance" non hanno alcun effetto. La causa non è il
 * filtro lato UI (`_filterEquityPointsByRange`, verificato corretto) ma il
 * backend: `db.listRiskEquityHistory` fa `ORDER BY ts DESC LIMIT ?`, cioè un
 * tetto per RIGHE, non per TEMPO. Con un campionamento ogni pochi secondi le
 * ultime 2000 righe sono poche ore di storia: qualunque finestra da 1 giorno in
 * su chiede più di quanto il backend abbia mai spedito, e il filtro lato UI non
 * ha niente da tagliare — stesso grafico per tutti i bottoni.
 *
 * Qui si fissa il contratto del fix:
 *  - un metodo DB additivo che legge per FINESTRA (`ts >= sinceTs`) e
 *    sottocampiona in modo UNIFORME su tutta la finestra (non le ultime N,
 *    altrimenti si ripresenta lo stesso difetto in piccolo), includendo SEMPRE
 *    l'ultimo campione;
 *  - `range` opzionale su `/api/perps/risk` e `/api/perps/performance`, con
 *    comportamento INVARIATO quando il parametro è assente;
 *  - il drawdown NON cambia in funzione di `range`: è un altro uso dello stesso
 *    dato grezzo, e la sua semantica non è nello scope di questo fix.
 *
 * Seam: DB su file temporaneo, `hyperliquid` sostituito, handler REALE preso
 * dal router stack — stesso pattern di test/riskEquitySkipsOnAccountError.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-equityrange-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: hyperliquid } = await import('../src/perps/hyperliquidClient.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { EQUITY_HISTORY_MAX_POINTS } = await import('../src/perps/riskSnapshot.js');

botManager.bots.clear();
notifier.notify = async () => true;

const NETWORK = 'testnet';
const DAY = 86400;
const CADENCE = 90;              // secondi fra un campione e il successivo
const NOW = Math.floor(Date.now() / 1000);

// Indirizzo con 8 giorni di storia: la finestra da 7 giorni è più larga di ciò
// che le ultime 2000 righe coprono (2000 × 90s ≈ 2,08 giorni) — è esattamente
// la condizione che in produzione rende i bottoni inerti.
const ADDR = '0xequityrange8d';
const SAMPLES = Math.floor((8 * DAY) / CADENCE);  // 7680, sotto la ritenzione (10k)

// Due indirizzi con storia IDENTICA per il test sul drawdown: uno per la
// chiamata con `range=1d` e uno per quella con `range=all`. Usarne uno solo
// renderebbe il test non falsificabile, perché `mergeDrawdownState` è monotono
// e la seconda chiamata erediterebbe il picco persistito dalla prima.
const ADDR_DD_A = '0xequityrangedda';
const ADDR_DD_B = '0xequityrangeddb';
const DD_SAMPLES = 3000;

/**
 * Semina diretta in tabella: `insertRiskEquitySample` esegue anche la DELETE di
 * ritenzione a ogni riga e qui servono migliaia di campioni. La ritenzione non è
 * il codice sotto test, e il contratto della tabella è rispettato.
 */
const insertRaw = db.db.prepare(`
  INSERT INTO risk_equity_history (network, address, ts, equity)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(network, address, ts) DO UPDATE SET equity = excluded.equity
`);
const seed = db.db.transaction((address, points) => {
  for (const point of points) insertRaw.run(NETWORK, address.toLowerCase(), point.ts, point.value);
});

/** Interpolazione lineare fra due punti di rottura, per una curva leggibile. */
function lerp(from, to, t) { return from + (to - from) * t; }

// Curva a 8 giorni: picco assoluto 3000 a 7,5 giorni fa (FUORI dalla finestra
// 7d), minimo 1500 a 5 giorni fa, risalita a 2500 adesso.
const history8d = [];
for (let i = 0; i < SAMPLES; i++) {
  const ts = NOW - 8 * DAY + i * CADENCE;
  const ageDays = (NOW - ts) / DAY;
  let value;
  if (ageDays > 7.5) value = lerp(2000, 3000, (8 - ageDays) / 0.5);
  else if (ageDays > 5) value = lerp(3000, 1500, (7.5 - ageDays) / 2.5);
  else value = lerp(1500, 2500, (5 - ageDays) / 5);
  history8d.push({ ts, value: Math.round(value * 100) / 100 });
}
seed(ADDR, history8d);

// Curva per il drawdown: picco 5000 nelle prime 1000 righe (fuori dalle ultime
// 2000, cioè invisibile al drawdown di oggi) e un secondo picco 2600 a metà
// delle ultime 2000 righe (dentro la finestra del drawdown, FUORI da 1d).
const historyDd = [];
for (let i = 0; i < DD_SAMPLES; i++) {
  const ts = NOW - (DD_SAMPLES - 1 - i) * CADENCE;
  let value;
  if (i < 500) value = lerp(2000, 5000, i / 500);
  else if (i < 1000) value = lerp(5000, 2000, (i - 500) / 500);
  else if (i < 1500) value = lerp(2000, 2600, (i - 1000) / 500);
  else value = lerp(2600, 2200, (i - 1500) / 1499);
  historyDd.push({ ts, value: Math.round(value * 100) / 100 });
}
seed(ADDR_DD_A, historyDd);
seed(ADDR_DD_B, historyDd);

let accountEquity = 2400;        // sotto ogni picco: le chiamate non ne creano di nuovi
hyperliquid.getNetwork = () => NETWORK;
hyperliquid.getFrontendOpenOrders = async () => [];
hyperliquid.getUserFills = async () => [];
hyperliquid.getAccount = async () => ({
  accountValue: accountEquity, equity: accountEquity, totalMarginUsed: 0, totalNtlPos: 0,
  withdrawable: accountEquity, spotUsdc: 0, spotAvailable: 0, spotHold: 0, positions: []
});

function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function call(routePath, query) {
  const handler = routeHandler('get', routePath);
  const captured = { statusCode: 200, body: null };
  await handler({ query, params: {}, body: {} }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  assert.equal(captured.statusCode, 200, `${routePath} deve rispondere 200`);
  return captured.body.data;
}

const span = (points) => points[points.length - 1].time - points[0].time;
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1) Il metodo DB: finestra temporale, sottocampionamento uniforme, ultimo punto
// ---------------------------------------------------------------------------

test('listRiskEquityHistoryByRange: la finestra 7d copre davvero la settimana', () => {
  const since = NOW - 7 * DAY;
  const points = db.listRiskEquityHistoryByRange(NETWORK, ADDR, { sinceTs: since, maxPoints: 2000 });

  assert.ok(points.length > 0, 'la finestra contiene dati');
  assert.deepEqual(Object.keys(points[0]).sort(), ['time', 'value'],
    'stessa forma di listRiskEquityHistory: nessun formato nuovo per la UI');
  assert.ok(points.every(p => p.time >= since), 'nessun punto fuori dalla finestra');
  assert.ok(near(points[0].time, since, 2 * CADENCE),
    `il punto più vecchio deve stare a ridosso di now-7d (ottenuto ${points[0].time - since}s dopo)`);
  assert.ok(span(points) >= 6.9 * DAY,
    `i punti devono coprire l'intera settimana, coperti ${(span(points) / DAY).toFixed(2)} giorni`);
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].time > points[i - 1].time, 'ordine cronologico crescente, senza duplicati');
  }
});

test('listRiskEquityHistoryByRange: oltre il tetto sottocampiona UNIFORMEMENTE, non le ultime N', () => {
  const since = NOW - 7 * DAY;
  const maxPoints = 500;
  const points = db.listRiskEquityHistoryByRange(NETWORK, ADDR, { sinceTs: since, maxPoints });
  const full = db.listRiskEquityHistoryByRange(NETWORK, ADDR, { sinceTs: since, maxPoints: 100000 });

  assert.equal(points.length, maxPoints, 'il tetto è rispettato esattamente');
  assert.ok(full.length > maxPoints, 'premessa: la finestra ha più righe del tetto');
  assert.ok(span(points) >= 6.9 * DAY, 'i punti ridotti coprono comunque tutta la finestra');

  // Uniformità: il passo atteso è full.length/maxPoints righe; nessun buco deve
  // valere più del doppio. Prendere "le ultime 500" darebbe un solo buco enorme
  // all'inizio — è il difetto in piccolo che questo caso esclude.
  const expectedGap = (full.length / maxPoints) * CADENCE;
  let maxGap = 0;
  for (let i = 1; i < points.length; i++) maxGap = Math.max(maxGap, points[i].time - points[i - 1].time);
  assert.ok(maxGap <= expectedGap * 2,
    `buco massimo ${maxGap}s, atteso ≈ ${Math.round(expectedGap)}s: i punti devono essere distribuiti su tutta la finestra`);
});

test('listRiskEquityHistoryByRange: l\'ultimo campione c\'è SEMPRE', () => {
  const newest = db.listRiskEquityHistory(NETWORK, ADDR, 1)[0];
  for (const maxPoints of [1, 2, 7, 333, 500, 2000]) {
    const points = db.listRiskEquityHistoryByRange(NETWORK, ADDR, { sinceTs: NOW - 7 * DAY, maxPoints });
    assert.deepEqual(points[points.length - 1], newest,
      `con maxPoints=${maxPoints} il grafico non deve sembrare troncato prima di adesso`);
    assert.ok(points.length <= maxPoints, `con maxPoints=${maxPoints} il tetto non si supera`);
  }
});

test('listRiskEquityHistoryByRange: sotto il tetto restituisce tutte le righe, intatte', () => {
  const since = NOW - DAY;
  const points = db.listRiskEquityHistoryByRange(NETWORK, ADDR, { sinceTs: since, maxPoints: 2000 });
  const expected = history8d.filter(p => p.ts >= since);
  assert.equal(points.length, expected.length, 'nessun sottocampionamento sotto il tetto');
  assert.equal(points[0].time, expected[0].ts);
  assert.equal(points[0].value, expected[0].value);
});

test('listRiskEquityHistoryByRange: sinceTs=0 (range "all") resta comunque sotto il tetto', () => {
  const points = db.listRiskEquityHistoryByRange(NETWORK, ADDR, { sinceTs: 0, maxPoints: EQUITY_HISTORY_MAX_POINTS });
  assert.ok(points.length <= EQUITY_HISTORY_MAX_POINTS,
    `mai più di ${EQUITY_HISTORY_MAX_POINTS} punti nemmeno su tutta la storia`);
  assert.ok(span(points) >= 7.9 * DAY, 'ma la copertura è tutta la storia disponibile (8 giorni)');
});

// ---------------------------------------------------------------------------
// 2) /api/perps/risk — la dashboard
// ---------------------------------------------------------------------------

test('GET /api/perps/risk?range=7d: la curva copre la settimana, non le ultime ore', async () => {
  const data = await call('/api/perps/risk', { address: ADDR, range: '7d' });
  const points = data.equityHistory;

  assert.ok(Array.isArray(points) && points.length > 0);
  assert.ok(points.length <= EQUITY_HISTORY_MAX_POINTS, 'tetto di punti rispettato');
  assert.ok(span(points) >= 6.9 * DAY,
    `con range=7d il grafico deve avere 7 giorni di dati, ottenuti ${(span(points) / DAY).toFixed(2)}`);
  assert.ok(points[0].time >= NOW - 7 * DAY - CADENCE, 'niente dati più vecchi della finestra chiesta');
  assert.equal(data.equityHistoryMeta.range, '7d', 'la risposta dichiara la finestra applicata');
});

test('GET /api/perps/risk?range=1d: finestra stretta e più densa, senza sottocampionare', async () => {
  const data = await call('/api/perps/risk', { address: ADDR, range: '1d' });
  const points = data.equityHistory;
  const week = (await call('/api/perps/risk', { address: ADDR, range: '7d' })).equityHistory;

  assert.ok(points.every(p => p.time >= NOW - DAY - CADENCE), 'solo l\'ultimo giorno');
  assert.ok(near(span(points), DAY, 4 * CADENCE), `copertura ≈ 24h, ottenuta ${span(points)}s`);
  // Densità: 1d sta sotto il tetto, quindi ha TUTTI i campioni del giorno,
  // mentre 7d è ridotto. Il passo medio di 1d deve essere più fitto.
  const stepDay = span(points) / (points.length - 1);
  const stepWeek = span(week) / (week.length - 1);
  assert.ok(stepDay < stepWeek, 'la finestra corta è più densa di quella lunga');
  assert.ok(near(stepDay, CADENCE, 1), 'nessun sottocampionamento quando i punti stanno sotto il tetto');
});

test('GET /api/perps/risk senza range: risposta INVARIATA (retrocompatibilità)', async () => {
  const data = await call('/api/perps/risk', { address: ADDR });
  const legacy = db.listRiskEquityHistory(NETWORK, ADDR, 2000);

  assert.equal(data.equityHistory.length, legacy.length, 'stesso conteggio di prima del fix');
  assert.deepEqual(data.equityHistory, legacy, 'stesse righe di prima del fix');
  assert.equal(data.equityHistoryMeta, undefined,
    'senza range la risposta non guadagna nemmeno campi nuovi');
  assert.ok(span(data.equityHistory) < 3 * DAY,
    'premessa del bug: senza range il backend continua a spedire solo le ultime righe');
});

test('GET /api/perps/risk: range sconosciuto = nessun range (nessuna sorpresa per chi già chiama)', async () => {
  const data = await call('/api/perps/risk', { address: ADDR, range: 'settimana-scorsa' });
  const legacy = db.listRiskEquityHistory(NETWORK, ADDR, 2000);
  assert.equal(data.equityHistory.length, legacy.length);
  assert.equal(data.equityHistoryMeta, undefined);
});

test('GET /api/perps/risk: il DRAWDOWN non dipende da range', async () => {
  // Storia identica su due indirizzi: nessuno dei due ha stato persistito
  // prima della sua unica chiamata, quindi il confronto è pulito.
  const withDay = await call('/api/perps/risk', { address: ADDR_DD_A, range: '1d' });
  const withAll = await call('/api/perps/risk', { address: ADDR_DD_B, range: 'all' });

  assert.deepEqual(withDay.drawdown, withAll.drawdown,
    'stesso dato grezzo, stesso drawdown: il range è una scelta di GRAFICO');
  // Valore atteso dal comportamento di OGGI: ultime 2000 righe → picco 2600.
  // Se il drawdown seguisse il range vedrebbe 5000 (all) o ≈2456 (1d).
  assert.ok(near(withDay.drawdown.peak, 2600, 1),
    `picco atteso 2600 (ultime 2000 righe), ottenuto ${withDay.drawdown.peak}`);
  assert.ok(near(withDay.drawdown.maxUsd, 400, 1),
    `drawdown massimo atteso 400, ottenuto ${withDay.drawdown.maxUsd}`);
  // Le curve esposte, invece, devono essere diverse: è il punto del fix.
  assert.ok(span(withAll.equityHistory) > span(withDay.equityHistory) * 2,
    'range=all mostra molta più storia di range=1d');
});

// ---------------------------------------------------------------------------
// 3) /api/perps/performance — la tab dedicata
// ---------------------------------------------------------------------------

test('GET /api/perps/performance?range=7d: stessa semantica della dashboard', async () => {
  const data = await call('/api/perps/performance', { address: ADDR, range: '7d' });
  const points = data.equityHistory;

  assert.ok(points.length <= EQUITY_HISTORY_MAX_POINTS);
  assert.ok(span(points) >= 6.9 * DAY,
    `con range=7d servono 7 giorni di dati, ottenuti ${(span(points) / DAY).toFixed(2)}`);
  assert.equal(data.equityHistoryMeta.range, '7d');
  assert.deepEqual(Object.keys(points[0]).sort(), ['time', 'value']);
});

test('GET /api/perps/performance senza range: risposta INVARIATA', async () => {
  const data = await call('/api/perps/performance', { address: ADDR });
  const legacy = db.listRiskEquityHistory(NETWORK, ADDR, Math.min(500, 5000));
  assert.deepEqual(data.equityHistory, legacy, 'stesse righe di prima del fix (limit di default 500)');
  assert.equal(data.equityHistoryMeta, undefined);
});

test('GET /api/perps/performance: il DRAWDOWN non dipende da range', async () => {
  const noRange = await call('/api/perps/performance', { address: ADDR_DD_A });
  const withDay = await call('/api/perps/performance', { address: ADDR_DD_A, range: '1d' });
  const withAll = await call('/api/perps/performance', { address: ADDR_DD_A, range: 'all' });

  assert.deepEqual(withDay.drawdown, noRange.drawdown);
  assert.deepEqual(withAll.drawdown, noRange.drawdown);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
