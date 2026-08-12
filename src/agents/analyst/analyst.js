/**
 * ANALYST AGENT (advisory)
 * ========================
 *
 * Gira periodicamente: raccoglie evidenze con strumenti read-only, ragiona con
 * un modello LLM e produce PROPOSTE che finiscono nella coda di approvazione.
 * Non esegue mai nulla.
 *
 * Supervisionato dal runtime (tick in try/catch). Rispetta un cap di run/ora per
 * controllare costi e latenza.
 *
 * LLM-02/03 — parla col modello attraverso `providers/`, non più con l'SDK
 * Anthropic diretto: `AGENT_ANALYST_PROVIDER` sceglie il fornitore, esattamente
 * come `AGENT_ADVISOR_PROVIDER` fa per il consulente. Il formato canonico interno
 * resta quello Anthropic-like (blocchi `text`/`tool_use`/`tool_result`, system
 * con `cache_control`), quindi il loop di tool-use qui sotto non è cambiato: è
 * l'adattatore a tradurre per i fornitori che parlano il dialetto OpenAI. Il
 * default resta `anthropic` e nessuna chiave nuova è obbligatoria.
 */

import { getClient } from './client.js';
import { getProvider, ProviderError } from '../providers/index.js';
import { TOOL_DEFS, runTool } from './tools.js';
import { SYSTEM_PROMPT } from './prompts.js';
import proposals from '../proposals.js';
// ADV-01: contabilità token/costo e prompt caching condivisi con il consulente
// conversazionale. Stessa matematica, un solo posto dove vive (vedi usage.js).
import {
  priceOf, simulateRun, moveCacheBreakpoint, estimatePromptTokens,
  TOOL_RESULT_CHAR_CAP, TOOL_RESULT_TOKENS
} from '../usage.js';
import db from '../../db/database.js';
import { HYPERLIQUID_CONFIG } from '../../config/config.js';
import logger from '../../utils/logger.js';

const MAX_TOOL_ITERATIONS = 10; // più passi: scan mercati + backtest su più candidati
const ALLOWED_TYPES = new Set(['pause_bot', 'close', 'tighten_sl', 'open', 'new_strategy_candidate']);

const MAX_TOKENS_PER_CALL = 3000;    // deve restare allineato al max_tokens della create()

/**
 * Parametri del preventivo. Solo il primo input è misurato esattamente
 * (countTokens); tutto il resto è un intervallo, perché quante iterazioni fare
 * e quanto scrivere lo decide il modello a runtime.
 */
const EST = {
  toolResultTokens: TOOL_RESULT_TOKENS, // ~1800 tok a tool_result pieno
  typical: { iterations: 4, outputPerIter: 700, finalOutput: 1500, toolCallsPerIter: 1 },
  max: { iterations: MAX_TOOL_ITERATIONS, outputPerIter: MAX_TOKENS_PER_CALL, finalOutput: MAX_TOKENS_PER_CALL, toolCallsPerIter: 2 }
};

// Il system prompt è identico a ogni run: marcandolo come cacheable si copre
// anche il blocco `tools`, che l'API renderizza PRIMA del system.
const CACHED_SYSTEM = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];

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

  // Contesto negativo: ciò che l'utente ha già scartato. Riproporlo brucerebbe
  // token per idee che verrebbero bocciate di nuovo.
  const avoid = rejectedContext();
  if (avoid) lines.push(avoid);

  lines.push('Ricorda: usa scan_markets e backtest_templates prima di proporre strategie, e includi i numeri nel rationale.');
  return lines.join('\n');
}

/** Riassume in una riga le strategie già rifiutate, per non farle riproporre. */
function rejectedContext() {
  let rows = [];
  try { rows = db.getRecentRejected(12); } catch { return ''; }
  if (!rows.length) return '';

  const seen = new Set();
  const items = [];
  for (const r of rows) {
    let cfg = null;
    try { cfg = JSON.parse(r.payload_json || '{}')?.config; } catch { /* payload illeggibile */ }
    // Identifica la strategia dagli indicatori delle regole d'ingresso: è ciò
    // che la distingue davvero, al di là del mercato.
    const ind = [...new Set((cfg?.entryRules || []).map(x => x.indicator).filter(Boolean))].join('+');
    const label = `${r.coin || '?'}${ind ? ` (${ind})` : ''}`;
    if (seen.has(label)) continue;
    seen.add(label);
    items.push(label);
  }
  if (!items.length) return '';
  return `Strategie già rifiutate dall'utente — NON riproporle, né varianti equivalenti sugli stessi indicatori: ${items.join('; ')}.`;
}

const PAUSED_SETTING = 'analyst_paused';

class Analyst {
  constructor() {
    this.name = 'analyst';
    this.runTimestamps = [];   // per il cap orario
    this.lastRunAt = null;
    this.lastSummary = null;
    this.lastError = null;
    this.lastProposalCount = 0;
    this._busy = false;          // true mentre una run è davvero in volo (per l'abort di stop())
    this._abortController = null;
  }

  get cfg() { return HYPERLIQUID_CONFIG.agents; }
  get intervalMs() { return (this.cfg.cadenceMin || 30) * 60 * 1000; }
  /** LLM-02 — fornitore configurato, simmetrico a `advisor.providerName`. */
  get providerName() { return this.cfg.analystProvider || 'anthropic'; }

  /**
   * Il fornitore con cui parlare, dietro l'interfaccia comune.
   *
   * Non memoizzato, per la stessa ragione dell'advisor: `AGENT_ANALYST_PROVIDER`
   * e la presenza delle chiavi possono cambiare tra un riavvio e l'altro, e una
   * cache qui sarebbe uno stato in più da invalidare per niente. Il modello è un
   * parametro perché `run()`/`estimate()` accettano un override per singola run
   * (`opts.model`), quindi non è sempre quello di configurazione.
   */
  _provider(model) {
    return getProvider({ provider: this.providerName, model });
  }

  /**
   * Il fornitore è utilizzabile? Ritorna un MOTIVO leggibile, mai un fallback
   * silenzioso su Anthropic: cambiare fornitore sotto il naso di chi ne ha
   * chiesto un altro rende impossibile capire su cosa si sta spendendo.
   *
   * Il percorso Anthropic conserva il messaggio storico parola per parola
   * (`ANTHROPIC_API_KEY mancante`): è quello che la UI mostra già e cambiarlo
   * sarebbe una regressione osservabile a fronte di zero guadagni.
   */
  _providerAvailability(model) {
    if (this.providerName === 'anthropic') {
      if (!getClient()) return { ok: false, error: 'ANTHROPIC_API_KEY mancante' };
      return { ok: true };
    }
    try {
      const provider = this._provider(model);
      if (!provider.isAvailable()) {
        return { ok: false, error: provider.unavailableReason(), code: 'provider_unavailable' };
      }
      return { ok: true, provider };
    } catch (e) {
      const code = e instanceof ProviderError ? `provider_${e.code}` : 'provider_error';
      return { ok: false, error: e.message, code };
    }
  }

  /** Pausa/stop persistiti in settings: sopravvivono a un riavvio del processo. */
  isPaused() {
    return db.getSetting(PAUSED_SETTING, 'false') === 'true';
  }

  /** Ferma le run future. Una run già in volo finisce da sola. Ripristinabile con resume(). */
  pause() {
    db.setSetting(PAUSED_SETTING, 'true');
    db.insertAudit('analyst', 'pause', {});
    logger.info('🧠 Analyst: messo in pausa');
  }

  resume() {
    db.setSetting(PAUSED_SETTING, 'false');
    db.insertAudit('analyst', 'resume', {});
    logger.info('🧠 Analyst: ripreso');
  }

  /**
   * Come pause(), ma annulla anche una run in corso (abort della chiamata Claude
   * in volo) e azzera il contatore orario: al prossimo resume() riparte da 0/N,
   * non da dove era rimasto. Non tocca il costo totale speso né le proposte già
   * create — quelli sono storico, non stato operativo.
   *
   * Limite dichiarato: se l'iterazione corrente sta eseguendo un tool (backtest,
   * lettura mercati) invece della chiamata a Claude, l'abort la interrompe al
   * prossimo giro del loop, non istantaneamente — i singoli tool non hanno un
   * proprio signal di cancellazione.
   */
  stop() {
    db.setSetting(PAUSED_SETTING, 'true');
    this.runTimestamps = [];
    if (this._abortController) {
      this._abortController.abort();
      logger.info('🧠 Analyst: run in corso annullata');
    }
    db.insertAudit('analyst', 'stop', {});
    logger.info('🧠 Analyst: fermato, contatore orario azzerato');
  }

  _underRateCap() {
    const hourAgo = Date.now() - 3600_000;
    this.runTimestamps = this.runTimestamps.filter(t => t > hourAgo);
    return this.runTimestamps.length < (this.cfg.maxCallsPerHour || 8);
  }

  /**
   * Proposte ancora in attesa di una decisione umana: né decise né scadute.
   *
   * `listProposals({status:'pending'})` restituisce anche quelle già oltre
   * `expires_at` (la scadenza è applicata in modo lazy, all'approvazione), quindi
   * il filtro temporale va fatto qui: contare come "arretrato" proposte già morte
   * bloccherebbe l'Analyst per sempre.
   */
  _pendingBacklog() {
    try {
      const now = Date.now();
      return db.listProposals({ status: 'pending', limit: 200 })
        .filter(p => p.source === 'analyst' && (p.expires_at == null || p.expires_at > now))
        .length;
    } catch (e) {
      // Se non riesco a leggere l'arretrato NON blocco la run (fail-open): il
      // gate serve a risparmiare, non a fermare l'analisi. Ma non in silenzio.
      logger.warn('🧠 Analyst: arretrato proposte non leggibile, procedo senza gate di cadenza', e.message);
      return 0;
    }
  }

  /**
   * Chiamato dal runtime sulla cadenza configurata.
   *
   * COST-01 — cadenza adattiva. Oltre al cap orario c'è un secondo freno: se ci
   * sono già almeno `skipIfPendingProposals` proposte in attesa di decisione, la
   * run periodica viene saltata. Misura sui dati reali (68 run, $8.00 spesi):
   * 127 delle 137 proposte sono scadute senza che nessuno le decidesse, cioè la
   * spesa marginale di una run che si sovrappone a un arretrato non consumato è
   * quasi tutta sprecata. Il gate non riduce la qualità delle proposte: riduce
   * quante volte le si riscrive prima che l'operatore le abbia guardate.
   *
   * Vale SOLO per la cadenza automatica: `run()` chiamato on-demand dalla UI non
   * passa da qui, perché un'analisi chiesta esplicitamente va eseguita.
   */
  async tick() {
    if (!this.cfg.enabled || this.isPaused()) return;
    if (!this._underRateCap()) { logger.info('🧠 Analyst: cap orario raggiunto, salto'); return; }
    const threshold = this.cfg.skipIfPendingProposals ?? 0;
    if (threshold > 0) {
      const backlog = this._pendingBacklog();
      if (backlog >= threshold) {
        logger.info(`🧠 Analyst: ${backlog} proposte ancora in attesa di decisione (soglia ${threshold}), run saltata per non spendere su un arretrato non consumato`);
        return;
      }
    }
    await this.run();
  }

  /**
   * Esegue un ciclo di analisi (anche on-demand dalla UI).
   * @param opts { model?, riskAppetite?, focusMarkets?, maxProposals?, exploration?, notes? }
   */
  async run(opts = {}) {
    if (this.isPaused() && !opts.force) {
      this.lastError = 'Analyst in pausa';
      return { error: this.lastError, paused: true };
    }
    const model = opts.model || this.cfg.analystModel;
    // LLM-02: il controllo di disponibilità sta PRIMA di contare la run nel cap
    // orario e di marcare `_busy`, esattamente com'era prima con getClient().
    const avail = this._providerAvailability(model);
    if (!avail.ok) { this.lastError = avail.error; return { error: this.lastError, code: avail.code }; }

    const maxProposals = Math.min(opts.maxProposals || 5, 8);

    this.runTimestamps.push(Date.now());
    this.lastRunAt = Date.now();
    this.lastError = null;
    this._busy = true;
    const controller = new AbortController();
    this._abortController = controller;

    // Content come array di blocchi (non stringa): serve per poterci agganciare
    // il cache_control mobile a ogni iterazione.
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildBriefing({ ...opts, maxProposals }) }] }];

    let tokensIn = 0, tokensOut = 0, cacheWrite = 0, cacheRead = 0;
    // COST-01: quante iterazioni ha davvero consumato la run. Non era registrato
    // da nessuna parte, quindi il cap MAX_TOOL_ITERATIONS non era tarabile su
    // dati — solo a occhio. Ora finisce in usage e nell'audit di ogni run.
    let iterations = 0;
    try {
      let final = null;
      // LLM-02: da qui in giù il codice non sa con quale fornitore sta parlando.
      const provider = avail.provider || this._provider(model);
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (controller.signal.aborted) throw new Error('Run annullata (stop)');
        iterations = i + 1;
        moveCacheBreakpoint(messages);
        const res = await provider.createChatCompletion({
          system: CACHED_SYSTEM,
          messages,
          tools: TOOL_DEFS,
          maxTokens: MAX_TOKENS_PER_CALL,
          signal: controller.signal
        });
        // `input_tokens` è il solo residuo NON cachato: il totale del prompt è
        // input + cache_creation + cache_read. L'adattatore compatibile OpenAI
        // restituisce l'uso già in questa forma (vedi `normalizeUsage`), quindi
        // il conteggio qui non dipende dal fornitore.
        tokensIn += res.usage?.input_tokens || 0;
        cacheWrite += res.usage?.cache_creation_input_tokens || 0;
        cacheRead += res.usage?.cache_read_input_tokens || 0;
        tokensOut += res.usage?.output_tokens || 0;

        if (res.stopReason === 'tool_use') {
          messages.push(provider.assistantTurnFromResult(res));
          const toolResults = [];
          for (const block of res.content) {
            if (block.type === 'tool_use') {
              const out = await runTool(block.name, block.input).catch(e => ({ error: e.message }));
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out).slice(0, TOOL_RESULT_CHAR_CAP) });
            }
          }
          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        // Risposta finale: estrai il testo
        final = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        break;
      }

      // Cap di iterazioni esaurito senza risposta finale: la run è costata per
      // intero e non produce nulla. Prima era indistinguibile da un output
      // illeggibile — due cause diverse con rimedi opposti (alzare il cap vs
      // correggere il prompt), quindi va detto esplicitamente.
      if (final == null) {
        logger.warn(`🧠 Analyst: cap di ${MAX_TOOL_ITERATIONS} iterazioni esaurito senza risposta finale — costo della run speso senza proposte`);
      }

      // Costo stimato della run (con il modello effettivamente usato) e totale speso
      const cost = priceOf(model, { tokensIn, tokensOut, cacheWrite, cacheRead });
      this._addCost(cost);

      const parsed = parseJsonBlock(final);
      // `promptTokens` è il totale dei token di prompt fatturati a qualsiasi
      // tariffa: è il numero che ha senso mostrare/persistere come "token in".
      const promptTokens = tokensIn + cacheWrite + cacheRead;
      const cacheHitRate = promptTokens ? cacheRead / promptTokens : 0;
      const usage = { model, tokensIn: promptTokens, tokensOut, cost, cacheWrite, cacheRead, cacheHitRate, iterations };
      if (!parsed) { this.lastSummary = 'Nessuna proposta (output non interpretabile).'; this.lastProposalCount = 0; this.lastUsage = usage; return { summary: this.lastSummary, proposals: 0, ...usage }; }

      this.lastSummary = parsed.summary || '';
      this.lastUsage = usage;
      const created = this._createProposals(parsed.proposals || [], usage, maxProposals);
      this.lastProposalCount = created;
      db.insertAudit('analyst', 'run.completed', {
        summary: this.lastSummary, proposals: created, model,
        // LLM-02: quale fornitore ha prodotto queste proposte. Senza, con più
        // fornitori configurabili non si potrebbe più risalire dall'esito alla
        // fonte — e il confronto di qualità tra fornitori è proprio il motivo per
        // cui l'astrazione esiste.
        provider: provider.name,
        tokensIn: promptTokens, tokensOut, cacheWrite, cacheRead, iterations,
        cost: Number(cost.toFixed(5))
      });
      logger.info(
        `🧠 Analyst: run completato — ${created} proposte · ${provider.name}/${model} · $${cost.toFixed(4)} ` +
        `(${promptTokens}+${tokensOut} tok · ${iterations} iter · cache ${(cacheHitRate * 100).toFixed(0)}% riletta)`,
        { summary: this.lastSummary }
      );
      return { summary: this.lastSummary, proposals: created, ...usage };
    } catch (e) {
      // controller.signal.aborted è l'unico controllo affidabile: l'SDK lancia
      // APIUserAbortError su un abort, non il DOMException 'AbortError' standard.
      const aborted = controller.signal.aborted;
      this.lastError = aborted ? 'Run annullata (stop)' : e.message;
      if (aborted) {
        // Annullamento intenzionale dell'utente via stop(): non è un errore da
        // allertare, solo da registrare.
        logger.info('🧠 Analyst: run annullata da stop()');
      } else {
        logger.error('🧠 Analyst: errore run', e.message);
      }
      if (aborted) return { error: this.lastError, aborted: true };
      throw e; // il runtime lo traccia/allerta
    } finally {
      this._busy = false;
      this._abortController = null;
    }
  }

  /**
   * Preventivo pre-run. Il resto è un intervallo perché numero di iterazioni e
   * lunghezza delle risposte li decide il modello.
   *
   * LLM-04 — come si ottiene il primo input dipende dal fornitore:
   *
   *  - **Anthropic**: `messages.countTokens`, che è ESATTO e GRATUITO. Non viene
   *    sostituito con una stima: rimpiazzare una misura esatta a costo zero con
   *    un'approssimazione sarebbe un peggioramento senza compenso.
   *  - **Altri fornitori**: non esiste un equivalente di `countTokens` nel
   *    dialetto compatibile OpenAI, quindi si usa l'euristica di
   *    `estimatePromptTokens`, che è locale e istantanea (nessuna rete: il
   *    preventivo non rallenta e non può fallire per un fornitore raggiungibile
   *    a fatica). Il risultato è DICHIARATO come stima via `firstInputExact:
   *    false` e `estimateMethod`, così nessun consumatore può confonderla con un
   *    conteggio.
   *
   * Sul percorso Anthropic l'euristica viene calcolata comunque — è aritmetica
   * locale, costa nulla — e riportata in `heuristicFirstInput`/`heuristicError`
   * accanto al valore esatto: è il modo di far accumulare al sistema la
   * calibrazione dell'euristica sui prompt VERI, senza spendere un centesimo e
   * senza dover credere a una taratura fatta a occhio.
   */
  async estimate(opts = {}) {
    const model = opts.model || this.cfg.analystModel;
    const avail = this._providerAvailability(model);
    if (!avail.ok) return { error: avail.error, code: avail.code };

    const maxProposals = Math.min(opts.maxProposals || 5, 8);
    const briefing = buildBriefing({ ...opts, maxProposals });
    const messages = [{ role: 'user', content: [{ type: 'text', text: briefing }] }];

    // Sempre calcolata: sul percorso Anthropic serve come termine di confronto,
    // sugli altri è il preventivo stesso.
    const heuristicFirstInput = estimatePromptTokens({ system: CACHED_SYSTEM, tools: TOOL_DEFS, messages });

    let firstInput = heuristicFirstInput;
    let firstInputExact = false;
    let estimateMethod = 'heuristic';
    let heuristicError = null;

    if (this.providerName === 'anthropic') {
      const anthropic = getClient();
      let counted;
      try {
        counted = await anthropic.messages.countTokens({
          model,
          system: CACHED_SYSTEM,
          tools: TOOL_DEFS,
          messages
        });
      } catch (e) {
        // Un 401 qui non è un problema del preventivo: la stessa chiave serve per
        // l'analisi, quindi lanciarla comunque fallirebbe allo stesso modo.
        if (e?.status === 401) {
          return { error: 'Chiave API Anthropic non valida o revocata: l\'analisi non può partire. Genera una nuova chiave su console.anthropic.com, aggiorna ANTHROPIC_API_KEY nel file .env e riavvia il server.', code: 'auth_error' };
        }
        throw e;
      }
      firstInput = counted.input_tokens;
      firstInputExact = true;
      estimateMethod = 'countTokens';
      // Scostamento relativo dell'euristica rispetto alla misura esatta, con il
      // segno: positivo = l'euristica sovrastima. Loggato solo quando è grosso,
      // perché è l'unico caso che richieda di ritarare qualcosa.
      if (firstInput > 0) {
        heuristicError = (heuristicFirstInput - firstInput) / firstInput;
        if (Math.abs(heuristicError) > 0.25) {
          logger.warn(
            `🧠 Analyst: l'euristica di stima token è fuori del ${(heuristicError * 100).toFixed(0)}% ` +
            `sul prompt reale (stimati ${heuristicFirstInput}, esatti ${firstInput}). ` +
            'Sui fornitori senza countTokens il preventivo eredita questo scostamento.'
          );
        }
      }
    }

    const scenarios = {
      // Nessun tool: il modello risponde subito. È il pavimento reale.
      min: simulateRun({ firstInput, iterations: 1, outputPerIter: 0, finalOutput: EST.typical.finalOutput, toolCallsPerIter: 0 }),
      typical: simulateRun({ firstInput, ...EST.typical }),
      max: simulateRun({ firstInput, ...EST.max })
    };
    for (const s of Object.values(scenarios)) s.cost = priceOf(model, s);

    return {
      model,
      provider: this.providerName,
      firstInput,
      // LLM-04 — il preventivo dice SEMPRE come è stato ottenuto il numero. Un
      // consumatore che mostra `firstInput` senza guardare questi campi mostra
      // una stima come se fosse un conteggio.
      firstInputExact,
      estimateMethod,
      heuristicFirstInput,
      heuristicError,
      maxIterations: MAX_TOOL_ITERATIONS,
      // Era `true` fisso. Con più fornitori è falso: nel dialetto compatibile
      // OpenAI i breakpoint di cache non sono controllabili dal client (li
      // ignora `openaiCompatible.js`), quindi dichiarare il caching attivo lì
      // sarebbe un dato disonesto in un modale che serve a decidere una spesa.
      cachingEnabled: this.providerName === 'anthropic',
      spentTotal: this.costTotal(),
      scenarios
    };
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
      paused: this.isPaused(),
      busy: this._busy,
      model: this.cfg.analystModel,
      // LLM-02: simmetrico a `advisor.status().provider`.
      provider: this.providerName,
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      runsThisHour: this.runTimestamps.length,
      maxCallsPerHour: this.cfg.maxCallsPerHour,
      // COST-01: rende visibile PERCHÉ una run periodica non è partita — senza
      // questi due numeri il gate di cadenza sembrerebbe un Analyst inattivo.
      cadenceMin: this.cfg.cadenceMin,
      skipIfPendingProposals: this.cfg.skipIfPendingProposals ?? 0,
      pendingBacklog: this._pendingBacklog(),
      lastRunAt: this.lastRunAt,
      lastSummary: this.lastSummary,
      lastProposalCount: this.lastProposalCount,
      lastUsage: this.lastUsage || null,
      costTotal: this.costTotal(),
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
