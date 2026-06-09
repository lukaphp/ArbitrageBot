/**
 * CLIENT HYPERLIQUID
 * ==================
 *
 * Unico punto di accesso a Hyperliquid: dati di mercato (info), esecuzione ordini
 * (exchange, firmati dall'agent key lato server) e invio dell'azione approveAgent
 * firmata da MetaMask.
 *
 * Switch testnet/mainnet a runtime (stato in memoria + persistito in settings).
 *
 * Note tecniche:
 *  - Hyperliquid non ha veri ordini "market": un market è un limit IoC a prezzo
 *    aggressivo (mid ± slippage). Vedi placeMarketOrder().
 *  - I prezzi devono rispettare max 5 cifre significative (perps): vedi roundPx().
 */

import axios from 'axios';
import { Hyperliquid } from 'hyperliquid';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import agentWallet from './agentWallet.js';
import db from '../db/database.js';
import logger from '../utils/logger.js';

class HyperliquidClient {
  constructor() {
    this.network = HYPERLIQUID_CONFIG.defaultNetwork || 'testnet';
    this.readSdks = new Map();   // network -> SDK (sola lettura)
    this.signSdks = new Map();   // `${network}:${master}` -> SDK (firma con agent key)
  }

  init() {
    const persisted = db.getSetting('perps_network');
    if (persisted === 'testnet' || persisted === 'mainnet') {
      this.network = persisted;
    }
    logger.info(`📡 Hyperliquid client pronto (rete: ${this.network})`);
  }

  endpoints(network = this.network) {
    return HYPERLIQUID_CONFIG.endpoints[network];
  }

  getNetwork() {
    return this.network;
  }

  setNetwork(network) {
    if (network !== 'testnet' && network !== 'mainnet') {
      throw new Error('Rete non valida (testnet|mainnet)');
    }
    this.network = network;
    db.setSetting('perps_network', network);
    logger.info(`🔀 Rete Perps impostata su: ${network}`);
    return this.network;
  }

  // ---- Istanze SDK ----

  async getReadSdk(network = this.network) {
    if (!this.readSdks.has(network)) {
      const sdk = new Hyperliquid({ enableWs: false, testnet: network === 'testnet' });
      this.readSdks.set(network, sdk);
    }
    return this.readSdks.get(network);
  }

  /**
   * SDK firmante per un master address (usa la chiave agent decifrata).
   * Lancia se l'agent non è approvato.
   */
  async getSignSdk(masterAddress, network = this.network) {
    const key = `${network}:${masterAddress.toLowerCase()}`;
    if (!this.signSdks.has(key)) {
      const agentKey = agentWallet.getAgentKey(masterAddress, network);
      if (!agentKey) {
        throw new Error('Agent non approvato per questo wallet/rete. Abilita prima l\'auto-trading.');
      }
      const sdk = new Hyperliquid({
        enableWs: false,
        testnet: network === 'testnet',
        privateKey: agentKey,
        walletAddress: masterAddress
      });
      this.signSdks.set(key, sdk);
    }
    return this.signSdks.get(key);
  }

  /** Invalida le SDK firmanti in cache (es. dopo cambio agent). */
  resetSignSdk(masterAddress, network = this.network) {
    this.signSdks.delete(`${network}:${masterAddress.toLowerCase()}`);
  }

  // ---- Info / dati di mercato ----

  async getMeta(network = this.network) {
    const sdk = await this.getReadSdk(network);
    return sdk.info.perpetuals.getMeta();
  }

  /** Lista mercati con leva massima e prezzo mid corrente. */
  async getMarkets(network = this.network) {
    const sdk = await this.getReadSdk(network);
    const [meta, mids] = await Promise.all([
      sdk.info.perpetuals.getMeta(),
      sdk.info.getAllMids()
    ]);
    return meta.universe
      .filter(u => !u.isDelisted)
      .map(u => {
        // L'SDK restituisce già il nome con suffisso '-PERP' (es. 'BTC-PERP').
        const coin = u.name.endsWith('-PERP') ? u.name : `${u.name}-PERP`;
        const base = coin.replace('-PERP', '');
        return {
          coin,
          name: base,
          maxLeverage: u.maxLeverage,
          szDecimals: u.szDecimals,
          mid: parseFloat(mids[coin] ?? mids[base] ?? '0') || null
        };
      });
  }

  async getAllMids(network = this.network) {
    const sdk = await this.getReadSdk(network);
    return sdk.info.getAllMids();
  }

  async getMid(coin, network = this.network) {
    const mids = await this.getAllMids(network);
    const px = mids[coin] ?? mids[coin.replace('-PERP', '')];
    return px ? parseFloat(px) : null;
  }

  /** Candele OHLC. interval es. '1m','5m','15m','1h'. */
  async getCandles(coin, interval = '15m', lookbackMs = 1000 * 60 * 60 * 12, network = this.network) {
    const sdk = await this.getReadSdk(network);
    const endTime = Date.now();
    const startTime = endTime - lookbackMs;
    return sdk.info.getCandleSnapshot(coin, interval, startTime, endTime);
  }

  async getFundingHistory(coin, lookbackMs = 1000 * 60 * 60 * 24, network = this.network) {
    const sdk = await this.getReadSdk(network);
    return sdk.info.perpetuals.getFundingHistory(coin, Date.now() - lookbackMs, Date.now());
  }

  async getPredictedFundings(network = this.network) {
    const sdk = await this.getReadSdk(network);
    return sdk.info.perpetuals.getPredictedFundings();
  }

  /**
   * Statistiche di mercato per scansione/ranking: variazione 24h, volume,
   * funding, open interest. Una sola richiesta (metaAndAssetCtxs).
   */
  async getMarketStats(network = this.network) {
    const sdk = await this.getReadSdk(network);
    const res = await sdk.info.perpetuals.getMetaAndAssetCtxs();
    const meta = Array.isArray(res) ? res[0] : res?.meta;
    const ctxs = Array.isArray(res) ? res[1] : res?.assetCtxs;
    if (!meta?.universe || !ctxs) return [];
    return meta.universe
      .map((u, i) => ({ u, c: ctxs[i] || {} }))
      .filter(x => !x.u.isDelisted)
      .map(({ u, c }) => {
        const coin = u.name.endsWith('-PERP') ? u.name : `${u.name}-PERP`;
        const mark = parseFloat(c.markPx || c.midPx || '0');
        const prev = parseFloat(c.prevDayPx || '0');
        return {
          coin,
          name: coin.replace('-PERP', ''),
          mark,
          change24hPct: prev ? ((mark - prev) / prev) * 100 : null,
          volume24h: parseFloat(c.dayNtlVlm || '0'),
          funding: c.funding != null ? parseFloat(c.funding) : null,
          openInterest: parseFloat(c.openInterest || '0'),
          maxLeverage: u.maxLeverage
        };
      });
  }

  /** Stato account normalizzato: equity, margine, posizioni aperte, saldo Spot. */
  async getAccount(masterAddress, network = this.network) {
    const sdk = await this.getReadSdk(network);
    const [state, spotUsdc] = await Promise.all([
      sdk.info.perpetuals.getClearinghouseState(masterAddress),
      this.getSpotUsdc(masterAddress, network).catch(() => 0)
    ]);
    const ms = state.marginSummary || {};
    const positions = (state.assetPositions || [])
      .map(ap => ap.position)
      .filter(p => p && parseFloat(p.szi) !== 0)
      .map(p => {
        const szi = parseFloat(p.szi);
        return {
          coin: p.coin,
          side: szi > 0 ? 'long' : 'short',
          size: Math.abs(szi),
          entryPx: parseFloat(p.entryPx),
          positionValue: parseFloat(p.positionValue),
          unrealizedPnl: parseFloat(p.unrealizedPnl),
          leverage: p.leverage ? parseFloat(p.leverage.value) : null,
          liquidationPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
          marginUsed: parseFloat(p.marginUsed)
        };
      });
    const accountValue = parseFloat(ms.accountValue || '0');
    return {
      accountValue,
      // Equity utilizzabile per il trading: con gli account unificati Hyperliquid
      // il saldo Spot fa già da collaterale per i perpetual, quindi va incluso.
      equity: accountValue + spotUsdc,
      totalMarginUsed: parseFloat(ms.totalMarginUsed || '0'),
      totalNtlPos: parseFloat(ms.totalNtlPos || '0'),
      withdrawable: parseFloat(state.withdrawable || '0'),
      spotUsdc,
      positions
    };
  }

  async getOpenOrders(masterAddress, network = this.network) {
    const sdk = await this.getReadSdk(network);
    return sdk.info.getUserOpenOrders(masterAddress);
  }

  /** Ordini aperti dettagliati (include trigger TP/SL con triggerPx). */
  async getFrontendOpenOrders(masterAddress, network = this.network) {
    const sdk = await this.getReadSdk(network);
    const orders = await sdk.info.getFrontendOpenOrders(masterAddress);
    return (orders || []).map(o => ({
      coin: o.coin,
      side: o.side === 'B' ? 'buy' : 'sell',
      sz: parseFloat(o.sz),
      limitPx: parseFloat(o.limitPx),
      isTrigger: o.isTrigger,
      triggerPx: o.triggerPx ? parseFloat(o.triggerPx) : null,
      orderType: o.orderType,
      isPositionTpsl: o.isPositionTpsl,
      oid: o.oid
    }));
  }

  /** Storico delle operazioni eseguite (fill), manuali e dei bot. */
  async getUserFills(masterAddress, network = this.network) {
    const sdk = await this.getReadSdk(network);
    const fills = await sdk.info.getUserFills(masterAddress);
    return (fills || [])
      .sort((a, b) => b.time - a.time)
      .slice(0, 200)
      .map(f => ({
        coin: f.coin,
        dir: f.dir,                              // es. 'Open Long', 'Close Short'
        side: f.side === 'B' ? 'buy' : 'sell',
        px: parseFloat(f.px),
        sz: parseFloat(f.sz),
        fee: parseFloat(f.fee),
        closedPnl: parseFloat(f.closedPnl),
        time: f.time,
        hash: f.hash,
        oid: f.oid
      }));
  }

  // ---- Azioni user-signed (firmate da MetaMask) ----

  /**
   * Invia a /exchange un'azione già firmata dal master wallet (MetaMask):
   * usata per approveAgent e usdClassTransfer (Spot↔Perp).
   */
  async submitSignedAction(action, signature, network = this.network) {
    const url = `${this.endpoints(network).api}/exchange`;
    const body = { action, nonce: action.nonce, signature };
    const { data } = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    if (data?.status === 'err') {
      throw new Error(typeof data.response === 'string' ? data.response : JSON.stringify(data.response));
    }
    return data;
  }

  /** Saldo USDC nel wallet Spot (HyperCore) del master. */
  async getSpotUsdc(masterAddress, network = this.network) {
    const url = `${this.endpoints(network).api}/info`;
    const { data } = await axios.post(url, { type: 'spotClearinghouseState', user: masterAddress }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 10000
    });
    const usdc = (data?.balances || []).find(b => b.coin === 'USDC');
    return usdc ? parseFloat(usdc.total) : 0;
  }

  // ---- Esecuzione ordini (firmati dall'agent) ----

  /** Arrotonda il prezzo a max 5 cifre significative (regola perps Hyperliquid). */
  roundPx(px) {
    if (px === 0) return 0;
    const digits = Math.ceil(Math.log10(Math.abs(px)));
    const decimals = Math.max(0, 5 - digits);
    return parseFloat(px.toFixed(Math.min(decimals, 8)));
  }

  /** Imposta la leva (cross di default) prima di aprire una posizione. */
  async setLeverage(masterAddress, coin, leverage, mode = 'cross', network = this.network) {
    const sdk = await this.getSignSdk(masterAddress, network);
    return sdk.exchange.updateLeverage(coin, mode, leverage);
  }

  /**
   * Ordine "market" = limit IoC a prezzo aggressivo.
   * @param {object} p { masterAddress, coin, isBuy, size, slippage=0.02, reduceOnly=false }
   */
  async placeMarketOrder({ masterAddress, coin, isBuy, size, slippage = 0.02, reduceOnly = false }, network = this.network) {
    const sdk = await this.getSignSdk(masterAddress, network);
    const mid = await this.getMid(coin, network);
    if (!mid) throw new Error(`Prezzo non disponibile per ${coin}`);
    const px = this.roundPx(isBuy ? mid * (1 + slippage) : mid * (1 - slippage));

    const res = await sdk.exchange.placeOrder({
      coin,
      is_buy: isBuy,
      sz: size,
      limit_px: px,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: reduceOnly
    });
    logger.info('⚡ Ordine market inviato', { coin, isBuy, size, px });
    return this._parseOrderResult(res);
  }

  /**
   * Ordine trigger TP o SL (reduce-only) per una posizione esistente.
   * @param {object} p { masterAddress, coin, isBuy, size, triggerPx, tpsl ('tp'|'sl') }
   *   isBuy va impostato come direzione dell'ordine di CHIUSURA
   *   (per chiudere un long: isBuy=false; per chiudere uno short: isBuy=true).
   */
  async placeTriggerOrder({ masterAddress, coin, isBuy, size, triggerPx, tpsl }, network = this.network) {
    const sdk = await this.getSignSdk(masterAddress, network);
    const px = this.roundPx(triggerPx);
    const res = await sdk.exchange.placeOrder({
      coin,
      is_buy: isBuy,
      sz: size,
      limit_px: px,
      order_type: { trigger: { isMarket: true, triggerPx: px, tpsl } },
      reduce_only: true
    });
    logger.info(`🎯 Ordine ${tpsl.toUpperCase()} inviato`, { coin, triggerPx: px, size });
    return this._parseOrderResult(res);
  }

  async cancelOrder({ masterAddress, coin, oid }, network = this.network) {
    const sdk = await this.getSignSdk(masterAddress, network);
    return sdk.exchange.cancelOrder({ coin, o: oid });
  }

  /** Chiude completamente una posizione con un market reduce-only. */
  async closePosition({ masterAddress, coin }, network = this.network) {
    const account = await this.getAccount(masterAddress, network);
    const pos = account.positions.find(p => p.coin === coin || `${p.coin}-PERP` === coin);
    if (!pos) throw new Error(`Nessuna posizione aperta su ${coin}`);
    // Per chiudere: ordine opposto al lato della posizione.
    return this.placeMarketOrder({
      masterAddress,
      coin,
      isBuy: pos.side === 'short',
      size: pos.size,
      reduceOnly: true
    }, network);
  }

  _parseOrderResult(res) {
    // Normalizza la risposta dell'SDK in un formato semplice.
    const statuses = res?.response?.data?.statuses || [];
    const first = statuses[0] || {};
    const filled = first.filled;
    const resting = first.resting;
    return {
      raw: res,
      status: res?.status,
      oid: filled?.oid ?? resting?.oid ?? null,
      avgPx: filled?.avgPx ? parseFloat(filled.avgPx) : null,
      totalSz: filled?.totalSz ? parseFloat(filled.totalSz) : null,
      error: first.error || null
    };
  }
}

export default new HyperliquidClient();
