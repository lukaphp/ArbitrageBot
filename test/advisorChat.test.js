/**
 * ADV-02/03 · turni, persistenza, contabilità, budget, retention.
 * ===============================================================
 *
 * Quello che qui si verifica non è "la chat risponde" (con un client finto
 * risponderebbe comunque), ma le proprietà che costano soldi o fiducia:
 *
 *  - il transcript **persiste** e si ricostruisce dal DB dopo un riavvio: una
 *    conversazione tenuta solo in memoria di processo sparisce a ogni deploy, e
 *    il container ne fa diversi al giorno (spike §5);
 *  - il costo di ogni turno è **contato e accumulato**, e finisce in audit;
 *  - al superamento del budget la chat **si ferma e lo dice**, e soprattutto
 *    **non chiama il modello**: il freno sta prima della spesa, non dopo;
 *  - un turno andato in errore **conta comunque** i token già consumati —
 *    altrimenti il budget frenerebbe in ritardo proprio quando qualcosa si rompe
 *    in loop;
 *  - eliminare una conversazione **non azzera** il budget speso del mese;
 *  - retention e cancellazione funzionano davvero (righe che spariscono, non un
 *    flag).
 *
 * Seam di test: `messages.create` dell'istanza Anthropic memoizzata sostituito
 * da uno script; DB su file temporaneo. Nessuna richiesta di rete.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AGENTS_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'chiave-finta-mai-inviata';
process.env.AGENT_ADVISOR_MODEL = 'claude-haiku-4-5';
process.env.AGENT_ADVISOR_WINDOW_TURNS = '3';   // finestra corta: il riassunto entra in gioco presto
process.env.AGENT_ADVISOR_MAX_ITERATIONS = '2';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-advchat-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { getClient } = await import('../src/agents/analyst/client.js');
const { default: advisor } = await import('../src/agents/advisor/advisor.js');
const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: botManager } = await import('../src/perps/botManager.js');

client.getAccount = async () => ({ equity: 1000, accountValue: 1000, totalMarginUsed: 0, spotUsdc: 0, totalNtlPos: 0, positions: [] });
client.getFrontendOpenOrders = async () => ([]);
marketData.getStatus = () => ({ isRunning: true, ws: true, wsFresh: true });
// Un bot finto serve solo a far risolvere master address e rete a `context()`
// degli strumenti: senza, `get_account` restituirebbe "nessun wallet collegato" e
// il test sul payload verificherebbe un errore invece di un dato.
botManager.bots.clear();
botManager.bots.set('bot-chat', {
  id: 'bot-chat', name: 'Bot Chat', coin: 'ETH-PERP', masterAddress: '0xchatmaster', network: 'testnet', status: 'stopped',
  getState: () => ({ id: 'bot-chat', name: 'Bot Chat', coin: 'ETH-PERP', status: 'stopped', inPosition: false, dailyPnl: 0, config: {}, stats: null })
});

const anthropic = getClient();
let script = [];
let calls = 0;
anthropic.messages.create = async (req) => {
  calls++;
  if (!script.length) throw new Error('script esaurito');
  const next = script.shift();
  if (typeof next === 'function') return next(req);
  return next;
};

const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 };
const textReply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });
const toolCall = (name, input = {}) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
  usage
});

const auditFor = (action) => db.listAudit(300).filter(r => r.action === action);

const spendKey = () => `advisor_spent_${new Date().toISOString().slice(0, 7)}`;
const spendCounter = () => parseFloat(db.getSetting(spendKey(), '0')) || 0;

beforeEach(() => {
  script = [];
  calls = 0;
  // Si azzera solo il LIMITE, non il contatore di spesa: il contatore è
  // monotono per disegno (cancellare una conversazione non deve abbassarlo), e
  // riportarlo a zero fra un caso e l'altro creerebbe uno stato che in
  // produzione non può esistere — mascherando proprio la proprietà da testare.
  db.setSetting('advisor_monthly_budget_usd', '10');
});

test('budget di default $10/mese senza nessuna configurazione', () => {
  db.db.prepare('DELETE FROM settings WHERE key = ?').run('advisor_monthly_budget_usd');
  const b = advisor.budget();
  assert.equal(b.monthlyLimitUsd, 10, 'il profilo più stretto dello spike §4.3');
  assert.equal(b.remainingUsd, b.monthlyLimitUsd - b.spentUsd);
  assert.ok(b.resetsAt > Date.now(), 'il budget si azzera il 1° del mese prossimo');
  db.setSetting('advisor_monthly_budget_usd', '10');
});

test('un turno: risposta, costo contato, transcript persistito, audit scritto', async () => {
  const s = advisor.createSession({});
  script = [textReply('Equity 1.000$, nessuna posizione aperta.')];

  const out = await advisor.chat(s.id, 'come sto andando?');

  assert.equal(out.error, undefined);
  assert.match(out.reply, /Equity/);
  assert.ok(out.costUsd > 0, 'il turno ha un costo');
  assert.equal(out.model, 'claude-haiku-4-5', 'usa il modello dell\'advisor, non quello dell\'Analyst');

  const msgs = advisor.getMessages(s.id);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant']);
  assert.equal(msgs[0].content, 'come sto andando?');
  assert.match(msgs[1].content, /Equity/);
  assert.ok(msgs[1].costUsd > 0, 'il costo è attaccato al messaggio, non solo alla sessione');

  const session = db.getChatSession(s.id);
  assert.ok(Math.abs(session.cost_usd - out.costUsd) < 1e-12, 'costo accumulato sulla sessione');
  assert.equal(session.tokens_in, 1000);
  assert.equal(session.tokens_out, 200);
  assert.equal(session.title, 'come sto andando?', 'titolo dalla prima domanda, non generato');

  const turn = auditFor('chat.turn')[0];
  assert.match(turn.detail_json, new RegExp(`"sessionId":"${s.id}"`));
  assert.match(turn.detail_json, /"costUsd":/);
  assert.match(turn.detail_json, /"toolsUsed":/);
});

test('turno con strumento: la riga tool è persistita ma il payload non torna alla UI', async () => {
  const s = advisor.createSession({});
  script = [toolCall('get_account', {}), textReply('Hai 1.000$ di equity e nessuna posizione.')];

  const out = await advisor.chat(s.id, 'quanto ho sul conto?');
  assert.deepEqual(out.toolsUsed, ['get_account']);

  const raw = db.listChatMessages(s.id);
  const toolRow = raw.find(m => m.role === 'tool');
  assert.ok(toolRow, 'la riga di strumento è persistita (serve all\'audit)');
  assert.match(toolRow.content, /equity/i, 'con il suo payload');
  assert.equal(toolRow.tool_name, 'get_account');

  const api = advisor.getMessages(s.id);
  const apiTool = api.find(m => m.role === 'tool');
  assert.equal(apiTool.toolName, 'get_account', 'la UI sa QUALE strumento è stato usato');
  assert.equal(apiTool.content, null, 'ma non riceve 6.000 caratteri di JSON per riga');
});

test('ripristino dopo riavvio: il transcript si ricostruisce dal DB', async () => {
  const s = advisor.createSession({});
  script = [textReply('prima risposta')];
  await advisor.chat(s.id, 'prima domanda');

  // "Riavvio": un'istanza di database nuova sullo stesso file, come farebbe il
  // processo dopo un deploy. Niente stato in memoria di mezzo.
  const { PerpsDatabase } = await import('../src/db/database.js');
  const fresh = new PerpsDatabase({ dbPath: db.dbPath });
  fresh.init();
  const rows = fresh.listChatMessages(s.id);
  const session = fresh.getChatSession(s.id);
  fresh.close();

  assert.equal(rows.length, 2, 'domanda e risposta sopravvivono al riavvio');
  assert.equal(rows[0].content, 'prima domanda');
  assert.ok(session.cost_usd > 0, 'anche la contabilità di sessione è persistita');
});

test('finestra + riassunto: oltre la soglia il riassunto viene persistito sulla sessione', async () => {
  const s = advisor.createSession({});
  for (let i = 1; i <= 5; i++) {
    script = [textReply(`risposta ottimista numero ${i}`)];
    await advisor.chat(s.id, `domanda numero ${i}`);
  }
  const session = db.getChatSession(s.id);
  assert.ok(session.summary, 'con finestra 3 e 5 turni il riassunto rotante esiste');
  assert.match(session.summary, /domanda numero 1/, 'conserva le domande (fatti)');
  assert.equal(/ottimista/.test(session.summary), false, 'non conserva le risposte (anti-bias)');

  // E il prompt del turno successivo lo usa come contesto invece di rispedire tutto.
  script = [(req) => {
    const flat = JSON.stringify(req.messages);
    assert.match(flat, /Contesto della conversazione, riassunto/);
    assert.equal(/risposta ottimista numero 1/.test(flat), false,
      'le risposte vecchie non vengono rispedite: è il tetto di costo della finestra');
    return textReply('ok');
  }];
  await advisor.chat(s.id, 'e adesso?');
});

test('BUDGET SUPERATO: la chat si ferma, lo dice, e non chiama il modello', async () => {
  const s = advisor.createSession({});
  // Si abbassa il LIMITE sotto lo speso già accumulato dai casi precedenti,
  // invece di gonfiare il contatore: nessuno stato artificiale.
  const spent = advisor.budget().spentUsd;
  db.setSetting('advisor_monthly_budget_usd', String(Math.max(0.0001, spent * 0.5)));
  calls = 0;
  script = [textReply('non dovrei essere chiamato')];

  const out = await advisor.chat(s.id, 'come sto andando?');

  assert.equal(out.reply, undefined, 'nessuna risposta finta');
  assert.equal(out.code, 'budget_exceeded');
  assert.match(out.error, /Budget mensile/);
  assert.match(out.error, /\$\d+\.\d{2} su \$\d+\.\d{2}/, 'dice speso e limite, con i numeri');
  assert.match(out.error, /1° del mese|advisorbudget/, 'dice come si sblocca');
  assert.equal(calls, 0, 'NESSUNA chiamata al modello oltre soglia: il freno è prima della spesa');
  assert.equal(db.listChatMessages(s.id).length, 0, 'nessun messaggio scritto per un turno mai partito');
  assert.ok(auditFor('chat.blocked').length >= 1, 'il blocco è in audit: spiega perché la chat "non risponde"');
});

test('turno in errore: il costo già consumato viene contato comunque', async () => {
  const s = advisor.createSession({});
  const before = spendCounter();
  // Primo giro con token consumati, poi l'API si rompe: i token sono già pagati.
  script = [toolCall('get_account', {}), () => { throw new Error('502 dal provider'); }];

  const out = await advisor.chat(s.id, 'domanda che va male');

  assert.equal(out.reply, undefined);
  assert.equal(out.code, 'turn_failed');
  assert.match(out.error, /502/);
  assert.ok(spendCounter() > before,
    'i token consumati prima dell\'errore contano: altrimenti un loop rotto spenderebbe "gratis"');
  const rows = db.listChatMessages(s.id);
  assert.ok(rows.some(m => m.role === 'error'), 'il fallimento è nel transcript, non nascosto');
  assert.ok(auditFor('chat.failed').length >= 1);
});

test('cap di iterazioni esaurito: risposta esplicita, non una risposta vuota', async () => {
  const s = advisor.createSession({});
  // AGENT_ADVISOR_MAX_ITERATIONS = 2 → due giri di tool_use, mai un end_turn.
  script = [toolCall('get_account', {}), toolCall('get_killswitch_state', {})];

  const out = await advisor.chat(s.id, 'analizza tutto');

  assert.ok(out.reply, 'una risposta c\'è');
  assert.match(out.reply, /non sono arrivato a una risposta/i);
  assert.match(out.reply, /costo/i, 'dice che il turno è stato pagato comunque');
  assert.ok(out.costUsd > 0);
});

test('eliminazione conversazione: righe via, budget speso NO', async () => {
  const s = advisor.createSession({});
  script = [textReply('risposta da cancellare')];
  await advisor.chat(s.id, 'domanda da cancellare');
  const spentBefore = advisor.budget().spentUsd;
  assert.ok(spentBefore > 0);

  const r = advisor.deleteSession(s.id);
  assert.equal(r.deleted, true);
  assert.equal(r.messages, 2, 'dice quanti messaggi ha eliminato');
  assert.equal(db.getChatSession(s.id), undefined);
  assert.equal(db.listChatMessages(s.id).length, 0);
  assert.ok(auditFor('advisor.session.deleted').length >= 1, 'l\'eliminazione è tracciata');

  assert.ok(Math.abs(advisor.budget().spentUsd - spentBefore) < 1e-12,
    'cancellare la cronologia non deve poter azzerare il budget consumato');
});

test('eliminazione di una conversazione inesistente: nessun errore, deleted false', () => {
  const r = advisor.deleteSession('non-esiste');
  assert.equal(r.deleted, false);
  assert.equal(r.messages, 0);
});

test('retention: le conversazioni non toccate da oltre la soglia vengono eliminate', () => {
  const old = advisor.createSession({});
  const recent = advisor.createSession({});
  db.insertChatMessage({ sessionId: old.id, role: 'user', content: 'vecchia' });
  const longAgo = Date.now() - 100 * 86400000; // 100 giorni > 90 di default
  db.db.prepare('UPDATE chat_sessions SET last_at = ?, started_at = ? WHERE id = ?').run(longAgo, longAgo, old.id);

  const purged = advisor.purgeExpired();

  assert.ok(purged.sessions >= 1);
  assert.equal(db.getChatSession(old.id), undefined, 'la vecchia è stata eliminata');
  assert.equal(db.listChatMessages(old.id).length, 0, 'con i suoi messaggi');
  assert.ok(db.getChatSession(recent.id), 'quella recente resta');
});

test('retention: il criterio è l\'ultimo uso, non la data di creazione', () => {
  const revived = advisor.createSession({});
  const longAgo = Date.now() - 200 * 86400000;
  db.db.prepare('UPDATE chat_sessions SET started_at = ?, last_at = ? WHERE id = ?').run(longAgo, Date.now(), revived.id);

  advisor.purgeExpired();

  assert.ok(db.getChatSession(revived.id),
    'una conversazione aperta mesi fa ma ripresa oggi è viva: non si cancella sotto il naso dell\'utente');
});

test('validazione: messaggio vuoto, troppo lungo, sessione inesistente → errori chiari, nessuna spesa', async () => {
  const s = advisor.createSession({});
  calls = 0;

  const empty = await advisor.chat(s.id, '   ');
  assert.equal(empty.code, 'empty_message');

  const long = await advisor.chat(s.id, 'x'.repeat(5000));
  assert.equal(long.code, 'message_too_long');
  assert.match(long.error, /5000/);

  const missing = await advisor.chat('sessione-che-non-esiste', 'ciao');
  assert.equal(missing.code, 'session_not_found');
  assert.match(missing.error, /non trovata/i);

  assert.equal(calls, 0, 'nessuna chiamata al modello per input non validi');
});

test('elenco sessioni: campi del contratto API e ordine per ultimo uso', async () => {
  const list = advisor.listSessions(50);
  assert.ok(list.length > 0);
  for (const s of list) {
    for (const k of ['id', 'title', 'startedAt', 'lastAt', 'costUsd']) {
      assert.ok(k in s, `il contratto prevede ${k}`);
    }
  }
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].lastAt >= list[i].lastAt, 'più recenti prima');
  }
});

test('un solo turno per volta sulla stessa conversazione', async () => {
  const s = advisor.createSession({});
  let release;
  script = [() => new Promise(resolve => { release = () => resolve(textReply('ok')); })];
  const first = advisor.chat(s.id, 'domanda lenta');
  await new Promise(setImmediate);

  const second = await advisor.chat(s.id, 'seconda domanda mentre la prima è in volo');
  assert.equal(second.code, 'turn_in_progress');

  release();
  const out = await first;
  assert.ok(out.reply);
});

test('degrado: chiave API assente → messaggio chiaro e nessuna chiamata al modello', async () => {
  // Agenti attivi ma chiave sparita (revocata, segreto non montato): è un caso
  // diverso da AGENTS_ENABLED=false e merita un messaggio diverso.
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const s = advisor.createSession({});
    calls = 0;
    script = [textReply('non dovrei essere chiamato')];

    const out = await advisor.chat(s.id, 'ciao');

    assert.equal(out.reply, undefined);
    assert.equal(out.code, 'no_api_key');
    assert.match(out.error, /ANTHROPIC_API_KEY/);
    assert.match(out.error, /cockpit/i, 'chiarisce che il resto della cockpit non è interessato');
    assert.equal(calls, 0);
    assert.equal(db.listChatMessages(s.id).length, 0);
    assert.equal(advisor.status().available, false);
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
  }
  assert.equal(advisor.status().available, true, 'ripristinata la chiave, l\'advisor torna disponibile');
});

test('estimateTurn: preventivo senza inferenza, chiamabile anche a budget esaurito', () => {
  db.setSetting('advisor_monthly_budget_usd', '0');
  calls = 0;
  const est = advisor.estimateTurn({ withTools: 1 });
  assert.equal(calls, 0, 'nessuna chiamata al modello: countTokens/simulazione sono gratuiti');
  assert.ok(est.cost > 0);
  assert.equal(est.model, 'claude-haiku-4-5');
  const noTools = advisor.estimateTurn({ withTools: 0 });
  assert.ok(noTools.cost < est.cost, 'un turno senza strumenti costa meno');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
