/**
 * RETRY CON BACKOFF (Hyperliquid)
 * ===============================
 *
 * Ritenta una funzione async sugli errori transitori — rate-limit (429) e
 * 5xx/errori di rete — con backoff esponenziale + jitter. Rispetta l'header
 * `Retry-After` quando presente. Gli errori non transitori (es. 4xx diversi da
 * 429, ordine rifiutato) NON vengono ritentati: si propagano subito.
 */

import logger from '../utils/logger.js';
import metrics from './metrics.js';

const DEFAULTS = { retries: 3, baseMs: 400, maxMs: 8000 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Estrae lo status HTTP da un errore axios o generico. */
function statusOf(err) {
  return err?.response?.status ?? err?.status ?? null;
}

/** True se l'errore è transitorio e ha senso ritentare. */
function isTransient(err) {
  const s = statusOf(err);
  if (s === 429) return true;
  if (s != null && s >= 500 && s < 600) return true;
  if (s != null) return false; // altri 4xx: errore "definitivo", non ritentare
  // Nessuno status → errore di rete/timeout: transitorio.
  const code = err?.code || '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)
    || /timeout|network|socket hang up/i.test(err?.message || '');
}

/** Ritardo (ms) per il tentativo `attempt` (0-based), onorando Retry-After. */
function delayFor(err, attempt, opts) {
  const ra = err?.response?.headers?.['retry-after'];
  if (ra != null) {
    const secs = parseFloat(ra);
    if (!isNaN(secs)) return Math.min(secs * 1000, opts.maxMs);
  }
  const exp = Math.min(opts.baseMs * 2 ** attempt, opts.maxMs);
  return exp / 2 + Math.random() * (exp / 2); // jitter
}

/**
 * Esegue `fn` con retry sugli errori transitori.
 * @param {Function} fn  funzione async da eseguire
 * @param {object} options { retries, baseMs, maxMs, label }
 */
export async function withRetry(fn, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  let lastErr;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.retries || !isTransient(err)) break;
      const wait = delayFor(err, attempt, opts);
      logger.warn(`↻ retry ${opts.label || ''} tra ${Math.round(wait)}ms (tentativo ${attempt + 1}/${opts.retries}, ${statusOf(err) || err.code || err.message})`);
      await sleep(wait);
    }
  }
  metrics.inc('api_errors_total'); // tentativi esauriti: errore definitivo
  throw lastErr;
}

export default { withRetry };
