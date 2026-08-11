/**
 * CRIT-02 — il cooldown di portafoglio deve sopravvivere a un riavvio.
 * ==================================================================
 *
 * `this.cooldowns = new Map()` era puramente in memoria: deploy, crash o OOM
 * azzeravano ogni cooldown attivo, riaprendo esattamente la finestra di re-entry
 * impulsivo che il cooldown esiste per chiudere — e nel momento peggiore, subito
 * dopo una serie di perdite.
 *
 * Persistenza in `settings` (la stessa tabella chiave-valore già usata per
 * `portfolio_limits`): è un mapping botId → timestamp, la stessa forma di dato.
 * Nessuna migrazione di schema.
 *
 * QUAL-01 item 2 vive sulle stesse righe: l'attivazione del cooldown non è più un
 * effetto collaterale di `canOpen()` ma un `recordLoss()` esplicito. Le due storie
 * sono state implementate in un unico passaggio su portfolio.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';
import { Portfolio } from '../src/perps/portfolio.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-cdpersist-'));
db.dbPath = path.join(tempDir, 'perps.db');

const COOLDOWN_KEY = 'portfolio_cooldowns';
const ACCOUNT = { positions: [] };

test('un cooldown attivo sopravvive al riavvio del processo', () => {
  const botId = 'cd-survive';
  const first = new Portfolio();
  first.setLimits({ maxConsecutiveLosses: 3, cooldownMinutes: 60 });

  first.recordLoss(botId, 3);
  const until = first.cooldownInfo(botId);
  assert.ok(until > Date.now(), 'cooldown attivo nell\'istanza corrente');

  // "Riavvio": istanza nuova, stesso DB. Prima di questo fix ripartiva vuota.
  const afterRestart = new Portfolio();
  assert.equal(afterRestart.cooldownInfo(botId), until,
    'il cooldown è ancora attivo, con lo stesso istante di scadenza');
  const verdict = afterRestart.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 0 });
  assert.equal(verdict.ok, false, 'e blocca ancora l\'apertura');
  assert.equal(verdict.cooldownUntil, until,
    'cooldownUntil resta il timestamp grezzo: è ciò che distingue un episodio dal successivo (una notifica per episodio)');
});

test('un cooldown già scaduto non viene ripristinato', () => {
  const botId = 'cd-expired';
  db.setSetting(COOLDOWN_KEY, JSON.stringify({ [botId]: Date.now() - 1000 }));

  const p = new Portfolio();
  assert.equal(p.cooldownInfo(botId), null, 'niente da ripristinare per un timestamp nel passato');
  assert.equal(p.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 0 }).ok, true);
});

test('valori corrotti nel settings: scartati singolarmente, non fanno saltare il resto', () => {
  const valid = Date.now() + 30 * 60000;
  db.setSetting(COOLDOWN_KEY, JSON.stringify({
    'cd-bad-1': 'domani', 'cd-bad-2': null, 'cd-good': valid
  }));

  const p = new Portfolio();
  assert.equal(p.cooldownInfo('cd-bad-1'), null);
  assert.equal(p.cooldownInfo('cd-bad-2'), null);
  assert.equal(p.cooldownInfo('cd-good'), valid, 'la voce valida viene comunque ripristinata');
});

test('DB illeggibile all\'avvio: si parte senza cooldown pregressi, non si crasha', () => {
  const realGetSetting = db.getSetting.bind(db);
  db.getSetting = (key) => {
    if (key === COOLDOWN_KEY) throw new Error('DB non disponibile (disco pieno)');
    return realGetSetting(key);
  };
  try {
    const p = new Portfolio();
    // Nessuna eccezione propagata: il server deve poter partire comunque.
    assert.equal(p.cooldownInfo('qualsiasi'), null);
    assert.equal(p.canOpen({ account: ACCOUNT, botId: 'qualsiasi', consecutiveLosses: 0 }).ok, true,
      'degrado: si opera senza cooldown pregressi invece di non partire');
  } finally {
    db.getSetting = realGetSetting;
  }
});

test('DB non scrivibile: il cooldown vale comunque in memoria (nessuna eccezione al chiamante)', () => {
  const realSetSetting = db.setSetting.bind(db);
  db.setSetting = () => { throw new Error('DB in sola lettura'); };
  try {
    const p = new Portfolio();
    p.recordLoss('cd-nowrite', 3);
    assert.ok(p.cooldownInfo('cd-nowrite') > Date.now(),
      'la protezione in memoria resta: la persistenza è un miglioramento, non un prerequisito');
  } finally {
    db.setSetting = realSetSetting;
  }
});

test('nessuna migrazione di schema: il cooldown vive in `settings`', () => {
  const p = new Portfolio();
  p.recordLoss('cd-settings', 5);
  const raw = db.getSetting(COOLDOWN_KEY);
  assert.ok(raw, 'presente nella tabella settings, non in una tabella nuova');
  assert.ok(JSON.parse(raw)['cd-settings'] > Date.now());

  // Nessuna colonna/tabella aggiunta per questa storia.
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  assert.ok(!tables.some(t => /cooldown/i.test(t)), `nessuna tabella dedicata: ${tables.join(', ')}`);
});

test('la scadenza pulisce anche il persistito (niente accumulo di voci morte)', () => {
  const p = new Portfolio();
  p.cooldowns.set('cd-stale', Date.now() - 5000); // episodio scaduto
  p.recordLoss('cd-fresh', 3);                    // qualunque scrittura ripulisce
  const persisted = JSON.parse(db.getSetting(COOLDOWN_KEY));
  assert.ok(!('cd-stale' in persisted), 'le voci scadute non vengono ri-scritte');
  assert.ok('cd-fresh' in persisted);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
