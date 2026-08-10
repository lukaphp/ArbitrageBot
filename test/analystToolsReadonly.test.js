/**
 * ADV-01 · i 5 strumenti read-only aggiunti a `analyst/tools.js`.
 * ==============================================================
 *
 * `get_risk_snapshot`, `get_killswitch_state`, `get_proposals`,
 * `get_trade_history`, `get_equity_history`. Tre cose da verificare, e sono
 * indipendenti:
 *
 *  1. **restituiscono i dati veri** letti dalle fonti già esistenti (DB,
 *     riskSnapshot, riskAgent), non un rimpasto approssimato;
 *  2. **rispettano `TOOL_RESULT_CHAR_CAP`** anche quando i dati sono molti — e
 *     lo fanno togliendo righe, non troncando il JSON a metà: un risultato non
 *     parsabile porta un modello a inventare;
 *  3. **restano di sola lettura.** Non è una proprietà osservabile "a occhio":
 *     qui si esegue OGNI strumento del `switch` e si verifica che lo stato
 *     scrivibile (kill-switch, proposte, posizioni, trade, settings) sia
 *     identico prima e dopo.
 *
 * Seam di test: singleton DB su file temporaneo (mai data/perps.db) popolato con
 * righe reali; `client`/`marketData`/`botManager` sostituiti nei soli metodi che
 * gli strumenti usano, per non fare rete. Cosa NON è coperto: le risposte reali
 * di Hyperliquid (account/ordini vengono da un fake) e gli strumenti che fanno
 * backtest/ML, coperti dalle loro suite.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-tools-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: predictor } = await import('../src/perps/predictor.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: riskAgent } = await import('../src/agents/riskAgent.js');
const { TOOL_DEFS, runTool } = await import('../src/agents/analyst/tools.js');
const { TOOL_RESULT_CHAR_CAP } = await import('../src/agents/usage.js');

const MASTER = '0xtoolmaster';
const NETWORK = 'testnet';

// --- Fake dei soli metodi usati dagli strumenti sotto test (nessuna rete) ---
client.network = NETWORK;
client.getAccount = async () => ({
  equity: 1000, accountValue: 1000, totalMarginUsed: 400, spotUsdc: 0,
  totalNtlPos: 2500,
  positions: [{ coin: 'SOL-PERP', side: 'long', size: 2, entryPx: 100, unrealizedPnl: -5, leverage: 3, positionValue: 2500, liquidationPx: 70 }]
});
client.getFrontendOpenOrders = async () => ([
  { coin: 'SOL-PERP', isTrigger: true, orderType: 'Stop Market', oid: 1 },
  { coin: 'SOL-PERP', isTrigger: false, orderType: 'Limit', oid: 2 }
]);
client.getUserFills = async () => ([]);
client.getMarketStats = async () => ([{ coin: 'SOL-PERP', mark: 100, volume24h: 1e6, change24hPct: 1.5, funding: 0.0001, maxLeverage: 20 }]);
client.getCandles = async () => ([]);
marketData.getStatus = () => ({ isRunning: true, ws: true, wsFresh: true });
marketData.getMarkets = () => ([{ coin: 'SOL-PERP', mid: 100, maxLeverage: 20 }]);
marketData.getMid = () => 100;
// Nessuna rete: senza candele backtest/ML restituiscono un errore, che per il
// test di sola-lettura è un esito perfettamente valido (anche il ramo di errore
// non deve scrivere).
marketData.getCandles = async () => ([]);
predictor.predict = async () => ({ error: 'nessun modello addestrato' });

/** Bot finto: solo ciò che listStates()/toRiskBotView leggono. */
function fakeBot(id, name) {
  return {
    id, name, coin: 'SOL-PERP', masterAddress: MASTER, network: NETWORK, status: 'running',
    getState: () => ({
      id, name, coin: 'SOL-PERP', status: 'running', inPosition: true, dailyPnl: -12,
      lastError: null, tickErrors: 0, lastTickAt: Date.now(), config: {},
      stats: { trades: 3, winRate: 0.66, totalPnl: 15 }
    })
  };
}

before(() => {
  botManager.bots.clear();
  botManager.bots.set('bot-tool', fakeBot('bot-tool', 'Bot Tool'));

  // Dati reali nelle tabelle che gli strumenti leggono.
  db.insertProposal({
    id: 'p-pending-1', type: 'new_strategy_candidate', coin: 'SOL-PERP',
    payload: { config: { entryRules: [{ indicator: 'rsi' }] } },
    rationale: 'RSI ipervenduto con expectancy positiva', confidence: 0.4, source: 'analyst'
  });
  db.insertProposal({
    id: 'p-rejected-1', type: 'new_strategy_candidate', coin: 'ETH-PERP',
    payload: { config: { entryRules: [{ indicator: 'macd' }] } },
    rationale: 'Momentum MACD', confidence: 0.3, source: 'analyst'
  });
  db.setProposalStatus('p-rejected-1', 'rejected');

  for (let i = 0; i < 5; i++) {
    db.insertTrade({ botId: 'bot-tool', coin: 'SOL-PERP', side: 'long', px: 100 + i, sz: 1, hlOid: 1000 + i });
  }
  db.insertTrade({ botId: 'other-bot', coin: 'ETH-PERP', side: 'short', px: 3000, sz: 0.1, hlOid: 2000 });

  const t0 = Math.floor(Date.now() / 1000) - 500;
  for (let i = 0; i < 20; i++) {
    db.insertRiskEquitySample(NETWORK, MASTER, t0 + i * 10, 1000 + (i < 10 ? i * 10 : (10 - (i - 10)) * 10), 180);
  }
  riskAgent.setKillSwitch(false);
});

/** Fotografia di TUTTO lo stato scrivibile toccato dai bot/agenti. */
function stateFingerprint() {
  return JSON.stringify({
    killswitch: db.getSetting('killswitch'),
    proposals: db.listProposals({ limit: 500 }),
    positions: db.listPositions(500),
    trades: db.listTrades(500),
    settings: db.db.prepare('SELECT key, value FROM settings ORDER BY key').all(),
    bots: db.listBots()
  });
}

test('i 5 strumenti nuovi sono dichiarati in TOOL_DEFS con schema valido', () => {
  const names = TOOL_DEFS.map(t => t.name);
  for (const n of ['get_risk_snapshot', 'get_killswitch_state', 'get_proposals', 'get_trade_history', 'get_equity_history']) {
    assert.ok(names.includes(n), `${n} dichiarato`);
    const def = TOOL_DEFS.find(t => t.name === n);
    assert.ok(def.description && def.description.length > 20, `${n} ha una descrizione utile al modello`);
    assert.equal(def.input_schema.type, 'object');
  }
  assert.equal(new Set(names).size, names.length, 'nessun nome duplicato');
  assert.equal(names.length, 15, '10 strumenti preesistenti + 5 nuovi');
});

test('get_killswitch_state: riflette il flag persistito, in entrambi i versi', async () => {
  riskAgent.setKillSwitch(false);
  let r = await runTool('get_killswitch_state');
  assert.equal(r.killSwitch, false);
  assert.equal(r.opensBlocked, false);
  assert.match(r.note, /spento/i);

  riskAgent.setKillSwitch(true);
  r = await runTool('get_killswitch_state');
  assert.equal(r.killSwitch, true);
  assert.equal(r.opensBlocked, true, 'un consulente che non sa che le aperture sono bloccate dà consigli falsi');
  assert.match(r.note, /ATTIVO/);
  assert.match(r.note, /non sono state chiuse/i, 'dichiara che le posizioni aperte NON vengono chiuse dal kill-switch');
  riskAgent.setKillSwitch(false);
});

test('get_risk_snapshot: numeri di esposizione/margine e alert dalla stessa derivazione della cockpit', async () => {
  const r = await runTool('get_risk_snapshot');
  assert.equal(r.equity, 1000);
  assert.equal(r.marginUsed, 400);
  assert.equal(r.marginPct, 40);
  assert.equal(r.openPositions, 1);
  assert.equal(r.exposureUsd, 2500);
  assert.equal(r.pendingOrders, 1, 'ordini limite non trigger');
  assert.equal(r.triggerOrders, 1);
  assert.ok(r.summary && ['ok', 'review', 'blocked'].includes(r.summary.status));
  assert.ok(Array.isArray(r.alerts));
  assert.ok(r.drawdown && r.drawdown.maxPct >= 0, 'drawdown derivato dalla curva persistita');
  assert.ok(r.limits.marginWarningPct === 60 && r.limits.drawdownCriticalPct === 10,
    'le soglie sono quelle condivise con /api/perps/risk (RISK_ALERT_THRESHOLDS)');
});

test('get_risk_snapshot: con kill-switch attivo la sintesi è "blocked" e l\'alert c\'è', async () => {
  riskAgent.setKillSwitch(true);
  const r = await runTool('get_risk_snapshot');
  assert.equal(r.killSwitch, true);
  assert.equal(r.summary.status, 'blocked');
  assert.ok(r.alerts.some(a => a.id === 'killswitch-active'), 'l\'alert del kill-switch è tra quelli restituiti');
  riskAgent.setKillSwitch(false);
});

test('get_proposals: proposte, conteggi e contesto negativo delle rifiutate', async () => {
  const r = await runTool('get_proposals', {});
  assert.ok(r.proposals.length >= 2);
  const pending = r.proposals.find(p => p.id === 'p-pending-1');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.coin, 'SOL-PERP');
  assert.match(pending.rationale, /expectancy/i);
  assert.equal(r.counts.rejected, 1, 'conteggi esatti per stato');
  assert.ok(r.recentlyRejected.some(x => x.coin === 'ETH-PERP' && x.indicators.includes('macd')),
    'le strategie già scartate arrivano al modello come contesto negativo');

  const onlyPending = await runTool('get_proposals', { status: 'pending' });
  assert.ok(onlyPending.proposals.every(p => p.status === 'pending'), 'il filtro per stato è applicato');
});

test('get_trade_history: filtra per bot e per mercato in SQL, più recenti prima', async () => {
  const all = await runTool('get_trade_history', { limit: 100 });
  assert.ok(all.trades.length >= 6);
  assert.ok(all.trades[0].ts >= all.trades[all.trades.length - 1].ts, 'ordine cronologico inverso');

  const byBot = await runTool('get_trade_history', { botId: 'bot-tool' });
  assert.equal(byBot.trades.length, 5);
  assert.ok(byBot.trades.every(t => t.botId === 'bot-tool'));

  const byCoin = await runTool('get_trade_history', { coin: 'ETH-PERP' });
  assert.equal(byCoin.trades.length, 1);
  assert.equal(byCoin.trades[0].coin, 'ETH-PERP');
});

test('get_equity_history: campioni della curva persistita + drawdown derivato', async () => {
  const r = await runTool('get_equity_history', { limit: 10 });
  assert.equal(r.network, NETWORK);
  assert.equal(r.samples.length, 10);
  assert.equal(r.samplesAvailable, 20, 'dice quanti campioni esistono, non solo quanti ne restituisce');
  assert.ok(r.samples[0].t > r.samples[r.samples.length - 1].t, 'più recenti prima');
  // La curva sale a 1090 e poi scende a 1000: drawdown massimo 90.
  assert.ok(Math.abs(r.drawdown.maxUsd - 90) < 1e-6, `drawdown massimo atteso 90, ottenuto ${r.drawdown.maxUsd}`);
});

test('cap dei tool_result: liste lunghe rientrano nei 6.000 caratteri restando JSON valido', async () => {
  for (let i = 0; i < 400; i++) {
    db.insertTrade({ botId: 'bot-flood', coin: 'FLOOD-PERP', side: 'long', px: 12345.6789, sz: 1.23456, hlOid: 90000 + i });
  }
  const r = await runTool('get_trade_history', { coin: 'FLOOD-PERP', limit: 400 });
  const json = JSON.stringify(r);
  assert.ok(json.length <= TOOL_RESULT_CHAR_CAP, `risultato di ${json.length} char oltre il cap di ${TOOL_RESULT_CHAR_CAP}`);
  assert.equal(r.truncated, true, 'il taglio è dichiarato, non nascosto');
  assert.equal(r.available, 400, 'quante righe esistevano davvero');
  assert.ok(r.returned < 400 && r.returned > 0);
  assert.doesNotThrow(() => JSON.parse(json), 'il JSON resta parsabile: si tolgono righe, non caratteri');
});

test('SOLA LETTURA: eseguire tutti gli strumenti non cambia una riga di stato', async () => {
  const before = stateFingerprint();
  const inputs = {
    get_markets: { limit: 3 },
    get_candles: { coin: 'SOL-PERP' },
    ml_predict: { coin: 'SOL-PERP' },
    run_backtest: { coin: 'SOL-PERP', config: {} },
    backtest_templates: { coin: 'SOL-PERP' },
    get_proposals: { limit: 5 },
    get_trade_history: { limit: 5 },
    get_equity_history: { limit: 5 }
  };
  for (const def of TOOL_DEFS) {
    // Un errore è un esito legittimo (dato assente/rete finta): quel che conta è
    // che nessuno strumento SCRIVA. Anche il ramo di errore non deve scrivere.
    await runTool(def.name, inputs[def.name] || {}).catch(() => null);
  }
  assert.equal(stateFingerprint(), before,
    'uno strumento ha modificato lo stato: nessuno strumento del switch può scrivere');
});

test('SOLA LETTURA: nessuno strumento espone una scrittura nota (kill-switch, proposte, ordini)', async () => {
  // Commenti rimossi: l'affermazione riguarda il CODICE. Citare
  // `riskAgent.setKillSwitch` in un commento per dire che non è raggiungibile è
  // legittimo; chiamarlo no.
  const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/analyst/tools.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const forbidden of [
    'setKillSwitch', 'insertProposal', 'setProposalStatus', 'proposals.create', 'proposals.approve',
    'placeMarketOrder', 'placeTriggerOrder', 'cancelOrder', 'closePosition', 'setSetting',
    'startBot', 'stopBot', 'updateBot', 'deleteBot', 'insertTrade', 'insertPosition'
  ]) {
    assert.equal(src.includes(forbidden), false,
      `tools.js contiene "${forbidden}": il switch di runTool non deve acquisire scritture`);
  }
});

test('strumento sconosciuto: errore esplicito, nessuna eccezione', async () => {
  const r = await runTool('disattiva_killswitch', {});
  assert.match(r.error, /sconosciuto/i);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
