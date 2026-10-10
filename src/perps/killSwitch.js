/**
 * KILL SWITCH — lettura condivisa del flag persistito (#72)
 * =========================================================
 *
 * Il flag vive in `settings` (`killswitch = 'on' | 'off'`) e lo scrivono le
 * rotte `/api/agents/killswitch`, `/api/perps/killswitch` e il comando Telegram
 * `/killswitch`. Fino a #72 lo leggeva solo il RiskAgent (proposte AI) e il tool
 * MCP `place_order_paper`: i bot a regole (`PerpsBot`) non lo guardavano mai, e
 * la notifica «nuove aperture bloccate» diceva il falso proprio per i bot che
 * aprono di più.
 *
 * Modulo a sé, in `src/perps/`, per non far dipendere `bot.js` da
 * `src/agents/riskAgent.js` (che a sua volta importa portfolio, execQueue,
 * riskManager: un ciclo in attesa di succedere). Dipende solo dal DB e dal
 * logger, quindi chiunque lo può importare.
 *
 * FAIL-CLOSED: se il flag non è leggibile si considera ATTIVO. Stessa scelta del
 * freno di overtrading — non sapere se l'operatore ha premuto il kill switch non
 * è la stessa cosa che sapere che non l'ha premuto, e un'apertura mancata costa
 * molto meno di una aperta contro la sua volontà. Il guasto è loggato UNA volta
 * per episodio (fino alla prossima lettura riuscita), non a ogni tick di ogni bot.
 */

import db from '../db/database.js';
import logger from '../utils/logger.js';

export const KILLSWITCH_SETTING = 'killswitch';

let readFailureLogged = false;

/**
 * Stato del kill switch con il motivo, per chi deve distinguere "attivo" da
 * "non leggibile" (il bot lo dice all'operatore: annunciare un kill switch
 * attivo quando in realtà è il DB a non rispondere sarebbe un'informazione falsa).
 *
 * @returns {{ on: boolean, readError: string|null }}
 */
export function readKillSwitch() {
  try {
    const on = db.getSetting(KILLSWITCH_SETTING, 'off') === 'on';
    readFailureLogged = false;
    return { on, readError: null };
  } catch (error) {
    const msg = error?.message || String(error);
    if (!readFailureLogged) {
      readFailureLogged = true;
      logger.error(`Kill switch: flag non leggibile (${msg}) — considerato ATTIVO per prudenza, nuove aperture bloccate`);
    }
    return { on: true, readError: msg };
  }
}

/** Il kill switch è attivo? Fail-closed: un flag illeggibile vale `true`. */
export function isKillSwitchOn() {
  return readKillSwitch().on;
}

export default { isKillSwitchOn, readKillSwitch, KILLSWITCH_SETTING };
