/**
 * Fuso orario del server — orari mostrati sbagliati nelle notifiche
 * ==================================================================
 *
 * Segnalazione utente: i messaggi di cooldown su Telegram dicevano "fino alle
 * 12" quando erano effettivamente le 13. Non è un problema di sincronizzazione
 * dell'orologio (l'NTP del VPS è corretto, verificato con `timedatectl`): è che
 * il container Docker risolve UTC di default (nessuna variabile TZ impostata),
 * e `new Date(x).toLocaleTimeString('it-IT')` — in `src/perps/portfolio.js` e in
 * altri 5 punti lato server — usa il fuso del *sistema*, non quello implicito
 * nella stringa di locale 'it-IT' (equivoco comune: il locale controlla solo il
 * formato — 24h, separatori — mai il fuso).
 *
 * Il fix è `TZ=Europe/Rome` nell'ambiente del servizio `app` in
 * docker-compose.yml: un solo punto per tutti i punti lato server, e — a
 * differenza di un offset fisso — gestisce da solo il passaggio CET/CEST.
 *
 * Questi test verificano (a) che la configurazione la dichiari e (b) che il
 * comportamento reale, in un processo Node con quel TZ (come lo vedrà il
 * container), produca l'ora di Roma e non quella UTC.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');

test('docker-compose.yml: il servizio app dichiara TZ=Europe/Rome', () => {
  const yml = fs.readFileSync(COMPOSE, 'utf8');
  const appService = yml.slice(yml.indexOf('\n  app:'), yml.indexOf('\n  caddy:'));
  assert.match(appService, /TZ=Europe\/Rome/, 'manca TZ=Europe/Rome nell\'ambiente del servizio app');
});

/** Formatta lo stesso istante UTC in un processo Node con il TZ indicato — replica esattamente come lo vedrà il container. */
function formatWithTz(isoUtc, tz) {
  const env = { ...process.env, TZ: tz };
  const out = execFileSync(process.execPath, ['-e', `
    process.stdout.write(new Date(process.argv[1]).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
  `, isoUtc], { env, encoding: 'utf8' });
  return out;
}

test('TZ=UTC (il container prima del fix, immagine base senza TZ impostata): l\'ora esce in UTC, non a Roma', () => {
  // 10 agosto, piena CEST (UTC+2): le 16:00 UTC sono le 18:00 a Roma, ma il
  // container — senza TZ esplicita — risolve UTC (verificato dal vero
  // container sul VPS: node -e "Intl.DateTimeFormat().resolvedOptions().timeZone" → "UTC").
  const senzaTz = formatWithTz('2026-08-10T16:00:00.000Z', 'UTC');
  assert.equal(senzaTz, '16:00', 'a TZ=UTC il processo mostra l\'ora UTC grezza — è il bug riportato');
});

test('con TZ=Europe/Rome (dopo il fix): l\'ora esce corretta, con l\'ora legale applicata', () => {
  // Stessa istante di cui sopra, in piena CEST (agosto): 16:00 UTC = 18:00 locali.
  const conTz = formatWithTz('2026-08-10T16:00:00.000Z', 'Europe/Rome');
  assert.equal(conTz, '18:00', 'con TZ=Europe/Rome il messaggio di cooldown deve mostrare l\'ora locale, non UTC');
});

test('con TZ=Europe/Rome: anche in inverno (CET, UTC+1) risulta corretto — niente offset fisso', () => {
  // 10 gennaio, piena CET (UTC+1): le 16:00 UTC sono le 17:00 a Roma.
  const inverno = formatWithTz('2026-01-10T16:00:00.000Z', 'Europe/Rome');
  assert.equal(inverno, '17:00', 'Europe/Rome deve passare da solo a CET fuori dall\'ora legale, senza bisogno di un secondo fix a ottobre');
});
