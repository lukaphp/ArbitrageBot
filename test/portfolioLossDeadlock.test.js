/**
 * CRIT-LOSSLOCK-25 — il blocco per perdite consecutive deve poter finire.
 * =======================================================================
 *
 * Difetto misurato in produzione (VPS, 2026-09-25). Tre bot — BTC, BNB, AVAX —
 * `status='running'`, nessuna posizione aperta, log identico ogni 10 secondi
 * per oltre 4 ore:
 *
 *     [WARN] Bot BTC JEV Verified Bot: apertura bloccata (portafoglio)
 *            "3 perdite consecutive → cooldown 60 min"
 *
 * Un "cooldown 60 min" che non è mai finito. Il ramo delle perdite consecutive
 * di `canOpen()` decide solo sul CONTEGGIO delle ultime chiusure, e quel
 * conteggio si azzera unicamente con una chiusura non in perdita. Ma per
 * chiudere bisogna prima aprire, e il ramo impedisce di aprire: la condizione
 * di uscita è irraggiungibile dall'interno. Non è un cooldown, è un blocco
 * definitivo con l'etichetta di un cooldown.
 *
 * La causa a monte era l'incidente della guardia SL (23-24/09): 27 chiusure su
 * 28 con `close_reason = 'errore verifica SL (chiusura di sicurezza)'`, in
 * gran parte in perdita. Il fix del 24/09 ha fermato l'emorragia ma non ha
 * ripulito lo stato che aveva prodotto — uno stato monotono senza il suo reset.
 *
 * La proprietà verificata qui: il blocco resta identico per tutta la durata
 * dichiarata (la protezione non si allenta), e scade quando quella durata è
 * passata dall'ULTIMA perdita.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';
import { Portfolio } from '../src/perps/portfolio.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-losslock-'));
db.dbPath = path.join(tempDir, 'perps.db');

const ACCOUNT = { positions: [] };
const MIN = 60000;

function fresh() {
  const p = new Portfolio();
  p.setLimits({ maxConcurrentPositions: 3, maxConsecutiveLosses: 3, cooldownMinutes: 60 });
  return p;
}

test('il blocco per perdite consecutive scade 60 min dopo l\'ultima perdita', () => {
  const p = fresh();
  const botId = 'lock-1';
  const lastLossAt = 1_000_000_000_000;

  const durante = p.canOpen({
    account: ACCOUNT, botId, consecutiveLosses: 3, lastLossAt, now: lastLossAt + 59 * MIN
  });
  assert.equal(durante.ok, false, 'dentro la finestra il blocco tiene');
  assert.match(durante.reason, /perdite consecutive/i);
  assert.equal(durante.cooldownUntil, lastLossAt + 60 * MIN,
    'espone la scadenza: è ciò che il chiamante usa per non rinotificare a ogni tick');

  const dopo = p.canOpen({
    account: ACCOUNT, botId, consecutiveLosses: 3, lastLossAt, now: lastLossAt + 61 * MIN
  });
  assert.equal(dopo.ok, true,
    'passata la finestra il bot deve poter riaprire: senza aprire non può mai spezzare la serie');
});

test('il limite esatto appartiene al blocco, non allo sblocco', () => {
  const p = fresh();
  const lastLossAt = 1_000_000_000_000;
  const base = { account: ACCOUNT, botId: 'lock-2', consecutiveLosses: 3, lastLossAt };
  assert.equal(p.canOpen({ ...base, now: lastLossAt + 60 * MIN - 1 }).ok, false);
  assert.equal(p.canOpen({ ...base, now: lastLossAt + 60 * MIN }).ok, true);
});

test('una perdita più recente riapre la finestra da capo', () => {
  const p = fresh();
  const t0 = 1_000_000_000_000;
  const base = { account: ACCOUNT, botId: 'lock-3', consecutiveLosses: 4 };
  // Vecchia perdita: scaduta.
  assert.equal(p.canOpen({ ...base, lastLossAt: t0, now: t0 + 90 * MIN }).ok, true);
  // Nuova perdita incassata nel frattempo: si riparte da quella.
  assert.equal(p.canOpen({ ...base, lastLossAt: t0 + 85 * MIN, now: t0 + 90 * MIN }).ok, false);
});

test('istante dell\'ultima perdita non disponibile: si blocca, come prima', () => {
  const p = fresh();
  const botId = 'lock-4';
  // Comportamento storico invariato (vedi portfolioCanOpenPure.test.js): senza
  // sapere QUANDO è arrivata l'ultima perdita non si può dire che la finestra
  // sia passata, e il dubbio non autorizza ad aprire.
  for (const lastLossAt of [undefined, null, 0, NaN, 'ieri']) {
    const v = p.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 3, lastLossAt });
    assert.equal(v.ok, false, `lastLossAt=${JSON.stringify(lastLossAt)} deve bloccare`);
    assert.match(v.reason, /perdite consecutive/i);
  }
});

test('sotto il limite di perdite consecutive nulla cambia', () => {
  const p = fresh();
  assert.equal(p.canOpen({
    account: ACCOUNT, botId: 'lock-5', consecutiveLosses: 2, lastLossAt: Date.now()
  }).ok, true);
});

test('canOpen resta PURA: valutare la scadenza non scrive nessun cooldown', () => {
  const p = fresh();
  const botId = 'lock-6';
  const lastLossAt = 1_000_000_000_000;
  p.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 3, lastLossAt, now: lastLossAt + 10 * MIN });
  p.canOpen({ account: ACCOUNT, botId, consecutiveLosses: 3, lastLossAt, now: lastLossAt + 99 * MIN });
  assert.equal(p.cooldownInfo(botId), null, 'nessuna scrittura da una funzione di verifica (QUAL-01)');
});

test('db.lastLossClosedAt: istante dell\'ultima chiusura in perdita', () => {
  db.init();
  const botId = 'lock-db';
  assert.equal(db.lastLossClosedAt(botId), null, 'nessuna chiusura → null, non 0');

  const perdita = db.insertPosition({ botId, coin: 'X-PERP', side: 'long', size: 1, entryPx: 100, leverage: 1 });
  db.updatePosition(perdita, { status: 'closed', pnl: -5, closed_at: 1_700_000_000_000, close_reason: 'stop loss eseguito' });
  assert.equal(db.lastLossClosedAt(botId), 1_700_000_000_000);

  // Una chiusura in UTILE più recente non sposta l'istante dell'ultima perdita:
  // la domanda è "quando ho perso l'ultima volta", non "quando ho chiuso".
  const vincita = db.insertPosition({ botId, coin: 'X-PERP', side: 'long', size: 1, entryPx: 100, leverage: 1 });
  db.updatePosition(vincita, { status: 'closed', pnl: 5, closed_at: 1_700_000_900_000, close_reason: 'take profit eseguito' });
  assert.equal(db.lastLossClosedAt(botId), 1_700_000_000_000);

  // Una perdita SUCCESSIVA sì: è quella da cui parte la finestra.
  const perdita2 = db.insertPosition({ botId, coin: 'X-PERP', side: 'long', size: 1, entryPx: 100, leverage: 1 });
  db.updatePosition(perdita2, { status: 'closed', pnl: -2, closed_at: 1_700_001_800_000, close_reason: 'stop loss eseguito' });
  assert.equal(db.lastLossClosedAt(botId), 1_700_001_800_000);
});
