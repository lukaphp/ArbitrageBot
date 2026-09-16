/**
 * Issue #14 — `GET /api/perps/markets` serviva prezzi congelati all'avvio.
 * =======================================================================
 *
 * `this.mids` è tenuto fresco ogni ~4s (WebSocket + fallback REST), ma il campo
 * `mid` DENTRO `this.markets` veniva scritto solo da `client.getMarkets()`, cioè
 * due volte in tutta la vita del processo: a `start()` e su cambio rete manuale.
 * L'endpoint leggeva quella copia, quindi mostrava in dashboard il prezzo
 * dell'ultimo avvio per ore (misurato in produzione: SOL 101.3 / AVAX 7.401 /
 * BTC 77802.5 identici al decimale per 24s, mentre il mid live testnet era
 * 100.025 / 7.5219 / 77351.5 — valori di nessuna rete, solo vecchi).
 *
 * Cosa verifica qui sotto:
 *   1. `getMarkets()` riflette un mid aggiornato in `this.mids` (il bug);
 *   2. il fallback sul simbolo base (`SOL` senza suffisso `-PERP`), come getMid;
 *   3. un coin senza mid live resta col valore statico, non torna a null;
 *   4. i metadati statici (szDecimals/maxLeverage/name) sopravvivono intatti —
 *      è ciò che leggono bot.js, executionAgent.js e server.js:1286;
 *   5. `getMarkets()` NON muta `this.markets`: resta una query pura, la fonte di
 *      verità del prezzo è `this.mids`;
 *   6. il percorso reale WebSocket → `this.mids` → `getMarkets()`;
 *   7. la rotta Express VERA serve due prezzi diversi in due chiamate
 *      consecutive SENZA alcun giro di rete aggiuntivo (`client.getMarkets` è
 *      sabotato: se la rotta lo chiamasse, il test fallirebbe);
 *   8. col cache ancora vuoto (fetch dei meta fallita all'avvio) la rotta
 *      ricorre ancora a `refreshMarkets()`.
 *
 * Seam: classe `MarketData` istanziata a mano (nessun `start()`, nessun timer) e
 * handler REALE della rotta preso dal router stack, come test/staleReconcile.test.js.
 * NON coperto: il WebSocket vero dell'SDK Hyperliquid (non simulabile
 * fedelmente, vedi test/marketDataWs.test.js) — qui si sostituisce il solo
 * `subscribeAllMids` per catturare la callback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-mid-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { MarketData, default: marketData } = await import('../src/perps/marketData.js');
const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: app } = await import('../src/server.js');

// Meta come li restituisce `client.getMarkets()`: `mid` è la fotografia del
// momento della fetch, ed è esattamente il valore che si congelava.
const metaCongelati = () => ([
  { coin: 'SOL-PERP', name: 'SOL', maxLeverage: 20, szDecimals: 2, mid: 101.3 },
  { coin: 'AVAX-PERP', name: 'AVAX', maxLeverage: 10, szDecimals: 1, mid: 7.401 },
  { coin: 'BTC-PERP', name: 'BTC', maxLeverage: 40, szDecimals: 5, mid: 77802.5 }
]);

const byCoin = (markets, coin) => markets.find(m => m.coin === coin);

test('getMarkets(): il mid segue this.mids invece della fotografia dell\'ultimo refresh', () => {
  const md = new MarketData();
  md.markets = metaCongelati();

  // Prima che arrivi qualsiasi tick: nulla da sovrascrivere.
  assert.equal(byCoin(md.getMarkets(), 'SOL-PERP').mid, 101.3);

  // Tick del feed (stringhe, come le consegnano WS e REST).
  md.mids = { 'SOL-PERP': '100.025', 'AVAX-PERP': '7.5219', 'BTC-PERP': '77351.5' };

  const markets = md.getMarkets();
  assert.equal(byCoin(markets, 'SOL-PERP').mid, 100.025);
  assert.equal(byCoin(markets, 'AVAX-PERP').mid, 7.5219);
  assert.equal(byCoin(markets, 'BTC-PERP').mid, 77351.5);

  // …e continua a seguirlo al tick successivo (il bug era proprio la seconda
  // lettura identica alla prima).
  md.mids = { ...md.mids, 'SOL-PERP': '100.44' };
  assert.equal(byCoin(md.getMarkets(), 'SOL-PERP').mid, 100.44);
});

test('getMarkets(): il mid si risolve anche col simbolo base, senza suffisso -PERP', () => {
  const md = new MarketData();
  md.markets = metaCongelati();
  md.mids = { SOL: '100.025' }; // chiave senza '-PERP', come da alcuni endpoint info

  assert.equal(byCoin(md.getMarkets(), 'SOL-PERP').mid, 100.025);
});

test('getMarkets(): un coin senza mid live resta col valore statico, non torna null', () => {
  const md = new MarketData();
  md.markets = metaCongelati();
  md.mids = { 'SOL-PERP': '100.025' }; // AVAX e BTC assenti dal feed

  const markets = md.getMarkets();
  assert.equal(byCoin(markets, 'AVAX-PERP').mid, 7.401);
  assert.equal(byCoin(markets, 'BTC-PERP').mid, 77802.5);
});

test('getMarkets(): i metadati statici restano intatti (szDecimals è quello che usa il sizing)', () => {
  const md = new MarketData();
  md.markets = metaCongelati();
  md.mids = { 'BTC-PERP': '77351.5' };

  // Stesso accesso di bot.js/_openPosition, executionAgent.js e server.js:1286.
  const market = md.getMarkets().find(m => m.coin === 'BTC-PERP');
  assert.equal(market.szDecimals, 5);
  assert.equal(market.maxLeverage, 40);
  assert.equal(market.name, 'BTC');
  assert.equal(md.getMarkets().length, 3);
});

test('getMarkets(): è una query pura, non riscrive this.markets', () => {
  // La fonte di verità del prezzo deve restare UNA (`this.mids`). Se il getter
  // riscrivesse la cache, `refreshMarkets()` e il feed si contenderebbero lo
  // stesso campo e tornerebbe possibile servire un valore mai più aggiornato.
  const md = new MarketData();
  md.markets = metaCongelati();
  md.mids = { 'SOL-PERP': '100.025' };

  md.getMarkets();
  assert.equal(md.markets.find(m => m.coin === 'SOL-PERP').mid, 101.3);
});

test('WebSocket → this.mids → getMarkets(): un tick del feed cambia il prezzo servito', async () => {
  const md = new MarketData();
  md.markets = metaCongelati();

  // Si sostituisce il SOLO `subscribeAllMids` per catturare la callback vera
  // del feed: il resto di `_startWs` (stato, log, wsNetwork) è quello reale.
  const realSubscribe = client.subscribeAllMids;
  let onMids = null;
  client.subscribeAllMids = async (cb) => { onMids = cb; return {}; };
  try {
    const ok = await md._startWs('testnet');
    assert.equal(ok, true);
    assert.ok(onMids, 'callback del feed registrata');

    onMids({ mids: { 'SOL-PERP': '100.025' } });
    assert.equal(byCoin(md.getMarkets(), 'SOL-PERP').mid, 100.025);

    onMids({ mids: { 'SOL-PERP': '99.9' } });
    assert.equal(byCoin(md.getMarkets(), 'SOL-PERP').mid, 99.9);
  } finally {
    client.subscribeAllMids = realSubscribe;
  }
});

// ---- rotta Express reale ----

function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  return layer.route.stack[0].handle;
}

async function callMarkets() {
  const handler = routeHandler('get', '/api/perps/markets');
  const captured = { statusCode: 200, body: null };
  await handler({ query: {}, params: {}, body: {} }, {
    status(c) { captured.statusCode = c; return this; },
    json(p) { captured.body = p; return this; }
  });
  return captured;
}

test('GET /api/perps/markets: due chiamate, due prezzi — e nessun giro di rete in più', async () => {
  const realGetMarkets = client.getMarkets;
  // Se la rotta rifacesse la fetch completa meta+mids, questa esploderebbe: il
  // fix deve riusare il feed già vivo, non duplicare traffico verso Hyperliquid.
  client.getMarkets = async () => { throw new Error('nessuna fetch REST attesa su questo percorso'); };
  const savedMarkets = marketData.markets;
  const savedMids = marketData.mids;
  try {
    marketData.markets = metaCongelati();
    marketData.mids = { 'SOL-PERP': '100.025', 'AVAX-PERP': '7.5219', 'BTC-PERP': '77351.5' };

    const prima = await callMarkets();
    assert.equal(prima.statusCode, 200);
    assert.equal(prima.body.success, true);
    assert.equal(byCoin(prima.body.data, 'SOL-PERP').mid, 100.025);
    assert.equal(byCoin(prima.body.data, 'BTC-PERP').mid, 77351.5);

    marketData.mids = { ...marketData.mids, 'SOL-PERP': '100.44', 'BTC-PERP': '77400' };

    const dopo = await callMarkets();
    assert.equal(byCoin(dopo.body.data, 'SOL-PERP').mid, 100.44);
    assert.equal(byCoin(dopo.body.data, 'BTC-PERP').mid, 77400);
    // AVAX non si è mosso nel feed: deve restare al suo valore, non sparire.
    assert.equal(byCoin(dopo.body.data, 'AVAX-PERP').mid, 7.5219);
  } finally {
    client.getMarkets = realGetMarkets;
    marketData.markets = savedMarkets;
    marketData.mids = savedMids;
  }
});

test('GET /api/perps/markets: con la cache meta ancora vuota ricorre a refreshMarkets()', async () => {
  const realGetMarkets = client.getMarkets;
  let fetchCount = 0;
  client.getMarkets = async () => { fetchCount++; return metaCongelati(); };
  const savedMarkets = marketData.markets;
  const savedMids = marketData.mids;
  try {
    // Scenario reale: `start()` ha fallito la fetch dei meta (warn, non throw),
    // quindi non c'è nessuna struttura statica su cui applicare i mid.
    marketData.markets = [];
    marketData.mids = { 'SOL-PERP': '100.025' };

    const res = await callMarkets();
    assert.equal(res.statusCode, 200);
    assert.equal(fetchCount, 1, 'una sola fetch dei meta, non una per mercato');
    assert.equal(byCoin(res.body.data, 'SOL-PERP').mid, 100.025);
    assert.equal(byCoin(res.body.data, 'BTC-PERP').szDecimals, 5);

    // Da qui in poi la cache è calda: nessuna altra fetch.
    await callMarkets();
    assert.equal(fetchCount, 1);
  } finally {
    client.getMarkets = realGetMarkets;
    marketData.markets = savedMarkets;
    marketData.mids = savedMids;
  }
});
