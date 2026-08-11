/**
 * WARN-02 — profondità della coda di esecuzione: misurata e segnalata.
 * ==================================================================
 *
 * `execQueue` è una catena di Promise senza alcun contatore: con più bot sullo
 * stesso master, un ordine di CHIUSURA urgente può restare in attesa dietro N
 * aperture non urgenti e nessuno può accorgersene — non esiste un numero da
 * guardare, né nei log né in /metrics.
 *
 * Questo sprint aggiunge SOLO visibilità: nessuna prioritizzazione (fuori scope
 * dichiarato). Il test verifica quindi due cose insieme: che la misura ci sia, e
 * che la serializzazione FIFO esistente non sia cambiata di una virgola.
 *
 * La soglia è letta da `process.env` al caricamento del modulo → import dinamico
 * dopo aver impostato l'ambiente (stesso pattern di test/marketDataWs.test.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import metrics from '../src/perps/metrics.js';
import logger from '../src/perps/../utils/logger.js';

process.env.PERPS_EXECQUEUE_DEPTH_WARN = '3';
const { default: execQueue } = await import('../src/perps/execQueue.js');

const warnings = [];
const realWarn = logger.warn.bind(logger);
logger.warn = (message, data) => { warnings.push(String(message)); };

/** Funzione che si completa solo quando il cancello viene aperto. */
function gated() {
  const g = {};
  g.promise = new Promise(resolve => { g.open = resolve; });
  g.fn = async () => { await g.promise; return 'done'; };
  return g;
}

test('la profondità è interrogabile e sale/scende con la coda', async () => {
  const M = '0xDEPTH1';
  assert.equal(execQueue.depth(M), 0, 'coda inattiva: profondità 0');

  const gates = [gated(), gated()];
  const running = gates.map(g => execQueue.run(M, g.fn));
  assert.equal(execQueue.depth(M), 2, 'due azioni in coda/in esecuzione');

  gates[0].open();
  await running[0];
  assert.equal(execQueue.depth(M), 1, 'una completata, una ancora in coda');

  gates[1].open();
  await Promise.all(running);
  assert.equal(execQueue.depth(M), 0, 'coda svuotata');
});

test('oltre soglia: warning una volta per episodio, non per accodamento', async () => {
  const M = '0xDEPTH2';
  warnings.length = 0;
  const before = metrics.get('execqueue_depth_warnings_total');

  // Soglia 3: le prime 3 non avvisano, la quarta sì.
  const gates = Array.from({ length: 6 }, () => gated());
  const running = gates.map(g => execQueue.run(M, g.fn));

  assert.equal(execQueue.depth(M), 6);
  const depthWarnings = warnings.filter(w => /Coda di esecuzione profonda/.test(w));
  assert.equal(depthWarnings.length, 1,
    'un solo warning per episodio di superamento, non uno per ciascuna azione sopra soglia');
  assert.match(depthWarnings[0], /0xdepth2/, 'il warning dice di quale wallet si tratta');
  assert.match(depthWarnings[0], /soglia 3/, 'e quale soglia è stata superata');
  assert.equal(metrics.get('execqueue_depth_warnings_total') - before, 1,
    'contatore Prometheus incrementato una volta');

  for (const g of gates) g.open();
  await Promise.all(running);
  assert.equal(execQueue.depth(M), 0);

  // Rientrata sotto soglia: un nuovo superamento è un episodio nuovo.
  warnings.length = 0;
  const again = Array.from({ length: 5 }, () => gated());
  const running2 = again.map(g => execQueue.run(M, g.fn));
  assert.equal(warnings.filter(w => /Coda di esecuzione profonda/.test(w)).length, 1,
    'nuovo episodio, nuovo warning');
  for (const g of again) g.open();
  await Promise.all(running2);
});

test('sotto soglia: nessun warning (nessun falso positivo)', async () => {
  const M = '0xDEPTH3';
  warnings.length = 0;
  const gates = [gated(), gated(), gated()]; // esattamente la soglia
  const running = gates.map(g => execQueue.run(M, g.fn));
  assert.equal(execQueue.depth(M), 3);
  assert.equal(warnings.filter(w => /Coda di esecuzione profonda/.test(w)).length, 0);
  for (const g of gates) g.open();
  await Promise.all(running);
});

test('depthSnapshot: fotografia delle code attive e soglia in vigore', async () => {
  const A = '0xDEPTH4';
  const B = '0xDEPTH5';
  const ga = [gated(), gated()];
  const gb = [gated()];
  const running = [...ga.map(g => execQueue.run(A, g.fn)), ...gb.map(g => execQueue.run(B, g.fn))];

  const snap = execQueue.depthSnapshot();
  assert.equal(snap.threshold, 3);
  assert.equal(snap.max, 2);
  assert.equal(snap.byKey['0xdepth4'], 2);
  assert.equal(snap.byKey['0xdepth5'], 1);

  for (const g of [...ga, ...gb]) g.open();
  await Promise.all(running);
  assert.ok(!('0xdepth4' in execQueue.depthSnapshot().byKey), 'le code svuotate non compaiono');
});

test('la serializzazione FIFO e la propagazione degli errori non cambiano', async () => {
  const M = '0xDEPTH6';
  const order = [];
  const mk = (id, ms) => () => new Promise(r => setTimeout(() => { order.push(id); r(id); }, ms));
  await Promise.all([
    execQueue.run(M, mk('A', 30)),
    execQueue.run(M, mk('B', 5)),
    execQueue.run(M, mk('C', 1))
  ]);
  assert.deepEqual(order, ['A', 'B', 'C'], 'ordine di accodamento, non di durata');

  // Un errore si propaga al chiamante (invariato) e non blocca la coda…
  const failed = await execQueue.run(M, async () => { throw new Error('boom'); }).catch(e => e.message);
  assert.equal(failed, 'boom');
  assert.equal(await execQueue.run(M, async () => 'ok'), 'ok');
  // …e non lascia la profondità sporca, che renderebbe il warning inutile.
  assert.equal(execQueue.depth(M), 0);
});

test.after(() => { logger.warn = realWarn; });
