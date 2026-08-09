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
import { runBacktest } from '../perps/backtester.js';
import logger from '../utils/logger.js';

/**
 * Soglie per il riciclo di una strategia scaduta. Sono volutamente più severe
 * del semplice "expectancy > 0" chiesto all'AI: qui non c'è un modello che
 * ragiona sul contesto, solo numeri, quindi serve un margine più netto.
 */
const RECYCLE = { lookbackDays: 45, minTrades: 10, minProfitFactor: 1.1 };

const n2 = v => (Number.isFinite(v) ? v.toFixed(2) : '—');

class Proposals {
  /**
   * Crea e accoda una proposta.
   *
   * `ttlMin` e `notify` sono opzionali e servono all'import di strategie
   * (STRAT-01), che ha esigenze diverse da una proposta dell'Analyst:
   *  - **TTL**: una candidatura importata a mano non decade col mercato come un
   *    "chiudi adesso", e con i 30 minuti di default scadrebbe mentre l'utente
   *    legge il messaggio di conferma;
   *  - **notify**: importare 20 strategie non deve produrre 20 messaggi Telegram.
   *    Una notifica per episodio, non una per elemento — la manda il chiamante,
   *    riassunta.
   * Senza questi due parametri il comportamento è identico a prima.
   */
  create({ type, coin, payload, rationale, confidence, backtest, source = 'analyst', model, costUsd, tokensIn, tokensOut, ttlMin, notify = true }) {
    const ttl = Number.isFinite(ttlMin) && ttlMin > 0
      ? ttlMin
      : (HYPERLIQUID_CONFIG.agents?.proposalTtlMin || 30);
    const id = crypto.randomUUID();
    const row = db.insertProposal({
      id, type, coin, payload, rationale, confidence, backtest, source,
      model, costUsd, tokensIn, tokensOut,
      expiresAt: Date.now() + ttl * 60 * 1000
    });
    db.insertAudit('analyst', 'proposal.created', { id, type, coin, source });
    bus.publish(EVENTS.PROPOSAL_CREATED, { id, type, coin });
    if (notify) {
      notifier.notify(`🧠 <b>Nuova proposta AI</b> [${type}] ${coin || ''}\n${rationale || ''}\nApprova con /approva ${id.slice(0, 8)}`);
    }
    logger.info(`🧠 Proposta creata: ${type} ${coin || ''}`, { id, source });
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
      backtest: safeParse(p.backtest_json),
      model: p.model,
      costUsd: p.cost_usd
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
  history({ status, limit } = {}) {
    const rows = db.getStrategyHistory({ status, limit });
    return rows.map(p => {
      const out = {
        id: p.id, coin: p.coin, status: p.status, rationale: p.rationale,
        confidence: p.confidence, createdAt: p.created_at, decidedAt: p.decided_at,
        linkedBotId: p.linked_bot_id, payload: safeParse(p.payload_json),
        model: p.model, costUsd: p.cost_usd, tokensIn: p.tokens_in, tokensOut: p.tokens_out
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

  /**
   * Ricicla strategie SCADUTE: rilancia il loro backtest sui dati correnti e
   * le ripropone solo se l'edge regge ancora. Non costa token — il backtest è
   * codice locale, nessuna chiamata all'AI.
   *
   * Le rifiutate non passano di qui di proposito: riproporre ciò che l'utente
   * ha scartato ne contraddirebbe la decisione. Vengono invece usate come
   * contesto anti-ripetizione nel briefing dell'Analyst.
   */
  async recycle(ids = []) {
    const results = [];
    // Una proposta pendente per lo stesso mercato renderebbe il riciclo un doppione
    const pendingKeys = new Set(
      db.listProposals({ status: 'pending', limit: 100 }).map(p => `${p.type}:${p.coin}`)
    );

    for (const id of ids) {
      const p = db.getProposal(id);
      if (!p) { results.push({ id, ok: false, reason: 'proposta non trovata' }); continue; }
      if (p.type !== 'new_strategy_candidate') {
        results.push({ id, coin: p.coin, ok: false, reason: 'non è una strategia' }); continue;
      }
      if (p.status !== 'expired') {
        results.push({ id, coin: p.coin, ok: false, reason: `è ${p.status}: si riciclano solo le scadute` }); continue;
      }

      const payload = safeParse(p.payload_json) || {};
      const { coin, interval, config } = payload;
      if (!coin || !config) {
        results.push({ id, coin: p.coin, ok: false, reason: 'payload incompleto, backtest non ripetibile' }); continue;
      }
      if (pendingKeys.has(`${p.type}:${coin}`)) {
        results.push({ id, coin, ok: false, reason: 'esiste già una proposta pendente per questo mercato' }); continue;
      }

      let r;
      try {
        r = await runBacktest(config, coin, { interval: interval || '1h', lookbackDays: RECYCLE.lookbackDays });
      } catch (e) {
        results.push({ id, coin, ok: false, reason: `backtest fallito: ${e.message}` }); continue;
      }
      if (!r || r.error) {
        results.push({ id, coin, ok: false, reason: r?.error || 'backtest senza risultato' }); continue;
      }

      const s = r.stats || {};
      const stats = { trades: s.trades, winRate: s.winRate, profitFactor: s.profitFactor, expectancy: s.expectancy };
      const holds = s.expectancy > 0 && s.trades >= RECYCLE.minTrades && s.profitFactor >= RECYCLE.minProfitFactor;
      if (!holds) {
        results.push({
          id, coin, ok: false, stats,
          reason: `edge non più confermato (${s.trades ?? 0} operazioni, PF ${n2(s.profitFactor)}, expectancy ${n2(s.expectancy)})`
        });
        continue;
      }

      const created = this.create({
        type: p.type, coin, payload, source: 'recycler',
        // La confidence non può salire riciclando: al massimo resta, e comunque
        // è limitata, perché l'idea era già stata ignorata una volta.
        confidence: Math.min(p.confidence ?? 0.5, 0.6),
        backtest: stats,
        rationale: `♻️ Riciclata da una proposta scaduta il ${new Date(p.decided_at || p.created_at).toLocaleDateString('it-IT')}. `
          + `Backtest rieseguito ora su ${RECYCLE.lookbackDays} giorni: ${s.trades} operazioni, `
          + `win rate ${((s.winRate || 0) * 100).toFixed(0)}%, profit factor ${n2(s.profitFactor)}, expectancy ${n2(s.expectancy)}.`
      });
      pendingKeys.add(`${p.type}:${coin}`);
      results.push({ id, coin, ok: true, newId: created?.id, stats });
    }

    const recycled = results.filter(x => x.ok).length;
    if (recycled) db.insertAudit('human', 'proposals.recycled', { recycled, valutate: ids.length });
    logger.info(`♻️ Riciclo strategie: ${recycled}/${ids.length} riproposte`);
    return { recycled, evaluated: ids.length, results };
  }

  /**
   * Elimina voci dallo storico strategie. Con `ids` cancella quelle indicate,
   * con `status` svuota una categoria intera. Le proposte 'pending' non sono
   * mai toccate.
   */
  deleteHistory({ ids, status } = {}) {
    const count = db.deleteStrategyHistory({ ids, status });
    if (count > 0) db.insertAudit('human', 'proposals.deleted', { count, status: status || null, ids: ids || null });
    return count;
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
