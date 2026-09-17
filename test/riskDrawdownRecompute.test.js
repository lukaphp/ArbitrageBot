/**
 * RESIDUO DI CRIT-05 — il drawdown massimo persistito non si può correggere.
 * ==========================================================================
 *
 * `mergeDrawdownState` è MONOTONO per disegno: `maxUsd`/`maxPct` sono il massimo
 * fra il valore calcolato sulla curva esposta e quello persistito in
 * `risk_drawdown_state`. È corretto nel caso normale — la curva mostrata è
 * limitata agli ultimi campioni, e un vero massimo storico non deve sparire
 * perché è uscito dalla finestra.
 *
 * Quello che mancava è il caso opposto: quando si scopre che lo STORICO su cui
 * quel massimo è stato calcolato era sbagliato (CRIT-05 ha eliminato un doppio
 * conteggio dell'equity che gonfiava `risk_equity_history`), non esisteva
 * nessun modo di correggerlo. Il primo test qui sotto è la caratterizzazione del
 * problema, e mostra il punto che rende una correzione "solo dati" insufficiente:
 * ripulire `risk_equity_history` NON basta, perché il pavimento persistito
 * sopravvive alla correzione e viene riscritto identico al primo giro.
 *
 * Non è un numero cosmetico: `deriveRiskAlerts` emette `drawdown-critical` sopra
 * il 10% e `summarizeRisk` porta la board a `blocked`, quindi un drawdown mai
 * accaduto lascia un alert critico che non si spegnerà mai — e lo stesso valore
 * finisce nel contesto del consulente AI (`get_risk_snapshot`,
 * `get_equity_history`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PerpsDatabase } from '../src/db/database.js';
import {
  calculateDrawdown,
  mergeDrawdownState,
  recomputeDrawdownFromHistory,
  deriveRiskAlerts,
  summarizeRisk,
  RISK_ALERT_THRESHOLDS
} from '../src/perps/riskSnapshot.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'recompute-drawdown.js');

const NETWORK = 'testnet';
const ADDRESS = '0xDEMOADDR';

/** Curva CORRETTA dopo il fix: equity piatta, nessun drawdown reale. */
const CURVA_CORRETTA = [
  { time: 100, value: 1000 },
  { time: 101, value: 1010 },
  { time: 102, value: 1005 }
];

/** Il pavimento scritto PRIMA della correzione, frutto dello storico gonfiato. */
const PAVIMENTO_FANTASMA = {
  peak: 2000,
  current: 1005,
  maxUsd: 600,
  maxPct: 30,
  currentUsd: 0,
  currentPct: 0
};

function freshDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-ddown-'));
  const dbPath = path.join(tempDir, 'perps.db');
  const database = new PerpsDatabase({ dbPath });
  database.init();
  for (const p of CURVA_CORRETTA) {
    database.insertRiskEquitySample(NETWORK, ADDRESS, p.time, p.value, 180);
  }
  database.upsertRiskDrawdownState(NETWORK, ADDRESS, PAVIMENTO_FANTASMA, 102000);
  return { database, dbPath, tempDir };
}

/** Quello che fa `/api/perps/risk` a ogni chiamata (server.js). */
function letturaComeLaRotta(database) {
  const history = database.listRiskEquityHistory(NETWORK, ADDRESS, 2000);
  const persisted = database.getRiskDrawdownState(NETWORK, ADDRESS);
  const drawdown = mergeDrawdownState(calculateDrawdown(history), persisted);
  database.upsertRiskDrawdownState(NETWORK, ADDRESS, drawdown, 103000);
  return drawdown;
}

test('caratterizzazione: correggere lo storico non abbassa il massimo — lo fa CRESCERE', () => {
  const { database, tempDir } = freshDb();
  try {
    // La curva in DB è già quella corretta: il drawdown vero è ~0.5%.
    const vero = calculateDrawdown(database.listRiskEquityHistory(NETWORK, ADDRESS, 2000));
    assert.ok(vero.maxPct < 1, `drawdown reale ${vero.maxPct}%`);

    const letto = letturaComeLaRotta(database);

    // Il valore riportato non è nemmeno il 30% persistito: è PEGGIO, ed è il
    // punto che la segnalazione sottostimava. `mergeDrawdownState` tiene il
    // `peak` più alto fra curva e persistito (2000, residuo dello storico
    // gonfiato) e ci sottrae l'equity CORRENTE corretta (1005), fabbricando un
    // drawdown "in corso" di 995 USD che non è mai accaduto — poi promosso a
    // massimo. Correggere la storia non solo non ripulisce il pavimento:
    // aumenta la distanza dal picco fantasma e peggiora il numero.
    assert.ok(Math.abs(letto.maxPct - 49.75) < 1e-9, `maxPct ${letto.maxPct}, atteso 49.75`);
    assert.ok(Math.abs(letto.currentUsd - 995) < 1e-9,
      `currentUsd ${letto.currentUsd}: è dato per drawdown ATTUALE, non solo storico`);

    // E si riscrive a ogni giro: nessun meccanismo lo fa decadere.
    assert.ok(database.getRiskDrawdownState(NETWORK, ADDRESS).maxDrawdownPct > 30);

    // Conseguenza operativa: alert critico permanente e board bloccata.
    const alerts = deriveRiskAlerts({ drawdown: letto, limits: RISK_ALERT_THRESHOLDS });
    assert.ok(alerts.some(a => a.id === 'drawdown-critical'), 'alert critico da un drawdown fantasma');
    assert.equal(summarizeRisk(alerts).status, 'blocked');
  } finally {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recomputeDrawdownFromHistory: ricalcola dalla curva ignorando il persistito', () => {
  const { database, tempDir } = freshDb();
  try {
    const history = database.listRiskEquityHistory(NETWORK, ADDRESS, 2000);
    const ricalcolato = recomputeDrawdownFromHistory(history);
    assert.ok(ricalcolato, 'con una curva disponibile il ricalcolo produce un risultato');
    assert.equal(ricalcolato.peak, 1010);
    assert.ok(Math.abs(ricalcolato.maxUsd - 5) < 1e-9, `maxUsd ${ricalcolato.maxUsd}, atteso 5`);
    assert.ok(ricalcolato.maxPct < 1, `maxPct ${ricalcolato.maxPct}, atteso <1%`);
  } finally {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recomputeDrawdownFromHistory: senza curva utilizzabile rifiuta invece di scrivere zeri', () => {
  assert.equal(recomputeDrawdownFromHistory([]), null, 'storico vuoto');
  assert.equal(recomputeDrawdownFromHistory(null), null, 'storico assente');
  assert.equal(
    recomputeDrawdownFromHistory([{ time: 1, value: 'n/d' }, { time: 2, value: null }]),
    null,
    'nessun campione numerico: azzerare il massimo sarebbe una bugia diversa, non una correzione'
  );
});

test('deleteRiskDrawdownState: rimuove il pavimento e la lettura riparte dalla curva', () => {
  const { database, tempDir } = freshDb();
  try {
    assert.equal(database.deleteRiskDrawdownState(NETWORK, ADDRESS), true);
    assert.equal(database.getRiskDrawdownState(NETWORK, ADDRESS), null);
    // Idempotente: rimuovere due volte non è un errore.
    assert.equal(database.deleteRiskDrawdownState(NETWORK, ADDRESS), false);

    // Senza pavimento la rotta riparte dalla sola curva…
    const letto = letturaComeLaRotta(database);
    assert.ok(letto.maxPct < 1, `dopo la rimozione la rotta legge ${letto.maxPct}%`);
    // …e la riga torna subito, riscritta con il valore VERO: la cancellazione
    // non lascia un buco permanente, riseminala. È il motivo per cui lo script
    // ricalcola e riscrive invece di limitarsi a cancellare.
    assert.ok(database.getRiskDrawdownState(NETWORK, ADDRESS).maxDrawdownPct < 1);
  } finally {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- Lo strumento operativo: script CLI su processo figlio ----

function runScript(args, dbPath) {
  return spawnSync(process.execPath, [SCRIPT, `--db=${dbPath}`, ...args], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' }
  });
}

test('script: senza --apply mostra il confronto e NON tocca il DB', () => {
  const { database, dbPath, tempDir } = freshDb();
  database.close();
  try {
    const r = runScript([`--network=${NETWORK}`, `--address=${ADDRESS}`], dbPath);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /30/, 'mostra il valore persistito attuale');
    assert.match(r.stdout, /--apply/, 'dice come applicare davvero');

    const check = new PerpsDatabase({ dbPath });
    check.init();
    assert.equal(check.getRiskDrawdownState(NETWORK, ADDRESS).maxDrawdownPct, 30,
      'una simulazione non deve scrivere niente');
    check.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('script --apply: riscrive il pavimento e la board si sblocca', () => {
  const { database, dbPath, tempDir } = freshDb();
  database.close();
  try {
    const r = runScript([`--network=${NETWORK}`, `--address=${ADDRESS}`, '--apply'], dbPath);
    assert.equal(r.status, 0, r.stderr);

    const check = new PerpsDatabase({ dbPath });
    check.init();
    const stato = check.getRiskDrawdownState(NETWORK, ADDRESS);
    assert.ok(stato.maxDrawdownPct < 1, `maxDrawdownPct ${stato.maxDrawdownPct} dopo il ricalcolo`);
    assert.ok(Math.abs(stato.maxDrawdownUsd - 5) < 1e-9);
    assert.equal(stato.peakEquity, 1010);

    // Il giro successivo della rotta non fa risalire il fantasma.
    const letto = letturaComeLaRotta(check);
    assert.ok(letto.maxPct < 1, `la rotta legge ancora ${letto.maxPct}%`);
    const alerts = deriveRiskAlerts({ drawdown: letto, limits: RISK_ALERT_THRESHOLDS });
    assert.equal(alerts.filter(a => a.id === 'drawdown-critical').length, 0);
    assert.equal(summarizeRisk(alerts).status, 'ok');
    check.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('script: storico assente → rifiuta con exit code non zero, senza scrivere', () => {
  const { database, dbPath, tempDir } = freshDb();
  database.close();
  try {
    const r = runScript(['--network=testnet', '--address=0xSCONOSCIUTO', '--apply'], dbPath);
    assert.notEqual(r.status, 0, 'un ricalcolo senza curva non può riuscire in silenzio');
    assert.match(`${r.stderr}${r.stdout}`, /storico|curva/i);

    const check = new PerpsDatabase({ dbPath });
    check.init();
    assert.equal(check.getRiskDrawdownState('testnet', '0xSCONOSCIUTO'), null);
    // L'account buono non è stato toccato per sbaglio.
    assert.equal(check.getRiskDrawdownState(NETWORK, ADDRESS).maxDrawdownPct, 30);
    check.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('script: --address mancante → uso e exit code non zero', () => {
  const { database, dbPath, tempDir } = freshDb();
  database.close();
  try {
    const r = runScript([`--network=${NETWORK}`], dbPath);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /--address/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
