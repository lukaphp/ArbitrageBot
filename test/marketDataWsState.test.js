/**
 * WARN-05 — stato esplicito del feed WS: healthy / retrying / degraded.
 * ===================================================================
 *
 * PORTATA CORRETTA rispetto all'audit: backoff minimo tra i tentativi e notifica
 * una-per-episodio esistevano già (li copre test/marketDataWs.test.js, che deve
 * restare verde parola per parola). Quello che mancava era uno stato
 * INTERROGABILE: con il solo booleano di connessione, "caduto un attimo, sto
 * ritentando" e "giù da mezz'ora, non si risolve da solo" sono lo stesso
 * `perps_ws_connected 0`.
 *
 * `degraded` scatta su TEMPO trascorso, non su numero di retry: il backoff già
 * rallenta i tentativi, quindi contarli non dice nulla sulla durata del guasto.
 *
 * Seam identico a test/marketDataWs.test.js: fake dei soli metodi WS del client,
 * `mock.timers` per non aspettare tempo reale, DB su file temporaneo.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import notifier from '../src/perps/notifier.js';
import db from '../src/db/database.js';
import { deriveRiskAlerts } from '../src/perps/riskSnapshot.js';
import { render } from '../src/perps/metrics.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-wsstate-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

process.env.PERPS_WS_WATCHDOG_MS = '1000';
process.env.PERPS_WS_RECONNECT_BACKOFF_MS = '5000';
process.env.PERPS_WS_DOWN_NOTIFY_MS = '10000';
const WATCHDOG_MS = 1000;
const { MarketData } = await import('../src/perps/marketData.js');

const live = new Set();
let subscribeFails = false;
let notifications = [];

client.getMarkets = async () => [];
client.getAllMids = async () => ({});
client.subscribeAllMids = async (_cb, network = client.getNetwork()) => {
  if (subscribeFails) throw new Error('WS non disponibile (fake)');
  live.add(network);
  return {};
};
client.wsConnected = (network = client.getNetwork()) => live.has(network);
client.closeWsFor = async (network) => live.delete(network);
client.closeWs = async () => { live.clear(); };
notifier.notify = async (text) => { notifications.push(text); return true; };

async function advance(ms) {
  mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

test('healthy → retrying → degraded, e ritorno a healthy', async () => {
  live.clear();
  subscribeFails = false;
  notifications = [];
  const md = new MarketData();
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 });
  try {
    await md.start(null);
    assert.equal(md.wsState, 'healthy', 'sottoscrizione riuscita: feed sano');
    assert.equal(md.getStatus().wsState, 'healthy', 'lo stato è leggibile da getStatus()');

    // Il WS cade e non si riprende.
    live.clear();
    subscribeFails = true;

    await advance(WATCHDOG_MS);
    assert.equal(md.wsState, 'retrying',
      'primo fallimento: NON degraded — il guasto momentaneo non è un guasto persistente');
    assert.deepEqual(notifications, [], 'nessun alert al primo fallimento');

    // Soglia a 10s dall'inizio del downtime (t+1000) → si entra in degraded al
    // giro di watchdog di t+11000.
    await advance(WATCHDOG_MS * 9);
    assert.equal(md.wsState, 'retrying', 'sotto soglia: ancora retrying');

    await advance(WATCHDOG_MS);
    assert.equal(md.wsState, 'degraded', 'oltre la soglia di TEMPO: guasto persistente');
    assert.equal(notifications.length, 1, 'un solo alert all\'ingresso in degraded');
    assert.match(notifications[0], /non disponibile/);

    // Mentre resta giù, il watchdog continua a ritentare: nessun alert nuovo.
    await advance(WATCHDOG_MS * 20);
    assert.equal(md.wsState, 'degraded');
    assert.equal(notifications.length, 1,
      'nessuna ripetizione per ogni retry nel mezzo (una notifica per episodio)');

    // Rientro.
    subscribeFails = false;
    await advance(WATCHDOG_MS * 6);
    assert.equal(md.wsState, 'healthy', 'feed ristabilito');
    assert.equal(notifications.length, 2, 'un solo alert al rientro in healthy');
    assert.match(notifications[1], /ristabilito/);

    await advance(WATCHDOG_MS * 10);
    assert.equal(notifications.length, 2, 'e nessun altro finché resta sano');
  } finally {
    md.stop();
    mock.timers.reset();
  }
});

test('sottoscrizione iniziale fallita: lo stato non dice "healthy"', async () => {
  live.clear();
  subscribeFails = true;
  notifications = [];
  const md = new MarketData();
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 });
  try {
    await md.start(null);
    assert.equal(md.wsState, 'retrying',
      'tra il tentativo fallito e il primo giro di watchdog lo stato non deve mentire');
  } finally {
    md.stop();
    mock.timers.reset();
    subscribeFails = false;
  }
});

test('lo stato è leggibile dagli endpoint esistenti (nessun endpoint nuovo)', () => {
  // /api/perps/risk passa `marketData.getStatus()` come `marketStatus` e lo espone
  // in `system.marketData`: lo stato arriva alla UI senza rotte nuove.
  const degraded = deriveRiskAlerts({
    marketStatus: { isRunning: true, ws: false, wsFresh: false, wsState: 'degraded', wsDownSeconds: 1800 }
  });
  const alert = degraded.find(a => a.id === 'market-ws-degraded');
  assert.ok(alert, 'alert dedicato al guasto persistente');
  assert.equal(alert.severity, 'warning', 'il fallback REST funziona: non è un blocco');
  assert.match(alert.body, /REST/);
  assert.ok(!degraded.some(a => a.id === 'market-ws-disconnected'),
    'un solo alert sul feed: degraded sostituisce il generico, non lo raddoppia');

  // Retrying resta l'alert storico, invariato.
  const retrying = deriveRiskAlerts({
    marketStatus: { isRunning: true, ws: false, wsFresh: false, wsState: 'retrying' }
  });
  assert.ok(retrying.some(a => a.id === 'market-ws-disconnected'));
  assert.ok(!retrying.some(a => a.id === 'market-ws-degraded'));

  // Chiamanti che non passano wsState (compatibilità): comportamento di prima.
  const legacy = deriveRiskAlerts({ marketStatus: { isRunning: true, ws: false, wsFresh: false } });
  assert.ok(legacy.some(a => a.id === 'market-ws-disconnected'));
});

test('metriche: perps_ws_state a tre valori, perps_ws_connected invariata', async () => {
  const sources = (wsState, connected) => ({
    botManager: { listStates: () => [] },
    marketData: { getStatus: () => ({ markets: 3, wsState }) },
    client: { wsConnected: () => connected }
  });

  const degraded = await render(sources('degraded', false));
  assert.match(degraded, /^perps_ws_state\{state="degraded"\} 1$/m);
  assert.match(degraded, /^perps_ws_state\{state="healthy"\} 0$/m);
  assert.match(degraded, /^perps_ws_state\{state="retrying"\} 0$/m);
  assert.match(degraded, /^perps_ws_connected 0$/m, 'la serie storica non cambia significato');

  const healthy = await render(sources('healthy', true));
  assert.match(healthy, /^perps_ws_state\{state="healthy"\} 1$/m);
  assert.match(healthy, /^perps_ws_connected 1$/m);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
