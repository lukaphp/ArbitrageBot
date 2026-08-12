/**
 * LLM-02/03/04 · l'Analyst dietro `providers/`, e il preventivo senza countTokens.
 * ===============================================================================
 *
 * Tre proprietà, in ordine di importanza:
 *
 *  1. **zero regressioni sul percorso Anthropic** (criterio esplicito di LLM-02).
 *     Non si verifica "la run funziona" — con un client finto funzionerebbe
 *     comunque — ma che il payload spedito all'SDK sia lo STESSO di prima:
 *     modello, `max_tokens`, il `cache_control` nel system e i `TOOL_DEFS` in
 *     formato nativo. L'astrazione deve cambiare l'indirezione, non il
 *     comportamento osservabile;
 *  2. **nessun fallback silenzioso**: un fornitore sconosciuto o senza chiave
 *     produce un motivo leggibile, non una discesa quieta su Anthropic. Cambiare
 *     fornitore sotto il naso di chi ne ha chiesto un altro rende impossibile
 *     capire su cosa si sta spendendo;
 *  3. **LLM-04**: su Anthropic il preventivo continua a usare `countTokens`
 *     (esatto e gratuito: sostituirlo con una stima peggiore sarebbe un
 *     peggioramento senza compenso); sugli altri fornitori usa un'euristica
 *     locale, DICHIARATA come tale, senza toccare la rete.
 *
 * Il modello non-Anthropic non è scritto a mano: viene preso dalle chiavi di
 * `pricing.models`. Gli alias DeepSeek sono già cambiati una volta (i
 * `deepseek-chat`/`deepseek-reasoner` su cui è keyato il listino sono stati
 * ritirati il 24 luglio 2026) e un test che li inchioda si romperebbe alla
 * riverifica dei prezzi di LLM-PRICE-01 per un motivo che non ha nulla a che
 * vedere con ciò che verifica.
 *
 * Nessuna rete: `messages.create`/`countTokens` sostituiti sull'istanza
 * memoizzata, `axios.post` sostituito per il percorso compatibile OpenAI.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Prima di qualunque import: config.js fotografa l'ambiente al caricamento.
process.env.AGENTS_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'chiave-finta-mai-inviata';
process.env.DEEPSEEK_API_KEY = 'chiave-finta-mai-inviata';
process.env.AGENT_ANALYST_MODEL = 'claude-sonnet-4-6';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-analystprov-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: axios } = await import('axios');
const { default: analyst } = await import('../src/agents/analyst/analyst.js');
const { getClient } = await import('../src/agents/analyst/client.js');
const { TOOL_DEFS } = await import('../src/agents/analyst/tools.js');
const { SYSTEM_PROMPT } = await import('../src/agents/analyst/prompts.js');
const { estimatePromptTokens, CHARS_PER_TOKEN } = await import('../src/agents/usage.js');
const { HYPERLIQUID_CONFIG } = await import('../src/config/config.js');
const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: botManager } = await import('../src/perps/botManager.js');

const cfg = HYPERLIQUID_CONFIG.agents;

/**
 * Un modello non-Anthropic che abbia un listino, preso dalla configurazione
 * invece che scritto a mano (vedi intestazione).
 */
const OAI_MODEL = Object.keys(cfg.pricing?.models || {}).find(k => !/claude/i.test(k));
assert.ok(OAI_MODEL, 'la configurazione deve avere almeno un modello non-Anthropic con listino');

client.getAccount = async () => ({ equity: 1000, accountValue: 1000, totalMarginUsed: 0, spotUsdc: 0, totalNtlPos: 0, positions: [] });
client.getFrontendOpenOrders = async () => ([]);
marketData.getStatus = () => ({ isRunning: true, ws: true, wsFresh: true });
marketData.getMarkets = () => ([{ coin: 'ETH-PERP', mid: 3000, maxLeverage: 20 }]);
botManager.bots.clear();
botManager.bots.set('bot-prov', {
  id: 'bot-prov', name: 'Bot Prov', coin: 'ETH-PERP', masterAddress: '0xprovmaster', network: 'testnet', status: 'stopped',
  getState: () => ({ id: 'bot-prov', name: 'Bot Prov', coin: 'ETH-PERP', status: 'stopped', inPosition: false, dailyPnl: 0, config: {}, stats: null })
});

// --- Seam Anthropic ---
const anthropic = getClient();
let script = [];
let createCalls = [];
let countTokenCalls = 0;
anthropic.messages.create = async (req) => {
  createCalls.push(req);
  if (!script.length) throw new Error('script esaurito');
  const next = script.shift();
  return typeof next === 'function' ? next(req) : next;
};
anthropic.messages.countTokens = async (req) => {
  countTokenCalls++;
  return { input_tokens: 4321, _req: req };
};

// --- Seam compatibile OpenAI ---
let httpCalls = [];
let oaiScript = [];
axios.post = async (url, body, opts) => {
  httpCalls.push({ url, body, opts });
  if (!oaiScript.length) throw new Error('script OpenAI esaurito');
  const next = oaiScript.shift();
  return { data: typeof next === 'function' ? next(body) : next };
};

const anthropicUsage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 };
const finalJson = (summary = 'nessuna opportunità') => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ summary, proposals: [] }) }],
  usage: anthropicUsage
});
const anthropicToolCall = (name = 'get_account') => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${name}`, name, input: {} }],
  usage: anthropicUsage
});

const oaiFinal = (summary = 'nessuna opportunità') => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary, proposals: [] }) } }],
  usage: { prompt_tokens: 1000, completion_tokens: 200 }
});
const oaiToolCall = (name = 'get_account') => ({
  choices: [{
    finish_reason: 'tool_calls',
    message: { content: null, tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: '{}' } }] }
  }],
  usage: { prompt_tokens: 1000, completion_tokens: 50 }
});

const auditFor = (action) => db.listAudit(300).filter(r => r.action === action);
const withProvider = async (name, fn) => {
  const saved = cfg.analystProvider;
  cfg.analystProvider = name;
  try { return await fn(); } finally { cfg.analystProvider = saved; }
};

beforeEach(() => {
  script = []; createCalls = []; countTokenCalls = 0;
  oaiScript = []; httpCalls = [];
  analyst.resume();
  analyst.runTimestamps = [];
});

// ---- LLM-03: la manopola ----

test('LLM-03: AGENT_ANALYST_PROVIDER è simmetrica ad AGENT_ADVISOR_PROVIDER — stesso default', () => {
  assert.equal(cfg.analystProvider, 'anthropic', 'default anthropic, come l\'advisor');
  assert.equal(cfg.advisorProvider, 'anthropic');
  assert.equal(analyst.providerName, 'anthropic');
  assert.equal(analyst.status().provider, 'anthropic', 'esposto in status(), come advisor.status().provider');
  // Nessuna chiave nuova obbligatoria: il default non richiede nulla oltre a
  // quello che l'Analyst già chiedeva prima di LLM-02.
  assert.equal(cfg.analystModel, 'claude-sonnet-4-6', 'nessun modello di default cambiato');
});

// ---- LLM-02: zero regressioni sul percorso Anthropic ----

test('LLM-02: il payload spedito ad Anthropic è invariato (modello, max_tokens, cache_control, TOOL_DEFS nativi)', async () => {
  script = [finalJson()];
  await analyst.run();

  assert.equal(createCalls.length, 1);
  const req = createCalls[0];
  assert.equal(req.model, 'claude-sonnet-4-6');
  assert.equal(req.max_tokens, 3000, 'lo stesso tetto di prima, non un valore nuovo');
  // Il system resta un array di blocchi col breakpoint di cache: è ciò su cui si
  // regge il risparmio da prompt caching di COST-01.
  assert.ok(Array.isArray(req.system));
  assert.equal(req.system[0].type, 'text');
  assert.equal(req.system[0].text, SYSTEM_PROMPT);
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  // Gli strumenti viaggiano nel formato NATIVO Anthropic (input_schema), non
  // tradotti: su Anthropic l'adattatore è un passacarte.
  assert.equal(req.tools, TOOL_DEFS, 'gli stessi TOOL_DEFS, per riferimento');
  assert.ok(req.tools[0].input_schema, 'formato nativo Anthropic, non tools[].function');
  assert.equal(httpCalls.length, 0, 'nessuna richiesta HTTP diretta sul percorso Anthropic');
});

test('LLM-02: il loop di tool-use su Anthropic funziona come prima e registra il fornitore', async () => {
  script = [anthropicToolCall('get_account'), finalJson('letto il conto')];
  const r = await analyst.run();

  assert.equal(createCalls.length, 2, 'un giro di strumenti + la risposta finale');
  assert.equal(r.iterations, 2);
  assert.equal(r.summary, 'letto il conto');
  // Il turno dell'assistente è stato rimesso nella conversazione, seguito dai
  // tool_result: è la forma che l'API richiede.
  const second = createCalls[1];
  const roles = second.messages.map(m => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user']);
  assert.equal(second.messages[2].content[0].type, 'tool_result');

  const detail = JSON.parse(auditFor('run.completed').find(r2 => /letto il conto/.test(r2.detail_json)).detail_json);
  assert.equal(detail.provider, 'anthropic', 'l\'audit dice quale fornitore ha prodotto le proposte');
  assert.equal(detail.model, 'claude-sonnet-4-6');
});

// ---- LLM-02: il percorso compatibile OpenAI ----

test('LLM-02: con un fornitore compatibile OpenAI la run passa dall\'adattatore, non da Anthropic', async () => {
  await withProvider('deepseek', async () => {
    oaiScript = [oaiFinal('via deepseek')];
    const r = await analyst.run({ model: OAI_MODEL });

    assert.equal(r.summary, 'via deepseek');
    assert.equal(createCalls.length, 0, 'l\'SDK Anthropic non è stato toccato');
    assert.equal(httpCalls.length, 1);
    assert.match(httpCalls[0].url, /\/chat\/completions$/);
    assert.equal(httpCalls[0].body.model, OAI_MODEL);
    // Gli strumenti tradotti nel dialetto OpenAI.
    assert.ok(httpCalls[0].body.tools[0].function, 'tools[].function, non input_schema');
    assert.equal(httpCalls[0].body.tools.length, TOOL_DEFS.length, 'tutti gli strumenti, nessuno perso nella traduzione');
  });
});

test('LLM-02: il tool-use tradotto chiude il giro e il costo usa il listino del modello, non quello Anthropic', async () => {
  await withProvider('deepseek', async () => {
    oaiScript = [oaiToolCall('get_account'), oaiFinal('fatto')];
    const r = await analyst.run({ model: OAI_MODEL });

    assert.equal(r.iterations, 2);
    assert.equal(httpCalls.length, 2);
    // Il risultato dello strumento è tornato al modello come messaggio di ruolo
    // `tool` con il tool_call_id giusto: senza, il modello non saprebbe a quale
    // richiesta si riferisce la risposta.
    const toolMsg = httpCalls[1].body.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg, 'i tool_result diventano messaggi di ruolo tool in questo dialetto');
    assert.equal(toolMsg.tool_call_id, 'call_get_account');

    // Il costo è calcolato sul listino di QUESTO modello. Confronto con la
    // tariffa Anthropic Sonnet ($3/1M in): se il fornitore fosse ignorato, il
    // costo coinciderebbe con quello calcolato a tariffa Sonnet.
    const rate = cfg.pricing.models[OAI_MODEL];
    const sonnet = cfg.pricing.sonnet;
    if (rate.in !== sonnet.in || rate.out !== sonnet.out) {
      const asSonnet = (r.tokensIn / 1e6) * sonnet.in + (r.tokensOut / 1e6) * sonnet.out;
      assert.ok(Math.abs(r.cost - asSonnet) > 1e-12,
        'il costo non è quello che si otterrebbe fatturando a tariffa Sonnet');
    }
    const detail = JSON.parse(auditFor('run.completed').find(x => /fatto/.test(x.detail_json)).detail_json);
    assert.equal(detail.provider, 'deepseek');
  });
});

// ---- Degrado: mai un fallback silenzioso ----

test('fornitore sconosciuto: motivo leggibile, e NESSUNA discesa quieta su Anthropic', async () => {
  await withProvider('fornitore-inesistente', async () => {
    script = [finalJson('non dovrei essere chiamato')];
    const r = await analyst.run();

    assert.ok(r.error, 'la run non parte');
    assert.match(r.error, /sconosciuto/i);
    assert.match(r.error, /anthropic/, 'elenca i valori ammessi');
    assert.equal(r.code, 'provider_unknown_provider');
    assert.equal(createCalls.length, 0, 'nessun fallback su Anthropic');
    assert.equal(httpCalls.length, 0);
  });
});

test('fornitore senza chiave: motivo leggibile, nessuna richiesta HTTP', async () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await withProvider('deepseek', async () => {
      const r = await analyst.run({ model: OAI_MODEL });
      assert.ok(r.error);
      assert.match(r.error, /chiave/i, 'dice che manca la chiave, non un errore grezzo');
      assert.equal(r.code, 'provider_unavailable');
      assert.equal(httpCalls.length, 0);
      assert.equal(createCalls.length, 0);
    });
  } finally {
    process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('modello senza listino: la run si rifiuta di partire invece di spendere a costo 0', async () => {
  await withProvider('deepseek', async () => {
    const r = await analyst.run({ model: 'modello-senza-listino-xyz' });
    assert.ok(r.error);
    assert.match(r.error, /listino|prezzi/i);
    assert.equal(r.code, 'provider_missing_pricing');
    assert.equal(httpCalls.length, 0, 'un costo che risulta 0 è un budget che non frena mai');
  });
});

// ---- LLM-04: il preventivo ----

test('LLM-04 · Anthropic: continua a usare countTokens (esatto, gratuito) e lo dichiara', async () => {
  const est = await analyst.estimate({});

  assert.equal(countTokenCalls, 1, 'countTokens è esatto E gratuito: non si sostituisce con una stima');
  assert.equal(est.firstInput, 4321, 'il valore esatto, non l\'euristica');
  assert.equal(est.firstInputExact, true);
  assert.equal(est.estimateMethod, 'countTokens');
  assert.equal(est.cachingEnabled, true, 'su Anthropic i breakpoint di cache sono controllabili');
  assert.equal(est.provider, 'anthropic');
  assert.equal(httpCalls.length, 0);

  // L'euristica è calcolata comunque e riportata accanto all'esatto: è così che
  // il sistema accumula la propria calibrazione sui prompt veri, gratis.
  assert.ok(est.heuristicFirstInput > 0);
  assert.equal(typeof est.heuristicError, 'number');
  assert.ok(Math.abs(est.heuristicError - (est.heuristicFirstInput - 4321) / 4321) < 1e-12,
    'lo scostamento è relativo e col segno');
});

test('LLM-04 · fornitore senza countTokens: euristica, dichiarata come tale, senza rete', async () => {
  await withProvider('deepseek', async () => {
    const est = await analyst.estimate({ model: OAI_MODEL });

    assert.equal(countTokenCalls, 0, 'countTokens non esiste in questo dialetto: non va nemmeno tentato');
    assert.equal(httpCalls.length, 0, 'il preventivo non fa rete: non rallenta e non può fallire per il fornitore');
    assert.equal(est.firstInputExact, false, 'DICHIARATA come stima, non spacciata per esatta');
    assert.equal(est.estimateMethod, 'heuristic');
    assert.equal(est.firstInput, est.heuristicFirstInput);
    assert.equal(est.heuristicError, null, 'senza un esatto con cui confrontarsi, nessuno scostamento inventato');
    assert.equal(est.cachingEnabled, false,
      'in questo dialetto i breakpoint di cache non sono controllabili dal client: dirlo attivo sarebbe un dato falso');
    assert.equal(est.provider, 'deepseek');
    // Il preventivo resta utilizzabile: scenari e costi ci sono comunque.
    assert.ok(est.scenarios.typical.cost > 0);
    assert.ok(est.scenarios.max.cost > est.scenarios.min.cost);
  });
});

test('LLM-04: la stima è calcolata sul prompt REALE dell\'Analyst, per intero', async () => {
  // ⚠️ ONESTÀ SUL LIMITE DI QUESTO TEST: qui NON si verifica l'euristica contro
  // una misura vera di `countTokens` — quel confronto richiede una chiamata reale
  // all'API Anthropic, che non è autorizzata in questo lavoro. Il finto restituisce
  // un numero arbitrario, quindi confrontarci il rapporto darebbe un test che
  // passa per un motivo inventato.
  //
  // Quello che si verifica davvero, ed è controllabile: la stima è quella del
  // payload REALE e COMPLETO che partirebbe (system + tutti i TOOL_DEFS +
  // briefing), non di un frammento. È il modo in cui l'euristica può sbagliare di
  // un ordine di grandezza invece che di qualche punto percentuale.
  const est = await analyst.estimate({});
  assert.equal(createCalls.length, 0, 'un preventivo non consuma inferenza');

  const sysChars = SYSTEM_PROMPT.length;
  const toolChars = TOOL_DEFS.reduce((a, t) => a + JSON.stringify(t).length, 0);
  // Il minimo incomprimibile: system + strumenti, senza contare il briefing.
  const floor = Math.ceil((sysChars + toolChars) / CHARS_PER_TOKEN);

  assert.ok(est.heuristicFirstInput >= floor,
    `la stima (${est.heuristicFirstInput}) include almeno system + strumenti (${floor})`);
  // E il briefing ci si aggiunge: la stima non è una costante che ignora i
  // parametri dell'analisi.
  const conNote = await analyst.estimate({ notes: 'z'.repeat(3300) });
  assert.ok(conNote.heuristicFirstInput >= est.heuristicFirstInput + 900,
    'un briefing più lungo alza la stima: ~3300 caratteri valgono ~1000 token');
});

// ---- L'euristica in isolamento ----

test('estimatePromptTokens: conta gli STRUMENTI, non solo il messaggio', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }];
  const senzaTools = estimatePromptTokens({ system: [{ type: 'text', text: 'sys' }], tools: [], messages });
  const conTools = estimatePromptTokens({ system: [{ type: 'text', text: 'sys' }], tools: TOOL_DEFS, messages });

  // È la proprietà che conta: TOOL_DEFS è la parte più grossa del prompt di una
  // run dell'Analyst. Ometterlo darebbe un preventivo sbagliato di un ordine di
  // grandezza, cioè inutile.
  assert.ok(conTools > senzaTools * 10,
    `con gli strumenti ${conTools} deve dominare il resto ${senzaTools}`);
});

test('estimatePromptTokens: monotona nel contenuto e coerente col rapporto caratteri/token', () => {
  const one = estimatePromptTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(330) }] }] });
  const two = estimatePromptTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(660) }] }] });
  assert.equal(one, Math.ceil(330 / CHARS_PER_TOKEN));
  assert.ok(two > one, 'più testo, più token');
  assert.equal(two, Math.ceil(660 / CHARS_PER_TOKEN));
});

test('estimatePromptTokens: conta il payload di tool_result e gli argomenti di tool_use', () => {
  const base = estimatePromptTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] });
  const withResult = estimatePromptTokens({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(1000) }] }
    ]
  });
  assert.ok(withResult > base + 250, 'un tool_result è prompt pagato, non un metadato da ignorare');

  const withUse = estimatePromptTokens({
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'get_candles', input: { coin: 'ETH-PERP', interval: '1h' } }] }]
  });
  assert.ok(withUse > 0, 'anche gli argomenti serializzati contano');
});

test('estimatePromptTokens: input vuoto o malformato non produce NaN', () => {
  assert.equal(estimatePromptTokens(), 0);
  assert.equal(estimatePromptTokens({}), 0);
  assert.equal(estimatePromptTokens({ system: null, tools: null, messages: null }), 0);
  assert.ok(Number.isFinite(estimatePromptTokens({ messages: [{ role: 'user', content: 'stringa piatta' }] })));
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
