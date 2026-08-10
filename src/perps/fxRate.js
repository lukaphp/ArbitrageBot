/**
 * TASSO DI CAMBIO EUR/USD (solo visualizzazione — CUR-01)
 * ======================================================
 *
 * Fornisce il tasso EUR/USD per mostrare un secondo valore in euro accanto ai
 * valori in dollari della cockpit. Sorgente: Frankfurter (frontend pubblico dei
 * tassi di riferimento BCE), API gratuita e **senza chiave** — nessun segreto da
 * gestire, nessuna quota da monitorare.
 *
 * QUESTO MODULO NON PARTECIPA A NESSUNA DECISIONE DI RISCHIO
 * ---------------------------------------------------------
 * È deliberatamente un livello di presentazione e nient'altro. I cap di rischio
 * (`maxDailyLossUsd`, `maxPositionUsd`, `maxTotalExposureUsd`) restano in USD e
 * non vengono convertiti: `riskManager.js`, `portfolio.js` e `riskAgent.js` non
 * importano questo file e non devono iniziare a farlo. Un tasso di cambio è un
 * dato esterno che può essere stantio o assente, e far dipendere un limite di
 * perdita da una GET verso Internet significherebbe che l'API di un terzo, se
 * cade, cambia la dimensione delle posizioni. Se un giorno servissero limiti
 * denominati in euro, è una story a sé con la sua analisi (sprint4.md §0.4).
 *
 * "MAI UN NUMERO VECCHIO SPACCIATO PER FRESCO"
 * -------------------------------------------
 * Il rischio vero di una cache su un tasso di cambio è mostrare per giorni un
 * valore di ieri come se fosse di adesso. Perciò ogni risposta porta sempre con sé
 * `asOf` (la data di riferimento BCE del tasso, non l'istante della nostra
 * chiamata), `ageMs` ed `error`: il valore non viaggia mai da solo. La UI nasconde
 * l'EUR e mostra solo USD quando `stale` è true (CUR-01).
 *
 * DUE OROLOGI, PERCHÉ SONO DUE GUASTI DIVERSI
 * -------------------------------------------
 *  1. `PERPS_FX_MAX_AGE_MS` (default 120h = 5 giorni) — età del **tasso**, misurata
 *     sulla data di riferimento BCE. Va necessariamente larga: la BCE non pubblica
 *     nel fine settimana né nei giorni di chiusura, quindi il lunedì pomeriggio il
 *     valore più fresco *che esista al mondo* è quello di venerdì (≈87h dalla
 *     mezzanotte di venerdì), e un ponte lungo arriva a ≈111h. Una soglia più
 *     stretta di così non segnalerebbe un guasto: nasconderebbe l'EUR ogni lunedì.
 *  2. `PERPS_FX_MAX_FETCH_AGE_MS` (default 24h) — età dell'ultima **chiamata
 *     riuscita**. Questa può essere stretta perché non dipende dal calendario
 *     della BCE: se da un giorno non riusciamo a parlare con la sorgente, il
 *     problema è nostro e va detto subito, senza aspettare cinque giorni.
 *
 * `stale` è vero se una qualsiasi delle due soglie è superata. Nessun valore di
 * queste variabili può far comparire un numero inventato: cambiano solo il momento
 * in cui l'EUR sparisce dalla vista.
 */

import axios from 'axios';
import logger from '../utils/logger.js';

// Host `.dev/v1`: il vecchio `api.frankfurter.app` risponde 301 (verificato il
// 2026-08-10), e axios seguirebbe il redirect ma su un endpoint dal contratto
// diverso (`from`/`to` invece di `base`/`symbols`).
const API_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD';

const TTL_MS = parseInt(process.env.PERPS_FX_TTL_MS, 10) || 6 * 60 * 60 * 1000;
const MAX_AGE_MS = parseInt(process.env.PERPS_FX_MAX_AGE_MS, 10) || 120 * 60 * 60 * 1000;
const MAX_FETCH_AGE_MS = parseInt(process.env.PERPS_FX_MAX_FETCH_AGE_MS, 10) || 24 * 60 * 60 * 1000;
const TIMEOUT_MS = parseInt(process.env.PERPS_FX_TIMEOUT_MS, 10) || 5000;

/**
 * Ultimo tasso ottenuto con successo. Sopravvive ai fallimenti di rete: un tasso
 * di quattro ore fa, etichettato come tale, è più utile di nessun tasso — ed è la
 * UI a decidere se mostrarlo, guardando `stale`.
 */
let cache = null;         // { rate, asOf, fetchedAt }
let lastError = null;     // ultimo tentativo fallito, per la diagnosi
let inFlight = null;      // promessa condivisa: una sola chiamata in volo

/** Millisecondi trascorsi dalla data di riferimento del tasso. */
function ageOf(asOf, now) {
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? Infinity : now - t;
}

/**
 * Interroga Frankfurter. Nessun retry: chi chiama ha già una cache e una risposta
 * onesta da dare ("stantio"), quindi insistere allungherebbe solo il tempo di
 * risposta della cockpit per un dato indicativo. È il contrario delle chiamate a
 * Hyperliquid, dove `withRetry` protegge operazioni che muovono denaro.
 */
async function fetchRate() {
  const res = await axios.get(API_URL, {
    timeout: TIMEOUT_MS,
    headers: { Accept: 'application/json' }
  });

  const rate = Number(res?.data?.rates?.USD);
  const asOf = res?.data?.date;

  // Un 200 con un corpo inatteso è un guasto come un 500: lasciando passare NaN
  // la cockpit mostrerebbe "€NaN" invece di nascondere l'EUR.
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`risposta senza un tasso USD utilizzabile (rates.USD=${JSON.stringify(res?.data?.rates?.USD)})`);
  }
  if (!asOf || Number.isNaN(Date.parse(asOf))) {
    throw new Error(`risposta senza data di riferimento valida (date=${JSON.stringify(asOf)})`);
  }
  return { rate, asOf, fetchedAt: Date.now() };
}

/**
 * Tasso EUR/USD corrente, con il suo stato.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] ignora il TTL e forza una nuova chiamata.
 * @returns {Promise<{rate:number|null, asOf:string|null, stale:boolean, ageMs:number|null,
 *                    fetchedAt:string|null, fetchAgeMs:number|null, source:string,
 *                    error:string|null}>}
 *   `rate` è `null` **solo** quando non esiste alcun valore: nessun numero
 *   inventato, nessun default a 1. Con `rate: null` arriva sempre `stale: true`.
 */
export async function getEurUsd(opts = {}) {
  const now = Date.now();
  const fresh = cache && !opts.force && (now - cache.fetchedAt) < TTL_MS;

  if (!fresh) {
    // Una sola chiamata in volo anche se la cockpit apre più pannelli insieme.
    inFlight = inFlight || fetchRate()
      .then(v => { cache = v; lastError = null; return v; })
      .catch(err => {
        lastError = err?.message || String(err);
        // warn, non error: con una cache valida non è un guasto operativo, e con
        // l'EUR nascosto il bot funziona identico. Nessuna notifica Telegram — un
        // tasso di cambio indisponibile non è un evento di trading.
        logger.warn(`FX EUR/USD non aggiornato: ${lastError}`);
        return null;
      })
      .finally(() => { inFlight = null; });
    await inFlight;
  }

  if (!cache) {
    return {
      rate: null, asOf: null, stale: true, ageMs: null, fetchedAt: null,
      fetchAgeMs: null, source: 'frankfurter',
      error: lastError || 'tasso non disponibile'
    };
  }

  const at = Date.now();
  const ageMs = ageOf(cache.asOf, at);
  const fetchAgeMs = at - cache.fetchedAt;

  return {
    rate: cache.rate,
    asOf: cache.asOf,
    stale: ageMs > MAX_AGE_MS || fetchAgeMs > MAX_FETCH_AGE_MS,
    ageMs,
    fetchedAt: new Date(cache.fetchedAt).toISOString(),
    fetchAgeMs,
    source: 'frankfurter',
    error: lastError
  };
}

/** Soglie effettive: usate dai test e utili in diagnosi. */
export function config() {
  return { ttlMs: TTL_MS, maxAgeMs: MAX_AGE_MS, maxFetchAgeMs: MAX_FETCH_AGE_MS, timeoutMs: TIMEOUT_MS, url: API_URL };
}

/** Azzera cache ed errore. Solo per i test: in esercizio non serve. */
export function _resetForTests() {
  cache = null;
  lastError = null;
  inFlight = null;
}

export default { getEurUsd, config, _resetForTests };
