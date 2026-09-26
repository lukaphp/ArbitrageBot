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

/**
 * Motivo di chiusura per una riga che duplica una posizione già chiusa da
 * un'altra riga: UNA sola posizione fisica, più righe `positions` che se la
 * contendono perché più bot sullo stesso (wallet, coin) l'hanno adottata
 * ciascuno per conto proprio (`_reconcile`, ramo di adozione).
 *
 * PERCHÉ NON RIUSARE `CLOSE_REASON_STALE_ORPHAN`. Quello dice «la posizione non
 * c'è più sull'exchange e il bot era fermo»: una divergenza DB↔exchange sanata
 * a posteriori, con PnL mai conosciuto. Qui è l'opposto — la posizione è
 * esistita davvero, si è chiusa davvero e il suo PnL è noto: appartiene però a
 * UNA riga sola, e queste sono le copie. Mescolarle renderebbe indistinguibili
 * due difetti diversi, che si correggono in modi diversi (l'uno con la
 * riconciliazione, l'altro impedendo l'adozione multipla).
 *
 * Vale la stessa disciplina sul testo: nessuna delle parole su cui la ladder di
 * `closeReasonBucket` fa match prima di arrivare qui ("stop loss", "esterna",
 * "riconciliata", "TP/SL", …), altrimenti una copia finirebbe contata come un
 * trade spiegato — esattamente il conteggio che questo motivo serve a evitare.
 *
 * Il PnL di queste righe va messo a `null`, non a 0: `null` è già la convenzione
 * del progetto per «non attribuibile a questa riga» (`(r.pnl || 0)` nelle somme,
 * `pnl != null` nella rotta dei fill), mentre 0 affermerebbe un trade chiuso in
 * pari che non è mai avvenuto.
 */
export const CLOSE_REASON_DUPLICATE_ADOPTION = 'duplicata (stessa posizione adottata da più bot)';

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

/**
 * ISSUE #58 — IL CASO OPPOSTO: la posizione ESISTE ancora e nessuno la sorveglia.
 *
 * `findOrphanPositions` guarda una riga `positions` che non ha più riscontro sul
 * live. Questa guarda una posizione VIVA sull'exchange, su un `master_address`
 * gestito dalla piattaforma, che nessun bot `running` sta tracciando.
 *
 * PERCHÉ È UNA CONDIZIONE DA SEGNALARE E NON DA RIPARARE. Fermare un bot non
 * chiude mai la sua posizione, ed è voluto (stesso principio "one-way" del
 * kill-switch e della guardia SL). La conseguenza è che finché il bot resta fermo
 * NESSUN componente sorveglia quella posizione: niente `_ensureStopLoss`, niente
 * `_closeNow`, niente TP/SL dinamico. L'unica protezione residua sono i trigger
 * già sul book, eseguiti dall'exchange — e possono fallire: book sottile, fill
 * parziale, prezzo che li supera senza farli scattare (è esattamente il caso
 * NEAR-PERP del 25/09/2026, CRIT-SLSTALE-25). Il riconciliatore non aiuta: agisce
 * solo DOPO che la posizione è sparita. E riavviare il bot da soli è escluso per
 * disegno — vedi il vincolo di direzione in `botManager.startReconciliationWatcher`:
 * un bot `stopped` con una posizione aperta è la situazione tipica di chi ha
 * fermato il bot APPOSTA per gestire l'uscita a mano.
 *
 * Quindi: serve una persona. L'unica cosa che il software può fare è dirlo, e
 * dirlo in modo che non sembri un errore transitorio che si risolve da sé.
 *
 * L'UNITÀ DI CONFRONTO È LA COIN, NON IL LATO. Un bot `running` su quella coin
 * adotta la posizione al tick successivo (`_reconcile`) qualunque sia il lato:
 * confrontare anche il lato produrrebbe un falso allarme per tutta la finestra di
 * adozione, e un alert che grida al lupo viene poi ignorato quando conta.
 *
 * GESTITO DALLA PIATTAFORMA = esiste almeno una riga `bots` con quel
 * `master_address`. Su un wallet che la piattaforma non conosce non c'è niente da
 * dire: nessuno si è mai impegnato a sorvegliarlo.
 *
 * Funzione PURA: nessun DB, nessun singleton, nessuna notifica. Il guscio che
 * legge gli account e decide quando parlare sta in `botManager`.
 *
 * @param livePositions `account.positions` letto dall'exchange per `address`
 * @param bots          righe `bots` (servono `id`, `coin`, `master_address`)
 * @param runningBotIds Set degli id attualmente `running` (il FATTO, non l'intento)
 * @param address       master address interrogato
 * @returns [{ position, coin, bots }] — `bots` sono i bot fermi di quella coin,
 *          `[]` se la posizione non appartiene a nessun bot noto
 */
export function findUnmanagedLivePositions({
  livePositions = [], bots = [], runningBotIds = new Set(), address = null
} = {}) {
  const addr = String(address || '').toLowerCase();
  if (!addr) return [];

  const ofWallet = bots.filter(b => String(b?.master_address || '').toLowerCase() === addr);
  // Wallet non gestito dalla piattaforma: nessuna aspettativa di sorveglianza.
  if (!ofWallet.length) return [];

  const out = [];
  for (const position of livePositions) {
    if (!position?.coin) continue;
    const onCoin = ofWallet.filter(b => sameCoin(position.coin, b.coin));
    // Un bot `running` su quella coin la sorveglia (o la adotta al prossimo tick).
    if (onCoin.some(b => runningBotIds.has(b.id))) continue;
    out.push({ position, coin: position.coin, bots: onCoin });
  }
  return out;
}

export default {
  CLOSE_REASON_STALE_ORPHAN, CLOSE_REASON_DUPLICATE_ADOPTION,
  findOrphanPositions, reconcileStalePositions, findUnmanagedLivePositions
};
