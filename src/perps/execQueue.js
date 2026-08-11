/**
 * CODA DI ESECUZIONE + NONCE MONOTONO (Hyperliquid)
 * =================================================
 *
 * Due garanzie per le azioni firmate verso Hyperliquid:
 *
 *  1. SERIALIZZAZIONE per master address: tutte le azioni firmate dello stesso
 *     wallet (apertura/chiusura/trigger/leva/trasferimenti) vengono accodate ed
 *     eseguite UNA ALLA VOLTA. Con più bot sullo stesso master questo evita firme
 *     concorrenti e nonce che collidono.
 *
 *  2. NONCE MONOTONO: nextNonce() restituisce sempre un valore strettamente
 *     crescente (max(Date.now(), lastNonce+1)), persistito in settings così resta
 *     monotono anche dopo un riavvio. Usato per le azioni user-signed (approveAgent,
 *     usdClassTransfer) dove costruiamo noi il nonce.
 *
 *  3. LOCK DI APERTURA per (master, coin) — CRIT-03. Non è una seconda coda: è un
 *     `Set` di chiavi. Serializzare le FIRME (punto 1) non impedisce a due bot
 *     sullo stesso mercato di superare entrambi i controlli di idoneità
 *     (`checkLimits`/`canOpen`/`_cooldownBlock`, che girano PRIMA della coda su uno
 *     snapshot account già stale) e di arrivare entrambi a firmare un'apertura. Il
 *     lock vive qui, accanto a `execQueue`, perché è lo stesso ambito — "chi sta
 *     facendo cosa su quel wallet" — e avere due punti di verità su questo è
 *     esattamente il rischio segnalato in fase di planning.
 *
 *  4. PROFONDITÀ DELLA CODA (WARN-02) — solo osservabilità. La catena di Promise
 *     non contava nulla: con più bot sullo stesso master, un ordine di chiusura
 *     urgente può restare dietro N aperture senza che nessuno se ne accorga. Qui
 *     si misura e si avvisa oltre soglia; NON si prioritizza (fuori scope
 *     dichiarato, candidato futuro).
 */

import db from '../db/database.js';
import metrics from './metrics.js';
import logger from '../utils/logger.js';

const NONCE_KEY = 'hl_last_nonce';

// Profondità oltre la quale la coda di un wallet è considerata anomala.
const DEPTH_WARN_THRESHOLD = Math.max(1, parseInt(process.env.PERPS_EXECQUEUE_DEPTH_WARN) || 10);

class ExecQueue {
  constructor() {
    // master(lowercase) -> Promise che rappresenta la coda della sua catena
    this.chains = new Map();
    this._lastNonce = null;
    // master(lowercase) -> azioni in coda o in esecuzione (WARN-02)
    this.depths = new Map();
    // chiavi già in warning: la soglia notifica al SUPERAMENTO, non a ogni
    // accodamento sopra soglia (stesso principio della notifica-per-episodio).
    this._depthWarned = new Set();
    // `${master}:${coin}` con un'apertura in corso (CRIT-03)
    this.openLocks = new Set();
  }

  // ---- Lock di apertura per (master, coin) — CRIT-03 ----

  _openKey(masterAddress, coin) {
    return `${String(masterAddress || 'default').toLowerCase()}:${String(coin || '')}`;
  }

  /**
   * Prova a prendere il lock di apertura. Ritorna false se è già preso: per il
   * chiamante è un evento ATTESO in un sistema multi-bot (stesso trattamento di
   * un `canOpen()` negativo), non un guasto — nessuna eccezione, nessun alert.
   */
  acquireOpenLock(masterAddress, coin) {
    const key = this._openKey(masterAddress, coin);
    if (this.openLocks.has(key)) return false;
    this.openLocks.add(key);
    return true;
  }

  releaseOpenLock(masterAddress, coin) {
    return this.openLocks.delete(this._openKey(masterAddress, coin));
  }

  /** Solo per diagnostica/test: il lock non si interroga per decidere, si prende. */
  isOpenLocked(masterAddress, coin) {
    return this.openLocks.has(this._openKey(masterAddress, coin));
  }

  // ---- Profondità della coda (WARN-02) ----

  /** Profondità corrente della coda di un wallet (0 se inattiva). */
  depth(masterAddress) {
    return this.depths.get(String(masterAddress || 'default').toLowerCase()) || 0;
  }

  /** Fotografia di tutte le code non vuote + la soglia in vigore. */
  depthSnapshot() {
    const byKey = {};
    let max = 0;
    for (const [key, value] of this.depths) {
      if (value > 0) byKey[key] = value;
      if (value > max) max = value;
    }
    return { max, byKey, threshold: DEPTH_WARN_THRESHOLD };
  }

  _enter(key) {
    const depth = this.depth(key) + 1;
    this.depths.set(key, depth);
    if (depth > DEPTH_WARN_THRESHOLD && !this._depthWarned.has(key)) {
      this._depthWarned.add(key);
      metrics.inc('execqueue_depth_warnings_total');
      logger.warn(`Coda di esecuzione profonda ${depth} azioni per ${key} (soglia ${DEPTH_WARN_THRESHOLD}): un ordine urgente può restare in attesa dietro le altre azioni dello stesso wallet`);
    }
    return depth;
  }

  _leave(key) {
    const depth = Math.max(0, this.depth(key) - 1);
    this.depths.set(key, depth);
    // Rientrata sotto soglia: il prossimo superamento è un episodio nuovo e va
    // segnalato di nuovo.
    if (depth <= DEPTH_WARN_THRESHOLD) this._depthWarned.delete(key);
    return depth;
  }

  /** Nonce strettamente crescente e persistito (monotono tra i riavvii). */
  nextNonce() {
    if (this._lastNonce == null) {
      this._lastNonce = parseInt(db.getSetting(NONCE_KEY, '0'), 10) || 0;
    }
    const candidate = Math.max(Date.now(), this._lastNonce + 1);
    this._lastNonce = candidate;
    try { db.setSetting(NONCE_KEY, String(candidate)); } catch { /* noop */ }
    return candidate;
  }

  /**
   * Esegue `fn` (che ritorna una Promise) serializzandola rispetto alle altre
   * azioni dello stesso master address. Ritorna il risultato di `fn`.
   */
  run(masterAddress, fn) {
    const key = (masterAddress || 'default').toLowerCase();
    this._enter(key);
    const prev = this.chains.get(key) || Promise.resolve();
    // Accoda dopo il precedente, ignorandone l'esito (non propaghiamo errori a valle).
    const next = prev.then(() => fn(), () => fn());
    // La coda avanza anche se `fn` fallisce, così non resta bloccata.
    this.chains.set(key, next.catch(() => {}));
    // La misura della profondità non cambia la serializzazione: `finally` non
    // altera valore né esito della promise restituita, solo la strumenta.
    return next.finally(() => this._leave(key));
  }
}

export default new ExecQueue();
