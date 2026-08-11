/**
 * QUAL-01 item 2 — `canOpen()` non scrive più lo stato che dichiara di verificare.
 * =============================================================================
 *
 * `canOpen()` prometteva una verifica e invece, nel ramo delle perdite
 * consecutive, ATTIVAVA il cooldown: chiunque volesse sapere "questo bot potrebbe
 * aprire?" — una diagnostica, una UI, un test — cambiava lo stato del sistema solo
 * per aver chiesto.
 *
 * Separazione: `canOpen()` pura (stesse decisioni, nessuna scrittura) e
 * `recordLoss(botId, consecutiveLosses)` esplicita, chiamata da
 * `bot._registerClose()` quando la perdita è CONFERMATA dai fill.
 *
 * Il blocco NON si allenta: `canOpen()` continua a rifiutare l'apertura appena le
 * perdite consecutive raggiungono il limite, anche se nessuno ha ancora chiamato
 * `recordLoss` (per esempio su posizioni chiuse prima di questo cambio).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';
import { Portfolio } from '../src/perps/portfolio.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-canopen-'));
db.dbPath = path.join(tempDir, 'perps.db');

const ACCOUNT = { positions: [] };

function fresh(limits = {}) {
  const p = new Portfolio();
  p.setLimits({ maxConcurrentPositions: 3, maxConsecutiveLosses: 3, cooldownMinutes: 60, ...limits });
  return p;
}

test('canOpen() non attiva alcun cooldown: chiamarla non cambia lo stato', () => {
  const p = fresh();
  const botId = 'pure-1';

  const first = p.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 3 });
  assert.equal(first.ok, false, 'blocca comunque: 3 perdite consecutive sul limite');
  assert.match(first.reason, /perdite consecutive/i);
  assert.equal(p.cooldownInfo(botId), null,
    'nessun cooldown scritto da una funzione di sola verifica');

  // Idempotente: dieci verifiche danno lo stesso esito della prima.
  for (let i = 0; i < 10; i++) {
    assert.equal(p.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 3 }).ok, false);
  }
  assert.equal(p.cooldownInfo(botId), null);
});

test('canOpen() torna a permettere l\'apertura quando la serie di perdite si interrompe', () => {
  const p = fresh();
  const botId = 'pure-2';
  assert.equal(p.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 3 }).ok, false);
  assert.equal(p.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 0 }).ok, true,
    'senza cooldown registrato, il verdetto dipende solo dagli input passati');
});

test('recordLoss() è il punto in cui il cooldown si attiva, e solo sopra il limite', () => {
  const p = fresh();

  assert.equal(p.recordLoss('rl-under', 2), null, 'sotto il limite: nessun cooldown');
  assert.equal(p.cooldownInfo('rl-under'), null);

  const until = p.recordLoss('rl-over', 3);
  assert.ok(until > Date.now(), 'raggiunto il limite: cooldown attivato');
  assert.equal(p.cooldownInfo('rl-over'), until);

  const blocked = p.canOpen({ account: ACCOUNT, botId: 'rl-over', consecutiveLosses: 0 });
  assert.equal(blocked.ok, false, 'e da lì in poi canOpen lo vede');
  assert.equal(blocked.cooldownUntil, until);
});

test('recordLoss() non allunga un cooldown già in corso a ogni chiamata', () => {
  const p = fresh();
  const first = p.recordLoss('rl-idem', 4);
  const second = p.recordLoss('rl-idem', 5);
  assert.equal(second, first,
    'lo stesso episodio non si rinnova: sarebbe un cooldown che non scade mai finché il bot perde');
});

test('gli altri limiti restano puri come prima (posizioni concorrenti, esposizione)', () => {
  const p = fresh({ maxConcurrentPositions: 1, maxTotalExposureUsd: 1000 });
  const account = { positions: [{ positionValue: 900 }] };

  const tooMany = p.canOpen({ account, plannedNotional: 10, botId: 'lim-1', consecutiveLosses: 0 });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.reason, /posizioni concorrenti/i);

  const p2 = fresh({ maxConcurrentPositions: 5, maxTotalExposureUsd: 1000 });
  const tooBig = p2.canOpen({ account, plannedNotional: 200, botId: 'lim-2', consecutiveLosses: 0 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.reason, /esposizione/i);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
