/**
 * CONTRATTO DELLE PATCH DI TUNING (proposte `tune_params`)
 * ========================================================
 *
 * Definisce COSA può contenere una proposta di tuning, e lo definisce una volta
 * sola per i due lati che se ne devono fidare: chi la produce
 * (`inactivityWatcher`) e chi la applica (`executionAgent`, dopo il click di
 * approvazione).
 *
 * Perché un modulo a sé e non una costante dentro uno dei due. Primo, il ciclo:
 * `executionAgent` ← `proposals` ← `inactivityWatcher`, quindi far importare
 * all'ExecutionAgent qualcosa dal watcher chiuderebbe l'anello e la validazione
 * arriverebbe a runtime in ordine indeterminato. Secondo, e più importante: è il
 * lato che SCRIVE a dover decidere cosa è ammissibile. Se la whitelist vivesse
 * nel produttore, chi applica starebbe di fatto delegando il controllo a chi ha
 * scritto la riga in `proposals` — e fra i due momenti c'è una tabella, non una
 * chiamata di funzione.
 *
 * ── Perché la whitelist è così stretta ──────────────────────────────────────
 * Una proposta `tune_params` approvata scrive dentro `bots.config_json` con UN
 * CLICK, senza la conferma a due stadi che protegge il percorso MCP. Limitando
 * le chiavi a `candleInterval` — *ogni quanto il bot guarda il mercato*, non
 * *quanto denaro ci mette sopra* — un'approvazione non può alzare la leva, la
 * size, i tetti di rischio o le regole d'ingresso, indipendentemente da cosa
 * contenga la riga in coda. È la stessa proprietà dichiarata in cima a
 * `executionAgent.js`: l'auto-esecuzione non aumenta mai l'esposizione.
 *
 * Aggiungere una chiave qui è una decisione di sicurezza, non di comodità.
 */

import { VALID_INTERVALS } from '../perps/strategySchema.js';

/** Tipo di proposta usato per i tuning. */
export const PROPOSAL_TYPE = 'tune_params';

/** Le UNICHE chiavi di config che una proposta `tune_params` può toccare. */
export const TUNABLE_KEYS = Object.freeze(['candleInterval']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Valida la patch di una proposta `tune_params`. Funzione PURA.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTunePatch(patch) {
  const errors = [];
  if (!isPlainObject(patch)) {
    return { ok: false, errors: ['la patch di tuning non è un oggetto.'] };
  }
  const keys = Object.keys(patch);
  if (!keys.length) {
    return { ok: false, errors: ['la patch di tuning è vuota: non c\'è niente da applicare.'] };
  }
  for (const k of keys) {
    if (!TUNABLE_KEYS.includes(k)) {
      errors.push(`"${k}" non è un parametro modificabile da una proposta di tuning (ammessi: ${TUNABLE_KEYS.join(', ')}).`);
    }
  }
  if (patch.candleInterval !== undefined && !VALID_INTERVALS.has(patch.candleInterval)) {
    errors.push(`intervallo candele non riconosciuto: ${JSON.stringify(patch.candleInterval)}.`);
  }
  return { ok: errors.length === 0, errors };
}

export default { PROPOSAL_TYPE, TUNABLE_KEYS, validateTunePatch };
