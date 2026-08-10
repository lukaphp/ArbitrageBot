/**
 * DEBT-01 item 1: `botManager.updateBot()` attende il tick in volo.
 * ================================================================
 *
 * È il MECCANISMO concreto dietro la race di SEC-08, non un caso ipotetico:
 * `updateBot()` fermava il timer (`clearInterval`) e costruiva subito una nuova
 * istanza `PerpsBot`, senza attendere il tick eventualmente già partito. Per la
 * durata di quel tick esistevano DUE istanze dello stesso bot che agivano sullo
 * stesso mercato e sulla stessa riga `positions`: la vecchia a metà tick (con la
 * sua `this.position` in memoria) e la nuova, appena avviata, che nasce con
 * `position = null` e legge lo stato da zero. SEC-08 ha reso innocuo lo STATO
 * prodotto da quella sovrapposizione (`insertPositionIfNoneOpen` +
 * `_hydratePosition`), non l'ha eliminata: qui si elimina la sovrapposizione.
 *
 * Cosa si osserva, e perché è l'osservabile giusto: ogni `tick()` chiama
 * `marketData.getSnapshot` come PRIMA operazione asincrona. Contando quante
 * chiamate a `getSnapshot` sono contemporaneamente in attesa si conta quanti
 * tick sono contemporaneamente in volo — cioè quante istanze sono attive.
 * L'assertion è che quel numero non superi mai 1.
 *
 * Seam di test: singleton DB su file temporaneo (mai data/perps.db),
 * `marketData.getSnapshot` sostituito da un cancello che si apre a comando
 * (mock di un singolo metodo singleton, pattern di test/botDca.test.js),
 * `paperBroker` come broker (config `paper: true`) e `notifier.notify`
 * neutralizzato. Cosa NON è coperto: il tick reale contro Hyperliquid — qui il
 * prezzo e l'account sono simulati, ma l'orchestrazione di `tick()`,
 * `start()`/`stop()` e `updateBot()` è quella di produzione.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-botmgr-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init(); // insertBot() non fa init lazy

const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { default: botManager } = await import('../src/perps/botManager.js');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => {};

// Cancello sui tick: ogni getSnapshot resta appesa finché non la si rilascia.
// `gates.length` = tick contemporaneamente in volo.
const gates = [];
let snapshotCalls = 0;
let maxConcurrentTicks = 0;
marketData.getSnapshot = async () => {
  snapshotCalls++;
  const gate = new Promise(resolve => gates.push(resolve));
  maxConcurrentTicks = Math.max(maxConcurrentTicks, gates.length);
  await gate;
  return { price: 100, candles: [], funding: null };
};

/** Rilascia tutti i tick in attesa e lascia drenare le microtask. */
async function releaseTicks() {
  while (gates.length) gates.shift()();
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
}

/** Lascia girare le microtask senza aprire alcun cancello. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
}

const CONFIG = {
  paper: true,
  // Loop lungo: l'unico tick del test è quello immediato di start(), niente
  // rumore dal setInterval.
  loopInterval: 3600000,
  sizing: { mode: 'fixed', value: 100 },
  leverage: 1,
  tp: { enabled: true, mode: 'percent', value: 10 },
  sl: { enabled: true, mode: 'percent', value: 5 }
};

test('updateBot durante un tick in volo: nessuna sovrapposizione tra istanza vecchia e nuova', async () => {
  const created = botManager.createBot({
    name: 'Bot Update', coin: 'UPD-PERP', network: 'testnet',
    masterAddress: '0xUPD1', config: CONFIG
  });
  const id = created.id;
  const original = botManager.bots.get(id);

  // start() lancia subito un tick: resta appeso al cancello.
  botManager.startBot(id);
  await settle();
  assert.equal(snapshotCalls, 1, 'un tick partito');
  assert.equal(original.busy, true, 'il tick della prima istanza è in volo');

  // Modifica del bot MENTRE il tick è in volo (lo scenario reale: PATCH
  // /api/perps/bots/:id su un bot in esecuzione).
  const updating = botManager.updateBot(id, { name: 'Bot Update 2', config: { ...CONFIG, leverage: 2 } });
  await settle();

  // Il punto della storia: finché il tick vecchio non è finito, l'istanza in
  // mappa deve essere ancora quella vecchia e nessun nuovo tick deve partire.
  assert.equal(botManager.bots.get(id), original,
    'istanza NON sostituita mentre il tick precedente è ancora in volo');
  assert.equal(snapshotCalls, 1, 'nessun tick della nuova istanza partito in parallelo');
  assert.equal(original.busy, true, 'il tick vecchio è ancora quello in volo');

  // Rilascia il tick vecchio: solo ora updateBot può completare.
  await releaseTicks();
  const state = await updating;

  const fresh = botManager.bots.get(id);
  assert.notEqual(fresh, original, 'istanza sostituita dopo la fine del tick');
  assert.equal(state.name, 'Bot Update 2');
  assert.equal(fresh.config.leverage, 2, 'la nuova istanza usa la config aggiornata');
  assert.equal(original.busy, false, 'il tick vecchio è concluso');
  assert.equal(original.timer, null, 'la vecchia istanza non ha più un timer attivo');
  assert.equal(fresh.status, 'running', 'il bot era running: riparte dopo l\'update');
  assert.equal(maxConcurrentTicks, 1,
    'mai due tick (= due istanze attive) contemporaneamente per lo stesso bot');

  await releaseTicks(); // tick della nuova istanza
  botManager.stopBot(id);
  await releaseTicks();
});

test('updateBot su un bot fermo non lo avvia e resta senza sovrapposizioni', async () => {
  const created = botManager.createBot({
    name: 'Bot Fermo', coin: 'UPD2-PERP', network: 'testnet',
    masterAddress: '0xUPD2', config: CONFIG
  });
  const id = created.id;
  const before = snapshotCalls;

  const state = await botManager.updateBot(id, { name: 'Bot Fermo 2' });

  assert.equal(state.status, 'stopped', 'un bot fermo resta fermo dopo l\'update');
  assert.equal(snapshotCalls, before, 'nessun tick avviato da un update su bot fermo');
  assert.equal(botManager.bots.get(id).name, 'Bot Fermo 2');
  assert.equal(maxConcurrentTicks, 1);
});

test.after(async () => {
  await releaseTicks();
  try { botManager.stopAll(); } catch { /* noop */ }
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
