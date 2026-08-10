/**
 * ANA-01 · aggregazioni di performance storica e rotta /api/perps/performance.
 * ===========================================================================
 *
 * I dati esistevano già tutti (posizioni chiuse con `close_reason`,
 * `risk_equity_history`, `ml_history`): mancava l'aggregazione. Qui si verifica
 * che i numeri siano quelli GIUSTI, con valori calcolati a mano nel test — non
 * ripresi dall'implementazione, altrimenti il test confermerebbe se stesso.
 *
 * Due punti che meritano attenzione più del resto:
 *
 *  - **`expectancy` ha la stessa definizione di `backtester.js`** (USD medi per
 *    trade, `totalPnl / n`). Se divergesse, confrontare il backtest di una
 *    strategia col suo risultato live sarebbe un confronto tra numeri diversi con
 *    lo stesso nome — il tipo di errore che nessuno nota. C'è un test dedicato;
 *  - **il breakdown di `close_reason` non finge una precisione che i dati non
 *    hanno**: `close_reason` è testo libero, e 'chiusa (TP/SL o esterna)' non
 *    permette di dire se è scattato il TP o lo SL. Il bucket si chiama
 *    `trigger_or_external` per questo, e il conteggio per testo esatto resta
 *    esposto. Un bucket chiamato "tp" sarebbe un numero inventato.
 *
 * Seam: DB su file temporaneo popolato con righe reali; la rotta è invocata
 * prendendo l'handler dal router stack dell'app Express (nessun listen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-perf-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: app } = await import('../src/server.js');
const { default: botManager } = await import('../src/perps/botManager.js');
botManager.bots.clear();

const BOT = 'bot-perf-1';
const EMPTY_BOT = 'bot-perf-vuoto';
const MASTER = '0xperfmaster';

/** Posizione chiusa con PnL, fee e motivo espliciti. */
function closed({ botId = BOT, pnl, fee = 0.1, reason, closedAt }) {
  const id = db.insertPosition({ botId, coin: 'PERF-PERP', side: 'long', size: 1, entryPx: 100, leverage: 1 });
  db.updatePosition(id, { status: 'closed', pnl, fee, close_reason: reason, closed_at: closedAt });
  return id;
}

const T0 = 1786000000000;
db.insertBot({ id: BOT, name: 'Bot Perf', coin: 'PERF-PERP', network: 'testnet', masterAddress: MASTER, config: {}, status: 'stopped' });
db.insertBot({ id: EMPTY_BOT, name: 'Bot Vuoto', coin: 'VOID-PERP', network: 'testnet', masterAddress: MASTER, config: {}, status: 'stopped' });

// 6 trade chiusi: 4 vincenti (+30 +20 +10 +20 = +80), 2 perdenti (−15 −25 = −40).
// totale +40 su 6 trade → expectancy attesa = 40/6 = 6,666…
closed({ pnl: 30, reason: 'chiusa (TP/SL o esterna)', closedAt: T0 + 1000 });
closed({ pnl: -15, reason: 'chiusa (TP/SL o esterna)', closedAt: T0 + 2000 });
closed({ pnl: 20, reason: 'Regola di uscita: indicator rsi', closedAt: T0 + 3000 });
closed({ pnl: 10, reason: 'Segnale esterno: close', closedAt: T0 + 4000 });
closed({ pnl: -25, reason: 'SL non garantito (chiusura di sicurezza)', closedAt: T0 + 5000 });
closed({ pnl: 20, reason: null, closedAt: T0 + 6000 });

// Curva equity e serie ML: già presenti nel DB, servono alla stessa risposta.
for (let i = 0; i < 12; i++) {
  db.insertRiskEquitySample('testnet', MASTER, Math.floor(T0 / 1000) + i * 60, 1000 + (i < 6 ? i * 10 : (6 - (i - 6)) * 10), 180);
}
db.insertMlHistory({ coin: 'PERF-PERP', interval: '1h', accuracy: 0.55, baseline: 0.51, edge: 0.04, auc: 0.58, samples: 800 });
db.insertMlHistory({ coin: 'PERF-PERP', interval: '1h', accuracy: 0.58, baseline: 0.51, edge: 0.07, auc: 0.61, samples: 850 });
db.insertMlHistory({ coin: 'OTHER-PERP', interval: '15m', accuracy: 0.49, baseline: 0.5, edge: -0.01, auc: 0.48, samples: 400 });
// `insertMlHistory` timbra con Date.now(): due inserimenti nello stesso
// millisecondo non sono una serie temporale. Si separano, come nella realtà
// (un retraining ogni tanto), altrimenti il test verificherebbe l'ordinamento
// dei pareggi invece dell'ordine cronologico.
db.db.prepare('UPDATE ml_history SET ts = ? WHERE accuracy = 0.55').run(T0 + 100000);
db.db.prepare('UPDATE ml_history SET ts = ? WHERE accuracy = 0.58').run(T0 + 200000);

function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function callPerformance(query = {}) {
  const handler = routeHandler('get', '/api/perps/performance');
  const captured = { statusCode: 200, body: null };
  await handler({ query, params: {}, body: {} }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  return captured;
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('getBotPerformance: conteggi, win rate e totali', () => {
  const p = db.getBotPerformance(BOT);
  assert.equal(p.trades, 6);
  assert.equal(p.wins, 4);
  assert.equal(p.losses, 2);
  assert.equal(p.breakeven, 0);
  assert.ok(near(p.winRate, 4 / 6));
  assert.ok(near(p.totalPnl, 40), `totalPnl atteso 40, ottenuto ${p.totalPnl}`);
  assert.ok(near(p.totalFees, 0.6), 'fee sommate (6 × 0.1)');
  assert.equal(p.bestUsd, 30);
  assert.equal(p.worstUsd, -25);
  assert.equal(p.firstClosedAt, T0 + 1000);
  assert.equal(p.lastClosedAt, T0 + 6000);
});

test('expectancy: USD medi per trade, stessa definizione di backtester.js', () => {
  const p = db.getBotPerformance(BOT);
  assert.ok(near(p.expectancy, 40 / 6), `atteso ${40 / 6}, ottenuto ${p.expectancy}`);
  // La formula "classica" (winRate·avgWin − lossRate·avgLoss) deve dare lo stesso
  // numero: se un giorno divergessero, uno dei due sarebbe sbagliato.
  const classica = p.winRate * p.avgWin - (p.losses / p.trades) * p.avgLossAbs;
  assert.ok(near(p.expectancy, classica), `expectancy ${p.expectancy} ≠ formula classica ${classica}`);
  // E coincide con avgPnl di getBotStats, che resta la fonte della card bot.
  assert.ok(near(p.expectancy, db.getBotStats(BOT).avgPnl), 'coerente con getBotStats.avgPnl');
});

test('avgWin / avgLoss: medie separate, avgLoss NEGATIVO come ogni PnL esposto', () => {
  const p = db.getBotPerformance(BOT);
  assert.ok(near(p.avgWin, 80 / 4), `avgWin atteso 20, ottenuto ${p.avgWin}`);
  // Segno coerente con pnl/totalPnl/worstUsd/expectancy: una perdita media che
  // arriva alla UI col segno positivo verrebbe formattata come un guadagno.
  assert.ok(near(p.avgLoss, -20), `avgLoss atteso -20, ottenuto ${p.avgLoss}`);
  assert.ok(near(p.avgLossAbs, 20), 'avgLossAbs è lo stesso numero in valore assoluto, per le formule');
  assert.ok(near(p.profitFactor, 80 / 40));
  // Freqtrade-style: (winRate·avgWin)/(lossRate·avgLoss) = (0.666·20)/(0.333·20) = 2
  assert.ok(near(p.expectancyRatio, 2), `expectancyRatio atteso 2, ottenuto ${p.expectancyRatio}`);
});

test('maxDrawdownUsd: calcolato sulla curva di PnL cumulato del bot', () => {
  // Cumulato: 30, 15, 35, 45, 20, 40. Picco 45 → minimo successivo 20 ⇒ DD = 25.
  const p = db.getBotPerformance(BOT);
  assert.ok(near(p.maxDrawdownUsd, 25), `drawdown atteso 25, ottenuto ${p.maxDrawdownUsd}`);
});

test('breakdown close_reason: conteggi per bucket, nella forma del contratto', () => {
  const p = db.getBotPerformance(BOT);
  // `closeReasons` sono NUMERI: è la forma dichiarata nel contratto e quella che
  // la UI consuma direttamente ({bucket: conteggio}).
  assert.deepEqual(p.closeReasons, { trigger_or_external: 2, strategy: 2, safety: 1, other: 1 });
  const somma = Object.values(p.closeReasons).reduce((s, n) => s + n, 0);
  assert.equal(somma, p.trades, 'i bucket coprono tutti i trade: nessuno perso per strada');
  assert.equal(p.closeReasons.other, 1,
    'una riga senza close_reason (pre-migrazione v2) finisce in "other", non sparisce');
});

test('closeReasonDetail: vinti/persi/PnL dentro ciascun bucket', () => {
  const p = db.getBotPerformance(BOT);
  // Serve perché `trigger_or_external` non distingue TP da SL: quanti di quei
  // trade sono in utile è l'informazione più vicina al vero che i dati permettono.
  assert.deepEqual(p.closeReasonDetail.trigger_or_external, { trades: 2, wins: 1, losses: 1, pnl: 15 });
  assert.deepEqual(p.closeReasonDetail.strategy, { trades: 2, wins: 2, losses: 0, pnl: 30 });
  assert.deepEqual(p.closeReasonDetail.safety, { trades: 1, wins: 0, losses: 1, pnl: -25 });
  assert.deepEqual(p.closeReasonDetail.other, { trades: 1, wins: 1, losses: 0, pnl: 20 });
  assert.deepEqual(Object.keys(p.closeReasonDetail).sort(), Object.keys(p.closeReasons).sort(),
    'le due viste descrivono gli stessi bucket');
});

test('breakdown: nessun bucket "tp"/"sl" inventato, e il testo esatto resta esposto', () => {
  const p = db.getBotPerformance(BOT);
  assert.equal('tp' in p.closeReasons, false,
    'con i dati attuali TP e SL non sono distinguibili: un bucket "tp" sarebbe un numero inventato');
  assert.equal('sl' in p.closeReasons, false);
  const raw = p.closeReasonsRaw.find(r => r.reason === 'chiusa (TP/SL o esterna)');
  assert.equal(raw.trades, 2, 'il conteggio per testo esatto è disponibile: la classificazione non nasconde nulla');
  assert.ok(p.closeReasonsRaw.some(r => r.reason === '(non registrato)'), 'anche il null è dichiarato');
});

test('classificatore: mappa i testi che bot.js scrive davvero', () => {
  assert.equal(db.closeReasonBucket('chiusa (TP/SL o esterna)'), 'trigger_or_external');
  assert.equal(db.closeReasonBucket('SL non garantito (chiusura di sicurezza)'), 'safety');
  assert.equal(db.closeReasonBucket('errore verifica SL (chiusura di sicurezza)'), 'safety');
  assert.equal(db.closeReasonBucket('Regola di uscita: indicator rsi'), 'strategy');
  assert.equal(db.closeReasonBucket('Segnale esterno: close'), 'strategy');
  assert.equal(db.closeReasonBucket(null), 'other');
  assert.equal(db.closeReasonBucket('qualcosa di nuovo'), 'other');
});

test('serie PnL cumulato: cronologica crescente e cumulativa', () => {
  const series = db.getBotPnlSeries(BOT);
  assert.equal(series.length, 6);
  assert.deepEqual(series.map(p => p.cumulative), [30, 15, 35, 45, 20, 40]);
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i].ts >= series[i - 1].ts, 'ordine cronologico crescente: è una curva');
  }
  assert.ok(near(series[series.length - 1].cumulative, db.getBotPerformance(BOT).totalPnl),
    'l\'ultimo punto della curva coincide col PnL totale');
});

test('bot senza trade chiusi: zeri e nessun NaN/Infinity spurio', () => {
  const p = db.getBotPerformance(EMPTY_BOT);
  assert.equal(p.trades, 0);
  assert.equal(p.expectancy, 0);
  assert.equal(p.avgWin, 0);
  assert.equal(p.avgLoss, 0);
  assert.equal(p.maxDrawdownUsd, 0);
  assert.deepEqual(p.closeReasons, {});
  assert.deepEqual(p.closeReasonDetail, {});
  assert.deepEqual(p.closeReasonsRaw, []);
  assert.equal(p.firstClosedAt, null);
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'number') assert.equal(Number.isNaN(v), false, `${k} è NaN`);
  }
  assert.deepEqual(db.getBotPnlSeries(EMPTY_BOT), [], 'stato vuoto gestito, non un errore');
});

test('listMlHistoryScopes: enumera le serie ML esistenti (era il motivo per cui non aveva consumer)', () => {
  const scopes = db.listMlHistoryScopes();
  const perf = scopes.find(s => s.coin === 'PERF-PERP' && s.interval === '1h');
  assert.ok(perf, 'la serie esiste');
  assert.equal(perf.samples, 2);
  assert.ok(scopes.some(s => s.coin === 'OTHER-PERP' && s.interval === '15m'));
});

test('GET /api/perps/performance: forma della risposta (contratto per la UI)', async () => {
  const out = await callPerformance();
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.success, true);
  const d = out.body.data;
  for (const k of ['generatedAt', 'network', 'ownerAddress', 'totals', 'bots', 'equityHistory', 'drawdown', 'mlHistory']) {
    assert.ok(k in d, `il contratto prevede ${k}`);
  }
  const bot = d.bots.find(b => b.botId === BOT);
  assert.ok(bot, 'il bot è nella risposta');
  for (const k of ['botId', 'name', 'coin', 'trades', 'winRate', 'expectancy', 'avgWin', 'avgLoss', 'closeReasons', 'pnlSeries']) {
    assert.ok(k in bot, `il contratto per bot prevede ${k}`);
  }
  assert.ok(near(bot.expectancy, 40 / 6));
  assert.deepEqual(bot.pnlSeries.map(p => p.cumulative), [30, 15, 35, 45, 20, 40]);
});

test('GET /api/perps/performance: totali di portafoglio coerenti con i bot', async () => {
  const d = (await callPerformance()).body.data;
  assert.equal(d.totals.bots, d.bots.length);
  assert.equal(d.totals.trades, d.bots.reduce((s, b) => s + b.trades, 0));
  assert.ok(near(d.totals.totalPnl, d.bots.reduce((s, b) => s + b.totalPnl, 0)));
  assert.ok(near(d.totals.expectancy, d.totals.totalPnl / d.totals.trades));
});

test('GET /api/perps/performance: equity e ML riusano le serie già esistenti', async () => {
  const d = (await callPerformance()).body.data;
  assert.equal(d.equityHistory.length, 12, 'curva equity da risk_equity_history');
  assert.deepEqual(Object.keys(d.equityHistory[0]).sort(), ['time', 'value'],
    'stessa forma di db.listRiskEquityHistory: nessun formato nuovo da imparare per la UI');
  assert.ok(near(d.drawdown.maxUsd, 50), `drawdown equity atteso 50, ottenuto ${d.drawdown.maxUsd}`);

  // `mlHistory` è un array PIATTO di punti, ciascuno con la sua coin/interval:
  // filtrare per coin è quello che serve a un grafico. `mlScopes` dice quali
  // serie esistono, per popolare un selettore senza doverle dedurre.
  const points = d.mlHistory.filter(m => m.coin === 'PERF-PERP' && m.interval === '1h');
  assert.equal(points.length, 2, 'la serie ML è finalmente esposta');
  assert.ok(points[0].ts <= points[1].ts, 'punti in ordine cronologico crescente');
  assert.equal(points[1].accuracy, 0.58);
  assert.equal(points[1].baseline, 0.51, 'accuracy E baseline: senza baseline l\'accuracy non dice nulla');
  assert.ok(d.mlHistory.some(m => m.coin === 'OTHER-PERP'), 'tutte le serie in un solo array');
  assert.ok(d.mlScopes.some(s => s.coin === 'PERF-PERP' && s.interval === '1h'),
    'mlScopes elenca le serie disponibili per il selettore');
});

test('GET /api/perps/performance: una sola chiamata restituisce tutto (nessun polling necessario)', async () => {
  const d = (await callPerformance()).body.data;
  assert.ok(d.bots.every(b => Array.isArray(b.pnlSeries)), 'le serie per bot arrivano con la risposta');
  assert.ok(Array.isArray(d.equityHistory) && Array.isArray(d.mlHistory),
    'equity e ML nella stessa risposta: la sezione si apre con un fetch, non con N');
});

test('GET /api/perps/performance: il parametro limit tronca le serie', async () => {
  const d = (await callPerformance({ limit: '2' })).body.data;
  const bot = d.bots.find(b => b.botId === BOT);
  assert.ok(bot.pnlSeries.length <= 10, 'il limite minimo è 10, non 2: una curva di 2 punti non è una curva');
  const wide = (await callPerformance({ limit: '999999' })).body.data;
  assert.ok(wide.bots.find(b => b.botId === BOT).pnlSeries.length === 6, 'limite superiore tappato, dati completi');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
