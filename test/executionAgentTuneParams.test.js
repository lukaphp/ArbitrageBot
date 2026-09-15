/**
 * Approvazione di una proposta `tune_params`: il click APPLICA davvero.
 * =====================================================================
 *
 * Primo test dedicato a `executionAgent` / `proposals` in questo repo: il
 * pattern che stabilisce è "DB reale su file temporaneo + botManager reale +
 * nessuna rete". Vale la pena spiegare perché non si mocka niente di tutto
 * questo, visto che sarebbe stato più rapido.
 *
 * Ciò che questa storia deve dimostrare è che una proposta approvata CAMBIA la
 * configurazione del bot — e la configurazione è una riga in `bots.config_json`,
 * più un'istanza `PerpsBot` in memoria che va ricostruita. Un test con un
 * `botManager` finto avrebbe verificato che `executionAgent` chiama un metodo,
 * non che la config cambia: passerebbe anche se `applyConfigPatch` dimenticasse
 * `max_allocation_usd` e azzerasse il tetto di allocazione del bot — che è
 * esattamente il guasto silenzioso contro cui quel metodo esiste. Quindi si
 * guarda la riga a valle, non la chiamata.
 *
 * La rete non serve: i bot restano `stopped` (una modifica di config non li
 * avvia) e `hyperliquidClient` non viene mai interrogato, perché `tune_params`
 * non passa dai rami di `_toAction` che leggono l'account (quelli sono per
 * close/tighten_sl/open). Se un domani ci passasse, questo test fallirebbe con
 * un errore di rete invece di dare un falso verde.
 *
 * Cosa NON è coperto: il riavvio di un bot `running` dopo il patch (richiede di
 * far girare il tick loop, cioè di simulare marketData e il broker — è già
 * coperto per `updateBot` in `test/botManagerUpdate.test.js`, e `applyConfigPatch`
 * non fa che chiamarlo). Dichiarato qui, non nascosto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-tune-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init(); // insertBot/insertProposal non fanno init lazy

const { default: notifier } = await import('../src/perps/notifier.js');
const notifiche = [];
notifier.notify = async (msg) => { notifiche.push(msg); };

const { default: botManager } = await import('../src/perps/botManager.js');
const { default: proposals } = await import('../src/agents/proposals.js');
const { default: executionAgent } = await import('../src/agents/executionAgent.js');
const { default: riskAgent } = await import('../src/agents/riskAgent.js');

const MASTER = '0x' + '1'.repeat(40);

/** Crea un bot fermo con la config indicata e lo carica nel botManager. */
function makeBot(config, over = {}) {
  const id = crypto.randomUUID();
  db.insertBot({
    id, name: `Bot ${id.slice(0, 4)}`, coin: 'SOL-PERP', network: 'testnet',
    masterAddress: MASTER, config, status: 'stopped',
    linked_agent_id: 'user_manual', max_allocation_usd: 500,
    actor_label: 'Tester', actor_id: 'tester', is_managed_by_agent: false,
    ...over
  });
  botManager.loadFromDb();
  return id;
}

const readConfig = (id) => JSON.parse(db.getBot(id).config_json);

const baseConfig = () => ({
  candleInterval: '15m',
  leverage: 3,
  sizing: { mode: 'percent', value: 10 },
  risk: { maxPositionUsd: 400, maxLeverage: 5, maxDailyLossUsd: 50 },
  sl: { enabled: true, mode: 'percent', value: 1.5 },
  entryRules: [{ type: 'price', op: '<', value: 100 }]
});

// ───────────────────────── il percorso felice, end-to-end ───────────────────

test('approvare una proposta tune_params CAMBIA davvero la config del bot', async () => {
  const botId = makeBot(baseConfig());
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP', source: 'inactivity-watcher',
    payload: { botId, patch: { candleInterval: '5m' }, cause: 'no_signal', idleMinutes: 42 },
    rationale: 'Fermo da 42 minuti.'
  });

  const res = await proposals.approve(p.id);

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.suggestion, false, 'non è un suggerimento: è stato applicato');
  assert.equal(readConfig(botId).candleInterval, '5m', 'la riga a valle deve essere cambiata, non solo la chiamata');
  assert.equal(db.getProposal(p.id).status, 'approved');
});

test('il merge NON cancella il resto della config né i campi della riga bot', async () => {
  // Il guasto silenzioso che `applyConfigPatch` esiste per evitare: applicare
  // una patch parziale e azzerare quello che non nomina — in particolare i
  // tetti di rischio per bot e `max_allocation_usd`, che nessuno guarda finché
  // non servono.
  const botId = makeBot(baseConfig());
  const prima = db.getBot(botId);
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, patch: { candleInterval: '5m' } }, rationale: 'x'
  });

  await proposals.approve(p.id);
  const dopo = readConfig(botId);

  assert.equal(dopo.candleInterval, '5m');
  assert.equal(dopo.leverage, 3, 'la leva non doveva muoversi');
  assert.deepEqual(dopo.risk, { maxPositionUsd: 400, maxLeverage: 5, maxDailyLossUsd: 50 });
  assert.deepEqual(dopo.sizing, { mode: 'percent', value: 10 });
  assert.deepEqual(dopo.sl, { enabled: true, mode: 'percent', value: 1.5 });
  assert.deepEqual(dopo.entryRules, prima && JSON.parse(prima.config_json).entryRules);

  const riga = db.getBot(botId);
  assert.equal(riga.max_allocation_usd, 500, 'il tetto di allocazione non doveva sparire');
  assert.equal(riga.actor_label, 'Tester');
  assert.equal(riga.linked_agent_id, 'user_manual');
  assert.equal(riga.coin, 'SOL-PERP');
});

// ─────────────────────── la proposta diagnostica (senza patch) ──────────────

test('proposta senza patch → noop onesto, nessuna modifica, e lo dice all\'utente', async () => {
  const botId = makeBot({ ...baseConfig(), entryRules: [] });
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, cause: 'no_entry_rules', idleMinutes: 300 },
    rationale: 'Nessuna regola d\'ingresso.'
  });

  notifiche.length = 0;
  const res = await proposals.approve(p.id);

  assert.equal(res.ok, true);
  assert.equal(res.suggestion, true, 'deve risultare un suggerimento, non un\'esecuzione');
  assert.deepEqual(readConfig(botId), { ...baseConfig(), entryRules: [] }, 'nulla doveva cambiare');
  assert.ok(notifiche.some(m => /da configurare a mano/.test(m)),
    'l\'utente deve sapere che il click non ha applicato niente');
});

test('una proposta diagnostica NON lascia una falsa traccia di esecuzione', async () => {
  // `execute()` prenota l'id nell'idempotenza PRIMA di sapere cosa farà: se il
  // ramo noop non la rilasciasse, in `executed_actions` resterebbe la traccia di
  // un'esecuzione mai avvenuta — e un eventuale retry legittimo verrebbe saltato.
  const botId = makeBot({ ...baseConfig(), entryRules: [] });
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP', payload: { botId }, rationale: 'x'
  });

  await proposals.approve(p.id);

  assert.equal(db.wasActionExecuted(p.id), false,
    'nessun ordine è stato riempito: non deve risultare un\'azione eseguita');
});

// ───────────────────────────── il cancello che conta ────────────────────────

test('patch fuori whitelist → RIFIUTATA al momento di scrivere, non ripulita', async () => {
  // Il watcher non produce mai una patch così; questo verifica che chi APPLICA
  // non si fidi di chi ha proposto. Fra i due momenti c'è una riga in
  // `proposals`, e nessuno garantisce da dove sia arrivata.
  const botId = makeBot(baseConfig());
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, patch: { candleInterval: '5m', leverage: 20 } }, rationale: 'x'
  });

  const res = await proposals.approve(p.id);

  assert.equal(res.ok, false);
  assert.match(res.reason, /fuori dai parametri modificabili/);
  const dopo = readConfig(botId);
  assert.equal(dopo.leverage, 3, 'la leva NON deve essere salita');
  assert.equal(dopo.candleInterval, '15m', 'e nemmeno la parte lecita va applicata: tutto o niente');
});

test('patch con la sola leva → rifiutata (nessuna scalata di privilegi via coda)', async () => {
  const botId = makeBot(baseConfig());
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, patch: { leverage: 25, risk: { maxPositionUsd: 999999 } } }, rationale: 'x'
  });

  const res = await proposals.approve(p.id);
  assert.equal(res.ok, false);
  assert.equal(readConfig(botId).leverage, 3);
  assert.equal(readConfig(botId).risk.maxPositionUsd, 400);
});

test('patch con un intervallo inventato → rifiutata prima di toccare il DB', async () => {
  const botId = makeBot(baseConfig());
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, patch: { candleInterval: '7s' } }, rationale: 'x'
  });

  const res = await proposals.approve(p.id);
  assert.equal(res.ok, false);
  assert.match(res.reason, /intervallo candele non riconosciuto/);
  assert.equal(readConfig(botId).candleInterval, '15m');
});

test('un\'esecuzione fallita lascia la proposta PENDING (ritentabile)', async () => {
  const botId = makeBot(baseConfig());
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, patch: { leverage: 20 } }, rationale: 'x'
  });

  await proposals.approve(p.id);
  assert.equal(db.getProposal(p.id).status, 'pending');
  assert.equal(db.wasActionExecuted(p.id), false, 'la prenotazione di idempotenza va rilasciata sull\'errore');
});

test('tune_params senza botId → errore esplicito, non una scrittura a vuoto', async () => {
  const res = await executionAgent.execute({
    id: crypto.randomUUID(), type: 'tune_params', coin: 'SOL-PERP', patch: { candleInterval: '5m' }
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /richiede botId/);
});

// ───────────────────────────── il gate del RiskAgent ────────────────────────

test('il RiskAgent classifica tune_params come modifica di configurazione', () => {
  // Senza questa classificazione l\'azione cadeva nel ramo delle APERTURE e
  // veniva respinta con «Nessun wallet/agent collegato»: un messaggio falso per
  // un\'azione che non apre niente e non richiede un account.
  const v = riskAgent.evaluate({ type: 'tune_params', coin: 'SOL-PERP', botId: 'x', patch: { candleInterval: '5m' } });
  assert.equal(v.ok, true, v.reason);
  assert.match(v.reason, /nessun ordine a mercato/);
});

test('con il KILL-SWITCH attivo nemmeno un tuning passa', async () => {
  const botId = makeBot(baseConfig());
  riskAgent.setKillSwitch(true);
  try {
    const p = proposals.create({
      type: 'tune_params', coin: 'SOL-PERP',
      payload: { botId, patch: { candleInterval: '5m' } }, rationale: 'x'
    });
    const res = await proposals.approve(p.id);
    assert.equal(res.ok, false);
    assert.match(res.reason, /Kill-switch/);
    assert.equal(readConfig(botId).candleInterval, '15m');
  } finally {
    riskAgent.setKillSwitch(false);
  }
});

// ────────────────────────────── advisory, non auto ──────────────────────────

test('una proposta NON approvata non cambia niente', async () => {
  const botId = makeBot(baseConfig());
  proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, patch: { candleInterval: '1m' } }, rationale: 'x'
  });

  // Nessuna approve(): la coda è advisory, la creazione non esegue.
  assert.equal(readConfig(botId).candleInterval, '15m');
});

test('rifiutare una proposta non cambia niente e la chiude', async () => {
  const botId = makeBot(baseConfig());
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, patch: { candleInterval: '1m' } }, rationale: 'x'
  });

  const res = proposals.reject(p.id);
  assert.equal(res.ok, true);
  assert.equal(db.getProposal(p.id).status, 'rejected');
  assert.equal(readConfig(botId).candleInterval, '15m');
});

test('una proposta SCADUTA non si applica nemmeno cliccando', async () => {
  const botId = makeBot(baseConfig());
  const p = proposals.create({
    type: 'tune_params', coin: 'SOL-PERP',
    payload: { botId, patch: { candleInterval: '5m' } }, rationale: 'x', ttlMin: 1
  });
  db.db.prepare('UPDATE proposals SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, p.id);

  const res = await proposals.approve(p.id);
  assert.equal(res.ok, false);
  assert.match(res.reason, /scaduta/);
  assert.equal(readConfig(botId).candleInterval, '15m');
});
