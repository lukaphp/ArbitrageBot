/**
 * QUAL-01 item 5 — retry sulle notifiche URGENTI, non su tutte.
 * ===========================================================
 *
 * Un 429 di Telegram (rate limit) o un 5xx facevano perdere la notifica in
 * silenzio: per un digest è irrilevante, per "stop loss non piazzabile → chiudo la
 * posizione" no. Le notifiche marcate `urgent` vengono ritentate; le altre
 * mantengono il comportamento storico (un tentativo solo) — riempire la coda di
 * retry per un messaggio non urgente su un rate limit temporaneo peggiora proprio
 * la situazione che il rate limit segnala.
 *
 * Cosa NON cambia: `notify()` non solleva mai. Una notifica persa non deve poter
 * interrompere la gestione di una posizione — ma finisce nei log e nel contatore
 * `telegram_errors_total` (contatore proprio: gonfiare `api_errors_total`, il cui
 * HELP parla di API Hyperliquid, renderebbe quella metrica una mezza verità).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';

import db from '../src/db/database.js';
import metrics from '../src/perps/metrics.js';
import notifier from '../src/perps/notifier.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-notify-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();
notifier.setConfig({ token: '123:FAKE', chatId: '42', enabled: true });

const realPost = axios.post;
let attempts = 0;
let behaviour = () => ({ data: { ok: true } });

axios.post = async (...args) => {
  attempts++;
  return behaviour(...args);
};

/** Errore in forma axios. `retryAfter: 0` tiene il test istantaneo. */
function httpError(status, { retryAfter } = {}) {
  const err = new Error(`HTTP ${status}`);
  err.response = { status, headers: retryAfter != null ? { 'retry-after': String(retryAfter) } : {}, data: {} };
  return err;
}

test('urgente + 429: ritentata e consegnata', async () => {
  attempts = 0;
  behaviour = () => { if (attempts === 1) throw httpError(429, { retryAfter: 0 }); return { data: { ok: true } }; };

  const ok = await notifier.notify('SL non piazzabile', { urgent: true });
  assert.equal(ok, true, 'consegnata al secondo tentativo');
  assert.equal(attempts, 2);
});

test('non urgente + 429: nessun retry (comportamento storico invariato)', async () => {
  attempts = 0;
  behaviour = () => { throw httpError(429, { retryAfter: 0 }); };

  const ok = await notifier.notify('digest giornaliero');
  assert.equal(ok, false, 'ritorna false, non solleva');
  assert.equal(attempts, 1, 'un solo tentativo: un digest non merita di insistere su un rate limit');
});

test('urgente + errore definitivo (400): non ritentata', async () => {
  attempts = 0;
  behaviour = () => { throw httpError(400); };

  const ok = await notifier.notify('chat_id sbagliato', { urgent: true });
  assert.equal(ok, false);
  assert.equal(attempts, 1, 'un 400 non si risolve ritentando: sarebbe solo ritardo');
});

test('urgente + guasto persistente: retry esauriti, nessuna eccezione, contatore proprio', async () => {
  attempts = 0;
  behaviour = () => { throw httpError(503, { retryAfter: 0 }); };
  const apiBefore = metrics.get('api_errors_total');
  const tgBefore = metrics.get('telegram_errors_total');

  const ok = await notifier.notify('errore nel garantire lo stop loss', { urgent: true });
  assert.equal(ok, false, 'la notifica è persa, ma la gestione della posizione va avanti');
  assert.equal(attempts, 3, '1 tentativo + 2 retry');
  assert.equal(metrics.get('telegram_errors_total') - tgBefore, 1, 'contato come errore Telegram');
  assert.equal(metrics.get('api_errors_total'), apiBefore,
    'e NON come errore verso Hyperliquid: il contatore di quello resta onesto');
});

test('notifier disabilitato: nessuna chiamata di rete, nemmeno per le urgenti', async () => {
  notifier.setConfig({ enabled: false });
  attempts = 0;
  const ok = await notifier.notify('urgentissima', { urgent: true });
  assert.equal(ok, false);
  assert.equal(attempts, 0);
  notifier.setConfig({ enabled: true });
});

test.after(() => {
  axios.post = realPost;
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
