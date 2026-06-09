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
   * @returns { size, notionalUsd, marginUsd }
   */
  sizePosition(config, equity, price, szDecimals = 3) {
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
   * Calcola i prezzi di TP e SL per una posizione.
   * @param side 'long' | 'short'
   * @returns { tpPx, slPx }
   */
  computeTpSl(entryPx, side, config) {
    const out = { tpPx: null, slPx: null };
    const isLong = side === 'long';

    const tp = config.tp;
    if (tp?.enabled) {
      if (tp.mode === 'absolute') out.tpPx = tp.value;
      else out.tpPx = isLong ? entryPx * (1 + tp.value / 100) : entryPx * (1 - tp.value / 100);
    }

    const sl = config.sl;
    if (sl?.enabled) {
      if (sl.mode === 'absolute') out.slPx = sl.value;
      else out.slPx = isLong ? entryPx * (1 - sl.value / 100) : entryPx * (1 + sl.value / 100);
    }

    return out;
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
  computeTrailing(position, currentPx, config) {
    const tr = config.trailing;
    if (!tr?.enabled) return null;
    const dist = tr.mode === 'absolute' ? tr.value : currentPx * (tr.value / 100);
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
