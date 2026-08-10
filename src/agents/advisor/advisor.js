/**
 * CONSULENTE AI CONVERSAZIONALE (ADV-02 fase 1 · budget ADV-03)
 * ============================================================
 *
 * Chat advisory in SOLA LETTURA sul portafoglio: sessioni, turni, contabilità,
 * budget, audit. **Non estende `analyst.js`** — hanno cicli di vita opposti
 * (batch con output JSON e cap di run/ora vs sessione lunga in prosa con
 * transcript da mantenere), e farli convivere in una classe sola costerebbe in
 * leggibilità senza far risparmiare nulla (spike §1). Ciò che si riusa davvero è
 * condiviso per davvero: `agents/usage.js` per la contabilità token/costo,
 * `analyst/tools.js` per gli strumenti, `analyst/client.js` per il client.
 *
 * Vincolo di disegno (spike §0), che qui è una proprietà del codice e non una
 * promessa: da questo modulo non esiste alcun percorso verso l'esecuzione. Non
 * importa `riskAgent` per scriverci, non importa `proposals`, non importa
 * `botManager`. Gli unici effetti collaterali sono righe in `chat_sessions`,
 * `chat_messages`, `audit` e due contatori in `settings`.
 *
 * Degrado (spike §9, DoD): senza `AGENTS_ENABLED=true` o senza
 * `ANTHROPIC_API_KEY`, `chat()` restituisce un errore CHIARO e la lettura dello
 * storico continua a funzionare. Mai un 200 silenzioso che sembra una risposta.
 */

import crypto from 'crypto';
import { getClient } from '../analyst/client.js';
import { getProvider, ProviderError } from '../providers/index.js';
import { ADVISOR_TOOLS, isAllowedTool, runAdvisorTool, unknownAllowlistedTools } from './toolset.js';
import { ADVISOR_SYSTEM_PROMPT, stateHeader } from './prompts.js';
import { buildApiMessages, normalizeAlternation } from './session.js';
import {
  priceOf, simulateRun, moveCacheBreakpoint, summarizeUsage, accumulateUsage, emptyUsage,
  TOOL_RESULT_CHAR_CAP, TOOL_RESULT_TOKENS
} from '../usage.js';
import riskAgent from '../riskAgent.js';
import db from '../../db/database.js';
import { HYPERLIQUID_CONFIG } from '../../config/config.js';
import logger from '../../utils/logger.js';

const MAX_TOKENS_PER_TURN = 1500;   // risposta in prosa, non un report
const MAX_MESSAGE_CHARS = 4000;     // un messaggio umano, non un incollaggio di log
const BUDGET_SETTING = 'advisor_monthly_budget_usd';

/** Chiave del contatore cumulativo di spesa del mese (YYYY-MM in UTC). */
function monthKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

function nextMonthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

/** Titolo della conversazione dalla prima domanda: fatto, non generato. */
function titleFrom(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Conversazione';
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
}

class Advisor {
  constructor() {
    this.name = 'advisor';
    this._busy = new Set();     // sessioni con un turno in volo (un turno per sessione)
    this.lastError = null;
    this.lastTurnAt = null;
  }

  get cfg() { return HYPERLIQUID_CONFIG.agents; }
  get windowTurns() { return this.cfg.advisorWindowTurns || 15; }
  get retentionDays() { return this.cfg.advisorRetentionDays || 90; }
  get providerName() { return this.cfg.advisorProvider || 'anthropic'; }

  /**
   * LLM-01 — il fornitore con cui parlare, dietro l'interfaccia comune.
   * Costruito a ogni turno e non memoizzato: `AGENT_ADVISOR_PROVIDER` e la
   * presenza delle chiavi possono cambiare tra un riavvio e l'altro, e una
   * cache qui vorrebbe dire uno stato in più da invalidare per niente.
   */
  _provider() {
    return getProvider({ provider: this.providerName, model: this.cfg.advisorModel });
  }

  /**
   * Il consulente può rispondere? Ritorna sempre un MOTIVO leggibile: è la
   * differenza tra una cockpit che degrada e una che sembra rotta.
   */
  availability() {
    if (!this.cfg.enabled) {
      return {
        ok: false, code: 'agents_disabled',
        reason: 'Il consulente AI è disattivato su questo deploy (AGENTS_ENABLED non è "true"). Tutto il resto della cockpit funziona normalmente; lo storico delle conversazioni resta consultabile.'
      };
    }
    // Percorso Anthropic: messaggi invariati parola per parola, sono già quelli
    // che la cockpit mostra e che i test verificano.
    if (this.providerName === 'anthropic') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return {
          ok: false, code: 'no_api_key',
          reason: 'ANTHROPIC_API_KEY non configurata: il consulente AI non può rispondere. Imposta la chiave nei segreti e riavvia. Nessun\'altra funzione della cockpit è interessata.'
        };
      }
      if (!getClient()) {
        return { ok: false, code: 'no_client', reason: 'Client Anthropic non inizializzabile: il consulente AI non può rispondere.' };
      }
      return { ok: true };
    }

    // Fornitore alternativo (LLM-01): stessa disciplina di degrado — un motivo
    // leggibile, mai un fallback silenzioso su Anthropic. Cambiare fornitore
    // sotto il naso di chi ne ha chiesto un altro renderebbe impossibile capire
    // su cosa si sta spendendo.
    try {
      const provider = this._provider();
      if (!provider.isAvailable()) {
        return { ok: false, code: 'provider_unavailable', reason: provider.unavailableReason() };
      }
      return { ok: true };
    } catch (e) {
      const code = e instanceof ProviderError ? `provider_${e.code}` : 'provider_error';
      return { ok: false, code, reason: e.message };
    }
  }

  // ---- Budget mensile (ADV-03) ----

  /**
   * Limite mensile in USD. Vive in `settings` (non in ENV) perché è modificabile
   * a runtime — ma SOLO da Telegram, con conferma a due passi: nessuna rotta web
   * lo scrive. Default: il profilo più stretto dello spike §4.3.
   */
  monthlyLimitUsd() {
    const raw = db.getSetting(BUDGET_SETTING, null);
    const parsed = raw == null ? NaN : parseFloat(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : (this.cfg.advisorMonthlyBudgetUsd ?? 10);
  }

  _spendKey(now = Date.now()) { return `advisor_spent_${monthKey(now)}`; }

  /**
   * Speso nel mese corrente.
   *
   * Il massimo tra due fonti, e non è ridondanza inutile: la somma su
   * `chat_messages` è precisa ma sparisce se l'utente ELIMINA una conversazione,
   * e cancellare la cronologia non deve poter azzerare il budget consumato. Il
   * contatore cumulativo in `settings` è quello che regge, la somma sul DB è il
   * controllo di coerenza.
   */
  spentThisMonthUsd(now = Date.now()) {
    const counter = parseFloat(db.getSetting(this._spendKey(now), '0')) || 0;
    const fromMessages = db.getAdvisorSpend(monthStart(now)).spentUsd || 0;
    return Math.max(counter, fromMessages);
  }

  _addSpend(cost, now = Date.now()) {
    if (!cost || !Number.isFinite(cost)) return;
    try {
      const key = this._spendKey(now);
      const cur = parseFloat(db.getSetting(key, '0')) || 0;
      db.setSetting(key, (cur + cost).toFixed(6));
    } catch (e) {
      // Un contatore di spesa che non si aggiorna è un budget che non frena:
      // loggato, mai silenziato.
      logger.error('💬 Advisor: impossibile aggiornare il contatore di spesa mensile', e.message);
    }
  }

  /** Stato del budget, sola lettura. È ciò che espone `GET /api/advisor/budget`. */
  budget(now = Date.now()) {
    const monthlyLimitUsd = this.monthlyLimitUsd();
    const spentUsd = this.spentThisMonthUsd(now);
    return {
      monthlyLimitUsd,
      spentUsd,
      remainingUsd: Math.max(0, monthlyLimitUsd - spentUsd),
      resetsAt: nextMonthStart(now),
      month: monthKey(now),
      exceeded: spentUsd >= monthlyLimitUsd
    };
  }

  /** Messaggio unico per il budget esaurito: la chat si ferma e lo DICE. */
  budgetBlockedMessage(b = this.budget()) {
    return `Budget mensile del consulente raggiunto: $${b.spentUsd.toFixed(2)} su $${b.monthlyLimitUsd.toFixed(2)}. Non parte nessun'altra richiesta al modello fino al 1° del mese, oppure fino a quando il budget non viene alzato da Telegram con /advisorbudget <importo> (conferma a due passi).`;
  }

  /**
   * Cambia il limite mensile. **Chiamato solo dal percorso Telegram** — non
   * esiste alcuna rotta web che arrivi qui, ed è verificato da test: chi
   * compromette la sessione web non deve potersi alzare il budget da solo
   * (approvazione fuori banda, stessa filosofia del kill-switch Telegram).
   *
   * @param via canale di provenienza, registrato in audit.
   */
  setMonthlyBudget(amountUsd, { via = 'telegram' } = {}) {
    const value = Number(amountUsd);
    if (!Number.isFinite(value) || value < 0) throw new Error('Importo non valido');
    if (value > 1000) throw new Error('Importo oltre il massimo consentito ($1000/mese)');
    const from = this.monthlyLimitUsd();
    const to = Math.round(value * 100) / 100;
    db.setSetting(BUDGET_SETTING, String(to));
    db.insertAudit('human', 'advisor.budget.changed', { da: from, a: to, via });
    logger.warn(`💬 Advisor: budget mensile cambiato da $${from} a $${to} (via ${via})`);
    return { from, to };
  }

  // ---- Sessioni ----

  /** Nuova conversazione. Occasione utile per applicare la retention. */
  createSession({ title = null } = {}) {
    const purged = this.purgeExpired();
    const id = crypto.randomUUID();
    const row = db.createChatSession({ id, title });
    if (purged.sessions) {
      logger.info(`💬 Advisor: retention ${this.retentionDays}gg — ${purged.sessions} conversazioni eliminate (${purged.messages} messaggi)`);
    }
    return this._sessionView(row);
  }

  listSessions(limit = 50) {
    return db.listChatSessions(limit).map(r => this._sessionView(r));
  }

  getSession(id) {
    const row = db.getChatSession(id);
    return row ? this._sessionView(row) : null;
  }

  /**
   * Transcript di una conversazione.
   *
   * Le righe di strumento sono restituite con `toolName` ma SENZA contenuto: il
   * payload è fino a 6.000 caratteri di JSON per riga e serve all'audit, non alla
   * UI — che deve poter mostrare "ho consultato get_risk_snapshot" senza
   * scaricare i dati. Il payload resta nel DB.
   */
  getMessages(sessionId, limit = 500) {
    return db.listChatMessages(sessionId, limit).map(m => ({
      id: m.id,
      role: m.role,
      content: m.role === 'tool' ? null : m.content,
      ts: m.ts,
      toolName: m.tool_name || null,
      costUsd: m.cost_usd ?? null
    }));
  }

  deleteSession(id) {
    const res = db.deleteChatSession(id);
    if (res.deleted) {
      db.insertAudit('human', 'advisor.session.deleted', { sessionId: id, messages: res.messages });
      logger.info(`💬 Advisor: conversazione ${id} eliminata (${res.messages} messaggi)`);
    }
    return res;
  }

  /** Retention: conversazioni non toccate da oltre `retentionDays` giorni. */
  purgeExpired(now = Date.now()) {
    try {
      return db.purgeOldChatSessions(this.retentionDays, now);
    } catch (e) {
      logger.error('💬 Advisor: retention non applicata', e.message);
      return { sessions: 0, messages: 0 };
    }
  }

  _sessionView(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title || null,
      startedAt: row.started_at,
      lastAt: row.last_at,
      costUsd: row.cost_usd || 0,
      tokensIn: row.tokens_in || 0,
      tokensOut: row.tokens_out || 0
    };
  }

  // ---- Il turno di conversazione ----

  /**
   * Un turno: messaggio dell'utente → (strumenti read-only) → risposta in prosa.
   *
   * Ordine dei controlli, che non è arbitrario:
   *  1. disponibilità (agenti attivi + chiave) — degrado dichiarato;
   *  2. validità del messaggio e della sessione;
   *  3. **budget**, PRIMA di qualunque chiamata al modello: "nessuna chiamata LLM
   *     oltre soglia" vuol dire che il freno sta prima della spesa, non dopo.
   *
   * Ritorna sempre un oggetto: `{ reply, toolsUsed, costUsd, budgetRemainingUsd }`
   * oppure `{ error, code }`. Mai un successo che nasconde un fallimento.
   */
  async chat(sessionId, message) {
    const avail = this.availability();
    if (!avail.ok) return { error: avail.reason, code: avail.code };

    const text = String(message ?? '').trim();
    if (!text) return { error: 'Messaggio vuoto: scrivi una domanda.', code: 'empty_message' };
    if (text.length > MAX_MESSAGE_CHARS) {
      return { error: `Messaggio troppo lungo (${text.length} caratteri, massimo ${MAX_MESSAGE_CHARS}).`, code: 'message_too_long' };
    }

    const session = db.getChatSession(sessionId);
    if (!session) return { error: 'Conversazione non trovata (potrebbe essere stata eliminata o scaduta per retention).', code: 'session_not_found' };

    const budgetBefore = this.budget();
    if (budgetBefore.exceeded) {
      // Registrato: un turno rifiutato per budget è un fatto operativo, non un
      // non-evento — è la traccia che spiega perché la chat "non risponde".
      db.insertAudit('advisor', 'chat.blocked', { sessionId, reason: 'budget', spentUsd: budgetBefore.spentUsd, monthlyLimitUsd: budgetBefore.monthlyLimitUsd });
      logger.warn(`💬 Advisor: turno bloccato, budget mensile raggiunto ($${budgetBefore.spentUsd.toFixed(2)}/$${budgetBefore.monthlyLimitUsd.toFixed(2)})`);
      return { error: this.budgetBlockedMessage(budgetBefore), code: 'budget_exceeded', budget: budgetBefore };
    }

    if (this._busy.has(sessionId)) {
      return { error: 'C\'è già un turno in corso su questa conversazione: attendi la risposta.', code: 'turn_in_progress' };
    }

    // Un refuso nell'allowlist significherebbe promettere al modello uno
    // strumento inesistente: meglio saperlo qui che da una risposta strana.
    const unknown = unknownAllowlistedTools();
    if (unknown.length) logger.error(`💬 Advisor: allowlist incoerente con TOOL_DEFS: ${unknown.join(', ')}`);

    this._busy.add(sessionId);
    const model = this.cfg.advisorModel;
    const maxIterations = this.cfg.advisorMaxIterations || 5;
    const acc = emptyUsage();
    const toolsUsed = [];
    const deniedTools = [];
    let iterations = 0;
    let reply = null;

    try {
      db.insertChatMessage({ sessionId, role: 'user', content: text });

      const rows = db.listRecentChatMessages(sessionId, 400);
      const built = buildApiMessages({ rows, summary: session.summary, windowTurns: this.windowTurns });
      const apiMessages = normalizeAlternation(built.messages);
      if (!apiMessages.length) {
        // Non dovrebbe accadere (il messaggio appena inserito è dell'utente), ma
        // mandare all'API un array vuoto darebbe un 400 opaco.
        throw new Error('Transcript non ricostruibile per questa conversazione');
      }

      const system = [
        { type: 'text', text: ADVISOR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        // Fuori dal blocco cachato di proposito: cambia a ogni turno (kill-switch,
        // budget), e metterlo dentro invaliderebbe la cache del prefisso.
        { type: 'text', text: stateHeader({
          killSwitch: riskAgent.isKillSwitchOn(),
          budgetRemainingUsd: budgetBefore.remainingUsd,
          monthlyLimitUsd: budgetBefore.monthlyLimitUsd
        }) }
      ];

      // LLM-01: da qui in giù il codice non sa con quale fornitore sta parlando.
      // `content` è sempre nel formato canonico interno (blocchi Anthropic-like),
      // che l'adattatore compatibile OpenAI produce traducendo i `tool_calls`.
      const provider = this._provider();
      for (let i = 0; i < maxIterations; i++) {
        iterations = i + 1;
        moveCacheBreakpoint(apiMessages);
        const res = await provider.createChatCompletion({
          system,
          messages: apiMessages,
          tools: ADVISOR_TOOLS,
          maxTokens: MAX_TOKENS_PER_TURN
        });
        accumulateUsage(acc, res.usage);

        if (res.stopReason === 'tool_use') {
          apiMessages.push(provider.assistantTurnFromResult(res));
          const results = [];
          for (const block of res.content) {
            if (block.type !== 'tool_use') continue;
            if (isAllowedTool(block.name)) toolsUsed.push(block.name);
            else deniedTools.push(block.name);
            const out = await runAdvisorTool(block.name, block.input || {}, { sessionId })
              .catch(e => ({ error: e.message }));
            const payload = JSON.stringify(out).slice(0, TOOL_RESULT_CHAR_CAP);
            db.insertChatMessage({ sessionId, role: 'tool', content: payload, toolName: block.name });
            results.push({ type: 'tool_result', tool_use_id: block.id, content: payload });
          }
          if (!results.length) throw new Error('Il modello ha chiesto strumenti senza indicarne nessuno');
          apiMessages.push({ role: 'user', content: results });
          continue;
        }

        reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        break;
      }

      const usage = summarizeUsage(model, acc);
      this._addSpend(usage.cost);

      if (!reply) {
        // Cap di iterazioni esaurito senza risposta: il turno è costato per intero
        // e non produce nulla. Va detto all'utente con queste parole, non lasciato
        // come una risposta vuota che sembra un problema di rete.
        logger.warn(`💬 Advisor: cap di ${maxIterations} iterazioni esaurito senza risposta (sessione ${sessionId}, $${usage.cost.toFixed(4)} spesi)`);
        reply = `Ho consultato i dati (${toolsUsed.join(', ') || 'nessuno strumento'}) ma non sono arrivato a una risposta entro il limite di passaggi previsto per un turno. Il costo di questo turno è stato comunque sostenuto. Riformula la domanda in modo più circoscritto (per esempio un solo mercato per volta).`;
      }

      const assistantMsgId = db.insertChatMessage({
        sessionId, role: 'assistant', content: reply,
        tokens: usage.tokensOut, costUsd: usage.cost
      });
      db.addChatSessionUsage(sessionId, { costUsd: usage.cost, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });
      if (!session.title) db.updateChatSession(sessionId, { title: titleFrom(text) });
      if (built.rollingSummary && built.rollingSummary !== session.summary) {
        db.updateChatSession(sessionId, { summary: built.rollingSummary });
      }

      db.insertAudit('advisor', 'chat.turn', {
        sessionId, costUsd: Number(usage.cost.toFixed(6)), toolsUsed,
        deniedTools: deniedTools.length ? deniedTools : undefined,
        model, iterations, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut
      });

      this.lastTurnAt = Date.now();
      this.lastError = null;
      const budgetAfter = this.budget();
      logger.info(`💬 Advisor: turno completato — ${model} · $${usage.cost.toFixed(4)} · ${iterations} iter · strumenti: ${toolsUsed.join(', ') || '—'}`);

      return {
        messageId: assistantMsgId,
        reply,
        toolsUsed,
        costUsd: usage.cost,
        budgetRemainingUsd: budgetAfter.remainingUsd,
        budgetExceeded: budgetAfter.exceeded,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        model,
        iterations,
        droppedTurns: built.droppedTurns
      };
    } catch (e) {
      // I token già consumati sono già stati spesi: contarli comunque, altrimenti
      // un turno andato in errore risulterebbe gratis e il budget frenerebbe tardi.
      const usage = summarizeUsage(model, acc);
      this._addSpend(usage.cost);
      this.lastError = e.message;
      logger.error('💬 Advisor: turno fallito', e.message);
      db.insertChatMessage({ sessionId, role: 'error', content: e.message, costUsd: usage.cost || null });
      if (usage.cost) db.addChatSessionUsage(sessionId, { costUsd: usage.cost, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });
      db.insertAudit('advisor', 'chat.failed', { sessionId, error: e.message, costUsd: Number((usage.cost || 0).toFixed(6)), toolsUsed, iterations });
      return { error: `Il consulente non è riuscito a rispondere: ${e.message}`, code: 'turn_failed', costUsd: usage.cost };
    } finally {
      this._busy.delete(sessionId);
    }
  }

  /**
   * Preventivo di un turno, senza inferenza. Riusa `simulateRun` di usage.js con
   * i parametri della chat: serve a mostrare l'ordine di grandezza prima di
   * spendere (spike §4.3 leva #4). Non fa chiamate di rete, quindi è gratuito e
   * chiamabile anche a budget esaurito.
   */
  estimateTurn({ withTools = 1, promptTokens = 2500 } = {}) {
    const model = this.cfg.advisorModel;
    const scenario = simulateRun({
      firstInput: promptTokens,
      iterations: withTools ? withTools + 1 : 1,
      outputPerIter: withTools ? 150 : 0,
      finalOutput: 500,
      toolCallsPerIter: withTools ? 1 : 0,
      toolResultTokens: TOOL_RESULT_TOKENS
    });
    return { model, ...scenario, cost: priceOf(model, scenario) };
  }

  status() {
    const avail = this.availability();
    const b = this.budget();
    return {
      enabled: this.cfg.enabled,
      available: avail.ok,
      reason: avail.ok ? null : avail.reason,
      code: avail.ok ? null : avail.code,
      model: this.cfg.advisorModel,
      provider: this.providerName,
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      windowTurns: this.windowTurns,
      maxIterations: this.cfg.advisorMaxIterations || 5,
      retentionDays: this.retentionDays,
      budget: b,
      writeToolsAvailable: 0, // fase 1: nessuno strumento di scrittura, per costruzione
      lastTurnAt: this.lastTurnAt,
      lastError: this.lastError
    };
  }
}

export default new Advisor();
