/**
 * JEV-OBS-01 · il client dell'osservatore TypeSafe Jev non fallisce MAI verso il chiamante.
 * ========================================================================================
 *
 * `askJev` vive su un percorso che parte da `bot.js` nel momento esatto in cui il
 * bot decide di aprire o chiudere una posizione. Non deve poter influenzare quella
 * decisione in nessun modo — e "in nessun modo" include il modo più banale:
 * lanciare un'eccezione che qualcuno, oggi o fra sei mesi, si ritrovi ad awaitare.
 *
 * Qui si verifica quello che la funzione PROMETTE, in isolamento dal bot:
 *
 *  1. **esito sempre strutturato**: chiave assente, budget esaurito, timeout, 500,
 *     rete morta, risposta illeggibile → sempre `{ ok:false, code }`, mai un throw;
 *  2. **il timeout è VERO**: un trasporto che non risponde MAI produce comunque un
 *     esito entro il tetto, e una riga di audit che dice che Jev è stato muto.
 *     Non ci si affida al solo `AbortController`: se il trasporto ignorasse
 *     l'abort (bug della libreria, event loop occupato) la promise resterebbe
 *     pendente per sempre e il silenzio non verrebbe mai registrato;
 *  3. **il budget frena PRIMA di spendere**: a budget esaurito il trasporto non
 *     viene proprio chiamato — si verifica sul contatore delle chiamate, non sul
 *     codice di ritorno, altrimenti il test sarebbe verde anche con una richiesta
 *     partita e poi scartata;
 *  4. **la spesa si accumula davvero**: una chiamata riuscita alza il contatore
 *     mensile, e il contatore alzato blocca la successiva. Un budget che non frena
 *     mai è il difetto che LLM-01 ha già chiuso per i fornitori LLM.
 *
 * Seam: nessuna rete. Il trasporto è iniettabile (`httpPost`, stesso pattern di
 * `providers/openaiCompatible.js`) e il DB è un file temporaneo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';
import { HYPERLIQUID_CONFIG } from '../src/config/config.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-jev-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { askJev, jevBudget, jevStatus, JEV_STATE_CHAR_CAP } = await import('../src/agents/jev.js');

const QUESTIONS = {
  signal_reliable: { type: 'noul', instructions: 'Il segnale è coerente col contesto?' }
};

/** Risposta reale osservata sull'API, usata come riferimento di forma. */
function okResponse({ noul = 0.78, inTok = 340, outTok = 21 } = {}) {
  return {
    data: {
      model: 'jev-1.13.0',
      answers: { signal_reliable: { type: 'noul', noul } },
      usage: { input_tokens: inTok, output_tokens: outTok }
    }
  };
}

/** Azzera lo stato di spesa del mese corrente (i test condividono il DB). */
function resetSpend() {
  const key = `jev_spent_${new Date().toISOString().slice(0, 7)}`;
  db.setSetting(key, '0');
  db.ensure().prepare('DELETE FROM jev_evaluations').run();
}

async function withKey(fn) {
  const before = process.env.JEV_API_KEY;
  process.env.JEV_API_KEY = 'jev-test-key';
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = before;
  }
}

test('senza JEV_API_KEY non parte nessuna chiamata, e non è un errore rumoroso', async () => {
  resetSpend();
  const before = process.env.JEV_API_KEY;
  delete process.env.JEV_API_KEY;
  let calls = 0;
  try {
    const out = await askJev({
      state: 'stato', questions: QUESTIONS, botId: 'b1', coin: 'SOL-PERP',
      httpPost: async () => { calls++; return okResponse(); }
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'missing_key');
    assert.ok(out.reason.includes('JEV_API_KEY'), 'il motivo nomina la manopola mancante');
    assert.equal(calls, 0, 'nessuna richiesta partita');
    assert.equal(db.listJevEvaluations({ limit: 10 }).length, 0,
      'nessuna riga di audit: non è stata fatta nessuna valutazione, non è "una valutazione fallita"');

    const st = jevStatus();
    assert.equal(st.available, false);
    assert.ok(st.reason.length > 30, 'il motivo è una frase leggibile, non un codice');
  } finally {
    if (before !== undefined) process.env.JEV_API_KEY = before;
  }
});

test('un trasporto che non risponde MAI produce comunque un esito, entro il tetto', () => withKey(async () => {
  resetSpend();
  const started = Date.now();
  const out = await askJev({
    state: 'stato', questions: QUESTIONS, botId: 'b-timeout', coin: 'SOL-PERP', action: 'open_long',
    timeoutMs: 60,
    // Ignora deliberatamente il signal di abort: è il caso peggiore (trasporto
    // che non onora l'AbortController). L'esito deve arrivare lo stesso.
    httpPost: () => new Promise(() => {})
  });
  const elapsed = Date.now() - started;

  assert.equal(out.ok, false);
  assert.equal(out.code, 'timeout');
  assert.ok(elapsed < 2000, `esito entro il tetto, non atteso all'infinito (${elapsed}ms)`);

  const rows = db.listJevEvaluations({ limit: 10 });
  assert.equal(rows.length, 1, 'il silenzio di Jev è registrato: una valutazione tentata e non risposta');
  assert.equal(rows[0].bot_id, 'b-timeout');
  assert.match(rows[0].error, /timeout/i);
  assert.equal(rows[0].answers_json, null, 'nessuna risposta da registrare');
  assert.equal(rows[0].action, 'open_long');
}));

test('errore HTTP, rete morta e risposta illeggibile: esito strutturato, mai un throw', () => withKey(async () => {
  for (const [label, httpPost, code] of [
    ['500', async () => { const e = new Error('Request failed'); e.response = { status: 500, data: { detail: 'boom' } }; throw e; }, 'http_error'],
    ['422 di schema', async () => { const e = new Error('Request failed'); e.response = { status: 422, data: { detail: [{ loc: ['body', 'questions'] }] } }; throw e; }, 'http_error'],
    ['rete morta', async () => { throw new Error('ECONNREFUSED'); }, 'network_error'],
    // Il timeout interno di axios è lo stesso fatto del nostro abort: stesso
    // codice, altrimenti in audit un endpoint lento sarebbe indistinguibile da
    // uno irraggiungibile.
    ['timeout di axios', async () => { const e = new Error('timeout of 2500ms exceeded'); e.code = 'ECONNABORTED'; throw e; }, 'timeout'],
    ['risposta senza answers', async () => ({ data: { model: 'jev-1.13.0' } }), 'bad_response']
  ]) {
    resetSpend();
    const out = await askJev({ state: 's', questions: QUESTIONS, botId: 'b-err', coin: 'X', httpPost });
    assert.equal(out.ok, false, `${label}: nessun successo finto`);
    assert.equal(out.code, code, `${label}: codice riconoscibile senza leggere il testo`);
    assert.ok(typeof out.reason === 'string' && out.reason.length > 0, `${label}: con un motivo`);

    const rows = db.listJevEvaluations({ limit: 10 });
    assert.equal(rows.length, 1, `${label}: la valutazione fallita è registrata`);
    assert.ok(rows[0].error, `${label}: con l'errore in chiaro`);
  }
}));

test('input non valido: rifiutato senza chiamare nessuno', () => withKey(async () => {
  resetSpend();
  let calls = 0;
  const httpPost = async () => { calls++; return okResponse(); };
  for (const bad of [
    { state: '', questions: QUESTIONS },
    { state: 'x', questions: {} },
    { state: 'x', questions: null }
  ]) {
    const out = await askJev({ ...bad, botId: 'b', coin: 'X', httpPost });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'invalid_request');
  }
  assert.equal(calls, 0, 'niente rete per una richiesta che sappiamo già malformata');
}));

test('risposta valida: answers, costo e contabilità mensile', () => withKey(async () => {
  resetSpend();
  const seen = [];
  const out = await askJev({
    state: 'stato del bot', questions: QUESTIONS, botId: 'b-ok', coin: 'SOL-PERP', action: 'open_long',
    httpPost: async (url, body, cfg) => { seen.push({ url, body, cfg }); return okResponse(); }
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.answers, { signal_reliable: { type: 'noul', noul: 0.78 } });
  assert.equal(out.model, 'jev-1.13.0', 'il modello riportato è quello che ha RISPOSTO, non quello chiesto');
  assert.ok(out.latencyMs >= 0);
  assert.ok(out.costUsd > 0, 'una chiamata pagata non può costare 0: un costo nullo è un budget che non frena');

  // Contratto della richiesta, come verificato sull'API reale.
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/v1\/systemone$/);
  assert.equal(seen[0].body.model, 'jev-latest');
  assert.equal(seen[0].body.state, 'stato del bot');
  assert.deepEqual(seen[0].body.questions, QUESTIONS);
  assert.equal(seen[0].cfg.headers.Authorization, 'Bearer jev-test-key');
  assert.ok(seen[0].cfg.signal, 'la richiesta porta un AbortSignal');

  const rows = db.listJevEvaluations({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].coin, 'SOL-PERP');
  assert.equal(JSON.parse(rows[0].answers_json).signal_reliable.noul, 0.78);
  assert.equal(JSON.parse(rows[0].questions_json).signal_reliable.type, 'noul');
  assert.equal(rows[0].tokens_in, 340);
  assert.equal(rows[0].tokens_out, 21);
  assert.ok(rows[0].cost_usd > 0);
  assert.ok(rows[0].latency_ms >= 0);

  const b = jevBudget();
  assert.ok(b.spentUsd > 0, 'la spesa è finita nel contatore mensile');
  assert.equal(b.exceeded, false);
}));

test('budget esaurito: la chiamata NON parte (e non è un errore rumoroso)', () => withKey(async () => {
  resetSpend();
  const limit = jevBudget().monthlyLimitUsd;
  db.setSetting(`jev_spent_${new Date().toISOString().slice(0, 7)}`, String(limit + 1));

  let calls = 0;
  const out = await askJev({
    state: 's', questions: QUESTIONS, botId: 'b-budget', coin: 'X',
    httpPost: async () => { calls++; return okResponse(); }
  });

  assert.equal(out.ok, false);
  assert.equal(out.code, 'budget_exceeded');
  assert.equal(calls, 0, 'il freno sta PRIMA della spesa, non dopo');
  assert.equal(db.listJevEvaluations({ limit: 10 }).length, 0,
    'nessuna valutazione: non è stata tentata');
  resetSpend();
}));

test('la spesa accumulata frena davvero: N chiamate e poi stop', () => withKey(async () => {
  resetSpend();
  // Budget minuscolo per questo caso: due chiamate a ~costo reale lo sfondano.
  const jevCfg = HYPERLIQUID_CONFIG.agents.jev;
  const savedLimit = jevCfg.monthlyBudgetUsd;
  jevCfg.monthlyBudgetUsd = 0.004;
  try {
    let calls = 0;
    const httpPost = async () => { calls++; return okResponse({ inTok: 100000, outTok: 10000 }); };

    const first = await askJev({ state: 's', questions: QUESTIONS, botId: 'b-acc', coin: 'X', httpPost });
    assert.equal(first.ok, true, 'la prima passa: il budget era intatto');
    assert.equal(calls, 1);

    const second = await askJev({ state: 's', questions: QUESTIONS, botId: 'b-acc', coin: 'X', httpPost });
    assert.equal(second.ok, false, 'la seconda no: la prima ha consumato il budget');
    assert.equal(second.code, 'budget_exceeded');
    assert.equal(calls, 1, 'e non è nemmeno partita');
  } finally {
    jevCfg.monthlyBudgetUsd = savedLimit;
    resetSpend();
  }
}));

test('lo stato testuale ha un tetto: il prompt non può crescere senza limite', () => withKey(async () => {
  resetSpend();
  let sent = null;
  const huge = 'x'.repeat(JEV_STATE_CHAR_CAP * 3);
  const out = await askJev({
    state: huge, questions: QUESTIONS, botId: 'b-cap', coin: 'X',
    httpPost: async (url, body) => { sent = body; return okResponse(); }
  });
  assert.equal(out.ok, true);
  assert.ok(sent.state.length <= JEV_STATE_CHAR_CAP + 40, 'troncato al tetto');
  assert.match(sent.state, /troncato/i, 'e il troncamento è dichiarato, non nascosto');
  resetSpend();
}));

test('un DB che rifiuta la scrittura non fa fallire la chiamata', () => withKey(async () => {
  resetSpend();
  const original = db.insertJevEvaluation;
  db.insertJevEvaluation = () => { throw new Error('disco pieno'); };
  try {
    const out = await askJev({
      state: 's', questions: QUESTIONS, botId: 'b-db', coin: 'X',
      httpPost: async () => okResponse()
    });
    assert.equal(out.ok, true, 'l\'audit è un effetto collaterale: se fallisce, il giudizio resta valido');
    assert.equal(out.auditWritten, false, 'ma lo dice, invece di far finta di aver scritto');
  } finally {
    db.insertJevEvaluation = original;
    resetSpend();
  }
}));

test('dentro la suite, senza trasporto iniettato, non parte nulla di reale', () => withKey(async () => {
  resetSpend();
  // Se un domani JEV_API_KEY finisse nell'ambiente di questa macchina (config.js
  // carica il file locale), i test che avviano bot veri farebbero partire
  // osservazioni fatturate verso api.typesafe.ai. Questo cancello lo impedisce, e
  // vale solo per chi NON inietta il trasporto — cioè non copre di meno i test
  // veri di questo file, che il trasporto lo iniettano tutti.
  const out = await askJev({ state: 's', questions: QUESTIONS, botId: 'b-suite', coin: 'X' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'test_context');
  assert.equal(db.listJevEvaluations({ limit: 10 }).length, 0);
  resetSpend();
}));

test('listJevEvaluations: più recenti prima, con filtro e limite', () => {
  resetSpend();
  for (let i = 0; i < 5; i++) {
    db.insertJevEvaluation({
      botId: i % 2 ? 'b-a' : 'b-b', coin: 'SOL-PERP', action: 'open_long',
      model: 'jev-1.13.0', state: `s${i}`, questions: QUESTIONS, answers: null,
      latencyMs: 10 + i, tokensIn: 1, tokensOut: 1, costUsd: 0, error: null, ts: 1000 + i
    });
  }
  const all = db.listJevEvaluations({ limit: 3 });
  assert.equal(all.length, 3);
  assert.equal(all[0].ts, 1004, 'più recenti prima');
  const onlyA = db.listJevEvaluations({ botId: 'b-a', limit: 10 });
  assert.equal(onlyA.length, 2);
  assert.ok(onlyA.every(r => r.bot_id === 'b-a'));
  resetSpend();
});
