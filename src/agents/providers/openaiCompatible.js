/**
 * ADATTATORE COMPATIBILE OPENAI — DeepSeek e OpenRouter (LLM-01)
 * =============================================================
 *
 * **Un solo adattatore per entrambi**: DeepSeek (`api.deepseek.com`) e
 * OpenRouter (`openrouter.ai/api/v1`) parlano lo stesso dialetto
 * `/chat/completions`, quindi qui cambiano solo `baseURL` e chiave. Non è una
 * scelta tra i due fornitori: è il disegno che li rende entrambi una riga di
 * configurazione invece di due percorsi di codice — e che rende gratuito
 * aggiungerne un terzo domani.
 *
 * La parte che giustifica l'esistenza di questo file è la **traduzione**, nelle
 * due direzioni, tra il formato canonico interno (Anthropic-like: blocchi
 * `text`/`tool_use`/`tool_result`) e quello OpenAI (`tool_calls` con argomenti
 * serializzati come stringa JSON). Tre differenze non sono cosmetiche:
 *
 *  1. **i `tool_result` sono messaggi separati** con ruolo `tool`, non blocchi
 *     dentro un messaggio utente. Un turno con tre strumenti diventa tre
 *     messaggi;
 *  2. **gli argomenti degli strumenti arrivano come STRINGA** da parsare. Un
 *     modello può produrre JSON malformato: qui non si tira a indovinare, la
 *     chiamata viene marcata e l'input resta vuoto, così a valle il dispatch la
 *     tratta come una chiamata qualunque (e l'allowlist di `toolset.js` continua
 *     a decidere lei se eseguirla);
 *  3. **il conteggio dei token cachati è opposto**: in Anthropic `input_tokens`
 *     ESCLUDE i token letti da cache, in stile OpenAI `prompt_tokens` LI
 *     INCLUDE. Riportarli tali e quali significherebbe contarli due volte in
 *     `summarizeUsage` e gonfiare il costo — cioè far scattare il budget di
 *     ADV-03 prima del dovuto. La sottrazione è fatta qui, ed è testata.
 *
 * I `cache_control: ephemeral` del formato interno vengono **ignorati**: in
 * questo dialetto i breakpoint di cache non sono controllabili dal client
 * (DeepSeek fa caching automatico lato server). Non è una perdita silenziosa —
 * il risparmio da cache si legge comunque nell'uso restituito, quando il
 * fornitore lo dichiara.
 *
 * Nessuna dipendenza nuova: `axios` è già usato da `hyperliquidClient` e
 * `telegramControl`.
 */

import axios from 'axios';
import logger from '../../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 120000;

/** Testo piatto dai blocchi di sistema del formato interno. */
function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return (Array.isArray(system) ? system : [system])
    .map(b => (typeof b === 'string' ? b : b?.text || ''))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Formato interno → messaggi in stile OpenAI.
 * Esportata per poter essere verificata in isolamento: è pura, e la traduzione è
 * il punto in cui un errore diventerebbe una conversazione incomprensibile per
 * il modello (o una chiamata di strumento persa).
 */
export function toOpenAiMessages(system, messages = []) {
  const out = [];
  const systemText = systemToText(system);
  if (systemText) out.push({ role: 'system', content: systemText });

  for (const m of messages) {
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: String(m.content ?? '') }];

    const texts = blocks.filter(b => b.type === 'text').map(b => b.text).filter(Boolean);
    const toolUses = blocks.filter(b => b.type === 'tool_use');
    const toolResults = blocks.filter(b => b.type === 'tool_result');

    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: texts.join('\n') || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
        }));
      }
      out.push(msg);
      continue;
    }

    // Ruolo utente: i risultati degli strumenti diventano messaggi `tool`
    // separati, e devono precedere l'eventuale testo dello stesso turno.
    for (const r of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '')
      });
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

/** `TOOL_DEFS` (formato Anthropic) → `tools` in stile OpenAI. */
export function toOpenAiTools(tools = []) {
  return (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} }
    }
  }));
}

/**
 * Risposta in stile OpenAI → formato canonico interno.
 * Il `content` restituito è fatto degli stessi blocchi che produrrebbe
 * Anthropic, così i loop di tool-use degli agenti non sanno da quale fornitore
 * arriva la risposta.
 */
export function fromOpenAiResponse(data, { model } = {}) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) content.push({ type: 'text', text: String(message.content) });

  const toolCalls = [];
  for (const call of message.tool_calls || []) {
    const name = call.function?.name;
    let input = {};
    let malformed = false;
    try {
      const args = call.function?.arguments;
      input = args ? JSON.parse(args) : {};
      if (input == null || typeof input !== 'object') { input = {}; malformed = true; }
    } catch {
      // Il modello ha prodotto argomenti non parsabili. Non si indovina: la
      // chiamata prosegue con input vuoto e la cosa resta tracciata nel log.
      // L'allowlist di `toolset.js` resta comunque l'unica a decidere se lo
      // strumento è eseguibile.
      malformed = true;
      logger.warn(`🔌 Provider ${model}: argomenti non parsabili per lo strumento "${name}", eseguito con input vuoto`);
    }
    const block = { type: 'tool_use', id: call.id, name, input };
    if (malformed) block.malformedArguments = true;
    content.push(block);
    toolCalls.push({ id: call.id, name, input, malformedArguments: malformed });
  }

  const finish = choice.finish_reason;
  const stopReason = finish === 'tool_calls' ? 'tool_use'
    : finish === 'length' ? 'max_tokens'
      : finish === 'stop' ? 'end_turn'
        : (finish || 'end_turn');

  return { content, toolCalls, stopReason, usage: normalizeUsage(data?.usage) };
}

/**
 * Uso in stile OpenAI → forma che `usage.accumulateUsage` consuma.
 *
 * `prompt_tokens` INCLUDE i token serviti da cache, mentre l'`input_tokens` di
 * Anthropic li ESCLUDE: senza la sottrazione qui sotto gli stessi token
 * verrebbero contati due volte in `summarizeUsage`, con un costo gonfiato e il
 * budget di ADV-03 che frena prima del dovuto.
 */
export function normalizeUsage(usage = {}) {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const cached = Number(
    usage?.prompt_cache_hit_tokens ??            // DeepSeek
    usage?.prompt_tokens_details?.cached_tokens ?? // OpenAI/OpenRouter
    0
  ) || 0;
  const cacheRead = Math.min(cached, prompt);
  return {
    input_tokens: Math.max(0, prompt - cacheRead),
    output_tokens: Number(usage?.completion_tokens) || 0,
    cache_creation_input_tokens: 0, // non esposto da questo dialetto
    cache_read_input_tokens: cacheRead
  };
}

/**
 * Costruisce l'adattatore. `baseURL` e `apiKey` decidono il fornitore: stesso
 * codice per DeepSeek diretto e per OpenRouter.
 *
 * @param name           etichetta del fornitore ('deepseek' | 'openrouter' | …)
 * @param httpPost       iniettabile solo per i test (default: axios.post)
 */
export function createOpenAiCompatibleProvider({ name, model, baseURL, apiKey, httpPost = null }) {
  const post = httpPost || ((...args) => axios.post(...args));
  const url = `${String(baseURL || '').replace(/\/+$/, '')}/chat/completions`;

  return {
    name,
    model,
    baseURL,

    isAvailable() {
      return !!apiKey && !!baseURL;
    },

    unavailableReason() {
      if (!baseURL) return `Nessun baseURL configurato per il fornitore "${name}".`;
      return `Chiave API mancante per il fornitore "${name}": impostala nei segreti per abilitarlo. Senza, resta attivo solo Anthropic.`;
    },

    async createChatCompletion({ system, messages, tools, maxTokens, signal }) {
      if (!apiKey) throw new Error(this.unavailableReason());

      const body = {
        model,
        max_tokens: maxTokens,
        messages: toOpenAiMessages(system, messages)
      };
      const mapped = toOpenAiTools(tools);
      if (mapped.length) {
        body.tools = mapped;
        body.tool_choice = 'auto';
      }

      const res = await post(url, body, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        timeout: DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {})
      });
      const data = res?.data ?? res;
      if (data?.error) {
        throw new Error(typeof data.error === 'string' ? data.error : (data.error.message || 'errore dal fornitore'));
      }

      const normalized = fromOpenAiResponse(data, { model });
      return { provider: name, model, ...normalized, raw: data };
    },

    /**
     * Il turno dell'assistente si rimette nella conversazione nel formato
     * INTERNO (blocchi), non in quello OpenAI: la traduzione avviene sempre e
     * solo al momento dell'invio, così la conversazione in memoria resta una
     * sola, indipendente dal fornitore.
     */
    assistantTurnFromResult(result) {
      return { role: 'assistant', content: result.content };
    }
  };
}

export default { createOpenAiCompatibleProvider, toOpenAiMessages, toOpenAiTools, fromOpenAiResponse, normalizeUsage };
