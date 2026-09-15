/**
 * Coda advisory per inattività: watcher deterministico + proposta `tune_params`.
 * =============================================================================
 *
 * La richiesta di prodotto: un bot che non apre posizioni da più di 15 minuti
 * deve generare una PROPOSTA in coda, mai un'azione automatica. Qui si verifica
 * il meccanismo su due livelli distinti, perché rispondono a due domande diverse:
 *
 *  1. `diagnoseInactivity` — funzione PURA, nessun orologio interno e nessun DB.
 *     È il posto dove vive la decisione ("è fermo? da quanto? perché? cosa si
 *     può proporre?"), quindi è dove si può esercitare ogni caso limite senza
 *     costruire mezza applicazione. Stesso principio per cui i calcoli di
 *     rischio stanno in `riskManager.js`.
 *  2. Il `tick()` dell'agente — l'orchestrazione: legge i bot, interroga il DB
 *     per l'ultima apertura, crea la proposta, applica l'anti-spam. Qui il DB è
 *     reale (file temporaneo, mai `data/perps.db`) e le proposte si contano
 *     leggendole dalla tabella, non spiando una funzione.
 *
 * Il watcher NON parla con nessun modello: è una sottrazione fra timestamp. Il
 * test lo dimostra indirettamente — gira senza chiave API, senza rete e senza
 * `AGENTS_ENABLED`.
 *
 * Cosa NON è coperto qui: l'applicazione della patch dopo l'approvazione, che
 * sta in `test/executionAgentTuneParams.test.js` (percorso di scrittura, con
 * botManager reale).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-idle-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init(); // insertProposal/insertBot non fanno init lazy

const { default: notifier } = await import('../src/perps/notifier.js');
notifier.notify = async () => {};

const {
  diagnoseInactivity, shorterInterval, inactivityWatcherAgent,
  CAUSE, PROPOSAL_TYPE, DEFAULT_INTERVAL
} = await import('../src/agents/inactivityWatcher.js');
const { validateTunePatch, TUNABLE_KEYS } = await import('../src/agents/tunePatch.js');

const MIN = 60 * 1000;
const T0 = 1_700_000_000_000; // istante fisso: la diagnosi non deve dipendere dall'orologio

/** Stato di bot minimo, nella forma prodotta da `bot.getState()`. */
const botState = (over = {}) => ({
  id: 'bot-1', name: 'SOL Test', coin: 'SOL-PERP',
  status: 'running', inPosition: false, startedAt: T0 - 60 * MIN,
  config: { candleInterval: '15m', entryRules: [{ type: 'price', op: '<', value: 100 }] },
  ...over
});

// ─────────────────────────────── shorterInterval ────────────────────────────

test('shorterInterval: scende di UN gradino solo, mai di più', () => {
  assert.equal(shorterInterval('1h'), '30m');
  assert.equal(shorterInterval('30m'), '15m');
  assert.equal(shorterInterval('15m'), '5m');
  assert.equal(shorterInterval('5m'), '3m');
});

test('shorterInterval: al minimo della scala non c\'è più niente da proporre', () => {
  assert.equal(shorterInterval('1m'), null);
});

test('shorterInterval: intervallo assente → parte dal default usato da bot.js', () => {
  assert.equal(DEFAULT_INTERVAL, '15m');
  assert.equal(shorterInterval(null), shorterInterval('15m'));
});

test('shorterInterval: intervallo non riconosciuto → nessuna proposta inventata', () => {
  assert.equal(shorterInterval('7s'), null);
});

// ────────────────────────────── validateTunePatch ───────────────────────────

test('la whitelist di tuning contiene SOLO candleInterval', () => {
  // Questa assertion è il guardrail della feature, non un dettaglio: ogni chiave
  // aggiunta qui è una cosa in più che un singolo click può cambiare nella
  // config di un bot, senza la conferma a due stadi dell'MCP.
  assert.deepEqual([...TUNABLE_KEYS], ['candleInterval']);
});

test('patch con una chiave di RISCHIO → rifiutata, una per una', () => {
  for (const patch of [{ leverage: 20 }, { sizing: { mode: 'percent', value: 90 } },
    { risk: { maxPositionUsd: 999999 } }, { entryRules: [] }, { maxPositionUsd: 1e9 }]) {
    const v = validateTunePatch(patch);
    assert.equal(v.ok, false, `${JSON.stringify(patch)} non doveva passare`);
    assert.match(v.errors[0], /non è un parametro modificabile/);
  }
});

test('patch che mescola una chiave lecita e una vietata → rifiutata INTERA', () => {
  // Mai applicata a metà: una patch parzialmente accettata applicherebbe una
  // modifica che nessuno ha approvato in quella forma.
  const v = validateTunePatch({ candleInterval: '5m', leverage: 20 });
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 1);
  assert.match(v.errors[0], /"leverage"/);
});

test('patch con intervallo fuori dalla whitelist degli intervalli → rifiutata', () => {
  const v = validateTunePatch({ candleInterval: '42s' });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /intervallo candele non riconosciuto/);
});

test('patch vuota, nulla o non oggetto → rifiutata', () => {
  assert.equal(validateTunePatch({}).ok, false);
  assert.equal(validateTunePatch(null).ok, false);
  assert.equal(validateTunePatch([{ candleInterval: '5m' }]).ok, false);
});

test('patch lecita → accettata', () => {
  assert.deepEqual(validateTunePatch({ candleInterval: '5m' }), { ok: true, errors: [] });
});

// ───────────────────────────── diagnoseInactivity ───────────────────────────

test('bot fermo (status != running) → non è inattivo, è spento', () => {
  const d = diagnoseInactivity(botState({ status: 'stopped' }), { now: T0 });
  assert.equal(d.idle, false);
  assert.match(d.skipReason, /non è in esecuzione/);
});

test('bot IN POSIZIONE → non inattivo, sta gestendo un\'operazione', () => {
  const d = diagnoseInactivity(botState({ inPosition: true }), { now: T0, lastOpenedAt: T0 - 300 * MIN });
  assert.equal(d.idle, false);
  assert.match(d.skipReason, /in posizione/);
});

test('sotto la soglia di 15 minuti → nessuna proposta', () => {
  const d = diagnoseInactivity(botState({ startedAt: T0 - 14 * MIN }), { now: T0, thresholdMs: 15 * MIN });
  assert.equal(d.idle, false);
  assert.match(d.skipReason, /sotto la soglia/);
});

test('la soglia è inclusiva: esattamente 15 minuti fa scattare la diagnosi', () => {
  const d = diagnoseInactivity(botState({ startedAt: T0 - 15 * MIN }), { now: T0, thresholdMs: 15 * MIN });
  assert.equal(d.idle, true);
});

test('appena avviato e senza startedAt → nessuna diagnosi inventata', () => {
  const d = diagnoseInactivity(botState({ startedAt: null }), { now: T0 });
  assert.equal(d.idle, false);
  assert.match(d.skipReason, /non ancora avviato/);
});

test('l\'ultima APERTURA vince sull\'avvio come riferimento', () => {
  // Bot avviato 60 minuti fa ma che ha aperto 5 minuti fa: non è inattivo.
  const d = diagnoseInactivity(botState(), { now: T0, thresholdMs: 15 * MIN, lastOpenedAt: T0 - 5 * MIN });
  assert.equal(d.idle, false);
  assert.equal(d.idleMs, 5 * MIN);
});

test('bot SENZA regole d\'ingresso → inattivo, causa dichiarata, NESSUNA patch', () => {
  // È il caso della flotta reale: nessun tuning di timeframe farebbe aprire un
  // bot che non ha regole. Proporre un `candleInterval` più corto qui sarebbe
  // una cura finta per una diagnosi sbagliata.
  const d = diagnoseInactivity(botState({ config: { entryRules: [] } }), { now: T0, thresholdMs: 15 * MIN });
  assert.equal(d.idle, true);
  assert.equal(d.cause, CAUSE.NO_ENTRY_RULES);
  assert.equal(d.patch, null);
  assert.match(d.rationale, /NESSUNA regola d'ingresso/);
  assert.match(d.rationale, /con qualunque timeframe/);
});

test('la causa si deduce dalla CONFIG, non dal testo di lastEval', () => {
  // Se la diagnosi leggesse `lastEval.reason`, una riformulazione di quella
  // frase in strategyEngine degraderebbe il watcher senza rompere nessun test.
  const d = diagnoseInactivity(
    botState({ config: { entryRules: [] }, lastEval: { action: 'hold', reason: 'frase completamente diversa' } }),
    { now: T0, thresholdMs: 15 * MIN }
  );
  assert.equal(d.cause, CAUSE.NO_ENTRY_RULES);
});

test('bot con regole ma senza segnale → propone UN gradino di timeframe più corto', () => {
  const d = diagnoseInactivity(botState(), { now: T0, thresholdMs: 15 * MIN });
  assert.equal(d.idle, true);
  assert.equal(d.cause, CAUSE.NO_SIGNAL);
  assert.deepEqual(d.patch, { candleInterval: '5m' });
  assert.equal(validateTunePatch(d.patch).ok, true, 'la patch prodotta deve superare il controllo di chi la applica');
});

test('la patch proposta non tocca MAI leva, size o tetti di rischio', () => {
  const d = diagnoseInactivity(botState({
    config: { candleInterval: '1h', leverage: 5, sizing: { mode: 'percent', value: 10 }, entryRules: [{ type: 'price', op: '<', value: 1 }] }
  }), { now: T0, thresholdMs: 15 * MIN });
  assert.deepEqual(Object.keys(d.patch), ['candleInterval']);
  assert.match(d.rationale, /Non cambia leva, size, TP\/SL né i tetti di rischio/);
});

test('intervallo già al minimo → inattivo, ma nessuna patch e lo dice', () => {
  const d = diagnoseInactivity(botState({
    config: { candleInterval: '1m', entryRules: [{ type: 'price', op: '<', value: 1 }] }
  }), { now: T0, thresholdMs: 15 * MIN });
  assert.equal(d.idle, true);
  assert.equal(d.patch, null);
  assert.match(d.rationale, /il più corto disponibile/);
});

test('regole in AND: la nota compare, ma la logica NON viene cambiata dalla patch', () => {
  const d = diagnoseInactivity(botState({
    config: {
      candleInterval: '1h', logic: 'all',
      entryRules: [{ type: 'price', op: '<', value: 1 }, { type: 'funding', op: '>', value: 0 }]
    }
  }), { now: T0, thresholdMs: 15 * MIN });
  assert.match(d.rationale, /in AND \(logic: "all"\)/);
  assert.deepEqual(d.patch, { candleInterval: '30m' }, 'la nota spiega, non autorizza a toccare la strategia');
});

test('il rationale distingue "non ha mai aperto" da "non apre da un po\'"', () => {
  const mai = diagnoseInactivity(botState(), { now: T0, thresholdMs: 15 * MIN });
  assert.match(mai.rationale, /non ha mai aperto una posizione/);
  const daUnPo = diagnoseInactivity(botState(), { now: T0, thresholdMs: 15 * MIN, lastOpenedAt: T0 - 90 * MIN });
  assert.match(daUnPo.rationale, /dall'ultima apertura sono passati 90 minuti/);
});

// ──────────────────────────────── tick dell'agente ──────────────────────────

/** Ripulisce proposte e posizioni fra un sottotest e l'altro. */
function resetDb() {
  db.db.prepare('DELETE FROM proposals').run();
  db.db.prepare('DELETE FROM positions').run();
}

/** Conta le proposte di tuning presenti, per bot. */
function tuneProposals(botId = null) {
  return db.listProposals({ limit: 100 })
    .filter(p => p.type === PROPOSAL_TYPE)
    .map(p => ({ ...p, payload: JSON.parse(p.payload_json || '{}') }))
    .filter(p => !botId || p.payload.botId === botId);
}

test('tick: un bot fermo da 20 minuti produce UNA proposta advisory', async () => {
  resetDb();
  let clock = T0;
  const bots = [botState({ id: 'bot-A', startedAt: T0 - 20 * MIN })];
  const agent = inactivityWatcherAgent({ getBots: () => bots, idleMs: 15 * MIN, now: () => clock });

  await agent.tick();

  const props = tuneProposals('bot-A');
  assert.equal(props.length, 1);
  assert.equal(props[0].type, 'tune_params');
  assert.equal(props[0].status, 'pending', 'advisory: nasce in attesa di decisione, non eseguita');
  assert.equal(props[0].source, 'inactivity-watcher');
  assert.equal(props[0].coin, 'SOL-PERP');
  assert.deepEqual(props[0].payload.patch, { candleInterval: '5m' });
  assert.equal(props[0].payload.cause, CAUSE.NO_SIGNAL);
  assert.equal(props[0].payload.idleMinutes, 20);
  assert.equal(props[0].confidence, null, 'nessun modello dietro: una confidence sarebbe un numero inventato');
});

test('tick: il TTL è più lungo dei 30 minuti di default delle proposte AI', async () => {
  resetDb();
  const clock = T0;
  const bots = [botState({ id: 'bot-A', startedAt: T0 - 20 * MIN })];
  await inactivityWatcherAgent({ getBots: () => bots, idleMs: 15 * MIN, now: () => clock }).tick();

  const p = tuneProposals('bot-A')[0];
  const ttlMin = Math.round((p.expires_at - p.created_at) / MIN);
  assert.ok(ttlMin > 30, `TTL ${ttlMin} min: con 30 la proposta scadrebbe prima che qualcuno apra la plancia`);
  assert.equal(ttlMin, 180);
});

test('anti-spam: tick ripetuti NON accumulano proposte per lo stesso bot', async () => {
  resetDb();
  let clock = T0;
  const bots = [botState({ id: 'bot-A', startedAt: T0 - 20 * MIN })];
  const agent = inactivityWatcherAgent({ getBots: () => bots, idleMs: 15 * MIN, now: () => clock });

  for (let i = 0; i < 12; i++) { await agent.tick(); clock += 5 * MIN; }

  assert.equal(tuneProposals('bot-A').length, 1,
    'un bot fermo per ore deve restare UNA riga in coda, non una ogni cinque minuti');
});

test('anti-spam: nemmeno dopo un RIFIUTO si ripropone subito la stessa cosa', async () => {
  resetDb();
  let clock = T0;
  const bots = [botState({ id: 'bot-A', startedAt: T0 - 20 * MIN })];
  const agent = inactivityWatcherAgent({ getBots: () => bots, idleMs: 15 * MIN, now: () => clock });

  await agent.tick();
  // L'utente rifiuta: il gate "esiste già una pendente" si apre di nuovo, e
  // senza il cooldown il watcher riproporrebbe al giro dopo.
  db.setProposalStatus(tuneProposals('bot-A')[0].id, 'rejected');

  clock += 10 * MIN;
  await agent.tick();
  assert.equal(tuneProposals('bot-A').length, 1, 'rifiutare non deve comprare solo cinque minuti di pace');
});

test('anti-spam: passato il cooldown, un bot ancora fermo torna a proporre', async () => {
  resetDb();
  let clock = T0;
  const bots = [botState({ id: 'bot-A', startedAt: T0 - 20 * MIN })];
  const agent = inactivityWatcherAgent({ getBots: () => bots, idleMs: 15 * MIN, cooldownMs: 30 * MIN, now: () => clock });

  await agent.tick();
  db.setProposalStatus(tuneProposals('bot-A')[0].id, 'expired');

  clock += 31 * MIN;
  await agent.tick();
  assert.equal(tuneProposals('bot-A').length, 2, 'il silenzio è temporaneo, non definitivo');
});

test('tick: bot diversi hanno code indipendenti', async () => {
  resetDb();
  const clock = T0;
  const bots = [
    botState({ id: 'bot-A', coin: 'SOL-PERP', startedAt: T0 - 20 * MIN }),
    botState({ id: 'bot-B', coin: 'ETH-PERP', startedAt: T0 - 20 * MIN }),
    botState({ id: 'bot-C', coin: 'BTC-PERP', startedAt: T0 - 5 * MIN }) // sotto soglia
  ];
  await inactivityWatcherAgent({ getBots: () => bots, idleMs: 15 * MIN, now: () => clock }).tick();

  assert.equal(tuneProposals('bot-A').length, 1);
  assert.equal(tuneProposals('bot-B').length, 1);
  assert.equal(tuneProposals('bot-C').length, 0, 'il bot sotto soglia non deve comparire');
});

test('tick: l\'ultima apertura viene letta dal DB e azzera l\'inattività', async () => {
  resetDb();
  const clock = T0;
  // Il bot ha aperto (e chiuso) 5 minuti fa: la riga in `positions` è la prova.
  db.db.prepare(
    `INSERT INTO positions (bot_id, coin, side, size, entry_px, status, opened_at, closed_at)
     VALUES (?, ?, 'long', 1, 100, 'closed', ?, ?)`
  ).run('bot-A', 'SOL-PERP', T0 - 5 * MIN, T0 - 1 * MIN);

  const bots = [botState({ id: 'bot-A', startedAt: T0 - 300 * MIN })];
  await inactivityWatcherAgent({ getBots: () => bots, idleMs: 15 * MIN, now: () => clock }).tick();

  assert.equal(tuneProposals('bot-A').length, 0,
    'avviato 5 ore fa ma operativo 5 minuti fa: non è un bot fermo');
});

test('tick: bot senza regole d\'ingresso → proposta DIAGNOSTICA, senza patch', async () => {
  resetDb();
  const clock = T0;
  const bots = [botState({ id: 'bot-A', startedAt: T0 - 60 * MIN, config: { entryRules: [] } })];
  await inactivityWatcherAgent({ getBots: () => bots, idleMs: 15 * MIN, now: () => clock }).tick();

  const p = tuneProposals('bot-A')[0];
  assert.equal(p.payload.patch, undefined, 'senza patch: approvare non deve fingere di aver risolto');
  assert.equal(p.payload.cause, CAUSE.NO_ENTRY_RULES);
});

test('tick: nessun bot → nessuna scrittura e nessun errore', async () => {
  resetDb();
  await inactivityWatcherAgent({ getBots: () => [] }).tick();
  assert.equal(tuneProposals().length, 0);
});

test('l\'agente ha la forma attesa dal runtime ({ name, intervalMs, tick })', () => {
  const agent = inactivityWatcherAgent({ getBots: () => [] });
  assert.equal(typeof agent.name, 'string');
  assert.ok(agent.intervalMs > 0);
  assert.equal(typeof agent.tick, 'function');
  assert.equal(typeof agent.status, 'function');
});
