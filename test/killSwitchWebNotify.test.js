/**
 * DEBT-01 item 3: il kill-switch cambiato DA WEB notifica su Telegram.
 * ====================================================================
 *
 * Asimmetria chiusa qui. Dopo TG-01 il percorso Telegram
 * (`/killswitch on|off`) manda sempre una notifica sul canale principale, con la
 * motivazione esplicita che «un kill-switch non è un'azione privata di chi l'ha
 * digitata». Il percorso web era muto: `POST /api/agents/killswitch` — l'unico
 * modo di SPEGNERE il kill-switch dalla cockpit (`perps.resumeFromKillSwitch`) —
 * si limitava a scrivere il flag. Risultato: le aperture tornavano consentite
 * senza che ne restasse traccia sul canale che l'operatore guarda davvero.
 *
 * Coperto:
 *  - `{on:false}` da web notifica, dice che le aperture sono di nuovo consentite
 *    e che i bot fermati NON ripartono da soli (vincolo UI-01, come TG-01);
 *  - `{on:true}` da web notifica, e dichiara il vero effetto di QUESTA rotta:
 *    blocca le aperture ma NON ferma i bot in esecuzione (quello lo fa
 *    `/api/perps/killswitch`). Mai annunciare qualcosa che non è stato fatto;
 *  - nessuna notifica se lo stato non cambia (una notifica per cambio reale, non
 *    per click), mentre l'audit registra comunque il tentativo;
 *  - il flag persistito resta la fonte di verità.
 *
 * Seam di test: si importa `src/server.js` (che esporta l'app Express) e si
 * invoca l'handler REALE della rotta, recuperato dal router stack, con req/res
 * finti. Nessun listen, nessuna richiesta HTTP, nessun socket: si esercita
 * esattamente il codice della rotta invece di una sua copia. Il singleton DB è
 * redirezionato su file temporaneo PRIMA dell'import (mai data/perps.db) e
 * `notifier.notify` è sostituito da un collettore, così nulla parte verso
 * Telegram. Cosa NON è coperto: middleware, auth e rate-limit della catena
 * Express (la rotta è dietro il gate cookie come tutte le /api/*), e il percorso
 * `/api/perps/killswitch`, che notificava già.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-ksweb-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: notifier } = await import('../src/perps/notifier.js');
const { default: riskAgent } = await import('../src/agents/riskAgent.js');
const { default: app } = await import('../src/server.js');

let notified = [];
notifier.notify = async (text) => { notified.push(text); };

/** Handler reale della rotta, preso dal router stack di Express. */
function routeHandler(method, routePath) {
  const layer = app._router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  const handlers = layer.route.stack.map(s => s.handle);
  assert.equal(handlers.length, 1, 'un solo handler sulla rotta');
  return handlers[0];
}

const killSwitchRoute = routeHandler('post', '/api/agents/killswitch');

function fakeRes() {
  const captured = { statusCode: 200, body: null };
  return {
    captured,
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; }
  };
}

async function callRoute(body) {
  const res = fakeRes();
  await killSwitchRoute({ body }, res);
  return res.captured;
}

const auditActions = () => db.listAudit(50).map(r => r.action);

/** Testo senza tag HTML: le asserzioni riguardano il messaggio, non il markup. */
const plain = (text) => String(text).replace(/<[^>]+>/g, '');

beforeEach(() => {
  notified = [];
  db.db.prepare('DELETE FROM audit').run();
});

test('{on:false} da web: spegne il flag e notifica sul canale principale', async () => {
  riskAgent.setKillSwitch(true);
  notified = [];
  db.db.prepare('DELETE FROM audit').run();

  const out = await callRoute({ on: false });

  assert.equal(riskAgent.isKillSwitchOn(), false, 'flag spento');
  assert.equal(db.getSetting('killswitch'), 'off', 'stato persistito');
  assert.deepEqual(out.body.success, true);
  assert.equal(out.body.data.killSwitch, false);

  assert.equal(notified.length, 1, 'una notifica per il cambio di stato');
  const msg = plain(notified[0]);
  assert.match(msg, /disattivato/i);
  assert.match(msg, /web/i, 'la notifica dice da dove è arrivato il comando');
  assert.match(msg, /consentite/i, 'dichiara l\'effetto reale: aperture di nuovo consentite');
  assert.match(msg, /non sono stati riavviati|non ripartono/i,
    'dice che i bot fermati non ripartono da soli (vincolo UI-01, come TG-01)');
  assert.ok(auditActions().includes('killswitch.off'), 'cambio registrato in audit');
});

test('{on:true} da web: notifica e NON annuncia effetti che questa rotta non ha', async () => {
  riskAgent.setKillSwitch(false);
  notified = [];

  const out = await callRoute({ on: true });

  assert.equal(riskAgent.isKillSwitchOn(), true);
  assert.equal(out.body.data.killSwitch, true);
  assert.equal(notified.length, 1);
  const msg = plain(notified[0]);
  assert.match(msg, /kill-switch/i);
  assert.match(msg, /bloccate/i, 'dichiara che le aperture sono bloccate');
  // Questa rotta scrive solo il flag: non ferma i bot (lo fa /api/perps/killswitch)
  // e non chiude posizioni. Dirlo è il punto: mai annunciare un effetto non prodotto.
  assert.match(msg, /non sono stati fermati/i,
    'chiarisce che i bot in esecuzione non sono stati fermati da questa rotta');
  assert.match(msg, /non sono state chiuse/i,
    'chiarisce che le posizioni aperte non sono state chiuse da questa rotta');
});

test('stato invariato: nessuna notifica (una per cambio reale, non per click)', async () => {
  riskAgent.setKillSwitch(false);
  notified = [];
  db.db.prepare('DELETE FROM audit').run();

  const out = await callRoute({ on: false });

  assert.equal(riskAgent.isKillSwitchOn(), false);
  assert.equal(out.body.success, true, 'la rotta risponde comunque con successo (idempotente)');
  assert.equal(notified.length, 0, 'nessuna notifica: lo stato era già quello richiesto');
  assert.ok(auditActions().includes('killswitch.off'),
    'il tentativo resta in audit: la traccia di chi ha premuto non si perde');
});

test('riattivazione ripetuta: una sola notifica per il cambio, non una per chiamata', async () => {
  riskAgent.setKillSwitch(true);
  notified = [];

  await callRoute({ on: false });
  await callRoute({ on: false });
  await callRoute({ on: false });

  assert.equal(notified.length, 1, 'una notifica per episodio, non per tentativo');
});

test('body vuoto: default a on=true (contratto invariato della rotta)', async () => {
  riskAgent.setKillSwitch(false);
  notified = [];

  const out = await callRoute(undefined);

  assert.equal(out.body.data.killSwitch, true);
  assert.equal(riskAgent.isKillSwitchOn(), true);
  assert.equal(notified.length, 1);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
