/**
 * CRIT-02-EXTRA — `getLimits()` non deve poter far esplodere `canOpen()`.
 * =====================================================================
 *
 * Trovato da Annie verificando CRIT-02: `getLimits()` leggeva
 * `db.getSetting('portfolio_limits')` e ci faceva `JSON.parse` senza rete di
 * protezione. Un DB non leggibile, o quella singola chiave corrotta, non produceva
 * un degrado ma un'eccezione che risaliva fino a `canOpen()` — quindi fino a
 * `_openPosition()` e a `riskAgent.evaluate()`. Non è una regressione di questo
 * sprint, ma CRIT-02 ha appena reso lo stesso meccanismo di lettura più critico
 * (il cooldown persistito passa da lì).
 *
 * Asimmetria deliberata, verificata in fondo al file: la LETTURA degrada ai
 * default, la SCRITTURA no. `setLimits()` è un'azione dell'utente ("salva questi
 * limiti"): ingoiare l'errore vorrebbe dire rispondere "salvato" a un salvataggio
 * mai avvenuto, e l'utente opererebbe convinto di avere cap che non esistono.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';
import logger from '../src/utils/logger.js';
import { Portfolio } from '../src/perps/portfolio.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-limitsguard-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const warnings = [];
const realWarn = logger.warn.bind(logger);
logger.warn = (message) => { warnings.push(String(message)); };

const KEY = 'portfolio_limits';
const ACCOUNT = { positions: [] };

/** Esegue `fn` con `db.getSetting` che lancia sulla sola chiave dei limiti. */
function withBrokenRead(fn) {
  const real = db.getSetting.bind(db);
  db.getSetting = (key, fallback) => {
    if (key === KEY) throw new Error('DB non leggibile (I/O error)');
    return real(key, fallback);
  };
  try { return fn(); } finally { db.getSetting = real; }
}

test('DB non leggibile: si ripiega sui default invece di sollevare', () => {
  warnings.length = 0;
  withBrokenRead(() => {
    const p = new Portfolio();
    const limits = p.getLimits();
    assert.equal(limits.maxConcurrentPositions, 3, 'default applicati');
    assert.equal(limits.maxConsecutiveLosses, 3);
    assert.ok(limits.maxTotalExposureUsd > 0);
    assert.ok(warnings.some(w => /limiti di portafoglio/i.test(w)),
      'degradare in silenzio significherebbe operare con cap diversi da quelli configurati senza saperlo');
  });
});

test('DB non leggibile: canOpen continua a decidere, e a decidere in sicurezza', () => {
  withBrokenRead(() => {
    const p = new Portfolio();
    // Non solleva…
    const ok = p.canOpen({ account: ACCOUNT, plannedNotional: 10, botId: 'lg-1', consecutiveLosses: 0 });
    assert.equal(ok.ok, true);
    // …e continua ad applicare i limiti (default: max 3 posizioni concorrenti).
    const full = p.canOpen({
      account: { positions: [{ positionValue: 1 }, { positionValue: 1 }, { positionValue: 1 }] },
      plannedNotional: 10, botId: 'lg-1', consecutiveLosses: 0
    });
    assert.equal(full.ok, false, 'un guasto del DB non deve trasformarsi in "nessun limite"');
    assert.match(full.reason, /posizioni concorrenti/i);
  });
});

test('JSON corrotto in `portfolio_limits`: default, con l\'anomalia loggata', () => {
  db.setSetting(KEY, '{ maxConcurrentPositions: 5,,, ');
  warnings.length = 0;
  const p = new Portfolio();
  assert.equal(p.getLimits().maxConcurrentPositions, 3);
  assert.ok(warnings.some(w => /limiti di portafoglio/i.test(w)));
  assert.equal(p.canOpen({ account: ACCOUNT, botId: 'lg-2', consecutiveLosses: 0 }).ok, true);
});

test('JSON valido ma non un oggetto: default (nessuna chiave spuria nei limiti)', () => {
  for (const raw of ['42', '"stringa"', 'null', '[1,2,3]']) {
    db.setSetting(KEY, raw);
    const limits = new Portfolio().getLimits();
    assert.equal(limits.maxConcurrentPositions, 3, `valore ${raw}`);
    assert.equal(limits.cooldownMinutes, 60);
    assert.ok(!('0' in limits), `nessuna chiave spuria da ${raw}`);
  }
});

test('configurazione parziale valida: merge coi default (comportamento invariato)', () => {
  db.setSetting(KEY, JSON.stringify({ maxConcurrentPositions: 1 }));
  const limits = new Portfolio().getLimits();
  assert.equal(limits.maxConcurrentPositions, 1, 'il valore configurato vince');
  assert.equal(limits.maxConsecutiveLosses, 3, 'gli altri restano ai default');
});

test('recordLoss non esplode con i limiti illeggibili (usa la stessa lettura)', () => {
  withBrokenRead(() => {
    const p = new Portfolio();
    const until = p.recordLoss('lg-3', 3); // 3 = default maxConsecutiveLosses
    assert.ok(until > Date.now(), 'il cooldown si attiva comunque, sui default');
  });
});

test('la SCRITTURA dei limiti non degrada: l\'errore arriva a chi ha chiesto di salvare', () => {
  const realSet = db.setSetting.bind(db);
  db.setSetting = () => { throw new Error('DB in sola lettura'); };
  try {
    const p = new Portfolio();
    assert.throws(() => p.setLimits({ maxConcurrentPositions: 9 }), /sola lettura/,
      'rispondere "salvato" a un salvataggio mai avvenuto è peggio di un errore visibile');
  } finally {
    db.setSetting = realSet;
  }
});

test.after(() => {
  logger.warn = realWarn;
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
