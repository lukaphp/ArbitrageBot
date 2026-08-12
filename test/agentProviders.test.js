/**
 * LLM-01 · interfaccia comune e adattatori (Anthropic + compatibile OpenAI).
 * =========================================================================
 *
 * Tre gruppi di verifiche, e solo il primo è "funziona":
 *
 *  1. **la traduzione** tra il formato canonico interno (Anthropic-like:
 *     `text`/`tool_use`/`tool_result`) e il dialetto OpenAI (`tool_calls` con
 *     argomenti serializzati). È la parte che giustifica l'esistenza
 *     dell'adattatore, ed è dove un errore diventerebbe una conversazione
 *     incomprensibile per il modello o una chiamata di strumento persa;
 *  2. **la contabilità dei token**, che è un problema di CORRETTEZZA e non di
 *     estetica: `prompt_tokens` in stile OpenAI include i token serviti da
 *     cache, `input_tokens` di Anthropic no. Riportarli tali e quali li
 *     conterebbe due volte, gonfiando `costUsd` e facendo scattare il budget di
 *     ADV-03 prima del dovuto;
 *  3. **il gate del listino prezzi**: un fornitore per un modello senza tariffa
 *     non deve nemmeno essere costruibile. Senza tariffa il costo è 0, e un
 *     budget a soglia dura che calcola 0 non frena mai.
 *
 * Lo stesso adattatore viene esercitato con `baseURL` DeepSeek e `baseURL`
 * OpenRouter, per verificare che siano davvero una riga di configurazione e non
 * due percorsi di codice.
 *
 * Nessuna rete: il client HTTP è iniettato (`httpPost`) e registra le richieste.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOpenAiCompatibleProvider, toOpenAiMessages, toOpenAiTools, fromOpenAiResponse, normalizeUsage
} from '../src/agents/providers/openaiCompatible.js';
import { getProvider, listProviders, PROVIDER_NAMES, ProviderError } from '../src/agents/providers/index.js';
import { summarizeUsage, accumulateUsage, emptyUsage, hasPricing, resolvePricing, priceOf } from '../src/agents/usage.js';
import { HYPERLIQUID_CONFIG } from '../src/config/config.js';

const DEEPSEEK_URL = 'https://api.deepseek.com/v1';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

/**
 * Modelli DeepSeek presi dalle CHIAVI di `pricing.models` invece che scritti a mano
 * (LLM-PRICE-01). Questo file inchiodava `deepseek-chat`, che è stato ritirato il
 * 2026-07-24: alla riverifica del listino quattro test sono diventati rossi per un
 * motivo che non c'entrava nulla con ciò che verificano. Derivandoli, la prossima
 * rinomina di un ID di modello resta un cambio in config.js e nient'altro.
 */
const PRICED = Object.keys(HYPERLIQUID_CONFIG.agents?.pricing?.models || {});
const DS_DIRECT = PRICED.find(k => k.startsWith('deepseek-'));
const DS_OPENROUTER = PRICED.find(k => k.startsWith('deepseek/'));
assert.ok(DS_DIRECT, 'il listino deve avere almeno un modello DeepSeek diretto');
assert.ok(DS_OPENROUTER, 'il listino deve avere almeno un modello DeepSeek via OpenRouter');

/** Client HTTP finto: registra le richieste e restituisce una risposta a copione. */
function fakeHttp(response) {
  const calls = [];
  const post = async (url, body, opts) => {
    calls.push({ url, body, opts });
    return { data: typeof response === 'function' ? response(body) : response };
  };
  return { post, calls };
}

const okResponse = (text = 'ciao') => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 }
});

// ------------------------------------------------------- traduzione in uscita ---

test('toOpenAiMessages: il system diventa un messaggio, i testi restano testi', () => {
  const out = toOpenAiMessages(
    [{ type: 'text', text: 'sei un consulente' }, { type: 'text', text: 'stato reale: ok' }],
    [{ role: 'user', content: [{ type: 'text', text: 'come sto andando?' }] }]
  );
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /sei un consulente/);
  assert.match(out[0].content, /stato reale: ok/, 'i blocchi di sistema si concatenano, nessuno si perde');
  assert.deepEqual(out[1], { role: 'user', content: 'come sto andando?' });
});

test('toOpenAiMessages: i cache_control vengono ignorati senza far saltare nulla', () => {
  // In questo dialetto i breakpoint di cache non sono controllabili dal client:
  // vanno ignorati, non devono diventare testo spurio nel prompt.
  const out = toOpenAiMessages(
    [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    [{ role: 'user', content: [{ type: 'text', text: 'ciao', cache_control: { type: 'ephemeral' } }] }]
  );
  assert.equal(out[0].content, 'system');
  assert.equal(out[1].content, 'ciao');
  assert.equal(/ephemeral/.test(JSON.stringify(out)), false, 'nessun residuo del formato interno nel payload');
});

test('toOpenAiMessages: tool_use → tool_calls con argomenti serializzati', () => {
  const out = toOpenAiMessages(null, [
    { role: 'user', content: [{ type: 'text', text: 'quanto ho?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'controllo' },
        { type: 'tool_use', id: 'tu_1', name: 'get_account', input: { limit: 3 } }
      ]
    }
  ]);
  const assistant = out.find(m => m.role === 'assistant');
  assert.equal(assistant.content, 'controllo');
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, 'tu_1');
  assert.equal(assistant.tool_calls[0].type, 'function');
  assert.equal(assistant.tool_calls[0].function.name, 'get_account');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"limit":3}',
    'gli argomenti sono una STRINGA JSON in questo dialetto, non un oggetto');
});

test('toOpenAiMessages: ogni tool_result diventa un messaggio `tool` separato', () => {
  // Differenza strutturale, non cosmetica: in Anthropic più risultati stanno
  // dentro un solo messaggio utente, qui sono messaggi distinti.
  const out = toOpenAiMessages(null, [
    { role: 'user', content: [{ type: 'text', text: 'vai' }] },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'a', name: 'get_account', input: {} },
      { type: 'tool_use', id: 'b', name: 'get_bots', input: {} }
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a', content: '{"equity":10}' },
      { type: 'tool_result', tool_use_id: 'b', content: '[]' }
    ] }
  ]);
  const toolMsgs = out.filter(m => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.deepEqual(toolMsgs.map(m => m.tool_call_id), ['a', 'b']);
  assert.equal(toolMsgs[0].content, '{"equity":10}');
  assert.equal(out.filter(m => m.role === 'user').length, 1, 'il turno di soli risultati non produce un messaggio utente vuoto');
});

test('toOpenAiTools: input_schema → parameters', () => {
  const out = toOpenAiTools([
    { name: 'get_account', description: 'stato del conto', input_schema: { type: 'object', properties: { x: { type: 'number' } } } }
  ]);
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 'get_account');
  assert.equal(out[0].function.description, 'stato del conto');
  assert.deepEqual(out[0].function.parameters, { type: 'object', properties: { x: { type: 'number' } } });
});

// ------------------------------------------------------ traduzione in entrata ---

test('fromOpenAiResponse: tool_calls → blocchi tool_use nel formato interno', () => {
  const res = fromOpenAiResponse({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'vedo i dati',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_risk_snapshot', arguments: '{"limit":5}' } }]
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2 }
  }, { model: DS_DIRECT });

  assert.equal(res.stopReason, 'tool_use', 'finish_reason tool_calls si traduce nel canone interno');
  const toolBlock = res.content.find(b => b.type === 'tool_use');
  assert.equal(toolBlock.name, 'get_risk_snapshot');
  assert.deepEqual(toolBlock.input, { limit: 5 }, 'gli argomenti tornano oggetto');
  assert.equal(toolBlock.id, 'c1');
  assert.equal(res.content.find(b => b.type === 'text').text, 'vedo i dati');
  assert.deepEqual(res.toolCalls.map(c => c.name), ['get_risk_snapshot']);
});

test('fromOpenAiResponse: argomenti JSON malformati → input vuoto e marcatura, non un crash', () => {
  const res = fromOpenAiResponse({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c1', function: { name: 'get_account', arguments: '{non json' } }] } }],
    usage: {}
  }, { model: DS_DIRECT });

  const block = res.content.find(b => b.type === 'tool_use');
  assert.deepEqual(block.input, {}, 'non si tira a indovinare cosa intendeva il modello');
  assert.equal(block.malformedArguments, true, 'ma la cosa resta marcata, non silenziata');
  assert.equal(res.toolCalls[0].malformedArguments, true);
});

test('fromOpenAiResponse: mappatura dei finish_reason', () => {
  const mk = (finish) => fromOpenAiResponse({ choices: [{ finish_reason: finish, message: { content: 'x' } }] }, {}).stopReason;
  assert.equal(mk('stop'), 'end_turn');
  assert.equal(mk('tool_calls'), 'tool_use');
  assert.equal(mk('length'), 'max_tokens');
  assert.equal(mk(undefined), 'end_turn', 'assenza → fine turno, non undefined che romperebbe il confronto');
});

// ------------------------------------------------- contabilità token e costo ---

test('normalizeUsage: i token da cache NON vengono contati due volte', () => {
  // prompt_tokens (stile OpenAI) INCLUDE i cachati; input_tokens (Anthropic) no.
  const u = normalizeUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 700, completion_tokens: 50 });
  assert.equal(u.input_tokens, 300, 'input = prompt − cachati');
  assert.equal(u.cache_read_input_tokens, 700);
  assert.equal(u.output_tokens, 50);

  // La prova che conta: il totale di prompt fatturato deve restare 1000, non 1700.
  const summary = summarizeUsage(DS_DIRECT, accumulateUsage(emptyUsage(), u));
  assert.equal(summary.tokensIn, 1000,
    'senza la sottrazione il prompt risulterebbe 1700 e il budget di ADV-03 frenerebbe prima del dovuto');
});

test('normalizeUsage: forma OpenAI/OpenRouter dei cachati e valori assenti', () => {
  const u = normalizeUsage({ prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens: 10 });
  assert.equal(u.input_tokens, 300);
  assert.equal(u.cache_read_input_tokens, 200);

  const vuoto = normalizeUsage(undefined);
  assert.deepEqual(vuoto, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    'nessun NaN quando il fornitore non dichiara l\'uso');

  const incoerente = normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 999 });
  assert.equal(incoerente.input_tokens, 0, 'cachati > prompt: non si producono token negativi');
  assert.equal(incoerente.cache_read_input_tokens, 100);
});

test('listino per modello: DeepSeek non viene fatturato a tariffa Sonnet', () => {
  assert.ok(hasPricing(DS_DIRECT));
  assert.equal(resolvePricing(DS_DIRECT).source, 'model');
  assert.equal(resolvePricing(DS_OPENROUTER).source, 'model', 'anche la forma con prefisso di OpenRouter');
  assert.equal(resolvePricing(`${DS_DIRECT}-2024-08`).source, 'model-prefix', 'le varianti datate ricadono sul prefisso');

  const usage = { tokensIn: 1_000_000, tokensOut: 1_000_000 };
  const deepseek = priceOf(DS_DIRECT, usage);
  const sonnet = priceOf('claude-sonnet-4-6', usage);
  assert.ok(deepseek < sonnet / 5,
    `DeepSeek deve costare molto meno di Sonnet: ${deepseek} vs ${sonnet} (prima ricadeva sul tier Sonnet)`);
});

test('modello senza listino: costo 0 (rete di sicurezza) ma hasPricing false', () => {
  assert.equal(hasPricing('modello-mai-visto'), false);
  assert.equal(resolvePricing('modello-mai-visto'), null);
  assert.equal(priceOf('modello-mai-visto', { tokensIn: 1_000_000 }), 0);
  // I tier Anthropic per sottostringa restano, altrimenti servirebbe elencare
  // ogni versione di Claude.
  assert.equal(resolvePricing('claude-haiku-4-5').source, 'tier');
});

// ------------------------------------------------------------------ registry ---

test('registry: un modello senza listino NON produce un fornitore', () => {
  // È il gate che protegge il budget: senza tariffa il costo è 0 e la soglia
  // dura di ADV-03 non frenerebbe mai. Meglio non partire, dicendo perché.
  assert.throws(
    () => getProvider({ provider: 'deepseek', model: 'modello-senza-listino' }),
    (e) => e instanceof ProviderError && e.code === 'missing_pricing' && /listino prezzi/i.test(e.message)
  );
});

test('registry: fornitore sconosciuto e modello mancante falliscono con un motivo', () => {
  assert.throws(() => getProvider({ provider: 'pippo', model: DS_DIRECT }),
    (e) => e.code === 'unknown_provider' && /Valori ammessi/.test(e.message));
  assert.throws(() => getProvider({ provider: 'deepseek' }),
    (e) => e.code === 'missing_model');
  assert.deepEqual([...PROVIDER_NAMES], ['anthropic', 'deepseek', 'openrouter']);
});

test('registry: senza chiavi i fornitori alternativi non sono disponibili, e lo dicono', () => {
  const saved = { d: process.env.DEEPSEEK_API_KEY, o: process.env.OPENROUTER_API_KEY };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const p = getProvider({ provider: 'deepseek', model: DS_DIRECT });
    assert.equal(p.isAvailable(), false, 'nessuna chiave nuova è obbligatoria: senza, il fornitore è solo non disponibile');
    assert.match(p.unavailableReason(), /Chiave API mancante/);
    assert.match(p.unavailableReason(), /solo Anthropic/, 'dice cosa resta funzionante');

    const stato = listProviders();
    assert.equal(stato.find(x => x.name === 'deepseek').configured, false);
    assert.match(stato.find(x => x.name === 'deepseek').reason, /DEEPSEEK_API_KEY/);
    assert.equal(stato.find(x => x.name === 'openrouter').baseURL, OPENROUTER_URL);
  } finally {
    if (saved.d) process.env.DEEPSEEK_API_KEY = saved.d;
    if (saved.o) process.env.OPENROUTER_API_KEY = saved.o;
  }
});

// ------------------------------------- lo stesso codice su due baseURL diversi ---

for (const [nome, baseURL] of [['deepseek', DEEPSEEK_URL], ['openrouter', OPENROUTER_URL]]) {
  test(`adattatore compatibile OpenAI su ${nome}: stessa richiesta, solo baseURL e chiave diversi`, async () => {
    const http = fakeHttp(okResponse('tutto bene'));
    const provider = createOpenAiCompatibleProvider({
      name: nome, model: DS_DIRECT, baseURL, apiKey: `chiave-finta-${nome}`, httpPost: http.post
    });

    assert.equal(provider.isAvailable(), true);
    const res = await provider.createChatCompletion({
      system: [{ type: 'text', text: 'sei un consulente' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'come va?' }] }],
      tools: [{ name: 'get_account', description: 'conto', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 500
    });

    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, `${baseURL}/chat/completions`, 'l\'endpoint segue il baseURL configurato');
    assert.equal(http.calls[0].opts.headers.Authorization, `Bearer chiave-finta-${nome}`);
    assert.equal(http.calls[0].body.model, DS_DIRECT);
    assert.equal(http.calls[0].body.max_tokens, 500);
    assert.equal(http.calls[0].body.tools[0].function.name, 'get_account');
    assert.equal(http.calls[0].body.tool_choice, 'auto');

    assert.equal(res.provider, nome);
    assert.equal(res.stopReason, 'end_turn');
    assert.equal(res.content[0].text, 'tutto bene');
    assert.equal(res.usage.input_tokens, 100);
  });
}

test('i due fornitori producono una richiesta IDENTICA a meno di URL e chiave', () => {
  const bodies = [];
  for (const [nome, baseURL] of [['deepseek', DEEPSEEK_URL], ['openrouter', OPENROUTER_URL]]) {
    const http = fakeHttp(okResponse());
    const p = createOpenAiCompatibleProvider({ name: nome, model: DS_DIRECT, baseURL, apiKey: 'k', httpPost: http.post });
    p.createChatCompletion({ system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'm' }] }], tools: [], maxTokens: 10 });
    bodies.push(http.calls);
  }
  // Le chiamate sono asincrone ma il body è costruito prima dell'await del post.
  assert.deepEqual(bodies[0][0].body, bodies[1][0].body,
    'non due percorsi di codice: un adattatore solo, due righe di configurazione');
});

test('errore dichiarato dal fornitore: si propaga, non passa per una risposta valida', async () => {
  const http = fakeHttp({ error: { message: 'quota esaurita' } });
  const p = createOpenAiCompatibleProvider({ name: 'deepseek', model: DS_DIRECT, baseURL: DEEPSEEK_URL, apiKey: 'k', httpPost: http.post });
  await assert.rejects(
    () => p.createChatCompletion({ system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [], maxTokens: 10 }),
    /quota esaurita/
  );
});

test('senza chiave l\'adattatore rifiuta prima di fare qualunque richiesta', async () => {
  const http = fakeHttp(okResponse());
  const p = createOpenAiCompatibleProvider({ name: 'deepseek', model: DS_DIRECT, baseURL: DEEPSEEK_URL, apiKey: null, httpPost: http.post });
  await assert.rejects(() => p.createChatCompletion({ system: [], messages: [], tools: [], maxTokens: 10 }), /Chiave API mancante/);
  assert.equal(http.calls.length, 0, 'nessuna richiesta parte senza chiave');
});

// ------------------------------------------------------- adattatore Anthropic ---

test('adattatore Anthropic: stesso comportamento di prima, formato interno intatto', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'chiave-finta-mai-inviata';
  const { getClient } = await import('../src/agents/analyst/client.js');
  const anthropic = getClient();
  const richieste = [];
  anthropic.messages.create = async (req) => {
    richieste.push(req);
    return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'get_account', input: {} }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 }
    };
  };

  const provider = getProvider({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  const res = await provider.createChatCompletion({
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
    tools: [{ name: 'get_account', description: 'x', input_schema: { type: 'object', properties: {} } }],
    maxTokens: 1500
  });

  // Il payload inviato all'SDK deve restare quello di sempre: i breakpoint di
  // cache sono l'ottimizzazione di costo su cui si regge COST-01/ADV-01.
  assert.equal(richieste[0].model, 'claude-haiku-4-5');
  assert.equal(richieste[0].max_tokens, 1500);
  assert.equal(richieste[0].system[0].cache_control.type, 'ephemeral', 'il cache_control arriva intatto');
  assert.equal(richieste[0].tools[0].name, 'get_account', 'i TOOL_DEFS passano nel formato nativo');

  assert.equal(res.stopReason, 'tool_use');
  assert.equal(res.content[0].type, 'tool_use', 'il content è già il formato canonico interno');
  assert.equal(res.usage.cache_read_input_tokens, 3, 'l\'uso passa nella forma che accumulateUsage consuma');
  assert.deepEqual(provider.assistantTurnFromResult(res), { role: 'assistant', content: res.content });
});
