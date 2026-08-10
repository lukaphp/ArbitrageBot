/**
 * ALLOWLIST DI STRUMENTI DEL CONSULENTE AI (ADV-02, spike §7.1 difesa #1)
 * ======================================================================
 *
 * Il canale conversazionale invita a chiedere di FARE. Prima o poi l'utente
 * scriverà "vabbè fallo tu", e la risposta del sistema non può dipendere dal
 * fatto che il modello si ricordi il prompt. Qui c'è la difesa strutturale:
 *
 *  1. la lista è **enumerata a mano**, non derivata da `TOOL_DEFS`. Se qualcuno
 *     domani aggiunge uno strumento di scrittura a `analyst/tools.js` — dove la
 *     fase 2 metterà `create_proposal` — quello **non** arriva automaticamente
 *     alla chat: bisogna scriverlo qui, cioè prendere una decisione;
 *  2. uno strumento fuori lista non viene nemmeno **inviato** al modello
 *     (`ADVISOR_TOOLS` è il filtro applicato alla richiesta);
 *  3. anche se il modello ne inventasse il nome, il **dispatch rifiuta**
 *     (`runAdvisorTool`) e il rifiuto finisce in audit. Non basta non offrirlo:
 *     un tentativo di uscire dalla lista è un'informazione, non un non-evento.
 *
 * **Fase 1: zero strumenti di scrittura.** Nessun `create_proposal` (fase 2,
 * fuori da questo sprint), nessun accesso a kill-switch, approvazioni,
 * esecuzione. Tutti e 15 gli strumenti qui sotto sono di sola lettura, e la loro
 * sola-letturità è verificata in test/analystToolsReadonly.test.js.
 */

import { TOOL_DEFS, runTool } from '../analyst/tools.js';
import db from '../../db/database.js';
import logger from '../../utils/logger.js';

/**
 * Gli strumenti che il consulente può usare, elencati uno per uno.
 * SOLA LETTURA — nessuna scrittura, in nessuna forma, in questa fase.
 */
export const ADVISOR_TOOL_NAMES = Object.freeze([
  // Stato dell'account e del portafoglio
  'get_account',
  'get_bots',
  'get_portfolio_limits',
  'get_recent_fills',
  // Rischio (le due che rendono onesto un consiglio: esposizione reale e blocchi attivi)
  'get_risk_snapshot',
  'get_killswitch_state',
  // Storico
  'get_proposals',
  'get_trade_history',
  'get_equity_history',
  // Mercato
  'get_markets',
  'get_candles',
  'scan_markets',
  // Analisi
  'ml_predict',
  'run_backtest',
  'backtest_templates'
]);

/** Definizioni effettivamente inviate al modello: solo quelle in allowlist. */
export const ADVISOR_TOOLS = TOOL_DEFS.filter(t => ADVISOR_TOOL_NAMES.includes(t.name));

/** True se lo strumento è in allowlist. */
export function isAllowedTool(name) {
  return ADVISOR_TOOL_NAMES.includes(name);
}

/**
 * Nomi in allowlist che non esistono (più) in `TOOL_DEFS`: un refuso qui
 * significherebbe uno strumento promesso al modello e mai eseguibile.
 */
export function unknownAllowlistedTools() {
  const defined = new Set(TOOL_DEFS.map(t => t.name));
  return ADVISOR_TOOL_NAMES.filter(n => !defined.has(n));
}

/**
 * Dispatch degli strumenti per il consulente. Rifiuta qualunque nome fuori
 * allowlist, lo registra in audit e restituisce al modello un messaggio che
 * REINDIRIZZA invece di rifiutare secco (spike §7.2): un "no" nudo spinge a
 * insistere e a cercare scorciatoie.
 *
 * @param sessionId serve solo per l'audit: sapere in quale conversazione è
 *        avvenuto il tentativo è metà dell'informazione.
 */
export async function runAdvisorTool(name, input = {}, { sessionId = null } = {}) {
  if (!isAllowedTool(name)) {
    logger.warn(`💬 Advisor: strumento fuori allowlist rifiutato: ${name}`, { sessionId });
    db.insertAudit('advisor', 'tool.denied', { sessionId, tool: name });
    return {
      error: `Strumento "${name}" non disponibile in questa conversazione.`,
      allowed: ADVISOR_TOOL_NAMES,
      hint: 'Questo canale è di sola lettura: posso osservare account, rischio, storico e backtest, ma non eseguire né modificare nulla. Spiega all\'utente cosa puoi mostrargli con gli strumenti disponibili.'
    };
  }
  return runTool(name, input);
}

export default { ADVISOR_TOOL_NAMES, ADVISOR_TOOLS, isAllowedTool, runAdvisorTool, unknownAllowlistedTools };
