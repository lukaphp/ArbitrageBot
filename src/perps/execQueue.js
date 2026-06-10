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
 */

import db from '../db/database.js';

const NONCE_KEY = 'hl_last_nonce';

class ExecQueue {
  constructor() {
    // master(lowercase) -> Promise che rappresenta la coda della sua catena
    this.chains = new Map();
    this._lastNonce = null;
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
    const prev = this.chains.get(key) || Promise.resolve();
    // Accoda dopo il precedente, ignorandone l'esito (non propaghiamo errori a valle).
    const next = prev.then(() => fn(), () => fn());
    // La coda avanza anche se `fn` fallisce, così non resta bloccata.
    this.chains.set(key, next.catch(() => {}));
    return next;
  }
}

export default new ExecQueue();
