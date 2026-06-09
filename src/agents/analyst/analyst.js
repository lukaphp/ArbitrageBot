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

const MAX_TOOL_ITERATIONS = 6;
const ALLOWED_TYPES = new Set(['pause_bot', 'close', 'tighten_sl', 'open', 'new_strategy_candidate']);

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

  /** Esegue un ciclo di analisi (anche on-demand dalla UI). */
  async run() {
    const anthropic = getClient();
    if (!anthropic) { this.lastError = 'ANTHROPIC_API_KEY mancante'; return { error: this.lastError }; }

    this.runTimestamps.push(Date.now());
    this.lastRunAt = Date.now();
    this.lastError = null;

    const messages = [{
      role: 'user',
      content: 'Analizza lo stato attuale di account, bot e mercati e proponi al massimo 3 azioni utili (privilegiando la riduzione del rischio). Usa gli strumenti per raccogliere dati prima di proporre.'
    }];

    try {
      let final = null;
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const res = await anthropic.messages.create({
          model: this.cfg.analystModel,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFS,
          messages
        });

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

      const parsed = parseJsonBlock(final);
      if (!parsed) { this.lastSummary = 'Nessuna proposta (output non interpretabile).'; this.lastProposalCount = 0; return { summary: this.lastSummary, proposals: [] }; }

      this.lastSummary = parsed.summary || '';
      const created = this._createProposals(parsed.proposals || []);
      this.lastProposalCount = created;
      db.insertAudit('analyst', 'run.completed', { summary: this.lastSummary, proposals: created });
      logger.info(`🧠 Analyst: run completato — ${created} proposte`, { summary: this.lastSummary });
      return { summary: this.lastSummary, proposals: created };
    } catch (e) {
      this.lastError = e.message;
      logger.error('🧠 Analyst: errore run', e.message);
      throw e; // il runtime lo traccia/allerta
    }
  }

  _createProposals(list) {
    // Evita duplicati: non riproporre stesso type+coin se già pendente
    const pending = db.listProposals({ status: 'pending', limit: 100 });
    const seen = new Set(pending.map(p => `${p.type}:${p.coin}`));
    let created = 0;
    for (const pr of list.slice(0, 3)) {
      if (!ALLOWED_TYPES.has(pr.type)) continue;
      const key = `${pr.type}:${pr.coin || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.create({
        type: pr.type, coin: pr.coin, payload: pr.payload || {},
        rationale: pr.rationale, confidence: pr.confidence, source: 'analyst'
      });
      created++;
    }
    return created;
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
      lastError: this.lastError
    };
  }
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
