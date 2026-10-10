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
 *  - `isLoopbackRequest(req)` — lato server: chi può chiamare `/internal/*`;
 *  - `postInternal(...)`       — lato client: la POST fire-and-forget.
 *
 * Sta in `src/utils/` e non in `src/mcp/` per una ragione di dipendenze, non di
 * gusto: `src/mcp/tools.js` importa già `src/perps/botManager.js`, quindi far
 * importare a `botManager` qualcosa da `mcp/tools.js` creerebbe un ciclo. Qui
 * non si importa nulla del dominio, e i due lati possono usarlo entrambi.
 */

import http from 'http';
import net from 'net';

/**
 * MODELLO DI FIDUCIA DELLE ROTTE `/internal/*` (issue #74)
 * --------------------------------------------------------
 *
 * Le rotte interne non chiedono cookie né token: la loro unica protezione è CHI
 * riesce ad aprire la connessione. L'unico chiamante legittimo è il processo
 * MCP Stdio che gira DENTRO lo stesso container (`docker exec -i … node
 * src/mcp/server.js`) e bussa con `postInternal`/`requestInternal` su
 * `127.0.0.1`. Quindi si ammette soltanto il loopback, e lo si legge dal peer
 * TCP vero (`req.socket.remoteAddress`), MAI da `req.ip`.
 *
 * Perché non `req.ip`: con `trust proxy 1` Express lo ricava
 * dall'`X-Forwarded-For` scritto da Caddy, cioè dal peer che vede CADDY. Dietro
 * `tailscale serve` → porta pubblicata → proxy Docker quel peer è il gateway
 * della rete Docker (172.x): ogni richiesta arrivata dalla tailnet sembrava
 * "interna". E un `X-Forwarded-For` lo può scrivere chiunque. Il socket invece
 * non si falsifica: una connessione che arriva da Caddy, da Grafana o da
 * qualunque altro container della rete `web` ha un indirizzo 172.x, e viene
 * respinta.
 *
 * Il vecchio `isInternalIp` ammetteva anche `172.*` "per la rete Docker
 * interna" (f030e8b), ma nessun chiamante l'ha mai usata: il ponte è sempre
 * stato loopback. Quel prefisso apriva le rotte a tutto ciò che passa da Caddy.
 *
 * Difesa in profondità: Caddy risponde 404 a `/internal/*` prima del
 * `reverse_proxy` (vedi Caddyfile), così le rotte non sono nemmeno raggiungibili
 * dalla tailnet. Questo controllo resta comunque la regola che conta, perché
 * vale anche per chi arriva direttamente su `app:3000` dalla rete Docker.
 *
 * Una regola sola per TUTTE le rotte interne: se cambia, cambia insieme per
 * tutte, non per quella che qualcuno si ricorda di aggiornare. Allargarla
 * (un'altra rete, un altro container) significa cambiare il modello di rischio:
 * a quel punto serve un segreto condiviso, non un prefisso IP.
 */

/**
 * `true` se l'indirizzo è di loopback: `127.0.0.0/8`, `::1`, oppure un IPv4
 * loopback mappato in IPv6 (`::ffff:127.x.y.z`, quello che Node riporta quando
 * il server ascolta su un socket dual-stack). Funzione pura, nessun I/O.
 *
 * @param {string|null|undefined} addr  indirizzo del peer, come lo dà Node
 * @returns {boolean}
 */
export function isLoopbackAddress(addr) {
  const s = String(addr || '');
  if (s === '::1') return true;
  const v4 = s.startsWith('::ffff:') ? s.slice(7) : s;
  return net.isIPv4(v4) && v4.startsWith('127.');
}

/**
 * Il cancello di `/internal/*`: la richiesta arriva da una connessione TCP di
 * loopback? Legge `req.socket.remoteAddress` e ignora di proposito `req.ip` e
 * ogni intestazione `X-Forwarded-*` (vedi il modello di fiducia sopra).
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLoopbackRequest(req) {
  return isLoopbackAddress(req?.socket?.remoteAddress);
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
  const res = await _request(path, payload, { timeoutMs, wantBody: false });
  return res.ok;
}

/**
 * POST JSON verso una rotta interna, ASPETTANDO LA RISPOSTA (CRIT #7).
 *
 * Il gemello "richiesta-risposta" di `postInternal`. Serve quando la chiamata
 * non è una notifica ma una DELEGA: il processo MCP Stdio non avvia più i bot da
 * sé, li fa avviare a Express — e quello che deve raccontare a Hermes è l'esito
 * VERO di là, non un successo locale. Con un booleano si potrebbe solo dire «ho
 * bussato», e «ho bussato» non è «è stato fatto».
 *
 * Non lancia mai. Distingue tre esiti, perché al chiamante servono diversi:
 *  - `reached: false` → Express non risponde: l'azione non è stata eseguita DA
 *    NESSUNO, e va detto così;
 *  - `ok: false` con `status`/`body` → Express ha risposto e ha rifiutato;
 *  - `ok: true` con `body` → fatto, e il corpo dice cosa è successo davvero.
 *
 * @returns {Promise<{reached: boolean, ok: boolean, status: number|null, body: any, error: string|null}>}
 */
export async function requestInternal(path, payload = null, { timeoutMs = 15000 } = {}) {
  return _request(path, payload, { timeoutMs, wantBody: true });
}

/**
 * Plumbing condiviso dai due lati client. `wantBody: false` NON registra
 * handler sul corpo e si limita a `resume()`: è il comportamento storico di
 * `postInternal`, che non deve cambiare (e che nei test è simulato da fake
 * minimali della risposta).
 */
async function _request(path, payload, { timeoutMs, wantBody }) {
  const fail = (error) => ({ reached: false, ok: false, status: null, body: null, error });
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
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!wantBody) {
          res.resume(); // scarica il corpo, altrimenti il socket resta appeso
          resolve({ reached: true, ok, status: res.statusCode, body: null, error: null });
          return;
        }
        let raw = '';
        res.setEncoding?.('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
          resolve({ reached: true, ok, status: res.statusCode, body: parsed, error: null });
        });
        res.on('error', (err) => resolve(fail(err.message)));
      });
      // Express spento o rotta assente: non è un errore per chi chiama.
      req.on('error', (err) => resolve(fail(err?.message || 'connessione fallita')));
      req.on('timeout', () => { req.destroy(); resolve(fail(`nessuna risposta entro ${timeoutMs}ms`)); });
      req.end(body);
    });
  } catch (err) {
    // Serializzazione impossibile (payload ciclico) o altro: mai propagare.
    return fail(err?.message || 'richiesta non inviabile');
  }
}

export default { isLoopbackAddress, isLoopbackRequest, postInternal, requestInternal };
