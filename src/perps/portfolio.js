/**
 * PORTFOLIO RISK MANAGER (Perps)
 * ==============================
 *
 * Limiti di rischio GLOBALI applicati a tutti i bot prima di aprire una
 * posizione: max posizioni concorrenti, esposizione totale, e cooldown dopo
 * N perdite consecutive. I limiti sono persistiti in `settings`.
 *
 * Usa lo stato account Hyperliquid (che già contiene TUTTE le posizioni del
 * master) per contare posizioni ed esposizione: nessuna dipendenza circolare
 * con il botManager.
 */

import db from '../db/database.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';

const DEFAULTS = {
  maxConcurrentPositions: 3,
  maxTotalExposureUsd: (HYPERLIQUID_CONFIG.risk.maxPositionUsd || 5000) * 2,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 60
};

class Portfolio {
  constructor() {
    this.cooldowns = new Map(); // botId -> timestamp di fine cooldown
  }

  getLimits() {
    const raw = db.getSetting('portfolio_limits');
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  }

  setLimits(obj) {
    const merged = { ...this.getLimits(), ...obj };
    db.setSetting('portfolio_limits', JSON.stringify(merged));
    return merged;
  }

  cooldownInfo(botId) {
    const until = this.cooldowns.get(botId);
    return until && Date.now() < until ? until : null;
  }

  /**
   * Verifica i limiti globali prima di aprire.
   * @param {object} p { account, plannedNotional, botId, consecutiveLosses }
   * @returns { ok, reason }
   */
  canOpen({ account, plannedNotional = 0, botId, consecutiveLosses = 0 }) {
    const L = this.getLimits();

    const until = this.cooldownInfo(botId);
    if (until) {
      return { ok: false, reason: `In cooldown fino alle ${new Date(until).toLocaleTimeString('it-IT')}` };
    }

    const positions = account.positions || [];
    if (positions.length >= L.maxConcurrentPositions) {
      return { ok: false, reason: `Max posizioni concorrenti (${L.maxConcurrentPositions}) raggiunto` };
    }

    const totalNotional = positions.reduce((s, p) => s + (p.positionValue || 0), 0) + plannedNotional;
    if (totalNotional > L.maxTotalExposureUsd) {
      return { ok: false, reason: `Esposizione totale ${totalNotional.toFixed(0)}$ oltre il limite (${L.maxTotalExposureUsd}$)` };
    }

    if (consecutiveLosses >= L.maxConsecutiveLosses) {
      this.cooldowns.set(botId, Date.now() + L.cooldownMinutes * 60000);
      return { ok: false, reason: `${consecutiveLosses} perdite consecutive → cooldown ${L.cooldownMinutes} min` };
    }

    return { ok: true };
  }
}

export default new Portfolio();
