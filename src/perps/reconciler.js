/**
 * RICONCILIAZIONE DELLE RIGHE `positions` ORFANE
 * ==============================================
 *
 * Il problema che risolve. `bot._reconcile()` sa già chiudere in DB una
 * posizione sparita dall'exchange, ma vive dentro `_runTick`: esiste solo
 * finché il bot è `running`. Se il bot è FERMO e la posizione si chiude nel
 * frattempo (TP/SL scattati, chiusura manuale, `/chiuditutto`), non c'è nessuno
 * che se ne accorga: la riga resta `open` a tempo indeterminato e continua a
 * comparire ovunque si leggano le "posizioni aperte" — con un `size` e un
 * `entry_px` che non corrispondono più a niente.
 *
 * Il presidio sta in `/api/perps/account` perché è il punto in cui l'account
 * live e le righe di DB sono già entrambi in mano, senza aggiungere né una
 * chiamata all'exchange né un timer.
 *
 * DUE LIMITI VOLUTI, che è più importante capire della logica stessa:
 *
 *  1. **Non si tocca un bot `running`.** Quello lo riconcilia il suo tick. Due
 *     percorsi che chiudono la stessa riga sono peggio di uno solo: la finestra
 *     in cui si sovrappongono produrrebbe una doppia chiusura con due PnL
 *     diversi.
 *  2. **Non si tocca ciò che non appartiene all'indirizzo della richiesta.** La
 *     GET riguarda un wallet; l'assenza dalle sue posizioni live non dice nulla
 *     sulle righe di bot che operano su un altro indirizzo. Per lo stesso motivo
 *     una riga senza bot noto (`bot_id` nullo, o bot non più esistente) NON
 *     viene toccata: senza `master_address` non si può stabilire di chi sia, e
 *     chiuderla sarebbe tirare a indovinare su un dato che parla di soldi. In
 *     pratica il caso "bot eliminato" non si presenta, perché `db.deleteBot`
 *     cancella anche le sue righe `positions`.
 *
 * IL PnL È `null`, NON 0. Il bot era fermo: la posizione può essersi chiusa
 * molto prima, e i fill che la spiegherebbero possono non essere più nella
 * finestra interrogabile. Zero significherebbe "chiusa in pari", cioè
 * un'affermazione al posto di un'assenza — e finirebbe nelle statistiche come
 * un trade in pareggio davvero avvenuto. `null` è già la convenzione del
 * progetto per "PnL sconosciuto" (`getBotStats`/`getBotPerformance` usano
 * `(r.pnl || 0)`, la rotta dei fill controlla `pnl != null`).
 *
 * Il `close_reason` è distinto da tutti gli altri e ha un bucket suo
 * (`reconciliation_mismatch`, vedi `db.closeReasonBucket`): queste chiusure non
 * sono un TP, non sono uno SL e non sono nemmeno una "chiusura esterna
 * riconosciuta" — sono una divergenza tra DB ed exchange sanata a posteriori, e
 * mescolarle alle altre falserebbe qualunque conteggio di performance.
 */

import db from '../db/database.js';
import logger from '../utils/logger.js';
import notifier from './notifier.js';

/**
 * Motivo di chiusura scritto sulle righe riconciliate. Testo DISTINTO da ogni
 * altro motivo del progetto e privo delle parole su cui la ladder di
 * `closeReasonBucket` fa match ("esterna", "TP/SL", "stop loss", …): deve
 * cadere nel suo bucket, non in quello di una chiusura spiegata.
 */
export const CLOSE_REASON_STALE_ORPHAN = 'riconciliata (orfana, bot fermo)';

/** Stessa tolleranza di suffisso già usata dalla rotta: DB 'SOL-PERP' ↔ live 'SOL'. */
const sameCoin = (liveCoin, rowCoin) => liveCoin === rowCoin || `${liveCoin}-PERP` === rowCoin;

/**
 * Seleziona le righe `open` che non hanno riscontro sull'exchange. Funzione
 * PURA: nessuna lettura di DB, nessuna scrittura, nessun singleton — decide
 * soltanto *quali* righe sono orfane, così la regola è verificabile in
 * isolamento (è la parte che, se sbagliata, chiude in DB una posizione vera).
 *
 * @param openRows      righe `positions` con `status === 'open'`
 * @param livePositions `account.positions` dell'indirizzo interrogato
 * @param bots          righe `bots` (servono `id` e `master_address`)
 * @param runningBotIds Set degli id attualmente `running` in botManager
 * @param address       indirizzo della richiesta
 * @returns [{ row, bot }] nell'ordine in cui compaiono in `openRows`
 */
export function findOrphanPositions({
  openRows = [], livePositions = [], bots = [], runningBotIds = new Set(), address = null
} = {}) {
  const addr = String(address || '').toLowerCase();
  if (!addr) return [];
  const botById = new Map(bots.map(b => [b.id, b]));

  const out = [];
  for (const row of openRows) {
    if (!row || row.status !== 'open') continue;
    const bot = row.bot_id ? botById.get(row.bot_id) : null;
    if (!bot) continue;                                                   // proprietario ignoto
    if (String(bot.master_address || '').toLowerCase() !== addr) continue; // altro wallet
    if (runningBotIds.has(bot.id)) continue;                              // ci pensa il suo tick

    const viva = livePositions.some(p => p && sameCoin(p.coin, row.coin) && p.side === row.side);
    if (!viva) out.push({ row, bot });
  }
  return out;
}

/**
 * Chiude le righe orfane trovate. Guscio di I/O attorno alla funzione pura: qui
 * ci sono DB, log e notifica, lì la decisione.
 *
 * Log **e** notifica insieme, come per gli altri disallineamenti tra stato
 * locale ed exchange (fill parziale, fill nullo, posizione adottata): una riga
 * che il sistema chiude da solo, con PnL sconosciuto, è esattamente ciò di cui
 * l'operatore deve sapere — e siccome la riga resta poi `closed`, la notifica
 * parte una volta per episodio, non a ogni refresh della dashboard.
 *
 * @returns le righe riconciliate (per test e diagnostica)
 */
export function reconcileStalePositions({ openRows, livePositions, bots, runningBotIds, address } = {}) {
  const orfane = findOrphanPositions({ openRows, livePositions, bots, runningBotIds, address });

  for (const { row, bot } of orfane) {
    try {
      db.updatePosition(row.id, {
        status: 'closed',
        pnl: null,
        close_reason: CLOSE_REASON_STALE_ORPHAN,
        closed_at: Date.now()
      });
    } catch (error) {
      // Una riconciliazione fallita non deve far fallire la rotta (la dashboard
      // resterebbe senza account), ma non può nemmeno sparire: la riga resta
      // orfana e qualcuno deve poterlo sapere.
      logger.error(`Riconciliazione della riga #${row.id} (${row.coin} ${row.side}) fallita`, error.message);
      continue;
    }

    logger.warn(`Posizione orfana riconciliata: riga #${row.id} ${row.side} ${row.coin} del bot ${bot.name} (fermo) non esiste più sull'exchange — chiusa in DB con PnL sconosciuto`);
    notifier.notify(`🧹 <b>${bot.name}</b>: posizione ${row.side.toUpperCase()} ${row.coin} non è più sull'exchange e il bot era fermo.\nRiga #${row.id} chiusa in database (PnL non ricostruibile a posteriori).`);
  }

  return orfane;
}

export default { CLOSE_REASON_STALE_ORPHAN, findOrphanPositions, reconcileStalePositions };
