/**
 * CRIT #7 · `paper_broker_state` non si riscrive per intero: reload-and-merge su `_save()`.
 * =======================================================================================
 *
 * L'INCIDENTE (12/09/2026, VPS). `paper_broker_state` è UN blob JSON in
 * `settings`, riscritto INTERO da `_save()` con lo stato in memoria del processo
 * chiamante, mentre `_load()` gira una volta sola all'avvio. Sul VPS i processi
 * che importano il singleton sono due (Express e MCP Stdio di Hermes): ognuno ha
 * la sua copia, e chi salva per ultimo cancella in silenzio quello che l'altro ha
 * scritto nel frattempo. Osservato: i trigger tp/sl `oid 35/36 @103.67/99.142` di
 * una posizione LIVE riportati a `oid 24/25 @104.68/98.639` (i livelli di un bot
 * cancellato 12 minuti prima) e `oidSeq` retrocesso da 37 a 35 — cioè oid futuri
 * che collidono con quelli ancora citati in `trailing_json`.
 *
 * COME SI SIMULANO DUE PROCESSI. Due istanze `PaperBroker` distinte sullo STESSO
 * database: è esattamente la condizione reale (memoria separata, storage
 * condiviso) senza dover forkare un processo. Quello che NON si riproduce qui è
 * l'interleaving vero: le due istanze si alternano in modo deterministico perché
 * è la sequenza di scritture a contare, non il timing.
 *
 * COSA DEVE VALERE DOPO IL FIX:
 *  1. un `_save()` scrive SOLO il delta del processo chiamante (account e coin su
 *     cui ha davvero agito); tutto il resto resta com'è su disco;
 *  2. `oidSeq` non retrocede MAI, nemmeno sull'account condiviso: al merge si
 *     prende il massimo e il processo lo adotta subito in memoria, così il
 *     prossimo oid che assegna non può collidere con uno già vivo altrove;
 *  3. l'equity dell'account condiviso si compone dei delta dei due processi, non
 *     dell'ultima fotografia di uno dei due;
 *  4. i fill non spariscono: l'unione è per identità del fill, non "l'ultima
 *     lista vince" — `bot._registerClose` classifica TP contro SL leggendo l'oid
 *     del fill di chiusura, un fill perso è una chiusura attribuita all'ordine
 *     sbagliato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import client from '../src/perps/hyperliquidClient.js';
import db from '../src/db/database.js';
import { PaperBroker } from '../src/perps/paperBroker.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-papermerge-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

// Nessuna rete: il fill paper chiede sempre il mid al client.
let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

/** Lo stato come lo vede un TERZO processo che rileggesse il DB adesso. */
const onDisk = () => JSON.parse(db.getSetting('paper_broker_state') || '{}');

test('due processi, account diversi: il salvataggio di uno non cancella i trigger dell\'altro', async () => {
  const EXPRESS = '0xexpress1';
  const MCP = '0xmcp1';

  // Processo A (Express) apre una posizione e la protegge.
  const a = new PaperBroker();
  await a.placeMarketOrder({ masterAddress: EXPRESS, coin: 'SOL-PERP', isBuy: true, size: 1 });
  await a.placeTriggerOrder({ masterAddress: EXPRESS, coin: 'SOL-PERP', isBuy: false, size: 1, triggerPx: 99.142, tpsl: 'sl' });

  // Processo B (MCP Stdio) parte ADESSO: legge lo stato di A e se lo tiene in
  // memoria. È la fotografia che nell'incidente è diventata stale.
  const b = new PaperBroker();
  await b.getAccount(EXPRESS); // forza `_load()` in B

  // A ri-prezza i trigger (place-then-cancel): sul disco ora ci sono i livelli NUOVI.
  const tp = await a.placeTriggerOrder({ masterAddress: EXPRESS, coin: 'SOL-PERP', isBuy: false, size: 1, triggerPx: 103.67, tpsl: 'tp' });
  const before = onDisk();
  assert.equal(before[EXPRESS].triggers['SOL-PERP'].length, 2, 'due trigger vivi su disco prima della scrittura di B');

  // B agisce su un ALTRO account e salva. Prima del fix scriveva anche la sua
  // copia stale di EXPRESS, cancellando il trigger appena piazzato da A.
  await b.placeMarketOrder({ masterAddress: MCP, coin: 'ETH-PERP', isBuy: true, size: 1 });

  const after = onDisk();
  assert.deepEqual(
    after[EXPRESS].triggers['SOL-PERP'].map(t => t.oid).sort(),
    before[EXPRESS].triggers['SOL-PERP'].map(t => t.oid).sort(),
    'i trigger dell\'account di A devono sopravvivere al salvataggio di B'
  );
  assert.ok(after[EXPRESS].triggers['SOL-PERP'].some(t => t.oid === tp.oid && t.triggerPx === 103.67),
    'il TP piazzato da A dopo il load di B è ancora al prezzo giusto');
  assert.ok(after[EXPRESS].oidSeq >= before[EXPRESS].oidSeq, 'oidSeq dell\'account di A non retrocede');
  assert.ok(after[MCP], 'e il lavoro di B è comunque persistito');
});

test('account condiviso: oidSeq non retrocede e il prossimo oid non collide', async () => {
  const SHARED = '0xshared';

  const a = new PaperBroker();
  await a.placeMarketOrder({ masterAddress: SHARED, coin: 'SOL-PERP', isBuy: true, size: 1 });

  // B fotografa lo stato (oidSeq basso) e resta indietro.
  const b = new PaperBroker();
  await b.getAccount(SHARED);
  const bSeqBefore = b._acc(SHARED).oidSeq;

  // A consuma altri oid: disco avanti rispetto alla memoria di B.
  for (let i = 0; i < 4; i++) {
    await a.placeTriggerOrder({ masterAddress: SHARED, coin: 'SOL-PERP', isBuy: false, size: 1, triggerPx: 95 + i, tpsl: 'sl' });
  }
  const aSeq = onDisk()[SHARED].oidSeq;
  const liveOids = onDisk()[SHARED].triggers['SOL-PERP'].map(t => t.oid);
  assert.ok(aSeq > bSeqBefore, 'presupposto del test: B è indietro sul contatore');

  // B agisce su un'ALTRA coin dello stesso account e salva.
  const order = await b.placeTriggerOrder({ masterAddress: SHARED, coin: 'ETH-PERP', isBuy: false, size: 1, triggerPx: 50, tpsl: 'sl' });

  const after = onDisk();
  assert.ok(after[SHARED].oidSeq >= aSeq, `oidSeq non retrocede (${after[SHARED].oidSeq} >= ${aSeq})`);
  assert.ok(!liveOids.includes(order.oid),
    `l'oid assegnato da B (${order.oid}) non deve essere uno di quelli già vivi (${liveOids.join(',')})`);
  assert.ok(after[SHARED].triggers['SOL-PERP'] && after[SHARED].triggers['SOL-PERP'].length === 4,
    'i trigger di A sulla sua coin restano tutti');
  assert.ok(after[SHARED].triggers['ETH-PERP'] && after[SHARED].triggers['ETH-PERP'].length === 1,
    'e quello di B è stato aggiunto, non ha sostituito il resto');
});

test('account condiviso: l\'equity somma i due delta, non l\'ultima fotografia', async () => {
  const SHARED = '0xshared-equity';

  const a = new PaperBroker();
  await a.placeMarketOrder({ masterAddress: SHARED, coin: 'SOL-PERP', isBuy: true, size: 1 });
  const b = new PaperBroker();
  await b.getAccount(SHARED); // B fotografa l'equity di adesso

  // A realizza una perdita: l'equity su disco scende.
  MID = 90;
  await a.closePosition({ masterAddress: SHARED, coin: 'SOL-PERP' });
  MID = 100;
  const equityAfterA = onDisk()[SHARED].equity;
  const bEquityBefore = b._acc(SHARED).equity;
  assert.ok(equityAfterA < bEquityBefore - 1, 'presupposto: A ha realizzato una perdita che B non ha visto');

  // B paga una fee su un'altra coin dello stesso account: il suo delta è la sola
  // fee, non «la mia equity di prima meno la fee» — che cancellerebbe la perdita
  // realizzata da A.
  await b.placeMarketOrder({ masterAddress: SHARED, coin: 'ETH-PERP', isBuy: true, size: 1 });

  const after = onDisk()[SHARED].equity;
  assert.ok(after < bEquityBefore - 9,
    `la perdita realizzata da A non deve essere cancellata dal salvataggio di B (equity ${after}, prima della perdita ${bEquityBefore})`);
  const applied = equityAfterA - after;
  assert.ok(applied > 0 && applied < 0.1,
    `sopra al valore su disco va applicata SOLO la fee di B (delta applicato: ${applied})`);
  // E la memoria di B adotta il totale vero: altrimenti al salvataggio dopo
  // ripartirebbe da una base sbagliata.
  assert.ok(Math.abs(b._acc(SHARED).equity - after) < 1e-9,
    'la memoria del processo che ha salvato riflette ciò che è stato scritto');
});

test('account condiviso: i fill dell\'altro processo non spariscono dal blob', async () => {
  const SHARED = '0xshared-fills';

  const a = new PaperBroker();
  await a.placeMarketOrder({ masterAddress: SHARED, coin: 'SOL-PERP', isBuy: true, size: 1 });
  const b = new PaperBroker();
  await b.getAccount(SHARED);

  MID = 110;
  await a.closePosition({ masterAddress: SHARED, coin: 'SOL-PERP' }); // fill di chiusura, con il suo oid
  MID = 100;
  const closing = onDisk()[SHARED].fills.filter(f => /close/i.test(f.dir));
  assert.equal(closing.length, 1, 'presupposto: su disco c\'è il fill di chiusura di A');

  await b.placeMarketOrder({ masterAddress: SHARED, coin: 'ETH-PERP', isBuy: true, size: 1 });

  const after = onDisk()[SHARED].fills;
  assert.ok(after.some(f => /close/i.test(f.dir) && f.oid === closing[0].oid),
    'il fill di chiusura di A è ancora nel blob: è ciò con cui si distingue una chiusura da TP da una da SL');
  assert.ok(after.some(f => f.coin === 'ETH-PERP'), 'e c\'è anche il fill di B');
  // Nessun doppione: l'unione è per identità del fill.
  const keys = after.map(f => `${f.time}|${f.oid}|${f.coin}|${f.dir}|${f.sz}`);
  assert.equal(new Set(keys).size, keys.length, 'nessun fill duplicato dopo l\'unione');
});

test('una chiusura CANCELLA davvero posizione e trigger dal blob (il merge non resuscita nulla)', async () => {
  const M = '0xclose-wins';
  const a = new PaperBroker();
  await a.placeMarketOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: true, size: 1 });
  await a.placeTriggerOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: false, size: 1, triggerPx: 95, tpsl: 'sl' });
  assert.ok(onDisk()[M].positions['SOL-PERP'], 'presupposto: posizione su disco');

  MID = 105;
  await a.closePosition({ masterAddress: M, coin: 'SOL-PERP' });
  MID = 100;

  const after = onDisk()[M];
  assert.equal(after.positions['SOL-PERP'], undefined, 'posizione rimossa, non ripescata dal disco');
  assert.equal(after.triggers['SOL-PERP'], undefined, 'trigger rimossi insieme alla posizione');
});

test('cancelOrder: la cancellazione di un trigger sopravvive al merge', async () => {
  const M = '0xcancel';
  const a = new PaperBroker();
  await a.placeMarketOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: true, size: 1 });
  const t1 = await a.placeTriggerOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: false, size: 1, triggerPx: 95, tpsl: 'sl' });
  const t2 = await a.placeTriggerOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: false, size: 1, triggerPx: 96, tpsl: 'sl' });
  await a.cancelOrder({ masterAddress: M, coin: 'SOL-PERP', oid: t1.oid });

  const oids = onDisk()[M].triggers['SOL-PERP'].map(t => t.oid);
  assert.deepEqual(oids, [t2.oid], 'il trigger vecchio resta cancellato (place-then-cancel: è il passo 3)');
});

test('blob illeggibile: si riscrive lo stato in memoria invece di perdere tutto, e lo si dice', async () => {
  const M = '0xcorrupt';
  const a = new PaperBroker();
  await a.placeMarketOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: true, size: 1 });

  db.setSetting('paper_broker_state', '{ questo non è json');
  const ok = await a.placeTriggerOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: false, size: 1, triggerPx: 95, tpsl: 'sl' });
  assert.ok(ok.oid > 0, 'la simulazione continua');

  const after = onDisk();
  assert.ok(after[M] && after[M].triggers['SOL-PERP'].length === 1,
    'lo stato del processo è stato riscritto sopra al blob corrotto: meglio di un blob illeggibile');
});

test('round-trip: un processo che riparte rilegge ciò che il merge ha scritto', async () => {
  const M = '0xroundtrip';
  const a = new PaperBroker();
  await a.placeMarketOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: true, size: 2 });
  await a.placeTriggerOrder({ masterAddress: M, coin: 'SOL-PERP', isBuy: false, size: 2, triggerPx: 95, tpsl: 'sl' });

  const restarted = new PaperBroker();
  const acc = await restarted.getAccount(M);
  const pos = acc.positions.find(p => p.coin === 'SOL-PERP');
  assert.ok(pos && pos.size === 2, 'posizione ripristinata');
  const orders = await restarted.getFrontendOpenOrders(M);
  assert.equal(orders.length, 1, 'trigger ripristinato');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
