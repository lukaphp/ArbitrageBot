/**
 * #34 punto 1 — il gate advisory deve vedere le APERTURE IN VOLO.
 * ===============================================================
 *
 * `portfolio.canOpen()` conta `account.positions` di uno snapshot e somma gli
 * slot che i bot hanno già impegnato in `execQueue` (`reservedSlots`). `bot.js`
 * glieli passa; `agents/riskAgent.evaluate()` — il gate deterministico davanti
 * alle proposte dell'Analyst — NON lo faceva: una proposta valutata mentre un
 * bot sta aprendo (fra `reserveOpenSlot` e `releaseOpenSlot`) veniva approvata
 * su un conteggio che ignorava quell'apertura. Con 2 posizioni a book, una terza
 * in volo e un cap di 3, il gate diceva ok e si finiva a 4.
 *
 * INVARIANTE CHE QUESTO TEST INCHIODA, oltre al rifiuto: `evaluate()` è una
 * VALUTAZIONE, non un'esecuzione. Legge il contatore e non lo tocca — non
 * riserva (approverebbe consumando capacità che nessuno userà se l'umano non
 * esegue) e non rilascia (regalerebbe capacità a un'apertura vera ancora in
 * volo). I casi in fondo al file assertano proprio il contatore prima/dopo, sia
 * sul verdetto di approvazione sia su quello di rifiuto.
 *
 * Il contatore è per WALLET: il caso "slot riservato su un ALTRO master" resta
 * approvato, altrimenti un'implementazione che somma le aperture in volo di
 * tutti i wallet passerebbe questo file senza essere corretta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ambiente fissato PRIMA degli import: `config.js` fotografa `process.env` al
// caricamento e `dotenv` non sovrascrive ciò che è già impostato, quindi così
// l'esito non dipende dal file di ambiente della macchina che lancia i test
// (una whitelist di mercati o un cap di notional locale renderebbero il
// rifiuto vero per il motivo sbagliato).
process.env.AGENT_MARKET_WHITELIST = '';
process.env.PERPS_MAX_LEVERAGE = '20';
process.env.PERPS_MAX_POSITION_USD = '5000';
process.env.PERPS_MAX_DAILY_LOSS_USD = '1000';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-riskagentslots-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: portfolio } = await import('../src/perps/portfolio.js');
const { default: execQueue } = await import('../src/perps/execQueue.js');
const { default: riskAgent } = await import('../src/agents/riskAgent.js');

// Cap esplicito: il test non deve dipendere dai default né inciampare
// nell'esposizione totale o nel cooldown da perdite consecutive.
portfolio.setLimits({ maxConcurrentPositions: 3, maxTotalExposureUsd: 1e9, maxConsecutiveLosses: 99 });
db.setSetting('killswitch', 'off');

const MASTER = '0xAbC0000000000000000000000000000000000001';
const ALTRO_MASTER = '0xdEf0000000000000000000000000000000000002';

/** Account con N posizioni già a book su altri mercati (nozionale trascurabile). */
function accountWith(n) {
  const positions = [];
  for (let i = 0; i < n; i++) positions.push({ coin: `OLD${i}-PERP`, positionValue: 10 });
  return { equity: 10000, accountValue: 10000, positions };
}

/** Proposta di apertura come la costruisce `proposals._toAction()`. */
function openAction({ master = MASTER, posizioniABook = 2 } = {}) {
  return {
    type: 'open',
    coin: 'SOL-PERP',
    side: 'long',
    masterAddress: master,
    account: accountWith(posizioniABook),
    notionalUsd: 100,
    leverage: 1,
    botId: `advisory-${Math.random().toString(16).slice(2)}`, // botId nuovo: nessun cooldown residuo
    config: {}
  };
}

/** Azzera il contatore del master, qualunque cosa abbiano lasciato i casi precedenti. */
function azzeraSlot(master) {
  while (execQueue.reservedOpenSlots(master) > 0) execQueue.releaseOpenSlot(master);
}

test('2 posizioni a book + 1 apertura in volo su un cap di 3: la proposta è RESPINTA', () => {
  azzeraSlot(MASTER);
  const action = openAction({ posizioniABook: 2 });

  // Senza aperture in volo la stessa proposta passa: è il contrappeso che
  // distingue "respinta perché il cap è pieno" da "respinta per altro".
  assert.equal(riskAgent.evaluate(action).ok, true, 'con 2 su 3 e niente in volo deve passare');

  // Un bot entra nella finestra critica: slot impegnato, posizione non ancora
  // visibile nello snapshot account (che resta a 2 posizioni, come in produzione).
  execQueue.reserveOpenSlot(MASTER);

  const verdetto = riskAgent.evaluate(action);
  assert.equal(verdetto.ok, false, 'il gate advisory deve contare anche l\'apertura in volo');
  assert.match(verdetto.reason, /Max posizioni concorrenti \(3\)/);
  assert.match(verdetto.reason, /2 aperte \+ 1 in apertura/,
    'la ragione deve distinguere i due addendi: in diagnosi "3 su 3 di cui 1 in volo" non è "3 su 3 a book"');
});

test('rilasciato lo slot, la stessa proposta torna approvabile (lettura viva, non fotografia)', () => {
  azzeraSlot(MASTER);
  const action = openAction({ posizioniABook: 2 });

  execQueue.reserveOpenSlot(MASTER);
  assert.equal(riskAgent.evaluate(action).ok, false);

  execQueue.releaseOpenSlot(MASTER);
  assert.equal(execQueue.reservedOpenSlots(MASTER), 0);
  assert.equal(riskAgent.evaluate(action).ok, true,
    'finita l\'apertura altrui il gate non deve restare bloccato');
});

test('slot riservato su un ALTRO wallet: non blocca — il cap è di wallet, non globale', () => {
  azzeraSlot(MASTER);
  azzeraSlot(ALTRO_MASTER);

  execQueue.reserveOpenSlot(ALTRO_MASTER);
  execQueue.reserveOpenSlot(ALTRO_MASTER);

  const verdetto = riskAgent.evaluate(openAction({ master: MASTER, posizioniABook: 2 }));
  assert.equal(verdetto.ok, true,
    'sommare le aperture in volo di tutti i wallet bloccherebbe proposte legittime');

  azzeraSlot(ALTRO_MASTER);
});

test('il master si normalizza come in execQueue: maiuscole/minuscole non aprono un buco', () => {
  azzeraSlot(MASTER);
  // Il bot riserva con l'indirizzo in checksum, la proposta arriva con lo stesso
  // indirizzo in minuscolo (o viceversa): devono essere lo STESSO wallet.
  execQueue.reserveOpenSlot(MASTER.toLowerCase());

  const verdetto = riskAgent.evaluate(openAction({ master: MASTER.toUpperCase(), posizioniABook: 2 }));
  assert.equal(verdetto.ok, false, 'due grafie dello stesso indirizzo non sono due wallet');
  azzeraSlot(MASTER);
});

test('evaluate() NON riserva e NON rilascia slot: valuta, non esegue', () => {
  azzeraSlot(MASTER);

  // (a) verdetto di approvazione
  const prima = execQueue.reservedOpenSlots(MASTER);
  assert.equal(riskAgent.evaluate(openAction({ posizioniABook: 1 })).ok, true);
  assert.equal(execQueue.reservedOpenSlots(MASTER), prima,
    'approvare consumando uno slot toglierebbe capacità a un\'apertura vera per una proposta che nessuno ha ancora eseguito');

  // (b) verdetto di rifiuto, con un\'apertura vera in volo
  execQueue.reserveOpenSlot(MASTER);
  const conVolo = execQueue.reservedOpenSlots(MASTER);
  assert.equal(riskAgent.evaluate(openAction({ posizioniABook: 2 })).ok, false);
  assert.equal(execQueue.reservedOpenSlots(MASTER), conVolo,
    'rilasciare qui lo slot di un\'apertura ancora in volo regalerebbe capacità oltre il cap');

  azzeraSlot(MASTER);
});

test('azioni che non aprono esposizione restano fuori dal conteggio', () => {
  azzeraSlot(MASTER);
  execQueue.reserveOpenSlot(MASTER);
  execQueue.reserveOpenSlot(MASTER);
  execQueue.reserveOpenSlot(MASTER);

  // Il cap è saturo di sole aperture in volo, ma una chiusura riduce il rischio
  // e un suggerimento non esegue niente: il gate non li deve toccare.
  assert.equal(riskAgent.evaluate({ type: 'close', coin: 'SOL-PERP', masterAddress: MASTER }).ok, true);
  assert.equal(riskAgent.evaluate({ type: 'note', coin: 'SOL-PERP', masterAddress: MASTER }).ok, true);

  azzeraSlot(MASTER);
});
