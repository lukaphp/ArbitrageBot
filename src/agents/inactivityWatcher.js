/**
 * INACTIVITY WATCHER (proposta di tuning per bot fermo)
 * =====================================================
 *
 * Quando un bot in esecuzione non apre una posizione da più di N minuti, questo
 * watcher mette in coda una PROPOSTA — advisory, mai auto-eseguita. Resta lì
 * finché una persona non la approva o la rifiuta dalla plancia (o da Telegram
 * con `/approva`), esattamente come le proposte dell'Analyst.
 *
 * ── Perché deterministico e non una chiamata all'Analyst ────────────────────
 * "Nessuna posizione aperta da più di 15 minuti" è una sottrazione fra due
 * timestamp: non c'è niente da ragionare, e far produrre questa proposta a un
 * modello significherebbe pagare token e latenza per una condizione che si
 * calcola in una riga. C'è anche un motivo misurato, non solo di principio:
 * delle proposte prodotte finora dall'Analyst, 127 su 137 sono SCADUTE senza
 * decisione (COST-01). Aggiungere un nuovo generatore a un canale già ignorato
 * avrebbe peggiorato proprio il numero che quella storia cercava di abbassare —
 * da cui anche l'anti-spam e il TTL lungo qui sotto, che sono la risposta allo
 * stesso problema.
 *
 * ── Cosa NON fa ─────────────────────────────────────────────────────────────
 * Non forza trade, non muta strategie da solo, non ferma né crea bot. Un bot
 * senza segnale è un bot che sta facendo il suo lavoro: l'assenza di un segnale
 * è un'informazione, non un guasto. L'unica cosa che questo componente produce è
 * una riga in coda con scritto da quanto il bot è fermo e perché.
 *
 * ── Il tuning proposto ──────────────────────────────────────────────────────
 * Un solo parametro è modificabile da una proposta `tune_params`:
 * `candleInterval`, e solo VERSO IL BASSO di un gradino della whitelist già
 * esistente (`VALID_INTERVALS`). È una whitelist stretta di proposito: questa è
 * una nuova via di scrittura dentro `bots.config_json` che si apre con UN CLICK,
 * senza la conferma a due stadi che protegge il percorso MCP. Limitandola a una
 * chiave che cambia *ogni quanto il bot guarda il mercato* e non *quanto denaro
 * mette a rischio*, una proposta approvata non può alzare la leva, la size o i
 * tetti di rischio nemmeno se la riga in coda fosse stata scritta da qualcun
 * altro. Vedi `validateTunePatch`.
 *
 * Quando non c'è niente di sensato da proporre (bot senza regole d'ingresso:
 * nessun tuning lo farebbe aprire; intervallo già al minimo) la proposta viene
 * creata lo stesso ma SENZA patch, e finisce nel ramo "non auto-eseguibile"
 * dell'ExecutionAgent. È il caso onesto: dire "questo bot non aprirà mai, e non
 * è un problema di timeframe" vale più di un tuning finto che sembra una cura.
 */

import db from '../db/database.js';
import proposals from './proposals.js';
import { PROPOSAL_TYPE, validateTunePatch } from './tunePatch.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

export { PROPOSAL_TYPE };

/**
 * Intervalli dal più lungo al più corto. Sottoinsieme ORDINATO di
 * `VALID_INTERVALS` (che è un Set, quindi non esprime un ordine): serve a
 * rispondere a "qual è il gradino subito più corto di questo?".
 */
export const INTERVAL_LADDER = Object.freeze([
  '1M', '1w', '3d', '1d', '12h', '8h', '4h', '2h', '1h', '30m', '15m', '5m', '3m', '1m'
]);

/** Intervallo usato dal bot quando la config non lo dichiara (vedi `bot.js`). */
export const DEFAULT_INTERVAL = '15m';

/** Da quanto un bot deve essere senza aperture prima di far scattare la proposta. */
export const DEFAULT_IDLE_MIN = 15;

/**
 * Cadenza del controllo. Un minuto sarebbe inutile (la soglia è 15) e
 * moltiplicherebbe le letture di DB per niente; cinque minuti danno al massimo
 * 5 minuti di ritardo sulla soglia, che su una diagnosi di inattività non
 * cambia nulla.
 */
export const DEFAULT_CHECK_MS = 5 * 60 * 1000;

/**
 * Silenzio per bot dopo aver proposto qualcosa, QUALUNQUE sia stato l'esito
 * della proposta precedente.
 *
 * Sei ore e non quindici minuti perché le due condizioni di spam sono diverse e
 * servono due gate distinti: finché la proposta è in coda basta "ne esiste già
 * una pendente"; ma appena viene rifiutata o scade, quel gate si apre di nuovo e
 * senza questo il watcher riproporrebbe la stessa identica cosa al controllo
 * successivo — rifiutando l'utente una volta si sarebbe comprato cinque minuti
 * di pace. È la stessa ragione per cui `proposals.recycle()` non ricicla le
 * rifiutate: riproporre ciò che è già stato scartato ne contraddice la decisione.
 */
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * TTL della proposta, più lungo dei 30 minuti di default delle proposte
 * dell'Analyst.
 *
 * Un "chiudi adesso" decade col mercato e dopo mezz'ora è un consiglio su un
 * prezzo che non c'è più; "questo bot è fermo da tre ore" è vero anche domani.
 * Con il TTL corto la proposta sarebbe scaduta prima che qualcuno aprisse la
 * plancia, e il watcher ne avrebbe generata un'altra identica: è esattamente il
 * meccanismo per cui cadenza 30 min e TTL 30 min si annullano a vicenda
 * (COST-01). Tre ore, una sola proposta viva per bot alla volta.
 */
export const DEFAULT_TTL_MIN = 180;

/** Cause di inattività che questo watcher sa distinguere. */
export const CAUSE = Object.freeze({
  NO_ENTRY_RULES: 'no_entry_rules',
  NO_SIGNAL: 'no_signal'
});

/**
 * Gradino di intervallo subito più corto, o null se non ce n'è (già al minimo,
 * o intervallo non riconosciuto).
 *
 * PURA. Non accorcia di due gradini in un colpo: da '1h' si passa a '30m', non a
 * '5m'. Un bot che guarda candele dodici volte più corte non è "un po' più
 * reattivo", è una strategia diversa — e chi approva con un click deve poter
 * prevedere cosa sta approvando.
 */
export function shorterInterval(interval) {
  const current = interval || DEFAULT_INTERVAL;
  const i = INTERVAL_LADDER.indexOf(current);
  if (i < 0 || i === INTERVAL_LADDER.length - 1) return null;
  return INTERVAL_LADDER[i + 1];
}

/**
 * Diagnosi di inattività di UN bot. PURA: nessun accesso a DB, nessun orologio
 * interno, nessuna scrittura. Tutto ciò che serve arriva dai parametri, così si
 * verifica in isolamento e non serve istanziare un `PerpsBot` per provarla.
 *
 * @param bot stato del bot (`bot.getState()` o equivalente):
 *            { id, name, coin, status, inPosition, startedAt, config }
 * @param opts { now, thresholdMs, lastOpenedAt }
 *             `lastOpenedAt` = timestamp dell'ultima apertura (null se mai).
 * @returns {{ idle: boolean, skipReason?: string, idleMs?: number,
 *             since?: number, cause?: string, patch?: object|null,
 *             rationale?: string }}
 */
export function diagnoseInactivity(bot, { now = Date.now(), thresholdMs, lastOpenedAt = null } = {}) {
  const threshold = Number.isFinite(thresholdMs) ? thresholdMs : DEFAULT_IDLE_MIN * 60 * 1000;

  if (!bot || bot.status !== 'running') {
    return { idle: false, skipReason: 'il bot non è in esecuzione' };
  }
  // Un bot in posizione non è inattivo: sta gestendo un'operazione aperta.
  if (bot.inPosition) {
    return { idle: false, skipReason: 'il bot è in posizione' };
  }

  // Riferimento: l'ultima apertura, o — se non ha mai aperto — l'avvio di questa
  // istanza. `startedAt` è in memoria e si azzera a ogni riavvio del processo,
  // quindi dopo un deploy nessun bot risulta "fermo da giorni" al primo giro.
  const since = lastOpenedAt || bot.startedAt || null;
  if (!since) {
    return { idle: false, skipReason: 'istante di riferimento non disponibile (bot non ancora avviato)' };
  }

  const idleMs = now - since;
  if (idleMs < threshold) {
    return { idle: false, skipReason: `fermo da ${Math.round(idleMs / 60000)} min, sotto la soglia`, idleMs, since };
  }

  const config = bot.config || {};
  const entryRules = Array.isArray(config.entryRules) ? config.entryRules : [];
  const idleMin = Math.round(idleMs / 60000);
  const openedEver = !!lastOpenedAt;
  const quando = openedEver
    ? `dall'ultima apertura sono passati ${idleMin} minuti`
    : `non ha mai aperto una posizione, e sono passati ${idleMin} minuti dall'avvio`;

  // La causa si deduce dalla CONFIG, non dal testo di `lastEval.reason`: quella
  // è una frase pensata per un essere umano e riscriverla — cosa che capita —
  // farebbe degradare il watcher senza che nessun test se ne accorga.
  if (!entryRules.length) {
    return {
      idle: true, idleMs, since, cause: CAUSE.NO_ENTRY_RULES, patch: null,
      rationale:
        `Il bot «${bot.name}» (${bot.coin}) è in esecuzione ma ${quando}. `
        + 'Il motivo non è il mercato: la sua configurazione non contiene NESSUNA regola d\'ingresso, '
        + 'quindi ogni valutazione finisce in "hold" e il bot non aprirà mai una posizione, con qualunque timeframe. '
        + 'Nessun parametro da ritoccare risolverebbe questo: serve definire una strategia d\'ingresso '
        + '(o fermare il bot, se non doveva essere in esecuzione).'
    };
  }

  const current = config.candleInterval || DEFAULT_INTERVAL;
  const target = shorterInterval(current);
  const dichiarato = config.candleInterval ? `${current}` : `${current} (default, non dichiarato in config)`;

  if (!target) {
    return {
      idle: true, idleMs, since, cause: CAUSE.NO_SIGNAL, patch: null,
      rationale:
        `Il bot «${bot.name}» (${bot.coin}) ha regole d'ingresso configurate ma ${quando}. `
        + `L'intervallo delle candele è già ${dichiarato}, il più corto disponibile: non c'è nessun `
        + 'timeframe più reattivo da proporre. Se l\'attesa non è voluta, la revisione riguarda le '
        + 'condizioni d\'ingresso, non la frequenza con cui vengono valutate.'
    };
  }

  const nota = config.logic === 'all' && entryRules.length > 1
    ? ` Da notare: le ${entryRules.length} regole sono in AND (logic: "all"), quindi devono verificarsi tutte insieme — `
      + 'è la causa più probabile di una lunga attesa, ma cambiare quella logica è una modifica di strategia e non viene proposta qui.'
    : '';

  return {
    idle: true, idleMs, since, cause: CAUSE.NO_SIGNAL,
    patch: { candleInterval: target },
    rationale:
      `Il bot «${bot.name}» (${bot.coin}) è in esecuzione con ${entryRules.length} regola/e d'ingresso, ma ${quando}. `
      + `Proposta: passare le candele da ${dichiarato} a ${target}, un solo gradino più corto. `
      + 'Vuol dire che il bot valuta le stesse identiche regole più spesso e su candele più fini: '
      + 'può cogliere movimenti che su una candela lunga si compensano, al prezzo di più segnali e '
      + 'quindi più operazioni. Non cambia leva, size, TP/SL né i tetti di rischio — quelli restano '
      + 'esattamente com\'erano. È reversibile: basta riportare l\'intervallo al valore precedente.'
      + nota
  };
}

/**
 * Agente periodico per il runtime (`agents/runtime.js`), stessa forma di
 * `proposals.janitorAgent()`: { name, intervalMs, tick }.
 *
 * Le dipendenze sono iniettabili per poterlo testare senza singleton: nei test
 * si passa un `botManager` finto e si controlla cosa finisce nel DB temporaneo.
 */
export function inactivityWatcherAgent({
  getBots,
  idleMs = (HYPERLIQUID_CONFIG.agents?.inactivityIdleMin || DEFAULT_IDLE_MIN) * 60 * 1000,
  checkMs = DEFAULT_CHECK_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  ttlMin = HYPERLIQUID_CONFIG.agents?.inactivityTtlMin || DEFAULT_TTL_MIN,
  now = () => Date.now()
} = {}) {
  /** botId -> ts dell'ultima proposta creata da QUESTO watcher (anti-spam). */
  const lastProposedAt = new Map();

  return {
    name: 'inactivity-watcher',
    intervalMs: checkMs,

    /** Esposto al runtime (`agentRuntime.status()`) per diagnosi. */
    status() {
      return { watched: lastProposedAt.size, idleThresholdMin: Math.round(idleMs / 60000) };
    },

    async tick() {
      const ts = now();
      const bots = typeof getBots === 'function' ? (getBots() || []) : [];
      if (!bots.length) return;

      // Un solo giro sulle proposte pendenti per tutto il tick, non uno per bot:
      // stesso motivo per cui `proposals.recycle()` costruisce `pendingKeys` una
      // volta sola prima del ciclo.
      const pendingBotIds = new Set(
        db.listProposals({ status: 'pending', limit: 200 })
          .filter(p => p.type === PROPOSAL_TYPE)
          .map(p => safeParse(p.payload_json)?.botId)
          .filter(Boolean)
      );

      for (const bot of bots) {
        const d = diagnoseInactivity(bot, { now: ts, thresholdMs: idleMs, lastOpenedAt: db.lastOpenedAt(bot.id) });
        if (!d.idle) continue;

        // Anti-spam 1: ne esiste già una in attesa di decisione per questo bot.
        if (pendingBotIds.has(bot.id)) continue;
        // Anti-spam 2: silenzio dopo l'ultima, comunque sia andata a finire.
        const last = lastProposedAt.get(bot.id) || 0;
        if (ts - last < cooldownMs) continue;

        // La patch viene rivalidata anche qui, in uscita: se un domani la
        // diagnosi producesse una chiave fuori whitelist, la proposta nasce
        // senza patch (suggerimento da configurare a mano) invece di nascere
        // con un payload che l'ExecutionAgent rifiuterebbe al momento del click.
        let patch = d.patch || null;
        if (patch) {
          const v = validateTunePatch(patch);
          if (!v.ok) {
            logger.warn(`⏸️ Inactivity watcher: patch scartata per ${bot.name} — ${v.errors.join(' ')}`);
            patch = null;
          }
        }

        try {
          proposals.create({
            type: PROPOSAL_TYPE,
            coin: bot.coin,
            payload: {
              botId: bot.id,
              botName: bot.name,
              cause: d.cause,
              idleMinutes: Math.round(d.idleMs / 60000),
              ...(patch ? { patch } : {})
            },
            rationale: d.rationale,
            // Non c'è un modello dietro: la "confidenza" qui sarebbe un numero
            // inventato con l'aspetto di una stima. Resta null di proposito.
            confidence: null,
            source: 'inactivity-watcher',
            ttlMin
          });
          lastProposedAt.set(bot.id, ts);
        } catch (e) {
          // Non è un money path (non si muove nulla a mercato), ma un watcher
          // che smette di funzionare in silenzio è il guasto che non si vede:
          // il log resta, e il runtime notifica se il tick fallisce del tutto.
          logger.error(`⏸️ Inactivity watcher: proposta non creata per ${bot.name}`, e.message);
        }
      }
    }
  };
}

function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

export default { inactivityWatcherAgent, diagnoseInactivity, shorterInterval, PROPOSAL_TYPE, CAUSE };
