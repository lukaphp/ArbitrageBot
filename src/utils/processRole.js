/**
 * RUOLO DEL PROCESSO — CHI ESEGUE I BOT
 * =====================================
 *
 * Sul VPS l'app non è un processo solo: dentro lo stesso container girano
 * `node src/server.js` (Express, il server principale, sempre attivo) e
 * `node src/mcp/server.js` (MCP Stdio, tenuto vivo dal watchdog di Hermes).
 * Importano gli STESSI singleton — `botManager`, `paperBroker`, `db` — ognuno
 * con la propria copia in memoria.
 *
 * Finché entrambi si sono sentiti liberi di AVVIARE bot, lo stesso bot ha avuto
 * due tick loop attivi sulla stessa riga `positions` e sullo stesso account
 * paper, ciascuno capace di piazzare e cancellare trigger per conto suo
 * (issue #7: `trailing_json` con `slOid` e `tpOids` mai coesistiti nello stesso
 * broker, e trigger TP/SL riportati a livelli di un bot già cancellato).
 *
 * Qui si dichiara UN proprietario del ciclo di esecuzione. Chi non lo possiede
 * non esegue: delega al processo che lo possiede e riporta l'esito vero.
 *
 * DUE REGOLE DI PROGETTO, ENTRAMBE DELIBERATE:
 *
 *  1. IL DEFAULT È «POSSIEDO IL LOOP». Un processo che non si dichiara si
 *     comporta esattamente come prima (esecuzione locale). Se il default fosse
 *     «delego», un Express che per qualsiasi motivo non riuscisse a dichiararsi
 *     inizierebbe a bussare a sé stesso — e i test, gli script CLI e il
 *     backtester si ritroverebbero a chiamare in rete una porta che non c'è.
 *     Il fallimento di questo meccanismo deve degradare al comportamento
 *     storico, non a un anello chiuso.
 *
 *  2. LA DICHIARAZIONE È ESPLICITA, non dedotta da `process.argv`. Dedurla
 *     avrebbe voluto dire indovinare: `src/mcp/server.js` e `src/server.js`
 *     finiscono ENTRAMBI per `server.js`, e un test o uno script che importa
 *     l'uno o l'altro cambierebbe ruolo per il nome del file che lo ha lanciato.
 *
 * `ARBITRAGEBOT_PROCESS_ROLE` permette di forzare il ruolo dall'ambiente (utile
 * in deploy: se un domani l'MCP Stdio venisse lanciato da un supervisore
 * diverso, si dichiara lì senza toccare il codice).
 */

export const ROLE_EXPRESS = 'express';
export const ROLE_MCP_STDIO = 'mcp_stdio';

const KNOWN = new Set([ROLE_EXPRESS, ROLE_MCP_STDIO]);

let role = KNOWN.has(process.env.ARBITRAGEBOT_PROCESS_ROLE)
  ? process.env.ARBITRAGEBOT_PROCESS_ROLE
  : ROLE_EXPRESS;

/**
 * Dichiara il ruolo di QUESTO processo. Va chiamata nell'entry point, prima di
 * caricare i bot: `loadFromDb()` decide in base a questo se avviarli.
 */
export function declareProcessRole(next) {
  if (!KNOWN.has(next)) throw new Error(`Ruolo di processo sconosciuto: ${next}`);
  role = next;
  return role;
}

export function getProcessRole() {
  return role;
}

/**
 * Questo processo può far girare tick loop di bot?
 *
 * È l'unica domanda che il resto del codice deve porsi: chi risponde `false`
 * non avvia timer, non riavvia bot al boot e non sorveglia niente — delega e
 * legge. Tenere la domanda in una funzione sola evita che fra sei mesi esistano
 * tre modi diversi di riconoscere il processo MCP.
 */
export function ownsTickLoop() {
  return role !== ROLE_MCP_STDIO;
}

export default { declareProcessRole, getProcessRole, ownsTickLoop, ROLE_EXPRESS, ROLE_MCP_STDIO };
