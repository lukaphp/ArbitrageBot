/**
 * COST-01: cadenza adattiva dell'Analyst (gate sull'arretrato di proposte).
 * ========================================================================
 *
 * Baseline misurata sul DB reale prima di toccare il codice (68 run, $8.00
 * spesi, media $0.12/run): 127 delle 137 proposte prodotte sono SCADUTE senza
 * decisione umana, 1 approvata. Cioè la spesa marginale di una run che si
 * sovrappone a un arretrato non consumato non ha destinatario. Il gate salta la
 * run periodica quando ci sono già N proposte in attesa; sul replay della
 * cronologia reale evita 23 run su 68 (−33% di spesa) senza toccare nulla di
 * come vengono prodotte le proposte che restano.
 *
 * Coperto qui: la soglia blocca/lascia passare; le proposte già scadute (che il
 * DB tiene ancora a 'pending', la scadenza è lazy) NON contano come arretrato —
 * altrimenti il gate bloccherebbe l'Analyst per sempre; le proposte di altre
 * sorgenti non contano; soglia 0 = comportamento pre-COST-01; una run chiesta
 * on-demand non passa dal gate.
 *
 * Seam: singleton DB su file temporaneo (come test/analystControl.test.js) e
 * `analyst.run` sostituito da un contatore — qui si verifica il GATE, non la run
 * (che richiederebbe una chiamata reale a Claude). La soglia è forzata su
 * HYPERLIQUID_CONFIG.agents, che è l'oggetto letto da `this.cfg`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';
import { HYPERLIQUID_CONFIG } from '../src/config/config.js';
import analyst from '../src/agents/analyst/analyst.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-cadence-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.ensure();

const agents = HYPERLIQUID_CONFIG.agents;
// Riferimento al run() VERO, prima di sostituirlo col contatore: serve per
// verificare che il gate non sia finito dentro run() (vedi ultimo test).
const realRun = analyst.run.bind(analyst);
let runs = 0;

function insertProposal({ id, source = 'analyst', status = 'pending', expiresInMin = 30 }) {
  db.insertProposal({
    id, type: 'new_strategy_candidate', coin: 'SOL-PERP', payload: {},
    rationale: 'test', confidence: 0.5, source, status,
    expiresAt: Date.now() + expiresInMin * 60 * 1000
  });
  if (status !== 'pending') db.setProposalStatus(id, status);
}

beforeEach(() => {
  db.db.prepare('DELETE FROM proposals').run();
  runs = 0;
  agents.enabled = true;
  analyst.resume();
  analyst.runTimestamps = [];
  analyst.run = async () => { runs++; return { proposals: 0 }; };
});

test('nessun arretrato → la run periodica parte', async () => {
  agents.skipIfPendingProposals = 1;
  await analyst.tick();
  assert.equal(runs, 1);
});

test('arretrato oltre la soglia → run saltata (nessuna spesa)', async () => {
  agents.skipIfPendingProposals = 1;
  insertProposal({ id: 'p1' });
  await analyst.tick();
  assert.equal(runs, 0, 'non si spende su un arretrato non consumato');
  assert.equal(analyst._pendingBacklog(), 1);
});

test('arretrato sotto la soglia → run consentita', async () => {
  agents.skipIfPendingProposals = 3;
  insertProposal({ id: 'p1' });
  insertProposal({ id: 'p2' });
  await analyst.tick();
  assert.equal(runs, 1, 'con soglia 3 e 2 pendenti la run passa');
});

test('proposte SCADUTE non contano come arretrato (scadenza lazy nel DB)', async () => {
  agents.skipIfPendingProposals = 1;
  insertProposal({ id: 'vecchia', expiresInMin: -10 }); // già oltre expires_at, ma status 'pending'
  assert.equal(db.listProposals({ status: 'pending' }).length, 1,
    'il DB la tiene ancora a pending: è esattamente il caso da non contare');
  assert.equal(analyst._pendingBacklog(), 0, 'una proposta morta non è arretrato');
  await analyst.tick();
  assert.equal(runs, 1, 'altrimenti il gate bloccherebbe l\'Analyst per sempre');
});

test('proposte di altre sorgenti non contano come arretrato dell\'Analyst', async () => {
  agents.skipIfPendingProposals = 1;
  insertProposal({ id: 'r1', source: 'recycler' });
  assert.equal(analyst._pendingBacklog(), 0);
  await analyst.tick();
  assert.equal(runs, 1);
});

test('soglia 0 = comportamento pre-COST-01 (gate disattivato)', async () => {
  agents.skipIfPendingProposals = 0;
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) insertProposal({ id });
  await analyst.tick();
  assert.equal(runs, 1, 'con soglia 0 l\'arretrato non ferma nulla');
});

test('il gate non è dentro run(): un\'analisi on-demand non viene bloccata dall\'arretrato', async () => {
  agents.skipIfPendingProposals = 1;
  for (const id of ['p1', 'p2', 'p3']) insertProposal({ id }); // arretrato ben oltre la soglia

  // Nessuna chiamata di rete: senza chiave l'analisi si ferma sul client, il che
  // dimostra che è arrivata OLTRE qualunque gate di cadenza. Se il gate finisse
  // dentro run(), qui tornerebbe un errore diverso (o non tornerebbe affatto).
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await realRun({ force: true });
    assert.match(r.error, /ANTHROPIC_API_KEY/,
      'run() on-demand procede fino al client, non si ferma sull\'arretrato');
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('status() espone soglia e arretrato (altrimenti il gate sembra un Analyst fermo)', () => {
  agents.skipIfPendingProposals = 2;
  insertProposal({ id: 'p1' });
  const s = analyst.status();
  assert.equal(s.skipIfPendingProposals, 2);
  assert.equal(s.pendingBacklog, 1);
  assert.equal(s.cadenceMin, agents.cadenceMin);
});

test('il cap orario resta il primo freno, indipendente dal gate', async () => {
  agents.skipIfPendingProposals = 0;
  agents.maxCallsPerHour = 2;
  analyst.runTimestamps = [Date.now(), Date.now()];
  await analyst.tick();
  assert.equal(runs, 0, 'cap orario raggiunto → nessuna run, anche senza arretrato');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
