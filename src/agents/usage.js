/**
 * CONTABILITÀ TOKEN/COSTO CONDIVISA TRA GLI AGENTI (ADV-01, fase 0 dello spike)
 * ============================================================================
 *
 * Qui vive UNA sola volta la matematica di costo e di prompt caching usata da
 * tutti gli agenti che parlano con Claude: l'Analyst (batch, output JSON) e il
 * consulente conversazionale (sessione lunga, prosa). Prima stava dentro
 * `analyst/analyst.js`.
 *
 * Perché estrarla PRIMA di scrivere la chat, e non dopo: due contabilità che
 * partono identiche divergono al primo cambio di listino o di moltiplicatore di
 * cache, e il costo mostrato all'utente inizia a dipendere da quale agente lo
 * ha calcolato. È lo stesso incidente già visto con lo schema di cifratura
 * duplicato tra `agentWallet.js` e `secretBox.js` (SEC-07).
 *
 * Nessun cambio di comportamento rispetto alla versione dentro `analyst.js`: le
 * funzioni sono le stesse, con l'unica differenza che `simulateRun` riceve
 * `toolResultTokens` come parametro (con default identico al valore che usava
 * l'Analyst) invece di leggerlo da una costante di modulo non accessibile.
 */

import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

// Moltiplicatori di prezzo del prompt caching rispetto alla tariffa di input:
// scrivere in cache costa 1.25x, rileggere 0.1x. Un loop agentico rispedisce
// tutta la history a ogni iterazione, quindi la rilettura è dove si risparmia.
export const CACHE_WRITE_MULT = 1.25;
export const CACHE_READ_MULT = 0.1;

/**
 * Tetto ai caratteri di UN `tool_result` rispedito al modello. Vale per tutti
 * gli strumenti, vecchi e nuovi: un risultato senza tetto fa crescere il prompt
 * (e il costo) in modo non prevedibile, e in chat il prompt si rispedisce a ogni
 * turno.
 */
export const TOOL_RESULT_CHAR_CAP = 6000;

/** ~3,3 caratteri per token: la stessa euristica usata nei preventivi. */
export const CHARS_PER_TOKEN = 3.3;

/** Token stimati di un `tool_result` pieno fino al cap. */
export const TOOL_RESULT_TOKENS = Math.round(TOOL_RESULT_CHAR_CAP / CHARS_PER_TOKEN);

/**
 * Sposta il punto di cache sull'ultimo blocco della conversazione, così che a
 * ogni iterazione la history già inviata venga riletta a 0.1x invece di essere
 * rifatturata a prezzo pieno. Tiene al massimo due breakpoint mobili: il limite
 * API è 4 e uno è già occupato dal system.
 */
export function moveCacheBreakpoint(messages) {
  const marked = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && typeof block === 'object' && block.cache_control) marked.push(block);
    }
  }
  while (marked.length > 1) delete marked.shift().cache_control;

  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || !last.content.length) return;
  const lastBlock = last.content[last.content.length - 1];
  if (lastBlock && typeof lastBlock === 'object') lastBlock.cache_control = { type: 'ephemeral' };
}

/**
 * Simula la contabilità token di una run di N iterazioni, tenendo conto del
 * prompt caching: a ogni iterazione il prefisso già inviato si rilegge (0.1x) e
 * solo il delta nuovo si riscrive (1.25x).
 */
export function simulateRun({
  firstInput, iterations, outputPerIter, finalOutput, toolCallsPerIter,
  toolResultTokens = TOOL_RESULT_TOKENS
}) {
  const delta = outputPerIter + toolCallsPerIter * toolResultTokens;
  let cacheWrite = firstInput; // la prima iterazione scrive tutto il prefisso
  let cacheRead = 0;
  for (let k = 2; k <= iterations; k++) {
    cacheRead += firstInput + delta * (k - 2); // prefisso già in cache dall'iterazione precedente
    cacheWrite += delta;                        // il delta appena aggiunto
  }
  const tokensOut = (iterations - 1) * outputPerIter + finalOutput;
  return { tokensIn: 0, cacheWrite, cacheRead, tokensOut, promptTokens: cacheWrite + cacheRead, iterations };
}

// Modelli già segnalati come privi di listino: si avvisa una volta sola, non a
// ogni turno (una riga di log per chiamata seppellirebbe l'avviso invece di darlo).
const warnedUnpriced = new Set();

/**
 * Risolve la tariffa di un modello. Due livelli, in quest'ordine:
 *
 *  1. **listino per MODELLO** (`pricing.models`, LLM-01) — match esatto, poi per
 *     prefisso più lungo (copre le varianti datate tipo `deepseek-chat-2024-08`);
 *  2. **tier Anthropic per sottostringa** del nome (opus/haiku/sonnet) — il
 *     comportamento storico, che resta per non dover elencare ogni versione di
 *     Claude.
 *
 * Ritorna `null` se il modello non è coperto da nessuno dei due. Il fallback
 * implicito su Sonnet che c'era prima era comodo e sbagliato: un modello di un
 * altro fornitore veniva fatturato a $3/$15 per milione — fino a ~11x il prezzo
 * reale — e con un costo gonfiato il budget mensile a soglia dura di ADV-03
 * scatta nel momento sbagliato.
 */
export function resolvePricing(model) {
  const pricing = HYPERLIQUID_CONFIG.agents?.pricing || {};
  const name = String(model || '');
  const models = pricing.models || {};

  if (models[name]) return { rate: models[name], source: 'model', key: name };
  const prefix = Object.keys(models)
    .filter(k => name.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return { rate: models[prefix], source: 'model-prefix', key: prefix };

  if (/opus/i.test(name) && pricing.opus) return { rate: pricing.opus, source: 'tier', key: 'opus' };
  if (/haiku/i.test(name) && pricing.haiku) return { rate: pricing.haiku, source: 'tier', key: 'haiku' };
  if (/sonnet/i.test(name) && pricing.sonnet) return { rate: pricing.sonnet, source: 'tier', key: 'sonnet' };
  return null;
}

/** True se esiste un listino per questo modello. Gate di attivazione (LLM-01). */
export function hasPricing(model) {
  return resolvePricing(model) != null;
}

/**
 * Costo stimato in USD, dal listino configurato.
 * I token letti dalla cache costano 0.1x e quelli scritti 1.25x della tariffa
 * di input: contarli come input pieno gonfierebbe il costo riportato.
 *
 * Modello senza listino → 0, **con un avviso**: un costo silenziosamente nullo
 * significa un budget che non frena mai. Il posto dove il caso viene davvero
 * impedito è a monte (`providers/index.js` rifiuta di costruire un fornitore per
 * un modello senza tariffa), qui resta la rete di sicurezza rumorosa.
 */
export function priceOf(model, { tokensIn = 0, tokensOut = 0, cacheWrite = 0, cacheRead = 0 } = {}) {
  const resolved = resolvePricing(model);
  if (!resolved) {
    const key = String(model || '(vuoto)');
    if (!warnedUnpriced.has(key)) {
      warnedUnpriced.add(key);
      logger.warn(`💸 Nessun listino prezzi per il modello "${key}": il costo risulta 0 e il budget non può frenare. Aggiungi una voce in HYPERLIQUID_CONFIG.agents.pricing.models.`);
    }
    return 0;
  }
  const inRate = resolved.rate.in || 0;
  return (tokensIn / 1e6) * inRate
    + (cacheWrite / 1e6) * inRate * CACHE_WRITE_MULT
    + (cacheRead / 1e6) * inRate * CACHE_READ_MULT
    + (tokensOut / 1e6) * (resolved.rate.out || 0);
}

/**
 * Contabilità di UNA chiamata `messages.create`, sommata su un accumulatore.
 * `input_tokens` è il solo residuo NON cachato: il totale del prompt è
 * input + cache_creation + cache_read. Averlo in un punto solo evita che chat e
 * Analyst contino "token in" in due modi diversi.
 */
export function accumulateUsage(acc, usage = {}) {
  acc.tokensIn += usage.input_tokens || 0;
  acc.cacheWrite += usage.cache_creation_input_tokens || 0;
  acc.cacheRead += usage.cache_read_input_tokens || 0;
  acc.tokensOut += usage.output_tokens || 0;
  return acc;
}

/** Accumulatore vuoto per `accumulateUsage`. */
export function emptyUsage() {
  return { tokensIn: 0, cacheWrite: 0, cacheRead: 0, tokensOut: 0 };
}

/**
 * Normalizza un accumulatore in ciò che si mostra/persiste: `tokensIn` è il
 * TOTALE dei token di prompt fatturati a qualsiasi tariffa.
 */
export function summarizeUsage(model, acc) {
  const promptTokens = acc.tokensIn + acc.cacheWrite + acc.cacheRead;
  return {
    model,
    tokensIn: promptTokens,
    tokensOut: acc.tokensOut,
    cacheWrite: acc.cacheWrite,
    cacheRead: acc.cacheRead,
    cacheHitRate: promptTokens ? acc.cacheRead / promptTokens : 0,
    cost: priceOf(model, acc)
  };
}

export default {
  CACHE_WRITE_MULT, CACHE_READ_MULT, TOOL_RESULT_CHAR_CAP, TOOL_RESULT_TOKENS, CHARS_PER_TOKEN,
  moveCacheBreakpoint, simulateRun, priceOf, resolvePricing, hasPricing,
  accumulateUsage, emptyUsage, summarizeUsage
};
