/**
 * PONTE LOOPBACK TRA I PROCESSI DELL'APP
 * ======================================
 *
 * Sul VPS non gira un solo processo: oltre a `node src/server.js` (Express, che
 * possiede le connessioni Socket.IO verso i browser) c'è un `node
 * src/mcp/server.js` long-lived (MCP Stdio di Hermes), dentro lo stesso
 * container. I due processi importano gli STESSI singleton (`botManager`, `db`,
 * `paperBroker`) ma ognuno ha la propria copia in memoria: in quello MCP
 * `botManager.io` è sempre `null`, perché lì non c'è nessun client connesso.
 *
 * Tutto ciò che deve ARRIVARE A UN BROWSER va quindi consegnato al processo
 * Express, e l'unico canale è una POST su loopback verso le rotte `/internal/*`.
 * Questo modulo raccoglie i due lati di quel canale, che prima esistevano
 * duplicati (il client in `src/mcp/tools.js`, il controllo IP in
 * `src/server.js`):
 *
 *  - `isInternalIp(ip)`  — lato server: chi può chiamare `/internal/*`;
 *  - `postInternal(...)` — lato client: la POST fire-and-forget.
 *
 * Sta in `src/utils/` e non in `src/mcp/` per una ragione di dipendenze, non di
 * gusto: `src/mcp/tools.js` importa già `src/perps/botManager.js`, quindi far
 * importare a `botManager` qualcosa da `mcp/tools.js` creerebbe un ciclo. Qui
 * non si importa nulla del dominio, e i due lati possono usarlo entrambi.
 */

import http from 'http';

/**
 * IP ammessi sulle rotte `/internal/*`: loopback (i due processi nello stesso
 * container) e rete Docker interna (172.x). Nessun cookie richiesto — la
 * protezione è la raggiungibilità, quindi qui non si allarga nulla senza
 * cambiare anche il modello di rischio.
 *
 * Estratto senza modifiche dal controllo inline di `/internal/mcp/reload`: se
 * un giorno quella regola cambia deve cambiare per TUTTE le rotte interne
 * insieme, non per quella che qualcuno si ricorda di aggiornare.
 */
export function isInternalIp(ip) {
  const s = String(ip || '');
  return s === '127.0.0.1'
    || s === '::1'
    || s.startsWith('::ffff:127.')
    || s.startsWith('172.');
}

/** Porta di Express: stessa risoluzione di `src/server.js` (i due processi condividono l'env). */
function expressPort() {
  return Number(process.env.PORT) || 3000;
}

/**
 * POST JSON verso una rotta interna del processo Express, in loopback.
 *
 * Fire-and-forget per contratto: la Promise si risolve SEMPRE (mai reject) con
 * `true` se la consegna è andata a buon fine, `false` altrimenti. Chi chiama può
 * ignorarla del tutto — è pensata per essere invocata da percorsi che non devono
 * rallentare (il tick di un bot) e da percorsi che non devono fallire per colpa
 * di Express (una risposta MCP, che deve funzionare anche a Express spento).
 *
 * Il booleano esiste perché "silenzioso" non deve voler dire "invisibile": chi
 * chiama decide se e come segnalare una serie di consegne fallite (vedi
 * `botManager._forwardUpdateToExpress`, che logga una volta per episodio).
 *
 * @param {string} path   rotta interna, es. '/internal/mcp/bot-update'
 * @param {object|null} payload  corpo JSON; `null` = body vuoto
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>} consegnato (2xx) oppure no
 */
export async function postInternal(path, payload = null, { timeoutMs = 3000 } = {}) {
  try {
    const body = payload == null ? '' : JSON.stringify(payload);
    return await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: expressPort(),
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: timeoutMs
      }, (res) => {
        res.resume(); // scarica il corpo, altrimenti il socket resta appeso
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      // Express spento o rotta assente: non è un errore per chi chiama.
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end(body);
    });
  } catch {
    // Serializzazione impossibile (payload ciclico) o altro: mai propagare.
    return false;
  }
}

export default { isInternalIp, postInternal };
