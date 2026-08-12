/**
 * DEBT-02 · cap sul numero di tool-call per turno advisor.
 * ========================================================
 *
 * Il buco che questa suite chiude, trovato da Annie in review Sprint 4:
 * `advisorMaxIterations` limita i giri di andata/ritorno col modello, non le
 * tool-call. Dentro UNA singola risposta il modello può chiedere quanti
 * strumenti vuole e il loop su `res.content` li eseguiva TUTTI — quindi con 5
 * iterazioni e 15 strumenti in allowlist il massimo teorico era 75 esecuzioni
 * locali. Quelle esecuzioni non muovono il budget monetario di ADV-03 (che conta
 * token), ma `run_backtest`/`scan_markets`/`ml_predict` costano CPU e latenza
 * sulla macchina: un limite che non c'era.
 *
 * Quello che si verifica qui NON è che un contatore riporti 3 — quello sarebbe
 * un test che si conferma da sé. Si verifica che il **lavoro locale non venga
 * svolto**, contando le invocazioni vere di `client.getAccount` dietro
 * `get_account`. Se il cap fosse solo contabile e gli strumenti girassero
 * comunque, questo contatore lo direbbe.
 *
 * Seam: `messages.create` dell'istanza Anthropic memoizzata sostituito da uno
 * script, DB su file temporaneo. Nessuna richiesta di rete.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AGENTS_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'chiave-finta-mai-inviata';
process.env.AGENT_ADVISOR_MODEL = 'claude-haiku-4-5';
process.env.AGENT_ADVISOR_MAX_ITERATIONS = '5';
process.env.AGENT_ADVISOR_MAX_TOOL_CALLS = '3';   // basso di proposito: il cap deve scattare

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-advtoolcap-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { getClient } = await import('../src/agents/analyst/client.js');
const { default: advisor } = await import('../src/agents/advisor/advisor.js');
const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { HYPERLIQUID_CONFIG } = await import('../src/config/config.js');

// Il contatore che rende onesto questo test: quante volte il lavoro locale è
// stato DAVVERO svolto, non quante volte diciamo di averlo svolto.
let accountCalls = 0;
client.getAccount = async () => {
  accountCalls++;
  return { equity: 1000, accountValue: 1000, totalMarginUsed: 0, spotUsdc: 0, totalNtlPos: 0, positions: [] };
};
client.getFrontendOpenOrders = async () => ([]);
marketData.getStatus = () => ({ isRunning: true, ws: true, wsFresh: true });
botManager.bots.clear();
botManager.bots.set('bot-cap', {
  id: 'bot-cap', name: 'Bot Cap', coin: 'ETH-PERP', masterAddress: '0xcapmaster', network: 'testnet', status: 'stopped',
  getState: () => ({ id: 'bot-cap', name: 'Bot Cap', coin: 'ETH-PERP', status: 'stopped', inPosition: false, dailyPnl: 0, config: {}, stats: null })
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

/** Una sola risposta del modello che chiede `n` strumenti in un colpo solo. */
const batchOfTools = (n, name = 'get_account') => ({
  stop_reason: 'tool_use',
  content: Array.from({ length: n }, (_, i) => ({ type: 'tool_use', id: `tu_${name}_${i}`, name, input: {} })),
  usage
});

const auditFor = (action) => db.listAudit(300).filter(r => r.action === action);

/**
 * Il record `chat.turn` DI QUESTA sessione, decodificato.
 *
 * Filtrato per sessionId e non preso per posizione: `listAudit` ordina per `ts
 * DESC` e i casi di questa suite scrivono più turni: pescare per indice fa
 * leggere il turno di un altro test e passare per il motivo sbagliato (è
 * successo, verificato).
 */
const turnDetail = (sessionId) => {
  const rows = auditFor('chat.turn').filter(r => JSON.parse(r.detail_json).sessionId === sessionId);
  assert.equal(rows.length, 1, 'esattamente un chat.turn per questa sessione');
  return JSON.parse(rows[0].detail_json);
};

beforeEach(() => {
  script = [];
  calls = 0;
  accountCalls = 0;
  db.setSetting('advisor_monthly_budget_usd', '10');
});

test('un solo giro che chiede 5 strumenti con cap 3: solo 3 vengono ESEGUITI', async () => {
  const s = advisor.createSession({});
  script = [batchOfTools(5)];

  const out = await advisor.chat(s.id, 'analizza tutto quello che puoi');

  // Il cuore del test: il lavoro locale è stato tagliato, non solo contato.
  assert.equal(accountCalls, 3,
    'il cap si applica PRIMA di eseguire: 5 richiesti, 3 eseguiti, 2 mai partiti');
  assert.equal(out.toolCalls, 3, 'il conteggio riportato coincide con le esecuzioni vere');
  assert.equal(out.toolCapHit, true);

  const toolRows = db.listChatMessages(s.id).filter(m => m.role === 'tool');
  assert.equal(toolRows.length, 3, 'una riga di transcript per ogni strumento eseguito, non per ogni richiesto');

  assert.equal(calls, 1,
    'il turno si ferma: non si paga un\'altra iterazione per rimandare al modello risultati parziali');
});

test('al superamento il turno si ferma con un messaggio chiaro, non un errore grezzo', async () => {
  const s = advisor.createSession({});
  script = [batchOfTools(5)];

  const out = await advisor.chat(s.id, 'analizza tutto');

  assert.equal(out.error, undefined, 'non è un errore: è un limite, stesso registro del budget');
  assert.equal(out.code, undefined);
  assert.ok(out.reply, 'una risposta c\'è sempre');
  assert.match(out.reply, /limite di 3 consultazioni/, 'dice QUAL È il limite, col numero');
  assert.match(out.reply, /altre 2/, 'dice quante ne sarebbero servite ancora');
  assert.match(out.reply, /costo di questo turno è stato comunque sostenuto/i,
    'dice che si è pagato comunque, come il cap di iterazioni');
  assert.match(out.reply, /AGENT_ADVISOR_MAX_TOOL_CALLS/,
    'dice quale manopola alzare: senza, l\'operatore non sa cosa fare');
  assert.ok(out.costUsd > 0, 'il turno ha un costo reale e lo riporta');

  // Il messaggio dell'assistente è persistito come tale: la conversazione resta
  // coerente e riprendibile, non tronca a metà.
  const rows = db.listChatMessages(s.id);
  assert.equal(rows[rows.length - 1].role, 'assistant');
  assert.equal(rows.some(m => m.role === 'error'), false, 'nessuna riga di errore per un limite previsto');
});

test('il cap è sul TURNO, non sulla singola risposta: vale anche a strumenti spalmati su più iterazioni', async () => {
  const s = advisor.createSession({});
  // 2 + 2 + 2: il cap di 3 cade DENTRO la seconda iterazione, non a un confine
  // comodo. È il caso che un cap implementato per-risposta invece che per-turno
  // lascerebbe passare.
  script = [batchOfTools(2), batchOfTools(2), batchOfTools(2)];

  const out = await advisor.chat(s.id, 'due per volta');

  assert.equal(accountCalls, 3, 'il tetto vale sull\'intero turno, sommando le iterazioni');
  assert.equal(out.toolCalls, 3);
  assert.equal(out.toolCapHit, true);
  assert.equal(calls, 2, 'si è fermato durante la seconda iterazione, la terza non è stata pagata');
});

test('il superamento è in audit: toolCalls sempre, skippedTools solo quando scatta', async () => {
  const s = advisor.createSession({});
  script = [batchOfTools(5)];
  await advisor.chat(s.id, 'analizza tutto');

  const detail = turnDetail(s.id);   // il turno capped resta un turno: finisce in chat.turn
  assert.equal(detail.toolCalls, 3);
  assert.equal(detail.toolCapHit, true);
  assert.deepEqual(detail.skippedTools, ['get_account', 'get_account'],
    'quali strumenti non sono partiti, non solo quanti');
});

test('NON-REGRESSIONE: un turno sotto il cap si comporta esattamente come prima', async () => {
  const s = advisor.createSession({});
  script = [batchOfTools(2), textReply('Equity 1.000$, nessuna posizione.')];

  const out = await advisor.chat(s.id, 'quanto ho sul conto?');

  assert.equal(accountCalls, 2, 'tutti gli strumenti richiesti sono stati eseguiti');
  assert.equal(out.toolCalls, 2);
  assert.equal(out.toolCapHit, false);
  assert.match(out.reply, /Equity/, 'la risposta del modello arriva intatta');
  assert.equal(/limite di \d+ consultazioni/.test(out.reply), false,
    'nessun messaggio di cap dove il cap non è stato raggiunto');

  const detail = turnDetail(s.id);
  assert.equal(detail.toolCalls, 2, 'il conteggio c\'è sempre, anche quando il cap non scatta');
  assert.equal(detail.toolCapHit, undefined, 'nessun rumore in audit per un turno normale');
  assert.equal(detail.skippedTools, undefined);
});

test('cap di tool-call e cap di iterazioni sono limiti DISTINTI, con messaggi distinti', async () => {
  // Cap di tool-call alzato oltre il bisogno: quello che deve scattare ora è il
  // cap di iterazioni (5), e il messaggio deve essere l'altro. Se i due limiti
  // fossero di fatto lo stesso, questo caso non sarebbe distinguibile.
  const cfg = HYPERLIQUID_CONFIG.agents;
  const saved = cfg.advisorMaxToolCalls;
  cfg.advisorMaxToolCalls = 99;
  try {
    const s = advisor.createSession({});
    script = Array.from({ length: 5 }, () => batchOfTools(1));

    const out = await advisor.chat(s.id, 'gira a vuoto');

    assert.equal(out.toolCapHit, false, 'il cap di tool-call non è stato raggiunto');
    assert.equal(out.toolCalls, 5, 'le 5 tool-call sono passate, una per iterazione');
    assert.equal(out.iterations, 5, 'si è fermato sul cap di ITERAZIONI');
    assert.match(out.reply, /non sono arrivato a una risposta/i, 'il messaggio dell\'altro limite');
    assert.equal(/AGENT_ADVISOR_MAX_TOOL_CALLS/.test(out.reply), false,
      'non suggerisce la manopola sbagliata');
  } finally {
    cfg.advisorMaxToolCalls = saved;
  }
});

test('il cap è visibile nello stato dell\'advisor, accanto a quello di iterazioni', () => {
  const st = advisor.status();
  assert.equal(st.maxToolCalls, 3, 'un limite che esiste ma non si vede non è diagnosticabile');
  assert.equal(st.maxIterations, 5);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
