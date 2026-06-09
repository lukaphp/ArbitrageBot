/**
 * RISK AGENT (gate deterministico unico)
 * ======================================
 *
 * UNICO punto di controllo del rischio prima di QUALSIASI esecuzione, qualunque
 * sia l'origine (bot a regole o proposta approvata dall'Analyst AI).
 *
 * Centralizza ciò che era sparso: `riskManager.checkLimits`, `portfolio.canOpen`,
 * i cap mainnet, la whitelist dei mercati e lo stato del KILL-SWITCH.
 *
 * È deterministico: stesse condizioni → stesso esito. L'AI non lo può aggirare.
 */

import riskManager from '../perps/riskManager.js';
import portfolio from '../perps/portfolio.js';
import db from '../db/database.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

// Azioni che riducono il rischio: non vanno bloccate dai cap.
const RISK_REDUCING = new Set(['close', 'close_suggestion', 'pause_bot', 'tighten_sl', 'reduce']);
// Azioni neutre: solo suggerimenti, non aprono nulla → non richiedono account.
const RISK_NEUTRAL = new Set(['new_strategy_candidate', 'rebalance_suggestion', 'note']);

class RiskAgent {
  /** Il kill-switch è ON? (flag persistito in settings). */
  isKillSwitchOn() {
    return db.getSetting('killswitch', 'off') === 'on';
  }

  setKillSwitch(on) {
    db.setSetting('killswitch', on ? 'on' : 'off');
    db.insertAudit('riskAgent', on ? 'killswitch.on' : 'killswitch.off', {});
  }

  /** Whitelist mercati (vuota = tutti consentiti). */
  _marketAllowed(coin) {
    const wl = HYPERLIQUID_CONFIG.agents?.marketWhitelist || [];
    if (!wl.length) return true;
    return wl.includes(coin) || wl.includes(coin?.replace('-PERP', ''));
  }

  /**
   * Valuta un'azione. Ritorna { ok, reason }.
   * action: { type, coin, side?, notionalUsd?, leverage?, botId?, config?, account?, consecutiveLosses?, dailyPnl? }
   */
  evaluate(action) {
    const verdict = this._evaluate(action);
    db.insertAudit('riskAgent', verdict.ok ? 'action.approved' : 'action.rejected',
      { type: action.type, coin: action.coin, reason: verdict.reason });
    if (!verdict.ok) logger.warn(`🛡️ RiskAgent: azione respinta — ${verdict.reason}`, { type: action.type, coin: action.coin });
    return verdict;
  }

  _evaluate(action) {
    if (this.isKillSwitchOn()) {
      return { ok: false, reason: 'Kill-switch attivo: tutte le aperture sono bloccate.' };
    }

    // Le azioni che riducono il rischio passano sempre.
    if (RISK_REDUCING.has(action.type)) return { ok: true, reason: 'Azione che riduce il rischio.' };

    // Le azioni neutre (suggerimenti) non aprono nulla: passano senza account.
    if (RISK_NEUTRAL.has(action.type)) return { ok: true, reason: 'Suggerimento (nessuna esecuzione).' };

    // Da qui in poi: aperture / incrementi di esposizione.
    if (!this._marketAllowed(action.coin)) {
      return { ok: false, reason: `Mercato ${action.coin} non in whitelist.` };
    }

    const account = action.account;
    if (!account) {
      return { ok: false, reason: 'Nessun wallet/agent collegato: collega l\'account (crea un bot o abilita l\'agent) per eseguire aperture.' };
    }

    const cfg = action.config || {};
    const plan = { notionalUsd: action.notionalUsd || 0, leverage: action.leverage || cfg.leverage || 1 };

    // 1) Limiti per-ordine (leva, notional, perdita giornaliera)
    const limit = riskManager.checkLimits(cfg, account, plan, action.dailyPnl || 0);
    if (!limit.ok) return limit;

    // 2) Limiti di portafoglio (posizioni concorrenti, esposizione, cooldown)
    const pf = portfolio.canOpen({
      account,
      plannedNotional: plan.notionalUsd,
      botId: action.botId,
      consecutiveLosses: action.consecutiveLosses || 0
    });
    if (!pf.ok) return pf;

    return { ok: true, reason: 'OK' };
  }
}

export default new RiskAgent();
