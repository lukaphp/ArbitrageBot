/**
 * MARKET DATA (Perps)
 * ===================
 *
 * Feed dei dati di mercato Hyperliquid per la sezione Perps:
 *  - prezzi mid di tutti i mercati (polling REST leggero, una sola request)
 *  - candele OHLC cache-ate per (coin, intervallo) per gli indicatori
 *  - funding rate previsto
 *
 * Fa broadcast dei prezzi ai client via Socket.io (evento `perps:price`).
 * Fornisce snapshot agli strategy engine dei bot (getSnapshot).
 *
 * Prezzi in tempo reale via WebSocket (subscribeAllMids), con POLLING REST come
 * fallback automatico: se il WS è "fresco" il poll REST si auto-salta (meno
 * carico, sub-secondo di latenza); se il WS cade, il poll riprende a 4s.
 *
 * WATCHDOG WEBSOCKET (WS-01)
 * --------------------------
 * `_startWs()` da solo non basta: veniva chiamato una volta sola all'avvio, e se
 * il WS cadeva (anche dopo che l'SDK esauriva i propri retry interni) nessuno se
 * ne accorgeva. Misurato in produzione: `perps_ws_connected 0` dopo ~28h di
 * uptime, senza un errore nei log, con il fallback REST che copriva il guasto in
 * silenzio per giorni. Il watchdog qui sotto verifica periodicamente lo stato
 * reale della connessione e ri-sottoscrive, con backoff minimo per non generare
 * un reconnect storm e una notifica Telegram (una per episodio) se il downtime
 * supera la soglia.
 *
 * STATO ESPLICITO A TRE VALORI (WARN-05)
 * --------------------------------------
 * Backoff e notifica-per-episodio esistevano già (l'audit li dava per mancanti):
 * quello che mancava davvero era uno STATO INTERROGABILE. Con il solo booleano di
 * connessione, "il WS è caduto un attimo e sto ritentando" e "sono in un guasto
 * persistente che non si risolverà da solo" erano indistinguibili da fuori —
 * `perps_ws_connected 0` in entrambi i casi.
 *
 *   healthy  → connesso e sottoscritto per la rete corrente
 *   retrying → giù, riconnessione in corso (col backoff già esistente)
 *   degraded → giù da oltre la soglia di downtime: fallback REST persistente
 *
 * La soglia di `degraded` è LA STESSA della notifica di downtime già esistente
 * (`PERPS_WS_DOWN_NOTIFY_MS`, alias `PERPS_WS_DEGRADED_MS`), non una seconda:
 * così "un solo alert all'ingresso in degraded e uno al rientro in healthy" è
 * esattamente la notifica-per-episodio che c'è già, invece di un secondo canale di
 * avvisi sullo stesso evento. Nessuna riga di backoff/retry è cambiata.
 */

import client from './hyperliquidClient.js';
import notifier from './notifier.js';
import metrics from './metrics.js';
import logger from '../utils/logger.js';

const PRICE_POLL_MS = 4000;
// Se l'ultimo messaggio WS è più recente di questa soglia, il poll REST si salta.
const WS_FRESH_MS = 8000;
// Ogni quanto il watchdog verifica che la sottoscrizione WS sia ancora viva.
const WS_WATCHDOG_MS = parseInt(process.env.PERPS_WS_WATCHDOG_MS) || 30000;
// Backoff MINIMO tra due tentativi di riconnessione: se il problema è persistente
// (rete giù, rate limit lato Hyperliquid) non deve trasformarsi in un loop di
// tentativi ravvicinati.
const WS_RECONNECT_BACKOFF_MS = parseInt(process.env.PERPS_WS_RECONNECT_BACKOFF_MS) || 15000;
// Downtime oltre il quale il WS giù diventa un problema da notificare. La
// notifica parte UNA volta per episodio, non a ogni tentativo: un WS che
// sfarfalla non deve generare rumore su Telegram.
const WS_DOWN_NOTIFY_MS = parseInt(process.env.PERPS_WS_DOWN_NOTIFY_MS) || 300000;
// Soglia oltre la quale lo stato del feed diventa `degraded` (WARN-05). È la
// stessa soglia della notifica qui sopra, così l'ingresso in degraded coincide
// con l'alert che parte già — un solo avviso per lo stesso evento.
// `PERPS_WS_DEGRADED_MS` esiste per poterla separare se un giorno servisse, ma il
// default è deliberatamente identico.
const WS_DEGRADED_MS = parseInt(process.env.PERPS_WS_DEGRADED_MS) || WS_DOWN_NOTIFY_MS;
export const WS_STATES = { HEALTHY: 'healthy', RETRYING: 'retrying', DEGRADED: 'degraded' };
const CANDLE_TTL_MS = 20000;
// Candele da richiedere di default: abbastanza per scaldare gli indicatori
// (RSI/EMA/MACD…) su QUALSIASI timeframe. Senza questo, su 1h/4h/1d si
// otterrebbero pochissime candele e gli indicatori resterebbero null (il bot
// non aprirebbe mai).
const DEFAULT_TARGET_CANDLES = 300;
const INTERVAL_MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '8h': 28800e3, '12h': 43200e3,
  '1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '1M': 2592000e3
};

export class MarketData {
  constructor() {
    this.io = null;
    this.mids = {};            // coin -> prezzo
    this.markets = [];         // lista mercati (meta)
    this.candleCache = new Map(); // `${coin}:${interval}` -> { data, ts }
    this.pollTimer = null;
    this.isRunning = false;
    this.lastWsTickAt = 0;     // timestamp dell'ultimo aggiornamento via WebSocket
    // --- Stato del watchdog WebSocket (WS-01) ---
    this.wsWatchdogTimer = null;
    this.wsNetwork = null;      // rete per cui la sottoscrizione WS è attualmente attiva
    this.wsDownSince = 0;       // inizio dell'episodio di downtime in corso (0 = WS su)
    this.wsDownNotified = false;// notifica già inviata per QUESTO episodio
    this.lastWsAttemptAt = 0;   // ultimo tentativo di (ri)sottoscrizione, per il backoff
    this.wsState = WS_STATES.HEALTHY; // healthy | retrying | degraded (WARN-05)
    this.netChangeHooked = false;
  }

  async start(io) {
    this.io = io;
    try {
      this.markets = await client.getMarkets();
      logger.info(`📈 Market data Perps avviato (${this.markets.length} mercati)`);
    } catch (error) {
      logger.warn('Market data: impossibile caricare i mercati all\'avvio', error.message);
    }
    this.isRunning = true;
    // Real-time via WebSocket (best-effort); il poll REST resta come fallback.
    this._startWs();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), PRICE_POLL_MS);
    // Watchdog: unica cosa nel nostro codice che si accorge che il WS è caduto.
    this.wsWatchdogTimer = setInterval(() => this._wsWatchdogTick(), WS_WATCHDOG_MS);
    // Cambio rete a runtime: ri-sottoscrive subito la rete nuova invece di
    // aspettare fino a WS_WATCHDOG_MS (il backoff viene azzerato perché non è un
    // guasto, è una scelta dell'operatore).
    if (!this.netChangeHooked) {
      client.onNetworkChange(() => {
        this.lastWsAttemptAt = 0;
        return this._wsWatchdogTick();
      });
      this.netChangeHooked = true;
    }
  }

  /**
   * Sottoscrive i mid via WebSocket. In caso di errore si resta sul polling REST.
   * @returns {Promise<boolean>} true se la sottoscrizione è stata stabilita.
   */
  async _startWs(network = client.getNetwork()) {
    try {
      await client.subscribeAllMids((data) => {
        // L'SDK può consegnare { mids: {...} } oppure direttamente la mappa.
        const mids = data?.mids || data;
        if (mids && typeof mids === 'object') {
          this.mids = mids;
          this.lastWsTickAt = Date.now();
          if (this.io) this.io.emit('perps:price', { mids, network: client.getNetwork(), ts: this.lastWsTickAt });
        }
      }, network);
      this.wsNetwork = network;
      logger.info(`🔌 Market data: prezzi in tempo reale via WebSocket (${network})`);
      return true;
    } catch (error) {
      logger.warn('Market data: WebSocket non disponibile, uso polling REST', error.message);
      // Lo stato non deve mentire nella finestra tra un tentativo fallito e il
      // giro di watchdog successivo (inclusa la sottoscrizione iniziale di
      // `start()`). Solo lo stato: `wsDownSince`/`lastWsAttemptAt`, da cui
      // dipendono backoff e notifica, restano gestiti dal watchdog.
      if (this.wsState === WS_STATES.HEALTHY) this.wsState = WS_STATES.RETRYING;
      return false;
    }
  }

  /**
   * Un giro di watchdog. Estratto dal timer per essere invocabile direttamente
   * (test e cambio rete) senza aspettare tempo reale. Non rigetta mai: un errore
   * qui non deve poter uccidere il timer e lasciare il watchdog morto.
   */
  async _wsWatchdogTick() {
    if (!this.isRunning) return false;
    try {
      const network = client.getNetwork();
      // "Sano" = connesso E sottoscritto per la rete ATTUALE: un WS connesso alla
      // rete precedente dopo un setNetwork consegnerebbe prezzi sbagliati.
      if (client.wsConnected(network) && this.wsNetwork === network) {
        this._markWsHealthy();
        return true;
      }

      const now = Date.now();
      if (!this.wsDownSince) this.wsDownSince = now;
      const downMs = now - this.wsDownSince;

      // WARN-05 — stato esplicito. `degraded` non al primo fallimento ma dopo la
      // soglia di TEMPO trascorso: il backoff rallenta già i tentativi, quindi un
      // contatore di retry non direbbe nulla su quanto dura il guasto.
      this.wsState = downMs >= WS_DEGRADED_MS ? WS_STATES.DEGRADED : WS_STATES.RETRYING;

      if (!this.wsDownNotified && downMs >= WS_DOWN_NOTIFY_MS) {
        this.wsDownNotified = true;
        logger.error(`Market data: WebSocket giù da ~${Math.round(downMs / 1000)}s (rete ${network}), avanti col fallback REST`);
        notifier.notify(`⚠️ <b>Market data</b>: WebSocket Hyperliquid non disponibile da ~${Math.round(downMs / 60000)} min (rete ${network}).\nI prezzi arrivano dal fallback REST: validi ma meno freschi.`);
      }

      // Backoff minimo: niente reconnect storm se il guasto è persistente.
      if (this.lastWsAttemptAt && (now - this.lastWsAttemptAt) < WS_RECONNECT_BACKOFF_MS) return false;
      this.lastWsAttemptAt = now;

      logger.warn(`Market data: WebSocket non connesso (rete ${network}), tentativo di riconnessione…`);
      // Via le istanze SDK morte prima di risottoscrivere, altrimenti getWsSdk le
      // ritrova in cache e non riconnette nulla.
      if (this.wsNetwork && this.wsNetwork !== network) await client.closeWsFor(this.wsNetwork);
      await client.closeWsFor(network);
      this.wsNetwork = null;

      const ok = await this._startWs(network);
      if (!ok) return false;

      // Solo un tentativo RIUSCITO conta come riconnessione (i fallimenti non
      // gonfiano il contatore). Include la ri-sottoscrizione dopo un cambio rete:
      // è comunque una riconnessione del WS, non un caso separato.
      metrics.inc('ws_reconnects_total');
      logger.info(`✅ Market data: WebSocket ristabilito (rete ${network}) dopo ~${Math.round(downMs / 1000)}s di downtime`);
      if (this.wsDownNotified) {
        notifier.notify(`✅ <b>Market data</b>: WebSocket Hyperliquid ristabilito (rete ${network}) dopo ~${Math.round(downMs / 60000)} min.`);
      }
      this._markWsHealthy();
      return true;
    } catch (error) {
      // Un fallimento del watchdog stesso non è mai silenzioso: se resta muto,
      // torniamo esattamente al bug che WS-01 risolve.
      logger.error('Market data: watchdog WebSocket in errore', error?.message);
      return false;
    }
  }

  /**
   * Chiude l'episodio di downtime corrente (WS di nuovo sano).
   * Chiamata anche da `stop()`: un feed fermato deliberatamente non è un guasto,
   * e chi legge lo stato ha comunque `isRunning` per distinguere i due casi.
   */
  _markWsHealthy() {
    this.wsDownSince = 0;
    this.wsDownNotified = false;
    this.wsState = WS_STATES.HEALTHY;
  }

  /** True se il WebSocket sta consegnando dati freschi. */
  _wsFresh() {
    return client.wsConnected() && (Date.now() - this.lastWsTickAt) < WS_FRESH_MS;
  }

  async poll() {
    // Se il WebSocket è fresco, evita la richiesta REST (riduce il carico).
    if (this._wsFresh()) return;
    try {
      const mids = await client.getAllMids();
      this.mids = mids;
      if (this.io) {
        this.io.emit('perps:price', { mids, network: client.getNetwork(), ts: Date.now() });
      }
    } catch (error) {
      logger.debug('Market data poll fallito', error.message);
    }
  }

  getMarkets() {
    return this.markets;
  }

  async refreshMarkets() {
    this.markets = await client.getMarkets();
    return this.markets;
  }

  getMid(coin) {
    const px = this.mids[coin] ?? this.mids[coin?.replace('-PERP', '')];
    return px ? parseFloat(px) : null;
  }

  /** Candele cache-ate con TTL. Il lookback di default scala con l'intervallo. */
  async getCandles(coin, interval = '15m', lookbackMs) {
    if (lookbackMs == null) {
      lookbackMs = (INTERVAL_MS[interval] || INTERVAL_MS['15m']) * DEFAULT_TARGET_CANDLES;
    }
    const key = `${coin}:${interval}`;
    const cached = this.candleCache.get(key);
    if (cached && Date.now() - cached.ts < CANDLE_TTL_MS) {
      return cached.data;
    }
    const data = await client.getCandles(coin, interval, lookbackMs);
    this.candleCache.set(key, { data, ts: Date.now() });
    return data;
  }

  /**
   * Snapshot per lo strategy engine: prezzo corrente + candele + funding.
   */
  async getSnapshot(coin, { interval = '15m', withFunding = false } = {}) {
    const [candles, mid] = await Promise.all([
      this.getCandles(coin, interval).catch(() => []),
      Promise.resolve(this.getMid(coin) ?? client.getMid(coin))
    ]);
    const snapshot = {
      coin,
      price: typeof mid === 'number' ? mid : await mid,
      candles: candles || [],
      ts: Date.now()
    };
    if (withFunding) {
      try {
        const predicted = await client.getPredictedFundings();
        snapshot.funding = this._extractFunding(predicted, coin);
      } catch { /* funding opzionale */ }
    }
    return snapshot;
  }

  _extractFunding(predicted, coin) {
    // predicted: [ [coinName, [ [venue, {fundingRate, ...}], ... ] ], ... ]
    const name = coin.replace('-PERP', '');
    const entry = Array.isArray(predicted)
      ? predicted.find(e => e[0] === name)
      : null;
    if (!entry) return null;
    const hlVenue = (entry[1] || []).find(v => v[0] === 'HlPerp') || (entry[1] || [])[0];
    return hlVenue?.[1]?.fundingRate ? parseFloat(hlVenue[1].fundingRate) : null;
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    // Il timer del watchdog va ripulito come il pollTimer: sopravvivere a stop()
    // significherebbe riaprire connessioni WS su un market data già fermo.
    if (this.wsWatchdogTimer) clearInterval(this.wsWatchdogTimer);
    this.wsWatchdogTimer = null;
    this.isRunning = false;
    this.wsNetwork = null;
    this._markWsHealthy();
    client.closeWs().catch(() => {});
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      markets: this.markets.length,
      network: client.getNetwork(),
      ws: client.wsConnected(),
      wsFresh: this._wsFresh(),
      wsNetwork: this.wsNetwork,
      wsDownSeconds: this.wsDownSince ? Math.round((Date.now() - this.wsDownSince) / 1000) : 0,
      // WARN-05 — campi ADDITIVI: `ws`/`wsFresh` restano quello che erano, quindi
      // nessun consumatore esistente (cockpit, /api/perps/risk, tool del
      // consulente) cambia comportamento.
      wsState: this.wsState,
      wsDegradedAfterSeconds: Math.round(WS_DEGRADED_MS / 1000)
    };
  }
}

export default new MarketData();
