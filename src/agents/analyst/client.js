/**
 * Wrapper del client Anthropic (SDK ufficiale).
 * Istanziato pigramente: senza ANTHROPIC_API_KEY l'Analyst resta disattivo.
 */

import Anthropic from '@anthropic-ai/sdk';

let instance = null;

export function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!instance) instance = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return instance;
}

export default { getClient };
