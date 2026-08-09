/**
 * TG-01: kill-switch comandabile da Telegram.
 * ===========================================
 *
 * Prima di questo comando un operatore con accesso solo alla chat — lo scenario
 * per cui il bot manda notifiche — non poteva né fermare né riprendere le
 * aperture: `/chiuditutto` chiude le posizioni ma non tocca `settings.killswitch`.
 *
 * Coperto qui:
 *  - `/killswitch on` alza il flag persistito e ferma i bot in esecuzione;
 *  - `/killswitch off` abbassa il flag e NON riavvia i bot fermati (vincolo di
 *    UI-01: riprendere a operare è una decisione separata);
 *  - lettura di stato senza argomento e argomento non valido non cambiano nulla
 *    (un comando che sblocca le aperture non deve partire per un errore di battitura);
 *  - un messaggio da una chat NON autorizzata non esegue nulla e non riceve
 *    risposta, ma fa avanzare l'offset di polling.
 *
 * Seam di test: il singleton `telegramControl` con `_send` sostituito da un
 * collettore (nessuna chiamata HTTP a Telegram), il singleton DB redirezionato su
 * file temporaneo (il kill-switch vive in `settings`, mai su data/perps.db reale),
 * e un finto bot iniettato in `botManager.bots` per osservare stop/start senza far
 * girare un PerpsBot vero (che farebbe polling di rete a ogni tick).
 * Cosa NON è coperto: il long-polling HTTP di `getUpdates` — l'autorizzazione è
 * esercitata tramite `_dispatchUpdate`, che è il punto in cui il loop la applica.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-tg-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init(); // setSetting/getSetting non fanno init lazy

const { default: telegramControl } = await import('../src/perps/telegramControl.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: riskAgent } = await import('../src/agents/riskAgent.js');

const AUTHORIZED = '424242';
let sent = [];

/** Bot finto: espone il minimo usato da botManager.listStates/stopBot/startBot. */
function fakeBot(id, name, status = 'running') {
  return {
    id, name, status, coin: 'SOL-PERP', calls: [],
    stop() { this.calls.push('stop'); this.status = 'stopped'; },
    start() { this.calls.push('start'); this.status = 'running'; },
    getState() { return { id: this.id, name: this.name, coin: this.coin, status: this.status, stats: null }; }
  };
}

beforeEach(() => {
  sent = [];
  telegramControl.chatId = AUTHORIZED;
  telegramControl._send = async (text) => { sent.push(text); };
  botManager.bots.clear();
  riskAgent.setKillSwitch(false);
});

test('/killswitch on: alza il flag persistito e ferma i bot in esecuzione', async () => {
  const running = fakeBot('b1', 'Bot Alfa', 'running');
  const alreadyStopped = fakeBot('b2', 'Bot Beta', 'stopped');
  botManager.bots.set('b1', running);
  botManager.bots.set('b2', alreadyStopped);

  await telegramControl._handle('/killswitch on');

  assert.equal(riskAgent.isKillSwitchOn(), true, 'flag kill-switch attivo');
  assert.equal(db.getSetting('killswitch'), 'on', 'flag persistito in settings (sopravvive al riavvio)');
  assert.deepEqual(running.calls, ['stop'], 'il bot in esecuzione è stato fermato');
  assert.deepEqual(alreadyStopped.calls, [], 'un bot già fermo non viene toccato');
  assert.match(sent[0], /ATTIVATO/);
  assert.match(sent[0], /Bot Alfa/, 'la risposta dice quali bot sono stati fermati');
  assert.match(sent[0], /NON sono state chiuse|chiuditutto/,
    'la risposta chiarisce che le posizioni aperte non vengono chiuse');
});

test('/killswitch off: sblocca le aperture e NON riavvia i bot fermati', async () => {
  const stopped = fakeBot('b1', 'Bot Alfa', 'stopped');
  botManager.bots.set('b1', stopped);
  riskAgent.setKillSwitch(true);

  await telegramControl._handle('/killswitch off');

  assert.equal(riskAgent.isKillSwitchOn(), false, 'flag kill-switch spento');
  assert.equal(db.getSetting('killswitch'), 'off');
  assert.deepEqual(stopped.calls, [], 'nessun bot riavviato: resta una decisione separata (vincolo UI-01)');
  assert.equal(stopped.status, 'stopped');
  assert.match(sent[0], /disattivato/i);
  assert.match(sent[0], /non.*ripartono|riavviali/i, 'la risposta dice che i bot vanno riavviati a mano');
});

test('/killswitch senza argomento è solo una lettura di stato', async () => {
  riskAgent.setKillSwitch(true);
  const bot = fakeBot('b1', 'Bot Alfa', 'running');
  botManager.bots.set('b1', bot);

  await telegramControl._handle('/killswitch');

  assert.equal(riskAgent.isKillSwitchOn(), true, 'stato invariato');
  assert.deepEqual(bot.calls, [], 'nessun effetto sui bot');
  assert.match(sent[0], /ATTIVO/);
});

test('/killswitch con argomento non valido non cambia nulla', async () => {
  riskAgent.setKillSwitch(true);

  await telegramControl._handle('/killswitch of'); // typo di "off"

  assert.equal(riskAgent.isKillSwitchOn(), true,
    'un errore di battitura non deve sbloccare le aperture');
  assert.match(sent[0], /non valido/i);
});

test('/killswitch on quando è già attivo: idempotente, nessun bot fermato due volte', async () => {
  riskAgent.setKillSwitch(true);
  const bot = fakeBot('b1', 'Bot Alfa', 'running');
  botManager.bots.set('b1', bot);

  await telegramControl._handle('/killswitch on');

  assert.equal(riskAgent.isKillSwitchOn(), true);
  assert.deepEqual(bot.calls, [], 'già attivo → non ripete lo stop');
  assert.match(sent[0], /già attivo/i);
});

test('chat NON autorizzata: nessun effetto, nessuna risposta, offset avanzato', async () => {
  riskAgent.setKillSwitch(true);
  telegramControl.offset = 0;

  await telegramControl._dispatchUpdate({
    update_id: 77,
    message: { chat: { id: 999999 }, text: '/killswitch off' }
  });

  assert.equal(riskAgent.isKillSwitchOn(), true,
    'una chat estranea non può sbloccare le aperture');
  assert.deepEqual(sent, [], 'nessuna risposta a una chat non autorizzata');
  assert.equal(telegramControl.offset, 78, 'offset avanzato: l\'update non viene riproposto in loop');
});

test('chat autorizzata: lo stesso comando passa dal dispatch ed esegue', async () => {
  riskAgent.setKillSwitch(true);
  telegramControl.offset = 0;

  await telegramControl._dispatchUpdate({
    update_id: 5,
    message: { chat: { id: Number(AUTHORIZED) }, text: '/killswitch off' }
  });

  assert.equal(riskAgent.isKillSwitchOn(), false, 'comando eseguito per la chat configurata');
  assert.equal(sent.length, 1);
  assert.equal(telegramControl.offset, 6);
});

test('/help elenca il comando kill-switch (scopribilità dalla chat)', async () => {
  await telegramControl._handle('/help');
  assert.match(sent[0], /\/killswitch on/);
  assert.match(sent[0], /\/killswitch off/);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
