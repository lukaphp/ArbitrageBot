/**
 * TEST-01: copertura di scripts/check-secrets.js
 * =============================================
 *
 * `check-secrets.js` è uno script CLI puro: nessuna funzione esportata, tutto il
 * comportamento sta nell'ambiente in ingresso e nel codice di uscita. Il modo
 * onesto di coprirlo è quindi eseguirlo davvero come processo figlio con un
 * ambiente controllato, invece di rifattorizzarlo per poterlo importare: così il
 * test copre anche il parsing dell'ambiente e l'exit code, cioè esattamente ciò
 * che `docs/DEPLOY.md` e lo script d'avvio si aspettano da lui. Nessuna modifica
 * allo script è stata necessaria per rendere possibile questo test.
 *
 * L'ambiente del figlio è costruito da ZERO (non eredita quello del processo di
 * test) e il caricamento del file di configurazione locale è neutralizzato con
 * DOTENV_CONFIG_PATH su un file vuoto: senza questo, il risultato dipenderebbe da
 * cosa ha configurato in locale chi lancia i test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-secrets.js', import.meta.url));

// File di configurazione vuoto: rende il test indipendente dalla macchina.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-secrets-'));
const emptyConfig = path.join(tempDir, 'empty.cfg');
fs.writeFileSync(emptyConfig, '');

/** Esegue lo script con un ambiente costruito da zero. */
function run(vars = {}) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: emptyConfig,
      DOTENV_CONFIG_QUIET: 'true',
      ...vars
    }
  });
  assert.equal(res.error, undefined, 'lo script deve essere eseguibile');
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

// Valori validi per i tre segreti critici (lunghezze minime: 32 / 16 / 0).
const CRITICAL_OK = {
  AGENT_ENCRYPTION_KEY: 'a'.repeat(64),
  SESSION_SECRET: 'b'.repeat(32),
  APP_PASSWORD_HASH: '$2b$10$' + 'c'.repeat(22)
};

test('produzione senza segreti critici: esce con codice ≠ 0', () => {
  const { code, out } = run({ NODE_ENV: 'production' });
  assert.notEqual(code, 0, 'in produzione i segreti critici mancanti devono bloccare');
  assert.equal(code, 1);
  assert.match(out, /segreti critici mancanti/i);
  assert.match(out, /AGENT_ENCRYPTION_KEY/);
  assert.match(out, /SESSION_SECRET/);
  assert.match(out, /APP_PASSWORD_HASH/);
});

test('sviluppo senza configurazione completa: non blocca', () => {
  const { code, out } = run({ NODE_ENV: 'development' });
  assert.equal(code, 0, 'in sviluppo l\'assenza di configurazione non deve bloccare');
  assert.match(out, /Nessun segreto critico mancante/i);
});

test('ambiente non impostato: non blocca (solo NODE_ENV=production è vincolante)', () => {
  const { code, out } = run({});
  assert.equal(code, 0);
  assert.match(out, /Ambiente: \(non impostato\)/);
});

test('produzione con i critici presenti e validi: esce con 0', () => {
  const { code, out } = run({ NODE_ENV: 'production', ...CRITICAL_OK });
  assert.equal(code, 0, 'con i critici a posto la produzione passa');
  assert.match(out, /Nessun segreto critico mancante/i);
});

test('produzione con un critico troppo corto: blocca e lo segnala senza stampare il valore', () => {
  const shortKey = 'troppo-corta-123';   // 16 caratteri, minimo 32
  const { code, out } = run({
    NODE_ENV: 'production',
    ...CRITICAL_OK,
    AGENT_ENCRYPTION_KEY: shortKey
  });
  assert.equal(code, 1, 'un valore presente ma sotto la lunghezza minima blocca come se fosse assente');
  assert.match(out, /TROPPO CORTA/);
  assert.match(out, new RegExp(`${shortKey.length} caratteri`));
  // Requisito di sicurezza dello script: mai stampare un valore, solo la lunghezza.
  assert.ok(!out.includes(shortKey), 'il valore del segreto non compare nell\'output');
  assert.ok(!out.includes(CRITICAL_OK.SESSION_SECRET), 'nessun altro valore compare nell\'output');
});

test('sviluppo con un critico troppo corto: segnalato ma non bloccante', () => {
  const { code, out } = run({ NODE_ENV: 'development', AGENT_ENCRYPTION_KEY: 'corta' });
  assert.equal(code, 0, 'in sviluppo resta un avviso, non un blocco');
  assert.match(out, /TROPPO CORTA/);
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
