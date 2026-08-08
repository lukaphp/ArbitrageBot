/**
 * WS-01: watchdog di riconnessione del WebSocket Hyperliquid.
 * ==========================================================
 *
 * Copre il comportamento che in produzione mancava del tutto: `_startWs()` era
 * chiamato una sola volta all'avvio, quindi un drop del WS lasciava il sistema
 * silenziosamente sul fallback REST (misurato: `perps_ws_connected 0` dopo ~28h).
 *
 * Cosa verifica, senza aspettare tempo reale (timer e Date mockati con
 * `mock.timers`):
 *   1. il watchdog registrato da `start()` si accorge che `wsConnected()` è
 *      diventato false e ri-sottoscrive, chiudendo prima l'istanza SDK morta;
 *   2. `ws_reconnects_total` sale solo sui tentativi RIUSCITI;
 *   3. il backoff minimo evita il reconnect storm mentre il WS resta giù;
 *   4. la notifica di downtime parte una volta per episodio, non per tentativo;
 *   5. `setNetwork()` chiude il WS della rete precedente e ri-sottoscrive la nuova;
 *   6. `stop()` ripulisce il timer del watchdog.
 *
 * Seam di test: il WebSocket dell'SDK non è simulabile in modo fedele, quindi si
 * sostituiscono i SOLI metodi WS di hyperliquidClient con un fake a stati
 * (`live` = insieme delle reti con WS vivo). `setNetwork`/`getNetwork` restano
 * quelli VERI, così il percorso di cambio rete è esercitato davvero.
 *
 * NOTA su cosa NON copre: non apre alcun WebSocket reale né verifica il
 * comportamento dell'SDK Hyperliquid (incluso `_attachWsLogging`, che dipende da
 * come l'SDK espone `sdk.ws.on` — verificabile solo contro l'SDK vero, resta
 * scoperto e best-effort per costruzione).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import notifier from '../src/perps/notifier.js';
import metrics from '../src/perps/metrics.js';
import db from '../src/db/database.js';

// DB su file temporaneo: `setNetwork` persiste la rete in `settings`, e nessun
// test deve toccare data/perps.db reale.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-ws-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

// Le soglie del watchdog sono lette da process.env al CARICAMENTO del modulo, e
// gli import statici ESM sono hoisted: marketData va quindi importato
// dinamicamente DOPO aver impostato l'ambiente. Valori ridotti per rendere il
// test leggibile (e per verificare che siano davvero configurabili).
process.env.PERPS_WS_WATCHDOG_MS = '1000';
process.env.PERPS_WS_RECONNECT_BACKOFF_MS = '5000';
process.env.PERPS_WS_DOWN_NOTIFY_MS = '10000';
const WATCHDOG_MS = 1000;
const { MarketData } = await import('../src/perps/marketData.js');

// --- Fake dei soli metodi WebSocket del client ---
const live = new Set();          // reti con WS "vivo"
let subscribeFails = false;      // la sottoscrizione fallisce (WS non disponibile)
let subscribeCalls = [];         // reti per cui è stata tentata la sottoscrizione
let closedNetworks = [];         // reti per cui è stata chiusa l'istanza SDK

// Riferimenti ai metodi VERI, salvati prima degli stub: due test qui sotto
// verificano l'implementazione reale di closeWsFor/_attachWsLogging.
const realCloseWsFor = client.closeWsFor.bind(client);
const realAttachWsLogging = client._attachWsLogging.bind(client);

client.getMarkets = async () => [];
client.getAllMids = async () => ({});
client.subscribeAllMids = async (_cb, network = client.getNetwork()) => {
  subscribeCalls.push(network);
  if (subscribeFails) throw new Error('WS non disponibile (fake)');
  live.add(network);
  return {};
};
client.wsConnected = (network = client.getNetwork()) => live.has(network);
client.closeWsFor = async (network) => { closedNetworks.push(network); return live.delete(network); };
client.closeWs = async () => { live.clear(); };

// Notifiche raccolte invece di essere inviate (nessuna chiamata a Telegram).
let notifications = [];
notifier.notify = async (text) => { notifications.push(text); return true; };

function resetFake() {
  live.clear();
  subscribeFails = false;
  subscribeCalls = [];
  closedNetworks = [];
  notifications = [];
}

/** Avanza i timer mockati e drena le microtask del tick asincrono. */
async function advance(ms) {
  mock.timers.tick(ms);
  // setImmediate NON è mockato: è la via d'uscita per far completare le catene
  // di await interne a _wsWatchdogTick prima delle assert.
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

test('watchdog: il WS che cade viene ristabilito e conta come riconnessione', async () => {
  resetFake();
  const md = new MarketData();
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 });
  try {
    await md.start(null);
    assert.deepEqual(subscribeCalls, ['testnet'], 'sottoscrizione iniziale');
    assert.equal(md.wsNetwork, 'testnet');

    const reconnectsBefore = metrics.get('ws_reconnects_total');

    // Il WS cade senza che nessuno lanci un errore: esattamente il caso reale.
    live.clear();
    assert.equal(client.wsConnected('testnet'), false, 'precondizione: wsConnected() false');

    await advance(WATCHDOG_MS);

    assert.deepEqual(subscribeCalls, ['testnet', 'testnet'], 'il watchdog ha ri-sottoscritto');
    assert.deepEqual(closedNetworks, ['testnet'],
      'istanza SDK morta rimossa da wsSdks PRIMA di ri-sottoscrivere');
    assert.equal(client.wsConnected('testnet'), true, 'WS di nuovo connesso');
    assert.equal(metrics.get('ws_reconnects_total') - reconnectsBefore, 1,
      'ws_reconnects_total incrementato una volta (tentativo riuscito)');
    assert.equal(md.wsDownSince, 0, 'episodio di downtime chiuso');

    // Con il WS sano il watchdog non deve fare nulla.
    await advance(WATCHDOG_MS * 3);
    assert.equal(subscribeCalls.length, 2, 'nessuna ri-sottoscrizione inutile con il WS sano');
  } finally {
    md.stop();
    mock.timers.reset();
  }
});

test('watchdog: backoff minimo e notifica una-per-episodio mentre il WS resta giù', async () => {
  resetFake();
  subscribeFails = true;
  const md = new MarketData();
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 });
  try {
    await md.start(null);
    assert.equal(subscribeCalls.length, 1, 'tentativo iniziale (fallito)');
    assert.equal(md.wsNetwork, null);

    const reconnectsBefore = metrics.get('ws_reconnects_total');

    // t+1000: primo giro di watchdog → tentativo (nessun tentativo precedente).
    await advance(WATCHDOG_MS);
    assert.equal(subscribeCalls.length, 2, 'il watchdog tenta la riconnessione');

    // t+2000..t+5000: quattro giri di watchdog dentro la finestra di backoff
    // (5000ms dal tentativo di t+1000) → nessun nuovo tentativo. Senza backoff
    // sarebbero 4 tentativi in più.
    await advance(WATCHDOG_MS * 4);
    assert.equal(subscribeCalls.length, 2, 'backoff rispettato: nessun reconnect storm');
    assert.deepEqual(notifications, [], 'sotto la soglia di downtime: nessuna notifica');

    // t+6000: backoff scaduto → un solo nuovo tentativo.
    await advance(WATCHDOG_MS);
    assert.equal(subscribeCalls.length, 3, 'un tentativo per finestra di backoff');

    // Il downtime è iniziato a t+1000; la soglia di notifica è 10000ms → scatta
    // al giro di watchdog di t+11000.
    await advance(WATCHDOG_MS * 5);
    assert.equal(notifications.length, 1, 'una sola notifica di downtime');
    assert.match(notifications[0], /WebSocket/);
    assert.match(notifications[0], /non disponibile/);

    // Il WS resta giù: la notifica NON si ripete a ogni tentativo.
    await advance(WATCHDOG_MS * 10);
    assert.equal(notifications.length, 1, 'una notifica per episodio, non per tentativo');
    assert.equal(metrics.get('ws_reconnects_total'), reconnectsBefore,
      'i tentativi falliti non incrementano ws_reconnects_total');

    // Ripristino: al primo tentativo utile (t+26000, backoff dall'ultimo
    // tentativo di t+21000) il WS torna su e viene notificato.
    subscribeFails = false;
    await advance(WATCHDOG_MS * 5);
    assert.equal(client.wsConnected('testnet'), true, 'WS ristabilito');
    assert.equal(metrics.get('ws_reconnects_total') - reconnectsBefore, 1,
      'una sola riconnessione contata');
    assert.equal(notifications.length, 2, 'notifica di ripristino inviata');
    assert.match(notifications[1], /ristabilito/);
  } finally {
    md.stop();
    mock.timers.reset();
  }
});

test('setNetwork: chiude il WS della rete precedente e ri-sottoscrive la nuova', async () => {
  resetFake();
  const md = new MarketData();
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 });
  try {
    await md.start(null);
    assert.deepEqual(subscribeCalls, ['testnet']);

    // setNetwork VERO (non mockato): persiste la rete, chiude il WS precedente e
    // notifica i listener → marketData ri-sottoscrive subito, senza aspettare il
    // prossimo giro di watchdog.
    client.setNetwork('mainnet');
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

    assert.ok(closedNetworks.includes('testnet'),
      'il WS della rete precedente è stato chiuso (non resta a consegnare prezzi della rete sbagliata)');
    assert.equal(subscribeCalls[subscribeCalls.length - 1], 'mainnet',
      'ri-sottoscrizione sulla rete nuova');
    assert.equal(md.wsNetwork, 'mainnet');
    assert.equal(live.has('testnet'), false, 'nessuna connessione morta residua sulla rete precedente');
  } finally {
    md.stop();
    mock.timers.reset();
    try { client.setNetwork('testnet'); } catch { /* noop */ }
  }
});

test('stop(): il timer del watchdog non sopravvive all\'arresto', async () => {
  resetFake();
  const md = new MarketData();
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 });
  try {
    await md.start(null);
    assert.ok(md.wsWatchdogTimer, 'watchdog attivo con il market data avviato');

    md.stop();
    assert.equal(md.wsWatchdogTimer, null, 'timer ripulito da stop()');

    live.clear();
    subscribeCalls = [];
    await advance(WATCHDOG_MS * 5);
    assert.equal(subscribeCalls.length, 0, 'nessun tentativo di riconnessione dopo stop()');
  } finally {
    mock.timers.reset();
  }
});

test('closeWsFor: rimuove davvero l\'istanza dalla cache wsSdks e la disconnette', async () => {
  // Il watchdog si affida a questo: se l'istanza morta restasse in wsSdks,
  // getWsSdk la ritroverebbe in cache e non riconnetterebbe nulla.
  let disconnected = 0;
  client.wsSdks.set('testnet', { disconnect: () => { disconnected++; } });
  client.wsSdks.set('mainnet', { disconnect: () => { disconnected++; } });

  assert.equal(await realCloseWsFor('testnet'), true);
  assert.equal(disconnected, 1, 'disconnect chiamato sull\'istanza rimossa');
  assert.equal(client.wsSdks.has('testnet'), false, 'istanza rimossa dalla cache');
  assert.equal(client.wsSdks.has('mainnet'), true, 'le altre reti non vengono toccate');

  assert.equal(await realCloseWsFor('testnet'), false, 'idempotente: niente da chiudere');

  // Un disconnect che lancia (connessione già morta) non deve propagare:
  // l'istanza è comunque fuori dalla cache, che è ciò che conta.
  client.wsSdks.set('testnet', { disconnect: () => { throw new Error('già morta'); } });
  assert.equal(await realCloseWsFor('testnet'), true);
  assert.equal(client.wsSdks.has('testnet'), false);

  client.wsSdks.delete('mainnet');
});

test('_attachWsLogging: aggancia gli eventi dell\'SDK (error/close/reconnect/max attempts)', () => {
  // Nomi degli eventi verificati sull'SDK installato (hyperliquid: emit("error"),
  // emit("close"), emit("reconnect"), emit("maxReconnectAttemptsReached")).
  const handlers = new Map();
  const fakeSdk = { ws: { on: (ev, h) => handlers.set(ev, h) } };

  assert.equal(realAttachWsLogging(fakeSdk, 'testnet'), true);
  for (const ev of ['error', 'close', 'reconnect', 'maxReconnectAttemptsReached']) {
    assert.equal(typeof handlers.get(ev), 'function', `evento ${ev} agganciato`);
  }
  // Gli handler non devono lanciare su payload malformati/assenti.
  handlers.get('error')(undefined);
  handlers.get('close')({});
  handlers.get('reconnect')();
  handlers.get('maxReconnectAttemptsReached')();

  // Idempotente: ri-agganciare la stessa istanza non duplica i listener.
  handlers.clear();
  assert.equal(realAttachWsLogging(fakeSdk, 'testnet'), true);
  assert.equal(handlers.size, 0, 'nessun listener duplicato alla seconda chiamata');

  // SDK senza emitter: non lancia, ritorna false (best-effort).
  assert.equal(realAttachWsLogging({ ws: {} }, 'testnet'), false);
  assert.equal(realAttachWsLogging({}, 'testnet'), false);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
