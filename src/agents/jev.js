/**
 * OSSERVATORE ASINCRONO — TypeSafe Jev (JEV-OBS-01)
 * =================================================
 *
 * Client di `POST https://api.typesafe.ai/v1/systemone`. Jev è un "System One
 * model": riceve uno STATO testuale più domande TIPIZZATE (`noul` → probabilità
 * calibrata, `choice` → opzione, `score` → livello su una scala ordinata) e
 * restituisce giudizi. Non è un LLM conversazionale, non ha strumenti, non
 * produce prosa e non decide niente.
 *
 * ⚠️ COSA QUESTO MODULO NON DEVE MAI FARE, ed è il motivo per cui è scritto così.
 * Il giudizio di Jev non può bloccare, ritardare o influenzare l'apertura o la
 * chiusura di una posizione: è un supervisore per la dashboard, non un guardrail
 * di rischio. I guardrail sono e restano `riskManager.js` e `portfolio.js`, che
 * sono deterministici e verificabili. Da questo vincolo discende tutto:
 *
 *  1. **`askJev` non lancia MAI.** Qualunque cosa accada — chiave assente,
 *     budget esaurito, 422 di schema, 500, DNS morto, risposta illeggibile, DB
 *     che rifiuta la scrittura — ritorna un esito strutturato `{ ok, code }`.
 *     Non perché il chiamante la awaiti (non lo fa: vedi `bot._observeWithJev`),
 *     ma perché fra sei mesi qualcuno potrebbe metterci un `await` davanti, e
 *     quel giorno un throw diventerebbe un tick di trading interrotto a metà.
 *  2. **Il tetto di attesa è garantito dal RACE, non solo dall'abort.** La
 *     richiesta porta un `AbortSignal` (che libera il socket), ma l'esito è
 *     deciso da una corsa con un timer: se il trasporto ignorasse l'abort — bug
 *     della libreria, event loop occupato — la promise resterebbe pendente per
 *     sempre e il silenzio di Jev non verrebbe mai registrato da nessuna parte.
 *     Un osservatore che tace senza lasciare traccia è peggio di un osservatore
 *     assente (è la lezione di WS-01: il sistema è restato degradato 28 ore
 *     senza una riga nei log).
 *  3. **Il budget frena PRIMA di spendere**, con lo stesso meccanismo di ADV-03:
 *     contatore mensile in `settings`, tariffa da `agents/usage.js`, e rifiuto di
 *     partire se il modello non ha un listino — un costo silenziosamente 0 è un
 *     budget che non frena mai (LLM-01).
 *  4. **Senza `JEV_API_KEY` non succede niente**, e lo si dice una volta sola.
 *     La chiave non esiste nei segreti di produzione: il comportamento normale,
 *     oggi, è che l'osservatore sia spento e che i bot lavorino esattamente come
 *     prima.
 *
 * L'audit finisce in `jev_evaluations` (vedi `db/database.js`) e ci finisce da
 * qui, quando la risposta arriva: il chiamante non aspetta questa scrittura.
 */

import axios from 'axios';
import db from '../db/database.js';
import { priceOf, hasPricing, monthKey, monthStart, nextMonthStart } from './usage.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * Tetto ai caratteri dello stato inviato. Stessa funzione di
 * `TOOL_RESULT_CHAR_CAP` per gli agenti LLM: un prompt senza tetto fa crescere
 * il costo in modo non prevedibile, e qui lo stato lo compone `bot.js` da dati
 * di mercato che possono diventare grossi (candele, liste di posizioni).
 */
export const JEV_STATE_CHAR_CAP = 4000;

/** Tipi di domanda ammessi dall'API. Una domanda di tipo diverso è un 422. */
export const JEV_QUESTION_TYPES = Object.freeze(['noul', 'choice', 'score']);

const BUDGET_SETTING = 'jev_monthly_budget_usd';

/** Avvisi già dati: uno per motivo, non uno per segnale (vedi WS-01). */
const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

/** Solo per i test: riapre la possibilità di osservare l'avviso una-tantum. */
export function _resetWarnings() {
  warned.clear();
}

function jevConfig() {
  return HYPERLIQUID_CONFIG.agents?.jev || {};
}

/** La chiave si legge dall'AMBIENTE a ogni chiamata, non dalla config: `config.js`
 * fotografa l'ambiente al caricamento, e una chiave aggiunta dopo l'avvio del
 * processo resterebbe invisibile per sempre. Stesso trattamento di LLM-01. */
function apiKey() {
  const cfg = jevConfig();
  return process.env[cfg.apiKeyEnv || 'JEV_API_KEY'] || null;
}

/**
 * Perché l'osservatore è (non) utilizzabile. Sola lettura, nessun effetto:
 * serve a rispondere «perché non vedo giudizi in dashboard?» senza leggere il
 * codice, come `listProviders()` per i fornitori LLM.
 */
export function jevStatus() {
  const cfg = jevConfig();
  const model = cfg.model || 'jev-latest';
  if (!apiKey()) {
    return {
      available: false, model, endpoint: cfg.endpoint || null,
      reason: `${cfg.apiKeyEnv || 'JEV_API_KEY'} non impostata: l'osservatore TypeSafe Jev è spento. I bot funzionano esattamente come prima — nessun giudizio viene richiesto e nessuna riga compare in jev_evaluations.`
    };
  }
  if (!hasPricing(model)) {
    return {
      available: false, model, endpoint: cfg.endpoint || null,
      reason: `Nessuna tariffa per il modello "${model}": senza costo il budget mensile non potrebbe frenare, quindi l'osservatore resta spento. Aggiungi una voce in HYPERLIQUID_CONFIG.agents.pricing.`
    };
  }
  return { available: true, model, endpoint: cfg.endpoint || null, reason: null };
}

// ---- Budget mensile (stesso meccanismo di ADV-03) ----

function spendKey(now = Date.now()) { return `jev_spent_${monthKey(now)}`; }

/**
 * Limite mensile in USD. Prima la riga in `settings` (modificabile a runtime
 * senza un deploy), poi il default di configurazione.
 *
 * ⚠️ NESSUN percorso di scrittura, né web né Telegram, tocca questa riga oggi:
 * è deliberato e simmetrico ad ADV-03, dove il budget si alza solo fuori banda.
 * Per un osservatore che non può muovere denaro la leva d'emergenza è lo
 * spegnimento (togliere la chiave), non l'aumento del tetto.
 */
export function jevMonthlyLimitUsd() {
  let raw = null;
  try { raw = db.getSetting(BUDGET_SETTING, null); } catch { raw = null; }
  const parsed = raw == null ? NaN : parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  const fallback = jevConfig().monthlyBudgetUsd;
  return Number.isFinite(fallback) ? fallback : 3;
}

/**
 * Speso nel mese corrente: il MASSIMO tra il contatore cumulativo in `settings`
 * e la somma delle righe di `jev_evaluations`. Le due fonti divergono quando una
 * scrittura in tabella fallisce — la spesa c'è stata comunque, e il contatore la
 * ricorda. Prendere il minimo (o una sola fonte) significherebbe un budget che
 * dimentica ciò che ha speso.
 */
export function jevSpentThisMonthUsd(now = Date.now()) {
  let counter = 0;
  let fromRows = 0;
  try { counter = parseFloat(db.getSetting(spendKey(now), '0')) || 0; } catch { counter = 0; }
  try { fromRows = db.getJevSpend(monthStart(now)).spentUsd || 0; } catch { fromRows = 0; }
  return Math.max(counter, fromRows);
}

/** Stato del budget, sola lettura. */
export function jevBudget(now = Date.now()) {
  const monthlyLimitUsd = jevMonthlyLimitUsd();
  const spentUsd = jevSpentThisMonthUsd(now);
  return {
    monthlyLimitUsd,
    spentUsd,
    remainingUsd: Math.max(0, monthlyLimitUsd - spentUsd),
    resetsAt: nextMonthStart(now),
    month: monthKey(now),
    exceeded: spentUsd >= monthlyLimitUsd
  };
}

function addSpend(cost, now = Date.now()) {
  if (!cost || !Number.isFinite(cost)) return;
  try {
    const key = spendKey(now);
    const cur = parseFloat(db.getSetting(key, '0')) || 0;
    db.setSetting(key, (cur + cost).toFixed(8));
  } catch (e) {
    // Un contatore di spesa che non si aggiorna è un budget che non frena:
    // loggato, mai silenziato. Non è un motivo per fallire la chiamata.
    logger.error('🔭 Jev: impossibile aggiornare il contatore di spesa mensile', e.message);
  }
}

// ---- Validazione della richiesta ----

/**
 * Controllo di forma FATTO IN CASA, prima di spendere. Un 422 dall'API non è un
 * errore di rete: è uno schema sbagliato (tipicamente `criteria` nella forma
 * invertita tra `choice` e `score`), e scoprirlo dopo aver pagato la chiamata —
 * o peggio, scoprirlo solo in produzione — è evitabile qui a costo zero.
 */
function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    return 'questions deve essere un oggetto { id: domanda }';
  }
  const ids = Object.keys(questions);
  if (!ids.length) return 'nessuna domanda da porre';
  for (const id of ids) {
    const q = questions[id];
    if (!q || typeof q !== 'object') return `domanda "${id}" non è un oggetto`;
    if (!JEV_QUESTION_TYPES.includes(q.type)) {
      return `domanda "${id}": tipo "${q.type}" non ammesso (${JEV_QUESTION_TYPES.join('|')})`;
    }
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) {
      return `domanda "${id}": instructions mancanti`;
    }
    if (q.type === 'choice' && (!q.criteria || Array.isArray(q.criteria) || typeof q.criteria !== 'object')) {
      return `domanda "${id}": choice.criteria deve essere un oggetto { opzione: descrizione }`;
    }
    if (q.type === 'score' && (!Array.isArray(q.criteria) || !q.criteria.length)) {
      return `domanda "${id}": score.criteria deve essere una lista ordinata di livelli`;
    }
  }
  return null;
}

/** Tronca lo stato al tetto DICHIARANDOLO: un troncamento silenzioso farebbe
 * giudicare Jev su un contesto che nessuno sa essere incompleto. */
function capState(state) {
  const text = String(state ?? '');
  if (text.length <= JEV_STATE_CHAR_CAP) return text;
  return `${text.slice(0, JEV_STATE_CHAR_CAP)}\n[…stato troncato a ${JEV_STATE_CHAR_CAP} caratteri]`;
}

/** Messaggio d'errore leggibile da un errore axios, senza sputare tutto il body. */
function describeHttpError(err) {
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  if (!status) return null;
  let extra = '';
  if (detail) {
    const s = typeof detail === 'string' ? detail : JSON.stringify(detail);
    extra = ` — ${s.slice(0, 300)}`;
    if (status === 422) {
      extra += ' (422 = schema della richiesta non valido, non un problema di rete)';
    }
  }
  return `HTTP ${status}${extra}`;
}

const TIMED_OUT = Symbol('jev-timeout');

/**
 * Chiede un giudizio a Jev. **Non lancia mai.**
 *
 * @param state      stato testuale da giudicare (troncato a JEV_STATE_CHAR_CAP)
 * @param questions  { [id]: { type, instructions, criteria? } }
 * @param botId/coin/action  contesto, solo per l'audit
 * @param httpPost   iniettabile SOLO per i test (default: axios.post)
 * @param timeoutMs  override del tetto, solo per i test
 * @returns { ok:true, answers, model, latencyMs, costUsd, auditWritten }
 *        | { ok:false, code, reason, latencyMs? }
 */
export async function askJev({
  state, questions, botId = null, coin = null, action = null,
  httpPost = null, timeoutMs = null, now = Date.now()
} = {}) {
  const startedAt = Date.now();
  let timer = null;
  let controller = null;

  try {
    const cfg = jevConfig();
    const model = cfg.model || 'jev-latest';

    // ---- Cancelli che si attraversano SENZA spendere e senza scrivere audit ----
    // Una chiamata mai partita non è una valutazione fallita: metterla in
    // `jev_evaluations` riempirebbe l'audit di righe che non dicono niente su
    // cosa pensasse l'osservatore, e renderebbe illeggibile la sola cosa che
    // quella tabella deve mostrare.
    // Nessuna chiamata REALE da dentro la suite di test, mai. `config.js` carica
    // il file di ambiente locale, quindi il giorno in cui JEV_API_KEY sarà nei
    // segreti di questa macchina un `npm test` farebbe partire osservazioni vere
    // e fatturate dai test che avviano bot veri (mcpServer.test.js ne avvia, e
    // il primo tick con un segnale basterebbe). È lo stesso incidente evitato
    // neutralizzando il file di configurazione locale negli script CLI, qui su un
    // canale che costa soldi. Chi TESTA questo modulo inietta il trasporto, e in
    // quel caso il cancello non si applica: il percorso resta coperto davvero.
    if (process.env.NODE_TEST_CONTEXT && !httpPost) {
      return {
        ok: false, code: 'test_context',
        reason: 'Osservazione non inviata: siamo dentro la suite di test e nessun trasporto è stato iniettato. Un test non deve poter spendere sul canale reale.'
      };
    }

    const key = apiKey();
    if (!key) {
      const st = jevStatus();
      warnOnce('missing_key', `🔭 Jev: ${st.reason}`);
      return { ok: false, code: 'missing_key', reason: st.reason };
    }
    if (!hasPricing(model)) {
      const st = jevStatus();
      warnOnce('missing_pricing', `🔭 Jev: ${st.reason}`);
      return { ok: false, code: 'missing_pricing', reason: st.reason };
    }

    const invalid = validateQuestions(questions);
    if (invalid || !String(state ?? '').trim()) {
      const reason = invalid || 'stato vuoto: non c\'è niente da giudicare';
      logger.warn(`🔭 Jev: richiesta non valida, non inviata — ${reason}`);
      return { ok: false, code: 'invalid_request', reason };
    }

    const budget = jevBudget(now);
    if (budget.exceeded) {
      // Una volta per mese, non una per segnale: a budget esaurito ogni segnale
      // passerebbe di qui, e un log per tick seppellirebbe l'avviso invece di
      // darlo. Non è un errore: è il freno che funziona.
      warnOnce(`budget_${budget.month}`, `🔭 Jev: budget mensile raggiunto ($${budget.spentUsd.toFixed(4)} su $${budget.monthlyLimitUsd.toFixed(2)}), nessuna altra osservazione fino al ${new Date(budget.resetsAt).toISOString().slice(0, 10)}. I bot non sono toccati: l'osservatore non è un guardrail.`);
      return {
        ok: false, code: 'budget_exceeded',
        reason: `Budget mensile Jev raggiunto: $${budget.spentUsd.toFixed(4)} su $${budget.monthlyLimitUsd.toFixed(2)}.`
      };
    }

    // ---- Chiamata, con tetto garantito ----
    const post = httpPost || ((...args) => axios.post(...args));
    const limitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : (cfg.timeoutMs || 2500);
    const body = { model, state: capState(state), questions };

    controller = new AbortController();
    let onTimeout;
    const timeout = new Promise(resolve => { onTimeout = () => resolve(TIMED_OUT); });
    // Il timer è volutamente REF'ATO. `unref()` sembrava la scelta gentile («una
    // osservazione in volo non deve trattenere un container che si spegne»), ma
    // rende possibile che questa promise non si risolva MAI: se il timer è
    // l'ultima cosa in piedi, l'event loop si svuota e l'esito — compresa la riga
    // di audit che dice che Jev è stato muto — non arriva. Un handle da 2,5s al
    // massimo è un prezzo accettabile per un esito sempre garantito; e comunque la
    // richiesta HTTP tiene già vivo il suo socket, quindi unref'are il solo timer
    // dava l'illusione di non trattenere niente. Trovato dal test del timeout.
    timer = setTimeout(() => { try { controller.abort(); } catch { /* già chiuso */ } onTimeout(); }, limitMs);

    let res;
    try {
      res = await Promise.race([
        post(cfg.endpoint, body, {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          timeout: limitMs,
          signal: controller.signal
        }),
        timeout
      ]);
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const http = describeHttpError(err);
      // Il tetto può scattare da tre parti: il nostro AbortController
      // (CanceledError/AbortError), il timeout interno di axios (ECONNABORTED,
      // impostato allo stesso valore) o la corsa col timer qui sotto. Sono lo
      // stesso fatto e devono produrre lo stesso codice: classificare come
      // "errore di rete" un timeout nostro renderebbe impossibile distinguere in
      // audit un endpoint lento da un endpoint irraggiungibile.
      const aborted = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED'
        || err?.name === 'AbortError' || err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT';
      const code = aborted ? 'timeout' : (http ? 'http_error' : 'network_error');
      const reason = aborted
        ? `timeout dopo ${limitMs}ms`
        : (http || err?.message || 'errore sconosciuto');
      recordAudit({ botId, coin, action, model, state: body.state, questions, latencyMs, error: reason, ts: now });
      logger.warn(`🔭 Jev: nessun giudizio su ${coin ?? '?'} (${reason}) — la decisione di trading non ne è stata toccata`);
      return { ok: false, code, reason, latencyMs };
    }

    const latencyMs = Date.now() - startedAt;

    if (res === TIMED_OUT) {
      const reason = `timeout dopo ${limitMs}ms`;
      recordAudit({ botId, coin, action, model, state: body.state, questions, latencyMs, error: reason, ts: now });
      logger.warn(`🔭 Jev: nessun giudizio su ${coin ?? '?'} (${reason}) — la decisione di trading non ne è stata toccata`);
      return { ok: false, code: 'timeout', reason, latencyMs };
    }

    const data = res?.data ?? res;
    const answers = data?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      const reason = 'risposta senza `answers` utilizzabili';
      recordAudit({ botId, coin, action, model, state: body.state, questions, latencyMs, error: reason, ts: now });
      logger.warn(`🔭 Jev: ${reason} su ${coin ?? '?'}`);
      return { ok: false, code: 'bad_response', reason, latencyMs };
    }

    // Il modello che ha RISPOSTO, non quello chiesto: `jev-latest` è un alias e
    // l'audit deve dire quale versione ha prodotto il giudizio.
    const answeredModel = data?.model || model;
    const tokensIn = Number(data?.usage?.input_tokens) || 0;
    const tokensOut = Number(data?.usage?.output_tokens) || 0;
    const costUsd = priceOf(answeredModel, { tokensIn, tokensOut });

    addSpend(costUsd, now);
    const auditWritten = recordAudit({
      botId, coin, action, model: answeredModel, state: body.state, questions,
      answers, latencyMs, tokensIn, tokensOut, costUsd, error: null, ts: now
    });

    logger.debug(`🔭 Jev (${answeredModel}) su ${coin ?? '?'} ${action ?? ''}: ${JSON.stringify(answers).slice(0, 200)} — ${latencyMs}ms, $${costUsd.toFixed(6)}`);
    return { ok: true, answers, model: answeredModel, latencyMs, costUsd, tokensIn, tokensOut, auditWritten };
  } catch (error) {
    // Rete di sicurezza: qualunque cosa sia sfuggita sopra esce di qui come
    // esito, non come eccezione. È il punto che rende vera la promessa "askJev
    // non lancia mai", e va tenuto anche se oggi sembra irraggiungibile.
    logger.error('🔭 Jev: errore inatteso nell\'osservatore (nessun effetto sul trading)', error?.message || error);
    return { ok: false, code: 'error', reason: error?.message || String(error), latencyMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Scrive la riga di audit. Ritorna true/false invece di lanciare: l'audit è un
 * effetto collaterale dell'osservazione, e se il disco è pieno il giudizio
 * resta comunque valido — ma chi chiama deve poterlo sapere, invece di credere
 * di aver scritto.
 */
function recordAudit(row) {
  try {
    db.insertJevEvaluation(row);
    return true;
  } catch (e) {
    logger.error('🔭 Jev: impossibile scrivere la valutazione in jev_evaluations', e.message);
    return false;
  }
}

export default {
  askJev, jevStatus, jevBudget, jevMonthlyLimitUsd, jevSpentThisMonthUsd,
  JEV_STATE_CHAR_CAP, JEV_QUESTION_TYPES, _resetWarnings
};
