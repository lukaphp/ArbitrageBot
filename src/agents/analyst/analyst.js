/**
 * ANALYST AGENT (Claude, advisory)
 * ================================
 *
 * Gira periodicamente: raccoglie evidenze con strumenti read-only, ragiona con
 * Claude e produce PROPOSTE che finiscono nella coda di approvazione. Non esegue
 * mai nulla.
 *
 * Supervisionato dal runtime (tick in try/catch). Rispetta un cap di run/ora per
 * controllare costi e latenza.
 */

import { getClient } from './client.js';
import { TOOL_DEFS, runTool } from './tools.js';
import { SYSTEM_PROMPT } from './prompts.js';
import proposals from '../proposals.js';
import db from '../../db/database.js';
import { HYPERLIQUID_CONFIG } from '../../config/config.js';
import logger from '../../utils/logger.js';

const MAX_TOOL_ITERATIONS = 10; // più passi: scan mercati + backtest su più candidati
const ALLOWED_TYPES = new Set(['pause_bot', 'close', 'tighten_sl', 'open', 'new_strategy_candidate']);

/** Costruisce il briefing (messaggio utente) dai parametri di analisi. */
function buildBriefing(opts = {}) {
  const lines = ['Esegui un\'analisi completa e proponi opportunità operative.'];
  const risk = { conservative: 'conservativa (priorità protezione capitale)', balanced: 'bilanciata', aggressive: 'aggressiva (accetta più rischio per più rendimento)' }[opts.riskAppetite];
  if (risk) lines.push(`Propensione al rischio: ${risk}.`);
  if (opts.focusMarkets && opts.focusMarkets.length) lines.push(`Concentrati su questi mercati: ${opts.focusMarkets.join(', ')} (ma puoi segnalarne altri se molto interessanti).`);
  else lines.push('Esplora i mercati con scan_markets per scegliere i candidati migliori del momento.');
  if (opts.exploration === false) lines.push('Sii selettivo: solo idee con edge storico chiaro.');
  else lines.push('Proponi anche idee esplorative (con confidence bassa e backtest a supporto): sarà l\'umano a filtrare.');
  lines.push(`Genera fino a ${opts.maxProposals || 5} proposte, diversificate per mercato e stile.`);
  if (opts.notes) lines.push(`Note di contesto dall'utente (tienine conto): "${opts.notes}"`);
  lines.push('Ricorda: usa scan_markets e backtest_templates prima di proporre strategie, e includi i numeri nel rationale.');
  return lines.join('\n');
}

class Analyst {
  constructor() {
    this.name = 'analyst';
    this.runTimestamps = [];   // per il cap orario
    this.lastRunAt = null;
    this.lastSummary = null;
    this.lastError = null;
    this.lastProposalCount = 0;
  }

  get cfg() { return HYPERLIQUID_CONFIG.agents; }
  get intervalMs() { return (this.cfg.cadenceMin || 30) * 60 * 1000; }

  _underRateCap() {
    const hourAgo = Date.now() - 3600_000;
    this.runTimestamps = this.runTimestamps.filter(t => t > hourAgo);
    return this.runTimestamps.length < (this.cfg.maxCallsPerHour || 8);
  }

  /** Chiamato dal runtime sulla cadenza configurata. */
  async tick() {
    if (!this.cfg.enabled) return;
    if (!this._underRateCap()) { logger.info('🧠 Analyst: cap orario raggiunto, salto'); return; }
    await this.run();
  }

  /**
   * Esegue un ciclo di analisi (anche on-demand dalla UI).
   * @param opts { model?, riskAppetite?, focusMarkets?, maxProposals?, exploration?, notes? }
   */
  async run(opts = {}) {
    const anthropic = getClient();
    if (!anthropic) { this.lastError = 'ANTHROPIC_API_KEY mancante'; return { error: this.lastError }; }

    const model = opts.model || this.cfg.analystModel;
    const maxProposals = Math.min(opts.maxProposals || 5, 8);

    this.runTimestamps.push(Date.now());
    this.lastRunAt = Date.now();
    this.lastError = null;

    const messages = [{ role: 'user', content: buildBriefing({ ...opts, maxProposals }) }];

    let tokensIn = 0, tokensOut = 0;
    try {
      let final = null;
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const res = await anthropic.messages.create({
          model,
          max_tokens: 3000,
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFS,
          messages
        });
        tokensIn += res.usage?.input_tokens || 0;
        tokensOut += res.usage?.output_tokens || 0;

        if (res.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: res.content });
          const toolResults = [];
          for (const block of res.content) {
            if (block.type === 'tool_use') {
              const out = await runTool(block.name, block.input).catch(e => ({ error: e.message }));
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out).slice(0, 6000) });
            }
          }
          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        // Risposta finale: estrai il testo
        final = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        break;
      }

      // Costo stimato della run (con il modello effettivamente usato) e totale speso
      const cost = priceOf(model, tokensIn, tokensOut);
      this._addCost(cost);

      const parsed = parseJsonBlock(final);
      const usage = { model, tokensIn, tokensOut, cost };
      if (!parsed) { this.lastSummary = 'Nessuna proposta (output non interpretabile).'; this.lastProposalCount = 0; this.lastUsage = usage; return { summary: this.lastSummary, proposals: 0, ...usage }; }

      this.lastSummary = parsed.summary || '';
      this.lastUsage = usage;
      const created = this._createProposals(parsed.proposals || [], usage, maxProposals);
      this.lastProposalCount = created;
      db.insertAudit('analyst', 'run.completed', { summary: this.lastSummary, proposals: created, model, tokensIn, tokensOut, cost: Number(cost.toFixed(5)) });
      logger.info(`🧠 Analyst: run completato — ${created} proposte · ${model} · $${cost.toFixed(4)} (${tokensIn}+${tokensOut} tok)`, { summary: this.lastSummary });
      return { summary: this.lastSummary, proposals: created, ...usage };
    } catch (e) {
      this.lastError = e.message;
      logger.error('🧠 Analyst: errore run', e.message);
      throw e; // il runtime lo traccia/allerta
    }
  }

  _createProposals(list, usage = {}, maxProposals = 5) {
    // Evita duplicati: non riproporre stesso type+coin se già pendente
    const pending = db.listProposals({ status: 'pending', limit: 100 });
    const seen = new Set(pending.map(p => `${p.type}:${p.coin}`));
    const toCreate = [];
    for (const pr of list.slice(0, maxProposals)) {
      if (!ALLOWED_TYPES.has(pr.type)) continue;
      const key = `${pr.type}:${pr.coin || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      toCreate.push(pr);
    }
    // Ripartisce equamente il costo della run tra le proposte generate
    const share = toCreate.length ? (usage.cost || 0) / toCreate.length : 0;
    const tokInShare = toCreate.length ? Math.round((usage.tokensIn || 0) / toCreate.length) : 0;
    const tokOutShare = toCreate.length ? Math.round((usage.tokensOut || 0) / toCreate.length) : 0;
    for (const pr of toCreate) {
      proposals.create({
        type: pr.type, coin: pr.coin, payload: pr.payload || {},
        rationale: pr.rationale, confidence: pr.confidence, source: 'analyst',
        model: usage.model, costUsd: share, tokensIn: tokInShare, tokensOut: tokOutShare
      });
    }
    return toCreate.length;
  }

  /** Accumula il costo totale speso dall'Analyst (persistito in settings). */
  _addCost(cost) {
    try {
      const cur = parseFloat(db.getSetting('analyst_cost_total', '0')) || 0;
      db.setSetting('analyst_cost_total', (cur + (cost || 0)).toFixed(6));
    } catch { /* noop */ }
  }

  costTotal() {
    return parseFloat(db.getSetting('analyst_cost_total', '0')) || 0;
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      model: this.cfg.analystModel,
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      runsThisHour: this.runTimestamps.length,
      maxCallsPerHour: this.cfg.maxCallsPerHour,
      lastRunAt: this.lastRunAt,
      lastSummary: this.lastSummary,
      lastProposalCount: this.lastProposalCount,
      lastUsage: this.lastUsage || null,
      costTotal: this.costTotal(),
      lastError: this.lastError
    };
  }
}

/** Costo stimato in USD per una run, dal listino configurato (per tier modello). */
function priceOf(model, tokensIn, tokensOut) {
  const pricing = HYPERLIQUID_CONFIG.agents?.pricing || {};
  const tier = /opus/i.test(model) ? pricing.opus : /haiku/i.test(model) ? pricing.haiku : pricing.sonnet;
  if (!tier) return 0;
  return (tokensIn / 1e6) * (tier.in || 0) + (tokensOut / 1e6) * (tier.out || 0);
}

/** Estrae il primo oggetto JSON valido da un testo (anche dentro ```json). */
function parseJsonBlock(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

export default new Analyst();
