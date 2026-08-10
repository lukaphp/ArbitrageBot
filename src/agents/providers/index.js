/**
 * REGISTRY DEI FORNITORI LLM (LLM-01)
 * ===================================
 *
 * Un punto solo dove si sceglie CON CHI parlare, dietro un'interfaccia unica:
 *
 *   createChatCompletion({ system, messages, tools, maxTokens, signal })
 *     → { provider, model, content, toolCalls, usage, stopReason, raw }
 *
 * `content` è sempre nel formato canonico interno (blocchi Anthropic-like), da
 * qualunque fornitore arrivi: è ciò che permette ai loop di tool-use degli
 * agenti di non sapere nemmeno quale fornitore stanno usando.
 *
 * **Il gate che conta.** Un fornitore non viene costruito se il modello non ha
 * una voce nel listino prezzi (`usage.hasPricing`). Non è pignoleria: il budget
 * mensile a soglia dura di ADV-03 si basa su `costUsd`, e un modello senza
 * tariffa produce costo 0 — cioè un budget che non frena mai, esattamente nella
 * storia che il PO ha voluto più cauta di tutte. Meglio un fornitore che si
 * rifiuta di partire dicendo perché, che uno che parte e non si ferma più.
 *
 * Nessuna chiave è obbligatoria: senza `DEEPSEEK_API_KEY`/`OPENROUTER_API_KEY`
 * quei fornitori risultano non disponibili e tutto resta come oggi (Anthropic).
 */

import { createAnthropicProvider, ANTHROPIC_PROVIDER } from './anthropic.js';
import { createOpenAiCompatibleProvider } from './openaiCompatible.js';
import { hasPricing } from '../usage.js';
import { HYPERLIQUID_CONFIG } from '../../config/config.js';

/** Fornitori conosciuti. `anthropic` è sempre presente e resta il default. */
export const PROVIDER_NAMES = Object.freeze(['anthropic', 'deepseek', 'openrouter']);

export class ProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

function providerConfig(name) {
  return HYPERLIQUID_CONFIG.agents?.providers?.[name] || null;
}

/**
 * Costruisce il fornitore richiesto per un dato modello.
 *
 * @throws ProviderError con un motivo LEGGIBILE — fornitore sconosciuto,
 *   non configurato, o modello senza listino prezzi. Mai un fallback silenzioso
 *   su un altro fornitore: cambiare fornitore sotto il naso di chi ha chiesto
 *   quello è il genere di "aiuto" che rende impossibile capire cosa è successo.
 */
export function getProvider({ provider = ANTHROPIC_PROVIDER, model, httpPost = null } = {}) {
  const name = String(provider || ANTHROPIC_PROVIDER).toLowerCase();
  if (!PROVIDER_NAMES.includes(name)) {
    throw new ProviderError(
      `Fornitore LLM sconosciuto: "${provider}". Valori ammessi: ${PROVIDER_NAMES.join(', ')}.`,
      'unknown_provider'
    );
  }
  if (!model) {
    throw new ProviderError('Nessun modello indicato per il fornitore LLM.', 'missing_model');
  }
  if (!hasPricing(model)) {
    throw new ProviderError(
      `Nessun listino prezzi per il modello "${model}": non posso calcolarne il costo, e senza costo il budget mensile non può frenare. Aggiungi una voce in HYPERLIQUID_CONFIG.agents.pricing.models prima di usarlo.`,
      'missing_pricing'
    );
  }

  if (name === ANTHROPIC_PROVIDER) return createAnthropicProvider({ model });

  const cfg = providerConfig(name);
  if (!cfg) {
    throw new ProviderError(`Fornitore "${name}" non configurato.`, 'not_configured');
  }
  return createOpenAiCompatibleProvider({
    name,
    model,
    baseURL: cfg.baseURL,
    apiKey: process.env[cfg.apiKeyEnv] || null,
    httpPost
  });
}

/**
 * Elenco diagnostico dei fornitori: cosa c'è, cosa è utilizzabile e perché no.
 * Serve a rispondere «perché non posso usare DeepSeek?» senza leggere il codice.
 * Non costruisce nulla e non richiede un modello: guarda solo la configurazione.
 */
export function listProviders() {
  return PROVIDER_NAMES.map(name => {
    if (name === ANTHROPIC_PROVIDER) {
      const ok = !!process.env.ANTHROPIC_API_KEY;
      return { name, configured: ok, baseURL: null, reason: ok ? null : 'ANTHROPIC_API_KEY non impostata' };
    }
    const cfg = providerConfig(name);
    const ok = !!(cfg && process.env[cfg.apiKeyEnv]);
    return {
      name,
      configured: ok,
      baseURL: cfg?.baseURL || null,
      reason: ok ? null : `${cfg?.apiKeyEnv || 'chiave'} non impostata`
    };
  });
}

export default { getProvider, listProviders, PROVIDER_NAMES, ProviderError };
