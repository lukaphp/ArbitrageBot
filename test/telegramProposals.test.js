/**
 * TELEGRAM — VERITÀ DELL'ESITO DI `/approva` E ETICHETTA DI `/proposte`
 * =====================================================================
 *
 * `_cmdDecide` rispondeva «✅ Approvata ed eseguita» su QUALUNQUE `r.ok`, ma
 * `proposals.approve()` torna `ok: true` anche quando non ha eseguito niente:
 * una `tune_params` DIAGNOSTICA (senza `patch`) viene solo archiviata, e un
 * `new_strategy_candidate` va configurato a mano. Affermare un'esecuzione mai
 * avvenuta su un canale che è l'unico controllo remoto del bot è la stessa
 * disonestà corretta nella coda web: chi legge aspetta un effetto che non
 * arriverà, e poi dà la colpa al bot.
 *
 * Coperto qui, sulle tre uscite REALI di `approve()`:
 *  - patch applicata → il messaggio riporta il cambiamento MISURATO (da → a),
 *    e la config nel DB è davvero cambiata (altrimenti il test verificherebbe
 *    solo il testo di un'applicazione che non c'è stata);
 *  - proposta diagnostica → dichiara che nulla è stato modificato, e la config
 *    nel DB è IDENTICA;
 *  - rifiuto del gate (kill-switch) → «Non eseguita», proposta ancora pendente.
 * Più l'etichetta di `/proposte`: «⚙️ regola automatica» per una proposta
 * deterministica senza confidenza, «conf —» quando il modello c'è ma il numero
 * manca (ignoto ≠ inesistente).
 *
 * Seam: percorso VERO end-to-end (`proposals.approve` → `riskAgent` →
 * `executionAgent` → `botManager.applyConfigPatch`), perché il punto del fix è
 * proprio la forma di ciò che `approve()` restituisce: con un doppio finto il
 * test passerebbe anche se quel contratto cambiasse. Il solo `_send` di
 * `telegramControl` è sostituito da un collettore (nessun HTTP a Telegram), il
 * DB singleton è redirezionato su file temporaneo, e `notifier.notify` è
 * silenziato perché con TELEGRAM_* nell'ambiente manderebbe messaggi veri da un
 * test. `PERPS_LOOPBACK_PUSH=0` evita che l'emit del bot aggiornato bussi alla
 * dashboard sulla porta 3000.
 * NON coperto: il long-polling di `getUpdates` (già esercitato via
 * `_dispatchUpdate` in telegramKillSwitch.test.js).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERPS_LOOPBACK_PUSH = '0';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-tg-prop-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: telegramControl } = await import('../src/perps/telegramControl.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: proposals } = await import('../src/agents/proposals.js');
const { default: riskAgent } = await import('../src/agents/riskAgent.js');
const { default: notifier } = await import('../src/perps/notifier.js');

notifier.notify = async () => false;

const AUTHORIZED = '424242';
let sent = [];
let botSeq = 0;

/** Bot reale in DB (serve: `applyConfigPatch` scrive su `bots.config_json`). */
function insertBot(config) {
  const id = `tg-prop-bot-${++botSeq}-${Date.now()}`;
  db.insertBot({
    id,
    name: 'Scalper BTC',
    coin: 'BTC-PERP',
    network: 'testnet',
    masterAddress: '0x000000000000000000000000000000000000dEaD',
    config,
    status: 'stopped'
  });
  botManager.loadFromDb();
  return id;
}

beforeEach(() => {
  sent = [];
  telegramControl.chatId = AUTHORIZED;
  telegramControl._send = async (text) => { sent.push(text); };
  riskAgent.setKillSwitch(false);
});

test('/approva di un tuning con patch: dice COSA è cambiato, e lo scrive davvero', async () => {
  const botId = insertBot({ candleInterval: '15m', leverage: 2 });
  const p = proposals.create({
    type: 'tune_params',
    coin: 'BTC-PERP',
    payload: { botId, botName: 'Scalper BTC', cause: 'no_signal', idleMinutes: 42, patch: { candleInterval: '5m' } },
    rationale: 'Bot fermo da 42 minuti',
    confidence: null,
    source: 'inactivity-watcher',
    notify: false
  });

  await telegramControl._handle(`/approva ${p.id.slice(0, 8)}`);

  assert.equal(sent.length, 1);
  assert.match(sent[0], /🎚️ Applicato/, 'un\'applicazione riuscita si annuncia come applicazione');
  assert.match(sent[0], /intervallo candele: 15m → 5m/,
    'il messaggio riporta il cambiamento misurato (da → a), non la patch richiesta');
  assert.doesNotMatch(sent[0], /candleInterval/, 'in chat va il nome leggibile, non la chiave di config');

  // La verifica che rende onesto il caso "applicato": la config persistita.
  const persisted = JSON.parse(db.getBot(botId).config_json);
  assert.equal(persisted.candleInterval, '5m');
  assert.equal(persisted.leverage, 2, 'il resto della config non viene toccato');
  assert.equal(db.getProposal(p.id).status, 'approved');
});

test('/approva di un tuning DIAGNOSTICO: non dice "eseguita", e non modifica nulla', async () => {
  const botId = insertBot({ candleInterval: '1m' });
  const before = db.getBot(botId).config_json;
  const p = proposals.create({
    type: 'tune_params',
    coin: 'BTC-PERP',
    // Nessuna `patch`: è il caso "intervallo già al minimo / nessuna regola
    // d'ingresso" — approvarla archivia la diagnosi e non tocca il bot.
    payload: { botId, botName: 'Scalper BTC', cause: 'no_entry_rules', idleMinutes: 61 },
    rationale: 'Il bot non ha regole d\'ingresso',
    confidence: null,
    source: 'inactivity-watcher',
    notify: false
  });

  await telegramControl._handle(`/approva ${p.id.slice(0, 8)}`);

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /eseguita/i,
    'nessuna esecuzione è avvenuta: il messaggio non deve affermarla');
  assert.doesNotMatch(sent[0], /Applicato/, 'niente è stato applicato');
  assert.match(sent[0], /diagnostica|non.*modificat|a mano/i,
    'il messaggio deve dire che il bot non è stato modificato');
  assert.equal(db.getBot(botId).config_json, before, 'config identica: la diagnosi non scrive');
});

test('/approva quando il gate rifiuta: "Non eseguita", proposta ancora pendente', async () => {
  const botId = insertBot({ candleInterval: '15m' });
  const p = proposals.create({
    type: 'tune_params',
    coin: 'BTC-PERP',
    payload: { botId, patch: { candleInterval: '5m' } },
    rationale: 'Bot fermo',
    confidence: null,
    source: 'inactivity-watcher',
    notify: false
  });
  riskAgent.setKillSwitch(true); // il kill-switch sta davanti a tutto, config comprese

  await telegramControl._handle(`/approva ${p.id.slice(0, 8)}`);

  assert.match(sent[0], /Non eseguita/);
  assert.doesNotMatch(sent[0], /✅|🎚️/, 'un rifiuto del gate non porta emoji di successo');
  assert.equal(db.getProposal(p.id).status, 'pending', 'resta in coda: non è stata decisa');
  assert.equal(JSON.parse(db.getBot(botId).config_json).candleInterval, '15m');
});

test('/approva di un\'azione davvero eseguibile mantiene il messaggio di esecuzione', async () => {
  // `pause_bot` viene eseguita per davvero (ferma l'istanza) e non tocca il
  // mercato: serve a verificare che il nuovo ternario non abbia trasformato
  // TUTTI gli esiti in "diagnostica" — il messaggio di prima resta dov'era vero.
  const p = proposals.create({
    type: 'pause_bot',
    coin: 'BTC-PERP',
    payload: { botId: insertBot({ candleInterval: '15m' }) },
    rationale: 'Drawdown oltre soglia',
    confidence: 0.8,
    notify: false
  });

  await telegramControl._handle(`/approva ${p.id.slice(0, 8)}`);

  assert.equal(sent.length, 1);
  assert.match(sent[0], /✅ Approvata ed eseguita/,
    'un\'azione realmente eseguita conserva il messaggio di prima');
  assert.match(sent[0], /pause_bot/);
});

test('/proposte: "regola automatica" per il watcher, "conf —" per l\'Analyst senza numero', async () => {
  proposals.create({
    type: 'tune_params', coin: 'BTC-PERP',
    payload: { botId: 'x', patch: { candleInterval: '5m' } },
    rationale: 'Bot fermo da 42 minuti', confidence: null,
    source: 'inactivity-watcher', notify: false
  });
  proposals.create({
    type: 'close', coin: 'ETH-PERP', payload: {},
    rationale: 'Funding avverso', confidence: null,
    source: 'analyst', notify: false
  });
  proposals.create({
    type: 'open', coin: 'SOL-PERP', payload: {},
    rationale: 'Breakout', confidence: 0.72,
    source: 'analyst', notify: false
  });

  await telegramControl._handle('/proposte');

  assert.match(sent[0], /⚙️ regola automatica/,
    'una regola deterministica non ha una confidenza: non deve sembrare un dato mancante');
  assert.match(sent[0], /conf —/, 'per l\'Analyst senza numero "—" resta corretto (ignoto)');
  assert.match(sent[0], /conf 72%/);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
