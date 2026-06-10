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
 */

import client from './hyperliquidClient.js';
import logger from '../utils/logger.js';

const PRICE_POLL_MS = 4000;
// Se l'ultimo messaggio WS è più recente di questa soglia, il poll REST si salta.
const WS_FRESH_MS = 8000;
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

class MarketData {
  constructor() {
    this.io = null;
    this.mids = {};            // coin -> prezzo
    this.markets = [];         // lista mercati (meta)
    this.candleCache = new Map(); // `${coin}:${interval}` -> { data, ts }
    this.pollTimer = null;
    this.isRunning = false;
    this.lastWsTickAt = 0;     // timestamp dell'ultimo aggiornamento via WebSocket
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
  }

  /** Sottoscrive i mid via WebSocket. In caso di errore si resta sul polling REST. */
  async _startWs() {
    try {
      await client.subscribeAllMids((data) => {
        // L'SDK può consegnare { mids: {...} } oppure direttamente la mappa.
        const mids = data?.mids || data;
        if (mids && typeof mids === 'object') {
          this.mids = mids;
          this.lastWsTickAt = Date.now();
          if (this.io) this.io.emit('perps:price', { mids, network: client.getNetwork(), ts: this.lastWsTickAt });
        }
      });
      logger.info('🔌 Market data: prezzi in tempo reale via WebSocket');
    } catch (error) {
      logger.warn('Market data: WebSocket non disponibile, uso polling REST', error.message);
    }
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
    this.isRunning = false;
    client.closeWs().catch(() => {});
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      markets: this.markets.length,
      network: client.getNetwork(),
      ws: client.wsConnected(),
      wsFresh: this._wsFresh()
    };
  }
}

export default new MarketData();
