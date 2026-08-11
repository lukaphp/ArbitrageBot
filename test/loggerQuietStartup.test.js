/**
 * WARN-01 — il logger non stampa niente di suo all'avvio.
 * =====================================================
 *
 * `logger.js:29` aveva una riga di debug ("🔧 Logger initialized - Level: …")
 * mai rimossa: l'unica del file che non passava dal formato strutturato del resto
 * del logger, stampata a ogni avvio del processo — quindi anche in cima all'output
 * di ogni script CLI e di ogni run di test.
 *
 * Verificato in un PROCESSO FIGLIO: è l'unico modo onesto di osservare cosa viene
 * scritto al CARICAMENTO del modulo (nel processo di test l'import è già avvenuto
 * prima che il test possa intercettare stdout).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const run = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
  cwd: new URL('..', import.meta.url).pathname,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});

test('importare il logger non produce output', () => {
  const out = run("await import('./src/utils/logger.js');");
  assert.equal(out.trim(), '', `il logger non deve stampare nulla all'import, invece: ${JSON.stringify(out)}`);
});

test('il logger continua a loggare quando gli si chiede di farlo', () => {
  const out = run(`
    const { default: logger } = await import('./src/utils/logger.js');
    logger.info('messaggio-di-prova');
    logger.warn('avviso-di-prova');
  `);
  assert.match(out, /messaggio-di-prova/, 'info funziona');
  assert.match(out, /avviso-di-prova/, 'warn funziona');
  assert.match(out, /\[INFO\]/, 'formato strutturato invariato (livello in chiaro)');
  // Una riga per messaggio: nessuna riga in più che si accoda ai log strutturati.
  assert.equal(out.trim().split('\n').length, 2);
});
