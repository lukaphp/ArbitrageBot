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
import { createRequire } from 'module';
import { Hyperliquid } from 'hyperliquid';
import { HYPERLIQUID_CONFIG } from '../config/config.js';

// L'SDK Hyperliquid, in ESM su Node < 23, non riesce a caricare il pacchetto
// 'ws' (dynamic require non supportato). Esponendo globalThis.require risolve il
// modulo correttamente e il WebSocket diventa disponibile. No-op se già presente.
if (typeof globalThis.require === 'undefined') {
  try { globalThis.require = createRequire(import.meta.url); } catch { /* noop */ }
}
import agentWallet from './agentWallet.js';
import execQueue from './execQueue.js';
import { withRetry } from './retry.js';
import metrics from './metrics.js';
import db from '../db/database.js';
import logger from '../utils/logger.js';

class HyperliquidClient {
  constructor() {
    this.network = HYPERLIQUID_CONFIG.defaultNetwork || 'testnet';
    this.readSdks = new Map();   // network -> SDK (sola lettura)
    this.signSdks = new Map();   // `${network}:${master}` -> SDK (firma con agent key)
    this.wsSdks = new Map();     // network -> SDK con WebSocket connesso
    // Listener notificati dopo un cambio rete a runtime: serve a chi ha una
    // sottoscrizione WS attiva (marketData) per ri-sottoscrivere la rete nuova
    // senza che questo modulo debba conoscerlo (nessun import circolare).
    this.networkChangeListeners = [];
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
    const previous = this.network;
    this.network = network;
    db.setSetting('perps_network', network);
    logger.info(`🔀 Rete Perps impostata su: ${network}`);
    if (previous !== network) {
      // Il WS della rete precedente non serve più: lasciandolo aperto resterebbe
      // una connessione viva che consegna i prezzi della rete SBAGLIATA, mentre
      // la rete nuova non verrebbe mai sottoscritta (nessuno richiama
      // subscribeAllMids) — restando silenziosamente sul fallback REST fino al
      // riavvio del processo.
      this.closeWsFor(previous).catch(() => { /* già loggato in closeWsFor */ });
      this._emitNetworkChange(network, previous);
    }
    return this.network;
  }

  /**
   * Registra un listener sul cambio rete. Invocato DOPO che la rete è cambiata e
   * che il WS della rete precedente è stato chiuso.
   * @param {(network: string, previous: string) => void} cb
   */
  onNetworkChange(cb) {
    if (typeof cb === 'function') this.networkChangeListeners.push(cb);
  }

  _emitNetworkChange(network, previous) {
    for (const cb of this.networkChangeListeners) {
      try {
        const r = cb(network, previous);
        // Un listener asincrono non deve poter far rigettare setNetwork.
        if (r && typeof r.catch === 'function') {
          r.catch(e => logger.warn('Listener cambio rete fallito', e?.message));
        }
      } catch (e) {
        logger.warn('Listener cambio rete fallito', e?.message);
      }
    }
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

  // ---- WebSocket (push real-time, con fallback al polling REST) ----

  /** SDK con WebSocket connesso (lazy). Lancia se la connessione fallisce. */
  async getWsSdk(network = this.network) {
    if (!this.wsSdks.has(network)) {
      const sdk = new Hyperliquid({ enableWs: true, testnet: network === 'testnet' });
      await sdk.connect();
      this.wsSdks.set(network, sdk);
      this._attachWsLogging(sdk, network);
      logger.info(`🔌 Hyperliquid WS connesso (${network})`);
    }
    return this.wsSdks.get(network);
  }

  /**
   * Aggancia gli eventi del WebSocket dell'SDK al NOSTRO logger.
   *
   * Serve perché l'SDK logga i propri tentativi di riconnessione interni con
   * console.error/console.warn diretti, che non passano dal nostro logger: senza
   * questo, un drop del WS può non lasciare alcuna traccia in logs/app.log (è il
   * difetto secondario #2 di WS-01).
   *
   * `maxReconnectAttemptsReached` è l'evento più importante: è il momento esatto
   * in cui l'SDK rinuncia e il watchdog di marketData diventa l'unica cosa che
   * può rimettere in piedi il feed.
   *
   * Best-effort: se l'SDK non esponesse un emitter, si registra a debug e si tira
   * avanti — il watchdog non dipende da questi eventi, li usa solo per lasciare
   * traccia.
   */
  _attachWsLogging(sdk, network) {
    const ws = sdk?.ws;
    if (!ws || typeof ws.on !== 'function') {
      logger.debug(`Hyperliquid WS (${network}): eventi non agganciabili (l'SDK non espone .on)`);
      return false;
    }
    if (ws.__hlLoggerAttached) return true;
    try {
      ws.on('error', (err) => {
        logger.warn(`🔌 Hyperliquid WS errore (${network})`, err?.message || String(err));
      });
      ws.on('close', (info) => {
        logger.warn(`🔌 Hyperliquid WS chiuso (${network})`, info?.reason || info?.code || '');
      });
      ws.on('reconnect', () => {
        logger.warn(`🔌 Hyperliquid WS: riconnessione interna dell'SDK in corso (${network})`);
      });
      ws.on('maxReconnectAttemptsReached', () => {
        logger.error(`🔌 Hyperliquid WS (${network}): l'SDK ha esaurito i propri tentativi di riconnessione — subentra il watchdog di marketData`);
      });
      ws.__hlLoggerAttached = true;
      return true;
    } catch (e) {
      logger.debug(`Hyperliquid WS (${network}): impossibile agganciare gli eventi`, e?.message);
      return false;
    }
  }

  /** True se il WebSocket per la rete è connesso. */
  wsConnected(network = this.network) {
    const sdk = this.wsSdks.get(network);
    try {
      // L'SDK espone isConnected() come metodo.
      return !!(sdk && sdk.ws && sdk.ws.isConnected());
    } catch {
      return false;
    }
  }

  /** Sottoscrive i mid di tutti i mercati. cb riceve l'oggetto AllMids. */
  async subscribeAllMids(cb, network = this.network) {
    const sdk = await this.getWsSdk(network);
    await sdk.subscriptions.subscribeToAllMids(cb);
    return sdk;
  }

  /** Sottoscrive i fill di un utente (riconciliazione event-driven). */
  async subscribeUserFills(masterAddress, cb, network = this.network) {
    const sdk = await this.getWsSdk(network);
    await sdk.subscriptions.subscribeToUserFills(masterAddress, cb);
    return sdk;
  }

  /**
   * Chiude e rimuove dalla cache la sola SDK WebSocket di una rete.
   * Va chiamata PRIMA di ri-sottoscrivere: se l'istanza morta resta in `wsSdks`,
   * `getWsSdk` la ritrova in cache e non riconnette nulla (e le istanze morte si
   * accumulerebbero a ogni cambio rete).
   * @returns {Promise<boolean>} true se c'era qualcosa da chiudere.
   */
  async closeWsFor(network) {
    const sdk = this.wsSdks.get(network);
    this.wsSdks.delete(network);
    if (!sdk) return false;
    try {
      sdk.disconnect?.();
    } catch (e) {
      // La chiusura di una connessione già morta può lanciare: non è un errore
      // bloccante (l'istanza è comunque fuori dalla cache), ma va tracciata.
      logger.debug(`Hyperliquid WS (${network}): disconnect fallito`, e?.message);
    }
    return true;
  }

  /** Chiude le connessioni WebSocket aperte. */
  async closeWs() {
    for (const network of [...this.wsSdks.keys()]) {
      await this.closeWsFor(network);
    }
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
    return withRetry(() => sdk.info.getAllMids(), { label: 'getAllMids' });
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
    return withRetry(() => sdk.info.getCandleSnapshot(coin, interval, startTime, endTime), { label: 'getCandles' });
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
      withRetry(() => sdk.info.perpetuals.getClearinghouseState(masterAddress), { label: 'getAccount' }),
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
    const orders = await withRetry(() => sdk.info.getFrontendOpenOrders(masterAddress), { label: 'getFrontendOpenOrders' });
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
    const fills = await withRetry(() => sdk.info.getUserFills(masterAddress), { label: 'getUserFills' });
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

  /**
   * PnL realizzato di un singolo ciclo di posizione dai FILL reali (non
   * dall'unrealized dell'ultimo tick). Somma il closedPnl dei fill di chiusura e
   * le fee di tutti i fill del coin a partire da `sinceTs` (apertura posizione).
   *
   * @returns {{ closedPnl, fee, net, fills }} net = closedPnl - fee
   *   oppure null se non sono ancora arrivati fill di chiusura (ritenta al tick dopo).
   */
  async getRealizedPnl(masterAddress, coin, sinceTs, network = this.network) {
    const fills = await this.getUserFills(masterAddress, network);
    const matchCoin = f => f.coin === coin || `${f.coin}-PERP` === coin || f.coin === coin.replace('-PERP', '');
    const since = sinceTs ? sinceTs - 1000 : 0; // piccolo margine per il clock skew
    const rel = fills.filter(f => matchCoin(f) && f.time >= since);
    const closing = rel.filter(f => /close/i.test(f.dir || ''));
    if (!closing.length) return null; // nessun fill di chiusura ancora visibile
    const closedPnl = closing.reduce((s, f) => s + (f.closedPnl || 0), 0);
    const fee = rel.reduce((s, f) => s + (f.fee || 0), 0); // fee open+close del ciclo
    return { closedPnl, fee, net: closedPnl - fee, fills: rel.length };
  }

  // ---- Azioni user-signed (firmate da MetaMask) ----

  /**
   * Invia a /exchange un'azione già firmata dal master wallet (MetaMask):
   * usata per approveAgent e usdClassTransfer (Spot↔Perp).
   */
  async submitSignedAction(action, signature, network = this.network) {
    const url = `${this.endpoints(network).api}/exchange`;
    const body = { action, nonce: action.nonce, signature };
    // Retry sicuro: il nonce è fisso, quindi un eventuale reinvio viene scartato
    // da Hyperliquid (no doppia esecuzione).
    return withRetry(async () => {
      const { data } = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' }, timeout: 15000
      });
      if (data?.status === 'err') {
        throw new Error(typeof data.response === 'string' ? data.response : JSON.stringify(data.response));
      }
      return data;
    }, { label: 'submitSignedAction' });
  }

  /** Saldo USDC nel wallet Spot (HyperCore) del master. */
  async getSpotUsdc(masterAddress, network = this.network) {
    const url = `${this.endpoints(network).api}/info`;
    const { data } = await withRetry(() => axios.post(url, { type: 'spotClearinghouseState', user: masterAddress }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 10000
    }), { label: 'getSpotUsdc' });
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
    // Serializzato per master: niente firme concorrenti che fanno collidere i nonce.
    return execQueue.run(masterAddress, () => sdk.exchange.updateLeverage(coin, mode, leverage));
  }

  /**
   * Ordine "market" = limit IoC a prezzo aggressivo.
   * @param {object} p { masterAddress, coin, isBuy, size, slippage=0.02, reduceOnly=false }
   */
  async placeMarketOrder({ masterAddress, coin, isBuy, size, slippage = 0.02, reduceOnly = false }, network = this.network) {
    const sdk = await this.getSignSdk(masterAddress, network);
    // Serializzato per master. NB: i market order NON vengono ritentati
    // automaticamente (un reinvio rischierebbe una doppia esecuzione): l'errore
    // si propaga e viene gestito dal chiamante.
    return execQueue.run(masterAddress, async () => {
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
      metrics.inc('orders_placed_total');
      return this._parseOrderResult(res);
    });
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
    return execQueue.run(masterAddress, async () => {
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
    });
  }

  async cancelOrder({ masterAddress, coin, oid }, network = this.network) {
    const sdk = await this.getSignSdk(masterAddress, network);
    return execQueue.run(masterAddress, () => sdk.exchange.cancelOrder({ coin, o: oid }));
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
