/**
 * Pausa/stop dell'Analyst.
 * ========================
 *
 * Copertura: pause()/resume() persistono lo stato (sopravvivono a un
 * riavvio — verificato leggendo il setting dal DB, non solo dall'oggetto in
 * memoria); run() rispetta la pausa senza nemmeno provare a contattare
 * Claude; stop() azzera il contatore orario e annulla un AbortController
 * finto, simulando una run in corso.
 *
 * Isolamento: stesso approccio di test/botDca.test.js — singleton DB
 * redirezionato su un file temporaneo, non data/perps.db.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';
import analyst from '../src/agents/analyst/analyst.js';

// Il costruttore di Analyst non tocca il DB (solo campi JS): sicuro
// redirezionare dbPath dopo l'import, come in test/botDca.test.js.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-analyst-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.ensure(); // setSetting() non fa lazy-init da sé (a differenza di getSetting) — inizializza qui, esplicito

test('isPaused() è false di default', () => {
  assert.equal(analyst.isPaused(), false);
});

test('pause() persiste lo stato — leggibile anche da una lettura DB indipendente', () => {
  analyst.pause();
  assert.equal(analyst.isPaused(), true);
  // Non ci si fida solo del metodo: si rilegge il setting grezzo, come farebbe
  // un nuovo processo dopo un riavvio.
  assert.equal(db.getSetting('analyst_paused', 'false'), 'true');
  analyst.resume();
});

test('resume() disattiva la pausa', () => {
  analyst.pause();
  analyst.resume();
  assert.equal(analyst.isPaused(), false);
});

test('run() in pausa non tenta nemmeno di contattare Claude', async () => {
  analyst.pause();
  const r = await analyst.run();
  assert.equal(r.paused, true);
  assert.match(r.error, /pausa/i);
  analyst.resume();
});

test('stop() azzera il contatore orario', () => {
  analyst.runTimestamps.push(Date.now(), Date.now(), Date.now());
  assert.equal(analyst.runTimestamps.length, 3);
  analyst.stop();
  assert.equal(analyst.runTimestamps.length, 0);
  assert.equal(analyst.isPaused(), true);
  analyst.resume();
});

test('stop() annulla una run in corso (AbortController.abort chiamato)', () => {
  let aborted = false;
  analyst._abortController = { abort: () => { aborted = true; } };
  analyst.stop();
  assert.equal(aborted, true);
  analyst._abortController = null;
  analyst.resume();
});

test('stop() non tocca il costo totale speso — è storico, non stato operativo', () => {
  db.setSetting('analyst_cost_total', '1.23456');
  analyst.stop();
  assert.equal(analyst.costTotal(), 1.23456);
  analyst.resume();
  db.setSetting('analyst_cost_total', '0');
});
