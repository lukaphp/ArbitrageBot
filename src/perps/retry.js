/**
 * RETRY CON BACKOFF E TIMEOUT (Hyperliquid)
 * =========================================
 *
 * Ritenta una funzione async sugli errori transitori — rate-limit (429) e
 * 5xx/errori di rete — con backoff esponenziale + jitter. Rispetta l'header
 * `Retry-After` quando presente. Gli errori non transitori (es. 4xx diversi da
 * 429, ordine rifiutato) NON vengono ritentati: si propagano subito.
 *
 * Ogni tentativo ha inoltre un TIMESTOP esplicito (`withTimeout`). Il retry da
 * solo non basta: ritenta soltanto DOPO un errore, quindi una `fn()` che non si
 * risolve E non si rigetta mai lo lascia appeso per sempre al primo tentativo.
 * È successo davvero, in produzione: il token bucket interno dell'SDK
 * Hyperliquid faceva morire di fame le richieste di peso 20 (`userFills`,
 * `frontendOpenOrders`) e la loro promise restava pendente all'infinito — la
 * dashboard non mostrava più né operazioni attive né storico, senza un solo
 * errore nei log. Con il timeout quel caso diventa un errore transitorio
 * (`code: 'ETIMEDOUT'`), quindi loggato, contato e ritentato.
 */

import logger from '../utils/logger.js';
import metrics from './metrics.js';

// `timeoutMs` è il tetto per SINGOLO tentativo, non per l'intera withRetry.
// 20s è largo rispetto a una risposta sana di Hyperliquid (1-3s) e resta sopra
// i timeout axios già impostati nelle chiamate dirette (10-15s), così è
// l'errore più specifico a vincere; chi ha bisogno di reagire prima lo abbassa.
const DEFAULTS = { retries: 3, baseMs: 400, maxMs: 8000, metric: 'api_errors_total', timeoutMs: 20000 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Errore di timeout: `code` ETIMEDOUT perché `isTransient` lo tratti come ritentabile. */
export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`timeout dopo ${ms}ms${label ? ` (${label})` : ''}`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

/**
 * Esegue `fn` imponendo un tetto di tempo. Se `ms` è 0/null/undefined il tetto
 * è disattivato e `fn` viene solo eseguita.
 *
 * Due dettagli non ovvi:
 *  - il timer va SEMPRE cancellato (anche sul percorso di successo), altrimenti
 *    tiene vivo l'event loop: in un processo che deve terminare da solo — un
 *    test, uno script una-botta — è la differenza fra uscire e restare appeso;
 *  - la `fn` che ha perso la corsa CONTINUA a girare: non possiamo annullarla.
 *    Se più tardi rigetta, l'errore è già "gestito" (`Promise.race` si è
 *    iscritta a entrambe), quindi non produce un unhandled rejection. Chi la usa
 *    su un percorso che muove denaro deve però ricordare che un timeout
 *    significa "non so l'esito", non "non è successo": va riconciliato.
 *
 * @param {Function} fn funzione async da eseguire
 * @param {number} ms tetto di tempo in ms (0/null = nessun tetto)
 * @param {string} [label] etichetta leggibile, finisce nel messaggio d'errore
 */
export function withTimeout(fn, ms, label) {
  const run = Promise.resolve().then(fn);
  if (!ms || ms <= 0) return run;
  let timer;
  return Promise.race([
    run,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms); })
  ]).finally(() => clearTimeout(timer));
}

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
 * @param {object} options { retries, baseMs, maxMs, label, metric, timeoutMs }
 *   `metric` è il contatore incrementato quando i tentativi si esauriscono:
 *   default `api_errors_total`, il cui HELP dichiara "errori verso le API
 *   Hyperliquid". Chi ritenta qualcos'altro (il notifier Telegram, QUAL-01) passa
 *   il proprio contatore invece di gonfiare quello di Hyperliquid con errori che
 *   non lo riguardano; `null` per non contare nulla.
 *   `timeoutMs` è il tetto per singolo tentativo (0/null per disattivarlo).
 */
export async function withRetry(fn, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  let lastErr;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await withTimeout(fn, opts.timeoutMs, opts.label);
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.retries || !isTransient(err)) break;
      const wait = delayFor(err, attempt, opts);
      logger.warn(`↻ retry ${opts.label || ''} tra ${Math.round(wait)}ms (tentativo ${attempt + 1}/${opts.retries}, ${statusOf(err) || err.code || err.message})`);
      await sleep(wait);
    }
  }
  if (opts.metric) metrics.inc(opts.metric); // tentativi esauriti: errore definitivo
  throw lastErr;
}

export default { withRetry, withTimeout, TimeoutError };
