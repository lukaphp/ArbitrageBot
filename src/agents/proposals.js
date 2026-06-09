/**
 * APPROVAL QUEUE (proposte dell'Analyst AI)
 * =========================================
 *
 * Le proposte dell'Analyst sono ADVISORY: restano in coda finché un umano non le
 * approva o rifiuta (o finché non scadono). L'approvazione NON basta: l'azione
 * passa comunque dal RiskAgent (gate deterministico) e solo poi dall'ExecutionAgent.
 *
 *   proposal.created → (umano) approve → RiskAgent → ExecutionAgent
 *                                      ↘ reject / expire → scartata
 */

import crypto from 'crypto';
import db from '../db/database.js';
import client from '../perps/hyperliquidClient.js';
import riskAgent from './riskAgent.js';
import executionAgent from './executionAgent.js';
import bus, { EVENTS } from './bus.js';
import notifier from '../perps/notifier.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

class Proposals {
  /** Crea e accoda una proposta. */
  create({ type, coin, payload, rationale, confidence, backtest, source = 'analyst' }) {
    const ttlMin = HYPERLIQUID_CONFIG.agents?.proposalTtlMin || 30;
    const id = crypto.randomUUID();
    const row = db.insertProposal({
      id, type, coin, payload, rationale, confidence, backtest, source,
      expiresAt: Date.now() + ttlMin * 60 * 1000
    });
    db.insertAudit('analyst', 'proposal.created', { id, type, coin });
    bus.publish(EVENTS.PROPOSAL_CREATED, { id, type, coin });
    notifier.notify(`🧠 <b>Nuova proposta AI</b> [${type}] ${coin || ''}\n${rationale || ''}\nApprova con /approva ${id.slice(0, 8)}`);
    logger.info(`🧠 Proposta creata: ${type} ${coin || ''}`, { id });
    return row;
  }

  list(opts) {
    return db.listProposals(opts).map(this._hydrate);
  }

  get(id) {
    const p = db.getProposal(id);
    return p ? this._hydrate(p) : null;
  }

  /** Trova una proposta per id completo o prefisso (comodo da Telegram). */
  findByPrefix(prefix) {
    const all = db.listProposals({ limit: 200 });
    return all.find(p => p.id === prefix || p.id.startsWith(prefix));
  }

  _hydrate(p) {
    return {
      ...p,
      payload: safeParse(p.payload_json),
      backtest: safeParse(p.backtest_json)
    };
  }

  /** Risolve master address + rete dal bot indicato o dal primo bot. */
  async _context(botId) {
    const { default: botManager } = await import('../perps/botManager.js'); // lazy: evita cicli
    const bots = [...botManager.bots.values()];
    const bot = botId ? bots.find(b => b.id === botId) : bots[0];
    return {
      masterAddress: bot?.masterAddress || process.env.WALLET_ADDRESS || null,
      network: bot?.network || client.network
    };
  }

  /**
   * Approva una proposta: arricchisce l'azione, la fa passare dal RiskAgent e,
   * se ok, dall'ExecutionAgent. Ritorna { ok, reason?, result? }.
   */
  async approve(id) {
    const p = this.get(id);
    if (!p) return { ok: false, reason: 'Proposta non trovata' };
    if (p.status !== 'pending') return { ok: false, reason: `Proposta già ${p.status}` };
    if (p.expires_at && p.expires_at < Date.now()) {
      db.setProposalStatus(p.id, 'expired');
      return { ok: false, reason: 'Proposta scaduta' };
    }

    const action = await this._toAction(p);

    // Gate deterministico (non aggirabile)
    const verdict = riskAgent.evaluate(action);
    if (!verdict.ok) {
      db.insertAudit('human', 'proposal.approved.blocked', { id: p.id, reason: verdict.reason });
      return { ok: false, reason: `RiskAgent: ${verdict.reason}` };
    }

    db.insertAudit('human', 'proposal.approved', { id: p.id, type: p.type });
    bus.publish(EVENTS.ACTION_APPROVED, { id: p.id, action });

    const exec = await executionAgent.execute(action);
    db.setProposalStatus(p.id, exec.ok ? 'approved' : 'pending'); // se l'esecuzione fallisce, resta pending per retry
    if (!exec.ok) return { ok: false, reason: exec.error };
    const isSuggestion = exec.result?.noop === true;
    notifier.notify(isSuggestion
      ? `📝 Suggerimento acquisito [${p.type}] ${p.coin || ''} — da configurare a mano`
      : `✅ Proposta eseguita [${p.type}] ${p.coin || ''}`);
    return { ok: true, result: exec.result, suggestion: isSuggestion };
  }

  reject(id) {
    const p = db.getProposal(id);
    if (!p) return { ok: false, reason: 'Proposta non trovata' };
    if (p.status !== 'pending') return { ok: false, reason: `Proposta già ${p.status}` };
    db.setProposalStatus(id, 'rejected');
    db.insertAudit('human', 'proposal.rejected', { id, type: p.type });
    bus.publish(EVENTS.ACTION_REJECTED, { id });
    return { ok: true };
  }

  /** Costruisce l'azione eseguibile da una proposta, arricchendola dal mercato. */
  async _toAction(p) {
    const payload = p.payload || {};
    const ctx = await this._context(payload.botId);
    const action = {
      id: p.id, type: p.type, coin: p.coin || payload.coin,
      masterAddress: ctx.masterAddress, network: ctx.network,
      botId: payload.botId, ...payload
    };

    // Per close/tighten_sl risolve lato e size dalla posizione reale.
    if (['close', 'close_suggestion', 'tighten_sl'].includes(p.type) && action.masterAddress && action.coin) {
      try {
        const acc = await client.getAccount(action.masterAddress, action.network);
        const pos = acc.positions.find(x => x.coin === action.coin || `${x.coin}-PERP` === action.coin);
        if (pos) {
          action.side = action.side || pos.side;
          action.size = action.size || pos.size;
          action.account = acc;
        }
      } catch (e) { logger.warn('Proposals: account non recuperabile', e.message); }
    }
    // Per open serve lo stato account per il RiskAgent.
    if (p.type === 'open' && action.masterAddress && !action.account) {
      try {
        action.account = await client.getAccount(action.masterAddress, action.network);
        action.notionalUsd = action.notionalUsd || (action.size && action.account ? action.size * (await client.getMid(action.coin, action.network).catch(() => 0)) : 0);
        action.config = action.config || {};
      } catch (e) { logger.warn('Proposals: account non recuperabile', e.message); }
    }
    return action;
  }

  /**
   * Storico delle strategie decise. Per quelle approvate e collegate a un bot,
   * allega l'ESITO live (win rate, trade, PnL) che evolve nel tempo.
   */
  history() {
    const rows = db.getStrategyHistory();
    return rows.map(p => {
      const out = {
        id: p.id, coin: p.coin, status: p.status, rationale: p.rationale,
        confidence: p.confidence, createdAt: p.created_at, decidedAt: p.decided_at,
        linkedBotId: p.linked_bot_id, payload: safeParse(p.payload_json)
      };
      if (p.linked_bot_id) {
        const bot = db.getBot(p.linked_bot_id);
        out.botName = bot?.name || null;
        out.botExists = !!bot;
        out.outcome = bot ? db.getBotStats(p.linked_bot_id) : null;
      }
      return out;
    });
  }

  /** Collega un bot a una proposta approvata (per seguirne l'esito). */
  linkBot(proposalId, botId) {
    const r = db.linkProposalBot(proposalId, botId);
    db.insertAudit('human', 'proposal.linked', { id: proposalId, botId });
    return r;
  }

  /** Agente janitor: marca scadute le proposte pendenti oltre il TTL. */
  janitorAgent() {
    return {
      name: 'proposal-janitor',
      intervalMs: 60 * 1000,
      tick: async () => {
        const n = db.expireStaleProposals();
        if (n > 0) { db.insertAudit('janitor', 'proposals.expired', { count: n }); }
      }
    };
  }
}

function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

export default new Proposals();
