/**
 * ADATTATORE ANTHROPIC (LLM-01)
 * =============================
 *
 * Refactor di `analyst/client.js` dietro l'interfaccia comune, **senza cambiare
 * una virgola del comportamento**: il formato canonico interno del progetto è
 * già quello Anthropic (blocchi di sistema con `cache_control: ephemeral`,
 * `stop_reason === 'tool_use'`, blocchi `tool_use`/`tool_result`), quindi qui
 * l'adattamento è un passacarte.
 *
 * Non è pigrizia, è la scelta di disegno che rende lo stretch fattibile: il
 * formato interno resta l'Anthropic-like perché è quello su cui si reggono i
 * breakpoint di cache mobili di COST-01/ADV-01, i `TOOL_DEFS` e i loop di
 * tool-use di due agenti già in produzione. Ribaltare il canone su quello OpenAI
 * avrebbe significato riscrivere quei loop — rischio di regressione grande, in
 * cambio di niente. È l'adattatore compatibile OpenAI a tradurre, in entrambe le
 * direzioni (vedi `openaiCompatible.js`).
 *
 * Continua a passare per `getClient()` invece di istanziare l'SDK per conto suo:
 * quell'istanza è memoizzata ed è il seam su cui i test sostituiscono
 * `messages.create`. Cambiarlo avrebbe rotto le suite di Analyst e Advisor senza
 * alcun guadagno.
 */

import { getClient } from '../analyst/client.js';

export const ANTHROPIC_PROVIDER = 'anthropic';

/**
 * @param model modello da usare (nessun default: lo decide il chiamante)
 */
export function createAnthropicProvider({ model }) {
  return {
    name: ANTHROPIC_PROVIDER,
    model,

    /** Disponibile se c'è la chiave: identico al comportamento di sempre. */
    isAvailable() {
      return !!process.env.ANTHROPIC_API_KEY && !!getClient();
    },

    unavailableReason() {
      return 'ANTHROPIC_API_KEY non configurata: il fornitore Anthropic non è utilizzabile.';
    },

    /**
     * Un turno. Ritorna la forma normalizzata dell'interfaccia comune; `content`
     * è il contenuto NATIVO Anthropic perché è già il formato canonico interno,
     * così i loop esistenti non cambiano di una riga.
     */
    async createChatCompletion({ system, messages, tools, maxTokens, signal }) {
      const anthropic = getClient();
      if (!anthropic) throw new Error('Client Anthropic non inizializzabile (ANTHROPIC_API_KEY mancante)');

      const res = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        tools,
        messages
      }, signal ? { signal } : undefined);

      return {
        provider: ANTHROPIC_PROVIDER,
        model,
        content: res.content,
        stopReason: res.stop_reason,
        toolCalls: (res.content || [])
          .filter(b => b.type === 'tool_use')
          .map(b => ({ id: b.id, name: b.name, input: b.input || {} })),
        // Già nel formato che `usage.accumulateUsage` consuma.
        usage: res.usage || {},
        raw: res
      };
    },

    /**
     * Blocco `assistant` da rimettere nella conversazione dopo un giro di
     * tool-use. Su Anthropic si rispedisce il contenuto così com'è arrivato.
     */
    assistantTurnFromResult(result) {
      return { role: 'assistant', content: result.content };
    }
  };
}

export default { createAnthropicProvider, ANTHROPIC_PROVIDER };
