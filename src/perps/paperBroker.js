/**
 * PAPER BROKER (forward-test live)
 * ================================
 *
 * Esecuzione SIMULATA sui prezzi reali in tempo reale: stessa pipeline dei bot
 * live (segnali, gate, gestione posizione) ma NESSUN ordine reale parte. Riempe
 * gli ordini al mid corrente ± slippage e applica le stesse fee taker del
 * backtester, così il forward-test riflette costi realistici.
 *
 * Espone il sottoinsieme dell'interfaccia di hyperliquidClient usato da PerpsBot,
 * così il bot può usarlo come "broker" trasparente quando config.paper === true.
 *
 * È il ponte mancante tra backtest e mainnet: valida la strategia su mercato
 * reale, in avanti, senza rischiare capitale.
 */

import client from './hyperliquidClient.js';
import logger from '../utils/logger.js';

const TAKER_FEE_PCT = 0.00035;
const DEFAULT_SLIPPAGE = 0.0005;
const START_EQUITY = parseFloat(process.env.PAPER_START_EQUITY) || 10000;

class PaperBroker {
  constructor() {
    // master(lower) -> { equity, positions: Map<coin,{side,size,entryPx,leverage}>,
    //                    triggers: Map<coin,[{oid,tpsl,triggerPx,isBuy,size}]>,
    //                    fills: [{time,coin,dir,closedPnl,fee}], oidSeq }
    this.state = new Map();
  }

  _acc(master) {
    const key = (master || 'paper').toLowerCase();
    if (!this.state.has(key)) {
      this.state.set(key, { equity: START_EQUITY, positions: new Map(), triggers: new Map(), fills: [], oidSeq: 1 });
    }
    return this.state.get(key);
  }

  roundPx(px) { return client.roundPx(px); }
  async getMid(coin, network) { return client.getMid(coin, network); }
  async setLeverage() { return { ok: true, paper: true }; }

  /** Valuta i trigger (TP/SL) virtuali contro il mid corrente e chiude se colpiti. */
  async _evaluateTriggers(master, network) {
    const acc = this._acc(master);
    for (const [coin, pos] of [...acc.positions]) {
      const trigs = acc.triggers.get(coin) || [];
      const mid = await client.getMid(coin, network).catch(() => null);
      if (mid == null) continue;
      for (const t of trigs) {
        const hit = pos.side === 'long'
          ? (t.tpsl === 'sl' ? mid <= t.triggerPx : mid >= t.triggerPx)
          : (t.tpsl === 'sl' ? mid >= t.triggerPx : mid <= t.triggerPx);
        if (hit) {
          // L'oid del fill è quello del TRIGGER che è scattato, non uno nuovo:
          // è la semantica di Hyperliquid (un ordine trigger che si attiva
          // produce un fill che porta il suo stesso oid) ed è ciò che permette
          // a `bot._registerClose` di sapere se ha chiuso il TP o lo SL.
          // Prima quest'informazione veniva scartata qui dentro.
          this._fillClose(master, coin, t.triggerPx, `trigger ${t.tpsl}`, { oid: t.oid });
          break;
        }
      }
    }
  }

  /**
   * Registra la chiusura simulata e realizza il PnL (netto fee).
   * @param meta.oid oid dell'ordine che ha prodotto la chiusura (trigger scattato
   *        o ordine di mercato). Va nel fill, come su Hyperliquid.
   */
  _fillClose(master, coin, px, reason, { oid = null } = {}) {
    const acc = this._acc(master);
    const pos = acc.positions.get(coin);
    if (!pos) return null;
    const notional = pos.size * px;
    const fee = notional * TAKER_FEE_PCT;
    const gross = pos.side === 'long' ? (px - pos.entryPx) * pos.size : (pos.entryPx - px) * pos.size;
    const closedPnl = gross;
    acc.equity += closedPnl - fee;
    acc.fills.push({ time: Date.now(), coin, dir: `Close ${pos.side === 'long' ? 'Long' : 'Short'}`, px, sz: pos.size, fee, closedPnl, oid });
    acc.positions.delete(coin);
    acc.triggers.delete(coin);
    logger.debug(`📝 Paper close ${coin} @ ${px} (${reason}) pnl=${closedPnl.toFixed(2)} fee=${fee.toFixed(2)}`);
    return { closedPnl, fee };
  }

  async getAccount(master, network) {
    await this._evaluateTriggers(master, network);
    const acc = this._acc(master);
    const positions = [];
    let unrealized = 0;
    for (const [coin, pos] of acc.positions) {
      const mid = await client.getMid(coin, network).catch(() => pos.entryPx);
      const upnl = pos.side === 'long' ? (mid - pos.entryPx) * pos.size : (pos.entryPx - mid) * pos.size;
      unrealized += upnl;
      positions.push({
        coin, side: pos.side, size: pos.size, entryPx: pos.entryPx,
        positionValue: pos.size * mid, unrealizedPnl: upnl, leverage: pos.leverage,
        liquidationPx: null, marginUsed: (pos.size * pos.entryPx) / (pos.leverage || 1)
      });
    }
    const equity = acc.equity + unrealized;
    return { accountValue: acc.equity, equity, totalMarginUsed: 0, totalNtlPos: 0, withdrawable: equity, spotUsdc: 0, positions };
  }

  async placeMarketOrder({ masterAddress, coin, isBuy, size, slippage = DEFAULT_SLIPPAGE, reduceOnly = false }, network) {
    const acc = this._acc(masterAddress);
    const mid = await client.getMid(coin, network);
    if (!mid) return { error: `Prezzo non disponibile per ${coin}` };
    const px = client.roundPx(isBuy ? mid * (1 + slippage) : mid * (1 - slippage));
    const oid = acc.oidSeq++;
    const existing = acc.positions.get(coin);

    if (reduceOnly || (existing && existing.side === (isBuy ? 'short' : 'long'))) {
      // Chiusura (riduzione totale: i bot chiudono l'intera size)
      this._fillClose(masterAddress, coin, px, 'market reduce', { oid });
    } else if (existing && existing.side === (isBuy ? 'long' : 'short')) {
      // DCA: media il prezzo d'ingresso
      const newSize = existing.size + size;
      existing.entryPx = (existing.entryPx * existing.size + px * size) / newSize;
      existing.size = newSize;
      const fee = px * size * TAKER_FEE_PCT;
      acc.equity -= fee;
      acc.fills.push({ time: Date.now(), coin, dir: `Open ${existing.side === 'long' ? 'Long' : 'Short'}`, px, sz: size, fee, closedPnl: 0, oid });
    } else {
      // Apertura nuova
      const side = isBuy ? 'long' : 'short';
      acc.positions.set(coin, { side, size, entryPx: px, leverage: 1 });
      const fee = px * size * TAKER_FEE_PCT;
      acc.equity -= fee;
      acc.fills.push({ time: Date.now(), coin, dir: `Open ${side === 'long' ? 'Long' : 'Short'}`, px, sz: size, fee, closedPnl: 0, oid });
    }
    return { oid, avgPx: px, totalSz: size, error: null, paper: true };
  }

  async placeTriggerOrder({ masterAddress, coin, isBuy, size, triggerPx, tpsl }, network) {
    const acc = this._acc(masterAddress);
    const px = client.roundPx(triggerPx);
    const oid = acc.oidSeq++;
    const list = acc.triggers.get(coin) || [];
    list.push({ oid, tpsl, triggerPx: px, isBuy, size });
    acc.triggers.set(coin, list);
    return { oid, avgPx: null, error: null, paper: true };
  }

  async cancelOrder({ masterAddress, coin, oid }) {
    const acc = this._acc(masterAddress);
    const list = (acc.triggers.get(coin) || []).filter(t => t.oid !== oid);
    acc.triggers.set(coin, list);
    return { ok: true, paper: true };
  }

  async closePosition({ masterAddress, coin }, network) {
    const acc = this._acc(masterAddress);
    const pos = acc.positions.get(coin);
    if (!pos) throw new Error(`Nessuna posizione aperta su ${coin}`);
    const mid = await client.getMid(coin, network);
    const px = client.roundPx(pos.side === 'long' ? mid * (1 - DEFAULT_SLIPPAGE) : mid * (1 + DEFAULT_SLIPPAGE));
    // L'oid si genera PRIMA del fill: deve finirci dentro, così una chiusura
    // esterna al bot resta distinguibile da un trigger scattato.
    const oid = acc.oidSeq++;
    this._fillClose(masterAddress, coin, px, 'closePosition', { oid });
    return { oid, avgPx: px, error: null, paper: true };
  }

  /** Ordini trigger "aperti" nel formato del frontend (per _ensureStopLoss). */
  async getFrontendOpenOrders(masterAddress) {
    const acc = this._acc(masterAddress);
    const out = [];
    for (const [coin, list] of acc.triggers) {
      for (const t of list) {
        out.push({ coin, side: t.isBuy ? 'buy' : 'sell', sz: t.size, limitPx: t.triggerPx,
          isTrigger: true, triggerPx: t.triggerPx, orderType: t.tpsl === 'sl' ? 'Stop Market' : 'Take Profit Market',
          isPositionTpsl: true, oid: t.oid });
      }
    }
    return out;
  }

  /**
   * PnL realizzato simulato dai fill di chiusura dal timestamp indicato.
   * `closingFills` espone i fill veri e propri (con il loro `oid`): serve a
   * `bot._registerClose` per capire QUALE ordine ha chiuso la posizione senza
   * fare una seconda lettura. Stessa forma di `hyperliquidClient.getRealizedPnl`.
   */
  async getRealizedPnl(masterAddress, coin, sinceTs) {
    const acc = this._acc(masterAddress);
    const since = sinceTs ? sinceTs - 1000 : 0;
    const matchCoin = f => f.coin === coin || `${f.coin}-PERP` === coin || f.coin === coin.replace('-PERP', '');
    const rel = acc.fills.filter(f => matchCoin(f) && f.time >= since);
    const closing = rel.filter(f => /close/i.test(f.dir || ''));
    if (!closing.length) return null;
    const closedPnl = closing.reduce((s, f) => s + (f.closedPnl || 0), 0);
    const fee = rel.reduce((s, f) => s + (f.fee || 0), 0);
    return { closedPnl, fee, net: closedPnl - fee, fills: rel.length, closingFills: closing };
  }
}

export default new PaperBroker();
