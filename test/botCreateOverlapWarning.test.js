/**
 * CRIT-03-EXTRA — avviso alla creazione di un bot su un mercato già coperto.
 * ========================================================================
 *
 * Il lock di CRIT-03 risolve la race TECNICA sull'apertura: due bot sullo stesso
 * (masterAddress, coin) non arrivano più entrambi a firmare. Non risponde alla
 * domanda a monte: nessuno segnalava che quel secondo bot fosse stato configurato.
 *
 * È già successo in produzione (`docs/KB/business-analysis-2026-08-11.md`): due bot
 * hanno shortato NEAR-PERP quasi nello stesso minuto con parametri quasi identici —
 * non diversificazione voluta, doppione. Il rischio reale è di esposizione: due bot
 * sullo stesso mercato sono una posizione doppia sullo stesso rischio, mentre i
 * limiti di portafoglio contano le POSIZIONI, non le strategie che le generano.
 *
 * NON è un blocco: due strategie diverse sullo stesso asset (timeframe diversi,
 * long su uno e short sull'altro) sono una scelta operativa legittima. Solo un
 * avviso, e la creazione avviene comunque.
 *
 * Perimetro (deliberato, allineato al testo approvato): la sovrapposizione è con un
 * altro bot **running**. Due bot fermi non aprono niente e non producono
 * esposizione.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import marketData from '../src/perps/marketData.js';
import db from '../src/db/database.js';
import botManager from '../src/perps/botManager.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-overlap-'));
db.dbPath = path.join(tempDir, 'perps.db');
// `db.insertBot()` è tra i pochi metodi che non chiamano `ensure()`: la prima
// operazione di questo test è proprio una creazione, quindi l'init va esplicito
// (in esercizio la fa `server.js` all'avvio).
db.init();

// Un bot avviato fa subito un tick: lo si rende inerte invece di impedirlo, così
// `startBot()` resta il percorso REALE (è `status === 'running'` che conta qui).
client.getMid = async () => 100;
client.roundPx = (px) => px;
marketData.getSnapshot = async (coin) => ({ coin, price: 100, candles: [], funding: null });
marketData.getMarkets = () => [];

const MASTER = '0xOverlapMaster';
// loopInterval alto: solo il tick immediato di start(), nessun timer che riparte.
const CONFIG = { paper: true, loopInterval: 3600000, sizing: { mode: 'fixed', value: 10 }, leverage: 1 };

let n = 0;
function create(coin, master = MASTER, name = null) {
  n++;
  return botManager.createBot({
    name: name || `Bot ${n}`, coin, masterAddress: master, network: 'testnet', config: CONFIG
  });
}

test('primo bot su un mercato: nessun avviso', () => {
  const state = create('OVL-PERP');
  assert.equal(state.warning, null, 'niente da segnalare: nessun altro bot su questo mercato');
  assert.ok(state.id, 'bot creato');
});

test('secondo bot sullo stesso (master, coin) con il primo running: avviso, ma creato', async () => {
  const first = create('DUP-PERP', MASTER, 'Primo su DUP');
  botManager.startBot(first.id);
  await botManager.bots.get(first.id).whenIdle();

  const second = create('DUP-PERP', MASTER, 'Secondo su DUP');

  assert.ok(second.id, 'la creazione NON è bloccata: è una scelta operativa legittima');
  assert.equal(db.getBot(second.id).coin, 'DUP-PERP', 'la riga esiste in DB');
  assert.ok(botManager.bots.get(second.id), 'ed è registrato nel manager');

  assert.ok(second.warning, 'avviso presente');
  assert.match(second.warning, /DUP-PERP/, 'dice su quale mercato');
  assert.match(second.warning, /Primo su DUP/, 'e con quale bot si sovrappone');
});

test('coin diversa sullo stesso master: nessun avviso', () => {
  const other = create('ALTRA-PERP');
  assert.equal(other.warning, null);
});

test('stessa coin ma master diverso: nessun avviso (conti separati, esposizioni separate)', () => {
  const other = create('DUP-PERP', '0xUnAltroWallet');
  assert.equal(other.warning, null);
});

test('l\'indirizzo scritto in altro case è lo stesso wallet', () => {
  const state = create('DUP-PERP', MASTER.toUpperCase());
  assert.ok(state.warning, 'il confronto non deve dipendere da come è scritto l\'indirizzo');
  assert.match(state.warning, /DUP-PERP/);
});

test('il bot che si sovrappone è fermo: nessun avviso', () => {
  const first = create('STOP-PERP', MASTER, 'Fermo su STOP');
  assert.equal(first.warning, null);
  // `first` è stato creato fermo (createBot non avvia) → nessuna esposizione.
  const second = create('STOP-PERP', MASTER, 'Secondo su STOP');
  assert.equal(second.warning, null,
    'due bot fermi non aprono nulla: avvisare qui sarebbe un falso positivo');
});

test('più bot running sullo stesso mercato: l\'avviso li elenca tutti', async () => {
  const a = create('TRIS-PERP', MASTER, 'Tris A');
  const b = create('TRIS-PERP', MASTER, 'Tris B');
  botManager.startBot(a.id);
  botManager.startBot(b.id);
  await botManager.bots.get(a.id).whenIdle();
  await botManager.bots.get(b.id).whenIdle();

  const c = create('TRIS-PERP', MASTER, 'Tris C');
  assert.match(c.warning, /Tris A/);
  assert.match(c.warning, /Tris B/);
});

test('findMarketOverlap: interrogabile a parte, e non conta il bot stesso', async () => {
  const a = create('SELF-PERP', MASTER, 'Self A');
  botManager.startBot(a.id);
  await botManager.bots.get(a.id).whenIdle();

  assert.equal(botManager.findMarketOverlap({ masterAddress: MASTER, coin: 'SELF-PERP' }).length, 1);
  assert.equal(
    botManager.findMarketOverlap({ masterAddress: MASTER, coin: 'SELF-PERP', excludeId: a.id }).length, 0,
    'escludendo se stesso, un bot non si sovrappone con sé'
  );
});

test('l\'avviso arriva davvero all\'operatore: la cockpit lo mostra', () => {
  // Un campo `warning` che nessuna interfaccia legge non è un avviso, è un dato
  // sepolto in una risposta JSON. Verifica statica sulla sorgente (stesso stile
  // delle altre verifiche su public/), non un test di DOM: qui interessa che il
  // collegamento esista, non come sia reso graficamente.
  const source = fs.readFileSync(new URL('../public/perps.js', import.meta.url), 'utf8');
  assert.match(source, /created\?\.warning/,
    'la creazione bot deve leggere il campo warning della risposta');
  assert.match(source, /this\.toast\(created\.warning, 'warning'\)/,
    'e mostrarlo come avviso, senza riscriverne il testo lato client');
});

test.after(() => {
  botManager.stopAll();
  for (const bot of botManager.bots.values()) bot.shutdown();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
