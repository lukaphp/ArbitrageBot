/**
 * TEST-01: copertura di scripts/rotate-encryption-key.js
 * =====================================================
 *
 * È lo script che rende ruotabile la chiave di cifratura a riposo (docs/DEPLOY.md
 * §10): se sbaglia, i segreti che proteggono i wallet agent diventano
 * irrecuperabili. Finora non aveva alcun test.
 *
 * Lo script è un CLI (nessuna funzione esportata) e il suo contratto sta tutto
 * in: cosa scrive sul DB, cosa NON scrive, e con quale exit code termina. Viene
 * quindi eseguito davvero come processo figlio su un DB temporaneo — nessuna
 * rifattorizzazione dello script è stata necessaria, e in più il test copre anche
 * il parsing di `--apply` e gli exit code, che una funzione estratta non
 * coprirebbe. Copre quindi anche la mitigazione del rischio R4 dello sprint
 * ("test manuale CLI oltre ai test automatici"): qui il test automatico È il CLI.
 *
 * Il DB è sempre un file temporaneo (mai data/perps.db) e l'ambiente del figlio è
 * costruito da zero, con il file di configurazione locale neutralizzato via
 * DOTENV_CONFIG_PATH: nessuna dipendenza da come è configurata la macchina.
 *
 * UNA CORREZIONE È STATA NECESSARIA: la query sulle chiavi agent leggeva la
 * colonna `address`, che nello schema non esiste (è `master_address`) — la
 * rotazione delle chiavi agent lanciava "no such column: address" e non era
 * eseguibile affatto. Senza quella correzione il primo criterio di accettazione
 * ("rotazione riuscita, i dati cifrati restano leggibili") non è verificabile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encrypt, decrypt } from '../src/perps/secretBox.js';
import { PerpsDatabase } from '../src/db/database.js';

const SCRIPT = fileURLToPath(new URL('../scripts/rotate-encryption-key.js', import.meta.url));

// Chiavi di test generate ad hoc: nessun valore reale, nessun ambiente toccato in
// modo permanente (vedi withKeys).
const OLD_SECRET = 'chiave-di-test-vecchia-' + '0'.repeat(40);
const NEW_SECRET = 'chiave-di-test-nuova-' + '1'.repeat(40);
const GHOST_SECRET = 'chiave-di-test-mai-fornita-allo-script';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-rotate-'));
const emptyConfig = path.join(tempRoot, 'empty.cfg');
fs.writeFileSync(emptyConfig, '');

/** Esegue fn con un portachiavi specifico, ripristinando l'ambiente dopo. */
function withKeys({ key, keyId, oldKeys }, fn) {
  const vars = {
    AGENT_ENCRYPTION_KEY: key,
    AGENT_ENCRYPTION_KEY_ID: keyId,
    AGENT_ENCRYPTION_KEYS_OLD: oldKeys
  };
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Cifra un valore come se fosse stato scritto dalla chiave v<keyId>. */
const encryptAs = (plain, secret, keyId) =>
  withKeys({ key: secret, keyId, oldKeys: undefined }, () => encrypt(plain));

/** Decifra usando SOLO la chiave nuova: prova che il dato è leggibile "dopo". */
const decryptWithNewKeyOnly = (payload) =>
  withKeys({ key: NEW_SECRET, keyId: 2, oldKeys: undefined }, () => decrypt(payload));

let dbSeq = 0;
/** DB temporaneo con schema reale + le righe passate. */
function makeDb({ wallets = [], telegram = null }) {
  const dbPath = path.join(tempRoot, `perps-${++dbSeq}.db`);
  const d = new PerpsDatabase({ dbPath });
  d.init();
  const ins = d.db.prepare(`INSERT INTO agent_wallets
    (master_address, network, agent_address, encrypted_key, agent_name, approved_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const w of wallets) {
    ins.run(w.master, w.network || 'testnet', '0xagent', w.enc, 'test', Date.now());
  }
  if (telegram) d.setSetting('telegram_config', JSON.stringify(telegram));
  d.close();
  return dbPath;
}

/** Legge lo stato persistito così com'è, senza interpretarlo. */
function readDb(dbPath) {
  const d = new PerpsDatabase({ dbPath });
  d.init();
  const wallets = d.db.prepare('SELECT master_address, encrypted_key FROM agent_wallets ORDER BY master_address').all();
  const telegramRaw = d.getSetting('telegram_config');
  d.close();
  let telegram = null;
  try { telegram = telegramRaw ? JSON.parse(telegramRaw) : null; } catch { telegram = null; }
  return { wallets, telegram, telegramRaw };
}

/** Esegue lo script sul DB indicato, con la chiave nuova corrente e la vecchia disponibile. */
function runRotate(dbPath, args = [], { oldKeys = `1:${OLD_SECRET}` } = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: emptyConfig,
      DOTENV_CONFIG_QUIET: 'true',
      DB_PATH: dbPath,
      AGENT_ENCRYPTION_KEY: NEW_SECRET,
      AGENT_ENCRYPTION_KEY_ID: '2',
      AGENT_ENCRYPTION_KEYS_OLD: oldKeys
    }
  });
  assert.equal(res.error, undefined, 'lo script deve essere eseguibile');
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const AGENT_PLAIN = '0xchiave-agent-di-test-non-un-valore-reale';
const TOKEN_PLAIN = '1234567:token-telegram-di-test';

/** Fixture standard: una chiave agent su v1, una già su v2, il token su v1. */
function standardFixture() {
  return makeDb({
    wallets: [
      { master: '0xAAA', enc: encryptAs(AGENT_PLAIN, OLD_SECRET, 1) },   // da ruotare
      { master: '0xBBB', enc: encryptAs(AGENT_PLAIN, NEW_SECRET, 2) }    // già corrente
    ],
    telegram: { tokenEnc: encryptAs(TOKEN_PLAIN, OLD_SECRET, 1), chatId: '42', enabled: true }
  });
}

test('dry-run (senza --apply): non scrive NULLA sul DB', () => {
  const dbPath = standardFixture();
  const before = readDb(dbPath);

  const { code, out } = runRotate(dbPath);

  assert.equal(code, 0);
  assert.match(out, /Modalità\s*:\s*verifica \(nessuna scrittura\)/);
  assert.match(out, /Da ri-cifrare\s*:\s*2/, 'due segreti da ruotare (v1), il terzo è già su v2');
  assert.match(out, /Ri-cifrati\s*:\s*0/);
  assert.match(out, /Rilancia con --apply/);

  const after = readDb(dbPath);
  assert.deepEqual(after.wallets, before.wallets, 'chiavi agent byte-per-byte identiche');
  assert.equal(after.telegramRaw, before.telegramRaw, 'telegram_config byte-per-byte identico');
  assert.ok(!out.includes(AGENT_PLAIN) && !out.includes(TOKEN_PLAIN),
    'lo script non stampa mai un segreto in chiaro');
});

test('--apply: ruota v1 → v2 e i dati restano leggibili con la sola chiave nuova', () => {
  const dbPath = standardFixture();
  const before = readDb(dbPath);

  const { code, out } = runRotate(dbPath, ['--apply']);

  assert.equal(code, 0);
  assert.match(out, /Modalità\s*:\s*APPLICA/);
  assert.match(out, /Ri-cifrati\s*:\s*2/);

  const after = readDb(dbPath);
  const wa = after.wallets.find(w => w.master_address === '0xAAA');
  const wb = after.wallets.find(w => w.master_address === '0xBBB');
  const beforeA = before.wallets.find(w => w.master_address === '0xAAA');
  const beforeB = before.wallets.find(w => w.master_address === '0xBBB');

  assert.notEqual(wa.encrypted_key, beforeA.encrypted_key, 'la chiave agent su v1 è stata ri-cifrata');
  assert.match(wa.encrypted_key, /^v2:/, 'marcata con la versione corrente');
  assert.equal(decryptWithNewKeyOnly(wa.encrypted_key), AGENT_PLAIN,
    'il segreto è ancora leggibile DOPO la rotazione, con la sola chiave nuova');

  assert.equal(wb.encrypted_key, beforeB.encrypted_key, 'chi era già su v2 non viene toccato');

  assert.match(after.telegram.tokenEnc, /^v2:/);
  assert.equal(decryptWithNewKeyOnly(after.telegram.tokenEnc), TOKEN_PLAIN, 'token Telegram leggibile');
  assert.equal(after.telegram.chatId, '42', 'gli altri campi di telegram_config sono preservati');
  assert.equal(after.telegram.enabled, true);

  // Rilanciando, non c'è più nulla da fare (rotazione idempotente).
  const second = runRotate(dbPath, ['--apply']);
  assert.equal(second.code, 0);
  assert.match(second.out, /Tutto già cifrato con la chiave corrente/);
  assert.deepEqual(readDb(dbPath).wallets, after.wallets, 'seconda passata: nessuna riscrittura');
});

test('valore non decifrabile: lasciato INTATTO, segnalato, exit ≠ 0 — e gli altri vengono comunque ruotati', () => {
  // v9 è cifrato con una chiave che allo script non viene mai fornita: è il caso
  // "chiave mancante nel portachiavi", quello in cui sovrascrivere significherebbe
  // perdere il segreto per sempre.
  const ghostEnc = encryptAs('segreto-perduto', GHOST_SECRET, 9);
  const dbPath = makeDb({
    wallets: [
      { master: '0xAAA', enc: encryptAs(AGENT_PLAIN, OLD_SECRET, 1) },
      { master: '0xZZZ', enc: ghostEnc }
    ]
  });

  const { code, out } = runRotate(dbPath, ['--apply']);

  assert.equal(code, 1, 'un segreto non decifrabile deve far uscire con codice ≠ 0');
  assert.match(out, /NON decifrabili \(lasciati intatti\)/);
  assert.match(out, /Chiave di cifratura v9 non disponibile/);
  assert.match(out, /AGENT_ENCRYPTION_KEYS_OLD/, 'l\'output dice come rimediare');

  const after = readDb(dbPath);
  const ghost = after.wallets.find(w => w.master_address === '0xZZZ');
  assert.equal(ghost.encrypted_key, ghostEnc,
    'il valore non decifrabile è byte-per-byte quello di prima: MAI sovrascritto');

  const good = after.wallets.find(w => w.master_address === '0xAAA');
  assert.match(good.encrypted_key, /^v2:/, 'i segreti decifrabili vengono comunque ruotati');
  assert.equal(decryptWithNewKeyOnly(good.encrypted_key), AGENT_PLAIN);
});

test('formato legacy (senza prefisso di versione): ruotato se la chiave che l\'ha prodotto è nel portachiavi', () => {
  // I valori scritti prima del versioning non hanno prefisso: vanno riconosciuti
  // come "da ruotare" e restare leggibili dopo.
  const legacy = withKeys({ key: OLD_SECRET, keyId: 1, oldKeys: undefined },
    () => encrypt(AGENT_PLAIN).replace(/^v\d+:/, ''));
  assert.ok(!/^v\d+:/.test(legacy), 'fixture in formato legacy');

  const dbPath = makeDb({ wallets: [{ master: '0xLEG', enc: legacy }] });
  const { code, out } = runRotate(dbPath, ['--apply']);

  assert.equal(code, 0);
  assert.match(out, /legacy \(senza versione\) → v2/);

  const after = readDb(dbPath);
  assert.match(after.wallets[0].encrypted_key, /^v2:/);
  assert.equal(decryptWithNewKeyOnly(after.wallets[0].encrypted_key), AGENT_PLAIN);
});

test('DB senza segreti: esce con 0 e non tocca niente', () => {
  const dbPath = makeDb({});
  const { code, out } = runRotate(dbPath, ['--apply']);
  assert.equal(code, 0);
  assert.match(out, /Segreti esaminati\s*:\s*0/);
  assert.match(out, /Tutto già cifrato con la chiave corrente/);
});

test('telegram_config con JSON illeggibile: segnalato, exit ≠ 0, valore non toccato', () => {
  const dbPath = makeDb({ wallets: [] });
  const d = new PerpsDatabase({ dbPath });
  d.init();
  d.setSetting('telegram_config', '{non-json');
  d.close();

  const { code, out } = runRotate(dbPath, ['--apply']);
  assert.equal(code, 1);
  assert.match(out, /telegram_config: JSON illeggibile/);
  assert.equal(readDb(dbPath).telegramRaw, '{non-json', 'valore illeggibile lasciato com\'era');
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
