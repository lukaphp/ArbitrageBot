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
 * Usa polling REST invece del WebSocket per semplicità/robustezza; il passaggio
 * a sottoscrizioni WS è un'ottimizzazione futura non bloccante.
 */

import client from './hyperliquidClient.js';
import logger from '../utils/logger.js';

const PRICE_POLL_MS = 4000;
const CANDLE_TTL_MS = 20000;

class MarketData {
  constructor() {
    this.io = null;
    this.mids = {};            // coin -> prezzo
    this.markets = [];         // lista mercati (meta)
    this.candleCache = new Map(); // `${coin}:${interval}` -> { data, ts }
    this.pollTimer = null;
    this.isRunning = false;
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
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), PRICE_POLL_MS);
  }

  async poll() {
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

  /** Candele cache-ate con TTL. */
  async getCandles(coin, interval = '15m', lookbackMs) {
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
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      markets: this.markets.length,
      network: client.getNetwork()
    };
  }
}

export default new MarketData();
