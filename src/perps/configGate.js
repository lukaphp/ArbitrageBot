/**
 * CANCELLO DI SCRITTURA DELLA CONFIG DI STRATEGIA (#46, #78)
 * ==========================================================
 *
 * Modulo NEUTRO: nessun import dal layer MCP, nessuna I/O. Ci vive
 * `validateConfigForWrite`, nato in `src/mcp/tools.js` per `register_bot` e
 * `update_strategy_params` e spostato qui quando è comparso un secondo percorso
 * di scrittura che doveva passare dallo STESSO cancello: le rotte della
 * dashboard `POST /api/perps/bots` e `PATCH /api/perps/bots/:id` (#78), che fino
 * ad allora scrivevano la config senza nessun controllo d'insieme. Importare
 * `mcp/tools.js` da `server.js` per questo avrebbe legato le rotte web a
 * guardrail, conferme a due stadi e loopback MCP; due copie del cancello
 * sarebbero divergenze in attesa di accadere.
 *
 * `mcp/tools.js` lo ri-esporta: chiamanti e test esistenti non cambiano.
 * Stesso schema già usato per `mergeStrategyConfig`/`extractBotConfig`
 * (spostate in `strategySchema.js` per lo stesso motivo).
 */

import { validateStrategyConfig, DERIVED_CONFIG_KEYS, sameConfigValue } from './strategySchema.js';
import { auditRiskConfig } from './riskManager.js';

/** Oggetto "semplice": né null, né array, né istanza esotica. */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Regola d'ingresso segnaposto, valida per costruzione. Vedi
 * `validateConfigForWrite`: serve SOLO a neutralizzare il controllo "nessuna
 * regola d'ingresso" senza andare a cercare quell'errore nella lista per
 * sottostringa (un messaggio riscritto in `strategySchema` renderebbe muto
 * questo cancello senza far fallire nessun test).
 */
const RULE_PLACEHOLDER = Object.freeze([Object.freeze({ type: 'price', op: '>', value: 0, signal: 'long' })]);

/**
 * CANCELLO DI SCRITTURA SULLA CONFIG INTERA (#46)
 * ==============================================
 *
 * `register_bot` e `update_strategy_params` validavano leva, `maxPositionUsd` e
 * i parametri di sizing dinamico come SCALARI ISOLATI: nessuno dei due ha mai
 * guardato la configurazione NEL SUO INSIEME prima di persisterla. Due incidenti
 * consecutivi sono nati da lì, e in entrambi i casi il sintomo è stato il
 * silenzio:
 *
 *  - BUG-RULESHAPE-01: `entryRules` scritte da un agente con `signal:
 *    'open_long'` invece di `'long'` e senza `type` — 46 ore di flotta accesa,
 *    puntuale a ogni tick, senza un solo segnale;
 *  - BUG-SIZECAP-01: `sizing.maxPositionUsd` / `strategyParams.leverage`, cioè
 *    percorsi che il motore non legge — leva dichiarata 5x e applicata 2x per
 *    mesi, corretta a mano sui bot BTC/SOL il 26/09/2026.
 *
 * I due fix di allora hanno reso il sistema TOLLERANTE e RUMOROSO a valle, ma
 * non impediscono che una config inservibile venga scritta. Questo è il
 * cancello a monte, e riusa le DUE funzioni che già sanno riconoscere i due
 * casi, senza duplicarne la logica:
 *
 *  1. `validateStrategyConfig` — la FORMA (regola di tipo sconosciuto,
 *     intervallo inesistente, `sizing.value` assente, leva oltre il massimo…);
 *  2. `riskManager.auditRiskConfig` — il PERCORSO (un parametro di rischio
 *     dichiarato in un campo che nessun controllo legge).
 *
 * Sono due domande diverse — "è scritta bene?" e "verrà applicata?" — e restano
 * in due funzioni diverse, come già impostato nel codice.
 *
 * DUE DECISIONI, entrambe volute:
 *
 * a) TUTTI gli avvisi di `auditRiskConfig` bloccano, compreso `maxPositionUsd`
 *    dichiarato due volte con valori diversi — che a differenza degli altri HA
 *    un fallback sicuro documentato (`resolveMaxPositionUsd` applica il più
 *    restrittivo). Quel fallback è una disciplina di LETTURA, nata per
 *    interpretare config che esistono già; non è il permesso di SCRIVERE
 *    un'ambiguità nuova. Nel momento della scrittura il chiamante è presente e
 *    può dire quale dei due numeri intendeva: accettarlo qui significherebbe far
 *    operare il bot con un tetto che nessuno ha scritto in quel campo, e l'unico
 *    posto che lo direbbe è un log all'avvio. In più, bloccare su TUTTA la lista
 *    evita di classificare per sottostringa il testo libero che quella funzione
 *    restituisce: una riga nuova in `auditRiskConfig` è automaticamente coperta,
 *    invece di passare in silenzio perché non corrisponde a nessun pattern.
 *    Il percorso di LETTURA non cambia: `resolveMaxPositionUsd` continua ad
 *    applicare il più restrittivo per i bot già in DB.
 *
 * b) «Nessuna regola d'ingresso» NON blocca. È l'unico caso in cui la config è
 *    inservibile ma VISIBILE: il bot non apre mai, la UI non mostra regole, e
 *    `runBacktestGate` scrive già `inconclusive` con il motivo dentro la config.
 *    È inoltre una decisione già presa altrove nel codice (un `register_bot`
 *    senza `entryRules` crea il bot di proposito, senza scaricare candele), e
 *    non è questo il cancello dove ribaltarla. Il male dei due incidenti era
 *    l'INVISIBILITÀ: `signal: 'open_long'` sembra una strategia funzionante a
 *    chiunque la guardi, `entryRules` assente no. Tutto il RESTO della config
 *    viene comunque validato anche quando le regole mancano.
 *
 * Funzione PURA: nessun log, nessun DB, nessuna notifica — restituisce il
 * rifiuto e lascia al chiamante (che ha il contesto: MCP o rotta HTTP) l'audit e
 * la risposta. Esportata perché è la parte decidibile in isolamento, senza
 * passare dalle due conferme.
 *
 * @param {object} config configurazione CANDIDATA COMPLETA: per `register_bot`
 *   la config del nuovo bot, per `update_strategy_params` quella attuale FUSA
 *   con la patch (`mergeStrategyConfig`), cioè quella con cui il bot opererebbe;
 *   per le rotte della dashboard (#78) la config inviata dal form per un bot
 *   nuovo, oppure quella che `db.updateBot` scriverebbe davvero
 *   (`preserveDerivedConfig` sulla config attuale) per un bot esistente.
 * @returns {{ ok: boolean, error?: string, guardrail?: string, issues?: string[] }}
 */
export function validateConfigForWrite(config) {
  const cfg = isPlainObject(config) ? config : {};

  // Config su cui si misura la FORMA. È una copia — mai mutazione dell'oggetto
  // del chiamante — con due sole differenze rispetto alla candidata:
  //
  //  - i blocchi AZZERATI (`risk: null`) non ci sono. Per il motore un blocco a
  //    `null` è indistinguibile dall'assenza (ogni lettura è `cfg.risk?.x`) ed è
  //    il modo documentato di cancellarlo (vedi `mergeStrategyConfig`);
  //    `validateStrategyConfig`, nato sull'import di un FILE dove `risk: null` è
  //    un errore di scrittura, lo rifiuta. La tolleranza sta qui e non lì: qui si
  //    rifiuta una config inservibile, non un'operazione legittima.
  //  - se le regole d'ingresso mancano, al loro posto c'è il segnaposto: così
  //    l'unico errore che sparisce è quello dell'assenza (decisione (b) sopra) e
  //    tutto il resto della config viene comunque validato.
  const forSchema = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (value !== null) forSchema[key] = value;
  }
  if (!Array.isArray(forSchema.entryRules) || !forSchema.entryRules.length) {
    forSchema.entryRules = RULE_PLACEHOLDER;
  }

  const schemaErrors = validateStrategyConfig(forSchema);

  if (schemaErrors.length) {
    return {
      ok: false,
      guardrail: 'strategy_schema',
      issues: schemaErrors,
      error: `GUARDRAIL_VIOLATION: Configurazione di strategia non valida — ${schemaErrors.join(' ')}`
    };
  }

  // Forma valida non significa "verrà applicata": un tetto o una leva scritti in
  // un campo che il motore non legge passano ogni controllo di schema.
  const riskIssues = auditRiskConfig(cfg);
  if (riskIssues.length) {
    return {
      ok: false,
      guardrail: 'risk_config',
      issues: riskIssues,
      error: 'GUARDRAIL_VIOLATION: Parametri di rischio che il motore non applicherebbe come dichiarati — '
        + `${riskIssues.join(' ')} Usa i campi canonici: leverage (radice) e maxPositionUsd (radice oppure risk.maxPositionUsd, uno solo).`
    };
  }

  return { ok: true };
}

/**
 * La modifica cambia ciò su cui è stato misurato il backtest? (#78)
 *
 * Il criterio NON è nuovo: è `DERIVED_CONFIG_KEYS.backtestSummary.invalidatedBy`,
 * cioè le stesse chiavi che fanno cadere il riassunto salvato quando cambiano
 * (`preserveDerivedConfig`) e che fanno rieseguire il cancello in
 * `update_strategy_params` (oggi: `entryRules`). Leggerlo da lì e non riscriverlo
 * qui tiene allineate le due cose per costruzione: il backtest si riesegue
 * esattamente quando il verdetto vecchio smetterebbe di valere, mai di più (una
 * rinomina dalla dashboard non scarica 30 giorni di candele) e mai di meno (non
 * resta un bot con regole nuove e nessuna misura).
 *
 * Il confronto è quello di `preserveDerivedConfig` (`sameConfigValue`): un
 * falso "cambiato" fa rieseguire una misura, mai saltarla.
 *
 * Funzione pura.
 *
 * @param {object} existingConfig config attualmente in DB
 * @param {object} candidateConfig config che verrebbe scritta
 * @returns {boolean}
 */
export function backtestedStrategyChanged(existingConfig, candidateConfig) {
  const before = isPlainObject(existingConfig) ? existingConfig : {};
  const after = isPlainObject(candidateConfig) ? candidateConfig : {};
  const keys = DERIVED_CONFIG_KEYS.backtestSummary?.invalidatedBy || [];
  return keys.some(k => !sameConfigValue(before[k], after[k]));
}
