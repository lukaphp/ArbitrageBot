/**
 * RISK MANAGER (Perps)
 * ====================
 *
 * Sizing delle posizioni, calcolo TP/SL e trailing stop, e controllo dei limiti
 * di rischio applicato lato server PRIMA di ogni ordine.
 *
 * Tutti i valori monetari sono in USD (collateral Hyperliquid = USDC).
 */

import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

class RiskManager {
  /** Arrotonda la size al numero di decimali consentito dal mercato. */
  roundSize(size, szDecimals = 3) {
    const f = Math.pow(10, szDecimals);
    return Math.floor(size * f) / f;
  }

  /**
   * Calcola la size (in unità di coin) da aprire.
   *
   * IMPORTANTE: `equity` deve essere l'ACCOUNT VALUE TOTALE del conto
   * (depositi + PnL non realizzato), MAI il solo margine libero/disponibile —
   * la percentuale di sizing va applicata all'equity complessivo, altrimenti
   * il sizing si riduce progressivamente man mano che il margine viene
   * impegnato da altre posizioni.
   *
   * GUARD DIFENSIVO (SEC-05): un `equity`/`price` non finito o non positivo
   * non è un caso limite normale — è quasi sempre sintomo di un bug a monte
   * (account non ancora caricato, risposta di rete malformata, ecc.). Senza
   * questo controllo un NaN si propagherebbe silenziosamente fino a
   * `roundSize`, e il cap di sicurezza (`notionalUsd > maxPos`) non
   * scatterebbe MAI perché ogni confronto con NaN è falso: l'ordine
   * verrebbe comunque respinto dall'exchange, ma senza nessun segnale
   * chiaro nei log fino a quel punto. Meglio fallire rumorosamente qui.
   * @returns { size, notionalUsd, marginUsd }
   */
  sizePosition(config, equity, price, szDecimals = 3) {
    if (!Number.isFinite(equity) || equity <= 0) {
      throw new Error(`sizePosition: equity non valido (${equity}) — deve essere l'account value totale (depositi + PnL non realizzato), non il margine libero`);
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`sizePosition: price non valido (${price})`);
    }
    const leverage = Math.max(1, config.leverage || HYPERLIQUID_CONFIG.risk.defaultLeverage);
    const sizing = config.sizing || { mode: 'percent', value: 10 };

    let marginUsd;
    if (sizing.mode === 'fixed') {
      marginUsd = sizing.value;                       // margine fisso in USD
    } else {
      marginUsd = equity * (sizing.value / 100);      // % dell'equity
    }

    let notionalUsd = marginUsd * leverage;

    // Cap di sicurezza
    const maxPos = Math.min(
      config.risk?.maxPositionUsd ?? Infinity,
      HYPERLIQUID_CONFIG.risk.maxPositionUsd
    );
    if (notionalUsd > maxPos) notionalUsd = maxPos;

    const size = this.roundSize(notionalUsd / price, szDecimals);
    return { size, notionalUsd: size * price, marginUsd: (size * price) / leverage };
  }

  /**
   * CRIT-01 — interpreta QUANTA size un ordine market ha davvero riempito.
   *
   * Su Hyperliquid un "market" è un limit IoC: può riempirsi del tutto, in parte,
   * o per niente. `_parseOrderResult` espone già `totalSz` (la size eseguita) ma
   * nessuno la leggeva: il bot registrava sempre la size PIANIFICATA. I tre esiti
   * richiedono trattamenti diversi, non una sfumatura dello stesso caso:
   *
   *  - `none` (totalSz null/0/non numerico): nessuna posizione esiste
   *    sull'exchange. Il capitale non è mai stato impegnato: non c'è niente da
   *    correggere più tardi, c'è solo da NON scrivere nulla.
   *  - `partial`: la posizione esiste, più piccola del previsto. Ogni numero a
   *    valle (riga DB, TP/SL, DCA, statistiche) deve usare `filled`.
   *  - `full`: comportamento storico, invariato.
   *
   * Vive qui e non in `bot.js` per la stessa ragione di `applyDcaFill`: è
   * aritmetica sul denaro, va verificabile in isolamento e condivisa con
   * chiunque altro legga un fill (percorso di apertura e percorso DCA).
   *
   * La tolleranza serve al confronto tra due numeri già arrotondati a
   * `szDecimals`: senza, un fill pieno restituito come 0.9999999999 verrebbe
   * classificato parziale e notificato come anomalia a ogni apertura.
   *
   * @param plannedSize size richiesta all'exchange
   * @param totalSz     `order.totalSz` come arriva dal broker (può essere null)
   * @returns { filled, planned, ratio, none, partial, full }
   */
  resolveFillSize(plannedSize, totalSz) {
    const EPS = 1e-9;
    const planned = Number.isFinite(Number(plannedSize)) ? Number(plannedSize) : 0;
    const raw = Number(totalSz);
    const filled = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const none = filled <= 0;
    const partial = !none && planned > 0 && filled + Math.max(EPS, planned * EPS) < planned;
    return {
      filled,
      planned,
      ratio: planned > 0 ? filled / planned : 0,
      none,
      partial,
      full: !none && !partial
    };
  }

  /**
   * WARN-03 — slippage REALE di un'esecuzione: quanto il prezzo medio ottenuto si
   * discosta dal prezzo di riferimento su cui la decisione è stata presa.
   *
   * Entrambi i valori erano già nello stesso scope di `bot._openPosition`
   * (`order.avgPx` e `snapshot.price`) e la differenza non veniva mai calcolata.
   * Ritorna una FRAZIONE (0.001 = 0.1%), non una percentuale, coerentemente con
   * il resto dei rapporti del modulo; `null` quando uno dei due prezzi non è
   * utilizzabile — nessun valore inventato per un dato che non c'è (una posizione
   * adottata da `_reconcile` non ha alcun ordine di riferimento).
   */
  computeSlippage(avgPx, referencePx) {
    const avg = Number(avgPx);
    const ref = Number(referencePx);
    if (!Number.isFinite(avg) || !Number.isFinite(ref) || avg <= 0 || ref <= 0) return null;
    return Math.abs(avg - ref) / ref;
  }

  /**
   * Calcola i prezzi di TP e SL per una posizione.
   * @param side 'long' | 'short'
   * @returns { tpPx, slPx }
   */
  computeTpSl(entryPx, side, config, ctx = {}) {
    const out = { tpPx: null, slPx: null };
    const isLong = side === 'long';
    const atr = ctx.atr; // ATR corrente, per gli stop adattivi alla volatilità

    const tp = config.tp;
    if (tp?.enabled) {
      if (tp.mode === 'absolute') out.tpPx = tp.value;
      else if (tp.mode === 'atr') out.tpPx = atr ? (isLong ? entryPx + tp.value * atr : entryPx - tp.value * atr) : null;
      else out.tpPx = isLong ? entryPx * (1 + tp.value / 100) : entryPx * (1 - tp.value / 100);
    }

    const sl = config.sl;
    if (sl?.enabled) {
      if (sl.mode === 'absolute') out.slPx = sl.value;
      else if (sl.mode === 'atr') out.slPx = atr ? (isLong ? entryPx - sl.value * atr : entryPx + sl.value * atr) : null;
      else out.slPx = isLong ? entryPx * (1 - sl.value / 100) : entryPx * (1 + sl.value / 100);
    }

    return out;
  }

  /**
   * SEC-01: aggiorna una posizione dopo un fill di aggiunta DCA (mediazione).
   * Calcola il nuovo prezzo medio ponderato ed i nuovi TP/SL su quel prezzo,
   * con la STESSA configurazione (percent/atr/absolute) usata all'apertura —
   * mai valori "a occhio", altrimenti TP/SL post-DCA sarebbero incoerenti
   * con la strategia configurata.
   *
   * Funzione pura (nessuna I/O): il chiamante (bot.js) si occupa di
   * piazzare/cancellare i trigger e persistere lo stato; qui viene solo
   * calcolato COSA piazzare. Separare il calcolo dall'orchestrazione I/O la
   * rende testabile in isolamento, senza dover far girare un PerpsBot intero.
   *
   * @param position { side, entryPx, size } — posizione PRIMA di questo fill
   * @param fillPx prezzo medio a cui è stato eseguito il fill di aggiunta
   * @param addSize size aggiunta con questo fill (unità di coin)
   * @returns { entryPx, size, tpPx, slPx }
   */
  applyDcaFill(position, fillPx, addSize, config, ctx = {}) {
    const size = position.size + addSize;
    // Media ponderata: nuovoEntry = (vecchioEntry×vecchiaSize + fillPx×addSize) / sizeTotale
    const entryPx = (position.entryPx * position.size + fillPx * addSize) / size;
    const { tpPx, slPx } = this.computeTpSl(entryPx, position.side, config, ctx);
    return { entryPx, size, tpPx, slPx };
  }

  /**
   * Calcola una scala di take profit parziali.
   * @param ladder lista di { portion (0..1), atPercent }
   * @returns [{ portion, px }]
   */
  computeTpLadder(entryPx, side, ladder) {
    const isLong = side === 'long';
    return (ladder || [])
      .filter(s => s && s.portion > 0 && s.atPercent > 0)
      .map(s => ({
        portion: s.portion,
        px: isLong ? entryPx * (1 + s.atPercent / 100) : entryPx * (1 - s.atPercent / 100)
      }));
  }

  /**
   * Nuovo stop trailing se il prezzo si è mosso a favore. Ritorna null se invariato.
   * @param position { side, slPx }
   */
  computeTrailing(position, currentPx, config, ctx = {}) {
    const tr = config.trailing;
    if (!tr?.enabled) return null;
    let dist;
    if (tr.mode === 'absolute') dist = tr.value;
    else if (tr.mode === 'atr') { if (!ctx.atr) return null; dist = tr.value * ctx.atr; }
    else dist = currentPx * (tr.value / 100);
    const isLong = position.side === 'long';
    const candidate = isLong ? currentPx - dist : currentPx + dist;

    if (position.slPx == null) return candidate;
    if (isLong && candidate > position.slPx) return candidate;
    if (!isLong && candidate < position.slPx) return candidate;
    return null;
  }

  /**
   * Controlla i limiti di rischio prima di aprire. Ritorna { ok, reason }.
   * @param account { accountValue }
   * @param plan    { notionalUsd, leverage }
   * @param dailyPnl perdita/profitto realizzato oggi (USD)
   */
  checkLimits(config, account, plan, dailyPnl = 0) {
    const maxLev = config.risk?.maxLeverage ?? HYPERLIQUID_CONFIG.risk.maxLeverage;
    if ((plan.leverage || 0) > maxLev) {
      return { ok: false, reason: `Leva ${plan.leverage}x oltre il massimo (${maxLev}x)` };
    }
    const equity = account.equity ?? account.accountValue;
    if (equity <= 0) {
      return { ok: false, reason: 'Equity nullo o insufficiente' };
    }
    const maxPos = Math.min(
      config.risk?.maxPositionUsd ?? Infinity,
      HYPERLIQUID_CONFIG.risk.maxPositionUsd
    );
    if (plan.notionalUsd > maxPos * 1.001) {
      return { ok: false, reason: `Notional ${plan.notionalUsd.toFixed(0)}$ oltre il massimo (${maxPos}$)` };
    }
    const maxDailyLoss = config.risk?.maxDailyLossUsd ?? HYPERLIQUID_CONFIG.risk.maxDailyLossUsd;
    if (dailyPnl <= -Math.abs(maxDailyLoss)) {
      return { ok: false, reason: `Limite di perdita giornaliera raggiunto (${maxDailyLoss}$)` };
    }
    return { ok: true, reason: 'OK' };
  }
}

export default new RiskManager();
