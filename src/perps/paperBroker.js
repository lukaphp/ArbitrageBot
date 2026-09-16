/**
 * PAPER BROKER (forward-test live)
 * ================================
 *
 * Esecuzione SIMULATA sui prezzi reali in tempo reale: stessa pipeline dei bot
 * live (segnali, gate, gestione posizione) ma NESSUN ordine reale parte. Riempe
 * gli ordini al mid corrente ± il COSTO di esecuzione simulato (`DEFAULT_SLIPPAGE`,
 * non la tolleranza dell'ordine — vedi `simulatedSlippage`) e applica le stesse
 * fee taker del backtester, così il forward-test riflette costi realistici.
 *
 * Espone il sottoinsieme dell'interfaccia di hyperliquidClient usato da PerpsBot,
 * così il bot può usarlo come "broker" trasparente quando config.paper === true.
 *
 * È il ponte mancante tra backtest e mainnet: valida la strategia su mercato
 * reale, in avanti, senza rischiare capitale.
 */

import client from './hyperliquidClient.js';
import db from '../db/database.js';
import logger from '../utils/logger.js';

const TAKER_FEE_PCT = 0.00035;
// Costo di esecuzione SIMULATO, per lato. È lo stesso valore del backtester
// (`DEFAULT_SLIPPAGE_PCT` in backtester.js): forward-test e backtest devono
// costare uguale, altrimenti non sono confrontabili.
const DEFAULT_SLIPPAGE = 0.0005;
const START_EQUITY = parseFloat(process.env.PAPER_START_EQUITY) || 10000;

// QUAL-01 item 3 — stato persistito in `settings`, chiave singola.
const STATE_KEY = 'paper_broker_state';
// I fill servono a `getRealizedPnl`, che guarda solo quelli dall'apertura della
// posizione in corso: oltre questa finestra sono storia già aggregata in
// `positions`/`trades`. Un forward-test lungo mesi non deve gonfiare senza limite
// una riga di `settings`.
const MAX_PERSISTED_FILLS = 500;

/**
 * Slippage REALIZZATO da simulare su un fill, dato il parametro `slippage` che
 * il chiamante passa a `placeMarketOrder`.
 *
 * CRIT #16 — sono due grandezze diverse e vanno tenute distinte:
 *  - il parametro del chiamante è una TOLLERANZA: `hyperliquidClient.placeMarketOrder`
 *    ci costruisce il limit IoC aggressivo (`mid ± slippage`), cioè il prezzo
 *    PEGGIORE accettabile. `bot._openPosition` e `bot._maybeDca` passano
 *    `config.slippage ?? 0.02`, cioè il 2%;
 *  - il COSTO di esecuzione atteso è un'altra cosa, dell'ordine dei punti base
 *    (`DEFAULT_SLIPPAGE`), ed è ciò che il fill simulato deve pagare — sul
 *    mercato vero il fill arriva dal book, non dal limit price.
 *
 * Usare la tolleranza come costo riempiva ogni ordine paper al 2% dal mid: con
 * uno SL all'1.5% la posizione nasceva GIÀ oltre il proprio stop e moriva alla
 * prima valutazione dei trigger, in entrambe le direzioni e a mercato fermo
 * (flotta OPS-FLEET-02 del 15/09: 18 trade su 18 in perdita, ~218 USD).
 *
 * Un IoC però non si riempie mai PEGGIO del proprio limit price: se il chiamante
 * indica una tolleranza più stretta del modello, è quella a valere.
 */
export function simulatedSlippage(tolerance) {
  const tol = Number(tolerance);
  if (!Number.isFinite(tol) || tol < 0) return DEFAULT_SLIPPAGE;
  return Math.min(tol, DEFAULT_SLIPPAGE);
}

export class PaperBroker {
  constructor() {
    // master(lower) -> { equity, positions: Map<coin,{side,size,entryPx,leverage}>,
    //                    triggers: Map<coin,[{oid,tpsl,triggerPx,isBuy,size}]>,
    //                    leverage: Map<coin, number>,
    //                    fills: [{time,coin,dir,closedPnl,fee}], oidSeq }
    this.state = new Map();
    this._loaded = false;
  }

  /**
   * QUAL-01 item 3 — ripristina lo stato simulato.
   *
   * Un riavvio azzerava il forward-test in corso: posizioni virtuali aperte,
   * trigger e PnL simulato spariti, equity di nuovo a `PAPER_START_EQUITY`. Il
   * paper mode serve a validare una strategia PRIMA di rischiare capitale reale,
   * e una serie di risultati che si azzera a ogni deploy non valida nulla.
   *
   * `oidSeq` è persistito con il resto e non è un dettaglio: gli oid dei trigger
   * sono ciò con cui `bot._classifyCloseFills` riconosce se ha chiuso il TP o lo
   * SL. Ripartendo da 1 dopo un riavvio, un oid nuovo potrebbe coincidere con uno
   * vecchio ancora tracciato in `trailing_json` e attribuire la chiusura
   * all'ordine sbagliato.
   *
   * Lazy come i cooldown di portafoglio (CRIT-02): il singleton nasce all'import,
   * quando il DB può non essere ancora inizializzato.
   */
  _load() {
    if (this._loaded) return this.state;
    this._loaded = true;
    try {
      const raw = db.getSetting(STATE_KEY);
      if (!raw) return this.state;
      const parsed = JSON.parse(raw) || {};
      for (const [key, acc] of Object.entries(parsed)) {
        this.state.set(key, {
          equity: Number.isFinite(Number(acc.equity)) ? Number(acc.equity) : START_EQUITY,
          positions: new Map(Object.entries(acc.positions || {})),
          triggers: new Map(Object.entries(acc.triggers || {})),
          // Assente negli stati salvati prima del fix sulla leva: si riparte da
          // vuoto, e le posizioni già aperte tengono la leva con cui sono nate.
          leverage: new Map(Object.entries(acc.leverage || {})),
          fills: Array.isArray(acc.fills) ? acc.fills : [],
          oidSeq: Number(acc.oidSeq) > 0 ? Number(acc.oidSeq) : 1
        });
      }
      const positions = [...this.state.values()].reduce((n, a) => n + a.positions.size, 0);
      logger.info(`📝 Paper broker: stato ripristinato (${this.state.size} account, ${positions} posizioni simulate aperte)`);
    } catch (error) {
      // Degrado: si riparte da zero, ma detto — un forward-test che sembra
      // ricominciato da capo senza spiegazione è un dato che non si può leggere.
      logger.warn('Paper broker: stato simulato non ripristinabile, si riparte da zero', error.message);
    }
    return this.state;
  }

  /** Salva lo stato simulato. Un errore di scrittura non interrompe la simulazione. */
  _save() {
    try {
      const out = {};
      for (const [key, acc] of this.state) {
        out[key] = {
          equity: acc.equity,
          positions: Object.fromEntries(acc.positions),
          triggers: Object.fromEntries(acc.triggers),
          leverage: Object.fromEntries(acc.leverage),
          fills: acc.fills.slice(-MAX_PERSISTED_FILLS),
          oidSeq: acc.oidSeq
        };
      }
      db.setSetting(STATE_KEY, JSON.stringify(out));
      return true;
    } catch (error) {
      logger.warn('Paper broker: stato simulato non persistito', error.message);
      return false;
    }
  }

  _acc(master) {
    this._load();
    const key = (master || 'paper').toLowerCase();
    if (!this.state.has(key)) {
      this.state.set(key, { equity: START_EQUITY, positions: new Map(), triggers: new Map(), leverage: new Map(), fills: [], oidSeq: 1 });
    }
    const acc = this.state.get(key);
    // Account ripristinato da uno stato salvato prima del fix sulla leva.
    if (!acc.leverage) acc.leverage = new Map();
    return acc;
  }

  roundPx(px) { return client.roundPx(px); }
  async getMid(coin, network) { return client.getMid(coin, network); }

  /**
   * Leva dell'account per coin. Non era un no-op innocuo: il valore ricevuto
   * veniva buttato e `placeMarketOrder` scriveva `leverage: 1` fisso, così
   * `marginUsed` in `getAccount()` risultava sbagliato di un fattore pari alla
   * leva reale (3x sulla flotta OPS-FLEET-02 → margine apparente 3 volte il
   * vero). Su Hyperliquid la leva è stato di account per coin, non un campo
   * dell'ordine: la si ricorda qui, come fa l'exchange, e la si applica al fill.
   * Stessa firma posizionale di `hyperliquidClient.setLeverage`.
   */
  async setLeverage(masterAddress, coin, leverage) {
    const acc = this._acc(masterAddress);
    const lev = Number(leverage);
    if (coin && Number.isFinite(lev) && lev > 0) {
      acc.leverage.set(coin, lev);
      this._save();
      return { ok: true, paper: true, leverage: lev };
    }
    // Valore non utilizzabile: non si inventa una leva e non si sporca lo stato.
    // Il fallback a 1 resta in `placeMarketOrder`, dove è visibile.
    logger.warn(`Paper broker: leva non valida per ${coin} (${leverage}), stato invariato`);
    return { ok: true, paper: true, leverage: acc.leverage.get(coin) ?? null };
  }

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
    this._save();
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
    // CRIT #16: il fill paga il costo di esecuzione simulato, NON la tolleranza
    // del chiamante (vedi `simulatedSlippage`).
    const slip = simulatedSlippage(slippage);
    const px = client.roundPx(isBuy ? mid * (1 + slip) : mid * (1 - slip));
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
      // La leva è stato di account per coin: un'aggiunta non la cambia (il bot
      // non ripassa da `setLeverage` per il DCA). Si completa solo se manca del
      // tutto, cioè su posizioni aperte prima di questo fix.
      existing.leverage = existing.leverage || acc.leverage.get(coin) || 1;
      const fee = px * size * TAKER_FEE_PCT;
      acc.equity -= fee;
      acc.fills.push({ time: Date.now(), coin, dir: `Open ${existing.side === 'long' ? 'Long' : 'Short'}`, px, sz: size, fee, closedPnl: 0, oid });
    } else {
      // Apertura nuova
      const side = isBuy ? 'long' : 'short';
      // Leva reale impostata dal bot prima dell'apertura (`setLeverage`); 1 solo
      // se nessuno l'ha mai impostata per questa coin.
      acc.positions.set(coin, { side, size, entryPx: px, leverage: acc.leverage.get(coin) || 1 });
      const fee = px * size * TAKER_FEE_PCT;
      acc.equity -= fee;
      acc.fills.push({ time: Date.now(), coin, dir: `Open ${side === 'long' ? 'Long' : 'Short'}`, px, sz: size, fee, closedPnl: 0, oid });
    }
    this._save();
    return { oid, avgPx: px, totalSz: size, error: null, paper: true };
  }

  async placeTriggerOrder({ masterAddress, coin, isBuy, size, triggerPx, tpsl }, network) {
    const acc = this._acc(masterAddress);
    const px = client.roundPx(triggerPx);
    const oid = acc.oidSeq++;
    const list = acc.triggers.get(coin) || [];
    list.push({ oid, tpsl, triggerPx: px, isBuy, size });
    acc.triggers.set(coin, list);
    this._save();
    return { oid, avgPx: null, error: null, paper: true };
  }

  async cancelOrder({ masterAddress, coin, oid }) {
    const acc = this._acc(masterAddress);
    const list = (acc.triggers.get(coin) || []).filter(t => t.oid !== oid);
    acc.triggers.set(coin, list);
    this._save();
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
