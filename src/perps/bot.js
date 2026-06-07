/**
 * PERPS BOT (auto-pilot)
 * ======================
 *
 * Una istanza = un mercato + una strategia. Esegue un loop periodico:
 *   snapshot mercato → strategyEngine → (ingresso | gestione | uscita) → persiste/emette.
 *
 * Macchina a stati: 'idle' → 'in_position' → 'idle'.
 * Tutta l'esecuzione è firmata dall'agent wallet (nessun popup MetaMask).
 *
 * Robustezza: ogni tick è racchiuso in try/catch; un errore non arresta il bot
 * né il processo. I limiti di rischio sono verificati prima di ogni apertura.
 */

import client from './hyperliquidClient.js';
import marketData from './marketData.js';
import strategyEngine from './strategyEngine.js';
import riskManager from './riskManager.js';
import portfolio from './portfolio.js';
import notifier from './notifier.js';
import * as ind from './indicators.js';
import db from '../db/database.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

export class PerpsBot {
  constructor(record, onUpdate) {
    this.id = record.id;
    this.name = record.name;
    this.coin = record.coin;
    this.network = record.network;
    this.masterAddress = record.master_address || record.masterAddress;
    this.config = typeof record.config_json === 'string'
      ? JSON.parse(record.config_json)
      : (record.config || {});
    this.onUpdate = onUpdate || (() => {});

    this.status = 'stopped';
    this.timer = null;
    this.busy = false;
    this.lastEval = null;
    this.lastError = null;
    this.dailyPnl = 0;
    this.dailyKey = this._todayKey();

    // Stato posizione locale (riallineato da Hyperliquid a ogni tick)
    this.position = null; // { id, side, size, entryPx, tpPx, slPx, slOid }
    const open = db.getOpenPositionByBot(this.id);
    if (open) {
      this.position = {
        id: open.id, side: open.side, size: open.size, entryPx: open.entry_px,
        tpPx: open.tp_px, slPx: open.sl_px,
        slOid: open.trailing_json ? JSON.parse(open.trailing_json).slOid : null
      };
    }
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  _rolloverDaily() {
    const key = this._todayKey();
    if (key !== this.dailyKey) {
      this.dailyKey = key;
      this.dailyPnl = 0;
    }
  }

  start() {
    if (this.status === 'running') return;
    this.status = 'running';
    db.setBotStatus(this.id, 'running');
    const interval = this.config.loopInterval || HYPERLIQUID_CONFIG.botLoopInterval;
    this.tick(); // primo giro immediato
    this.timer = setInterval(() => this.tick(), interval);
    logger.info(`▶️  Bot avviato: ${this.name} (${this.coin})`, { id: this.id });
    this._emit();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = 'stopped';
    db.setBotStatus(this.id, 'stopped');
    logger.info(`⏹️  Bot fermato: ${this.name}`, { id: this.id });
    this._emit();
  }

  /**
   * Arresto per shutdown del server: ferma il timer SENZA cambiare lo stato
   * persistito, così il bot riparte da solo al prossimo avvio.
   */
  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    this._rolloverDaily();
    try {
      const interval = this.config.candleInterval || '15m';
      const needFunding = (this.config.entryRules || []).some(r => r.type === 'funding')
        || (this.config.exitRules || []).some(r => r.type === 'funding');
      const snapshot = await marketData.getSnapshot(this.coin, { interval, withFunding: needFunding });

      // Riallinea lo stato posizione con Hyperliquid (fonte di verità)
      const account = await client.getAccount(this.masterAddress, this.network);
      const livePos = account.positions.find(p => p.coin === this.coin || `${p.coin}-PERP` === this.coin);
      this._reconcile(livePos);

      const state = { inPosition: !!this.position, side: this.position?.side };
      const decision = strategyEngine.evaluate(this.config, snapshot, state);
      this.lastEval = { ...decision, price: snapshot.price, ts: Date.now() };

      if (this.position) {
        await this._manageOpen(snapshot, account, decision);
      } else if (decision.action === 'open_long' || decision.action === 'open_short') {
        await this._openPosition(decision.action === 'open_long' ? 'long' : 'short', snapshot, account);
      }

      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      logger.error(`Bot ${this.name} tick error`, error.message);
    } finally {
      this.busy = false;
      this._emit();
    }
  }

  /** Allinea this.position con la posizione reale su Hyperliquid. */
  _reconcile(livePos) {
    if (!livePos && this.position) {
      // Posizione chiusa esternamente (TP/SL scattati o chiusura manuale)
      const pnl = this.position.lastUnrealized || 0;
      this._registerClose(pnl, 'chiusa (TP/SL o esterna)');
    } else if (livePos && this.position) {
      this.position.size = livePos.size;
      this.position.lastUnrealized = livePos.unrealizedPnl;
    } else if (livePos && !this.position) {
      // Posizione aperta non tracciata: adottala
      this.position = {
        id: db.insertPosition({
          botId: this.id, coin: this.coin, side: livePos.side,
          size: livePos.size, entryPx: livePos.entryPx, leverage: livePos.leverage
        }),
        side: livePos.side, size: livePos.size, entryPx: livePos.entryPx,
        tpPx: null, slPx: null, slOid: null
      };
    }
  }

  async _openPosition(side, snapshot, account) {
    const market = marketData.getMarkets().find(m => m.coin === this.coin);
    const szDecimals = market?.szDecimals ?? 3;
    const leverage = this.config.leverage || HYPERLIQUID_CONFIG.risk.defaultLeverage;

    const equity = account.equity ?? account.accountValue;
    const plan = riskManager.sizePosition(this.config, equity, snapshot.price, szDecimals);
    plan.leverage = leverage;

    const check = riskManager.checkLimits(this.config, account, plan, this.dailyPnl);
    if (!check.ok) {
      logger.warn(`Bot ${this.name}: apertura bloccata`, check.reason);
      this.lastEval = { action: 'hold', reason: `Bloccato: ${check.reason}`, ts: Date.now() };
      return;
    }
    if (plan.size <= 0) {
      logger.warn(`Bot ${this.name}: size calcolata nulla`);
      return;
    }

    // Conferma multi-timeframe (gate): salta se il TF superiore non concorda
    if (!(await this._mtfConfirm(side))) {
      this.lastEval = { action: 'hold', reason: `Conferma ${this.config.mtfConfirm?.interval} non concorde`, ts: Date.now() };
      return;
    }

    // Limiti di portafoglio (globali): posizioni concorrenti, esposizione, cooldown
    const cl = db.getConsecutiveLosses(this.id);
    const pf = portfolio.canOpen({ account, plannedNotional: plan.notionalUsd, botId: this.id, consecutiveLosses: cl });
    if (!pf.ok) {
      logger.warn(`Bot ${this.name}: apertura bloccata (portafoglio)`, pf.reason);
      this.lastEval = { action: 'hold', reason: `Portafoglio: ${pf.reason}`, ts: Date.now() };
      if (/cooldown/i.test(pf.reason)) notifier.notify(`⏸️ <b>${this.name}</b>: ${pf.reason}`);
      return;
    }

    await client.setLeverage(this.masterAddress, this.coin, leverage,
      this.config.marginMode || 'cross', this.network);

    const isBuy = side === 'long';
    const order = await client.placeMarketOrder({
      masterAddress: this.masterAddress, coin: this.coin, isBuy, size: plan.size,
      slippage: this.config.slippage ?? 0.02
    }, this.network);

    if (order.error) {
      logger.error(`Bot ${this.name}: ordine rifiutato`, order.error);
      return;
    }

    const entryPx = order.avgPx || snapshot.price;
    const { tpPx, slPx } = riskManager.computeTpSl(entryPx, side, this.config);

    const posId = db.insertPosition({
      botId: this.id, coin: this.coin, side, size: plan.size,
      entryPx, leverage, tpPx, slPx
    });
    db.insertTrade({ botId: this.id, coin: this.coin, side, px: entryPx, sz: plan.size, hlOid: order.oid });

    this.position = { id: posId, side, size: plan.size, entryPx, tpPx, slPx, slOid: null };

    // Piazza i trigger TP/SL (reduce-only). Ordine di chiusura: opposto al lato.
    await this._placeTpSl();

    logger.info(`🟢 Bot ${this.name}: aperta ${side} ${plan.size} ${this.coin} @ ${entryPx}`);
    notifier.notify(`🟢 <b>${this.name}</b> ha aperto <b>${side.toUpperCase()}</b> ${plan.size} ${this.coin} @ ${entryPx}\nTP ${tpPx ? tpPx.toFixed(2) : '—'} · SL ${slPx ? slPx.toFixed(2) : '—'}`);
  }

  /** Conferma multi-timeframe: true se il TF superiore concorda col lato (o se disattivata). */
  async _mtfConfirm(side) {
    const mtf = this.config.mtfConfirm;
    if (!mtf || !mtf.interval) return true;
    try {
      const candles = await marketData.getCandles(this.coin, mtf.interval);
      const emaVal = ind.ema(candles, mtf.period || 50);
      const price = candles?.length ? parseFloat(candles[candles.length - 1].c) : null;
      if (emaVal == null || price == null) return true; // dati insufficienti → non bloccare
      return side === 'long' ? price > emaVal : price < emaVal;
    } catch {
      return true;
    }
  }

  async _placeTpSl() {
    if (!this.position) return;
    const closeIsBuy = this.position.side === 'short'; // chiudere short = buy; chiudere long = sell
    try {
      // Take profit: scala parziale se configurata, altrimenti TP singolo
      const ladder = this.config.partialTp;
      if (Array.isArray(ladder) && ladder.length) {
        const steps = riskManager.computeTpLadder(this.position.entryPx, this.position.side, ladder);
        const market = marketData.getMarkets().find(m => m.coin === this.coin);
        const szDec = market?.szDecimals ?? 3;
        for (const st of steps) {
          const sz = riskManager.roundSize(this.position.size * st.portion, szDec);
          if (sz > 0) {
            await client.placeTriggerOrder({
              masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
              size: sz, triggerPx: st.px, tpsl: 'tp'
            }, this.network);
          }
        }
      } else if (this.position.tpPx) {
        await client.placeTriggerOrder({
          masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
          size: this.position.size, triggerPx: this.position.tpPx, tpsl: 'tp'
        }, this.network);
      }
      if (this.position.slPx) {
        const res = await client.placeTriggerOrder({
          masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
          size: this.position.size, triggerPx: this.position.slPx, tpsl: 'sl'
        }, this.network);
        this.position.slOid = res.oid;
        db.updatePosition(this.position.id, { trailing_json: JSON.stringify({ slOid: res.oid }) });
      }
    } catch (error) {
      logger.warn(`Bot ${this.name}: errore piazzamento TP/SL`, error.message);
    }
  }

  async _manageOpen(snapshot, account, decision) {
    // Uscita su segnale strategia
    if (decision.action === 'close') {
      await this._closeNow(decision.reason);
      return;
    }
    // DCA: aggiunge alla posizione su movimento avverso (mediazione del prezzo)
    await this._maybeDca(snapshot);
    // Trailing stop
    const newSl = riskManager.computeTrailing(this.position, snapshot.price, this.config);
    if (newSl != null) {
      const roundedSl = client.roundPx(newSl);
      const closeIsBuy = this.position.side === 'short';
      try {
        if (this.position.slOid) {
          await client.cancelOrder({ masterAddress: this.masterAddress, coin: this.coin, oid: this.position.slOid }, this.network);
        }
        const res = await client.placeTriggerOrder({
          masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
          size: this.position.size, triggerPx: roundedSl, tpsl: 'sl'
        }, this.network);
        this.position.slPx = roundedSl;
        this.position.slOid = res.oid;
        db.updatePosition(this.position.id, { sl_px: roundedSl, trailing_json: JSON.stringify({ slOid: res.oid }) });
        logger.info(`🪤 Bot ${this.name}: trailing stop → ${roundedSl}`);
      } catch (error) {
        logger.debug(`Bot ${this.name}: trailing update fallito`, error.message);
      }
    }
  }

  /** DCA basico: aggiunge alla posizione se il prezzo va contro di una soglia. */
  async _maybeDca(snapshot) {
    const dca = this.config.dca;
    if (!dca || !dca.steps) return;
    const done = this.position.dcaCount || 0;
    if (done >= dca.steps) return;
    const adverse = this.position.side === 'long'
      ? (this.position.entryPx - snapshot.price) / this.position.entryPx
      : (snapshot.price - this.position.entryPx) / this.position.entryPx;
    // Soglia progressiva: step 1 a stepPercent, step 2 a 2×stepPercent, ...
    if (adverse * 100 < dca.stepPercent * (done + 1)) return;
    try {
      const market = marketData.getMarkets().find(m => m.coin === this.coin);
      const szDec = market?.szDecimals ?? 3;
      const addSize = riskManager.roundSize(this.position.size * (dca.sizeMultiplier || 1), szDec);
      if (addSize <= 0) return;
      const order = await client.placeMarketOrder({
        masterAddress: this.masterAddress, coin: this.coin,
        isBuy: this.position.side === 'long', size: addSize, slippage: this.config.slippage ?? 0.02
      }, this.network);
      if (order.error) return;
      this.position.dcaCount = done + 1;
      this.position.size += addSize;
      db.insertTrade({ botId: this.id, coin: this.coin, side: this.position.side, px: order.avgPx || snapshot.price, sz: addSize, hlOid: order.oid });
      logger.info(`➕ Bot ${this.name}: DCA #${this.position.dcaCount} +${addSize} ${this.coin}`);
      notifier.notify(`➕ <b>${this.name}</b>: DCA #${this.position.dcaCount} (+${addSize} ${this.coin})`);
    } catch (error) {
      logger.debug(`Bot ${this.name}: DCA fallito`, error.message);
    }
  }

  async _closeNow(reason) {
    try {
      await client.closePosition({ masterAddress: this.masterAddress, coin: this.coin }, this.network);
      const pnl = this.position?.lastUnrealized || 0;
      this._registerClose(pnl, reason);
      logger.info(`🔴 Bot ${this.name}: posizione chiusa (${reason})`);
    } catch (error) {
      logger.error(`Bot ${this.name}: errore chiusura`, error.message);
    }
  }

  _registerClose(pnl, reason) {
    if (this.position) {
      db.updatePosition(this.position.id, { status: 'closed', pnl, closed_at: Date.now() });
    }
    this.dailyPnl += pnl;
    this.position = null;
    const emoji = pnl >= 0 ? '✅' : '🔻';
    notifier.notify(`🔴 <b>${this.name}</b> ha chiuso (${reason}) — PnL ${emoji} ${pnl.toFixed(2)}$ · giornaliero ${this.dailyPnl.toFixed(2)}$`);
    // Stop automatico se superato il limite di perdita giornaliera
    const maxDailyLoss = this.config.risk?.maxDailyLossUsd ?? HYPERLIQUID_CONFIG.risk.maxDailyLossUsd;
    if (this.dailyPnl <= -Math.abs(maxDailyLoss)) {
      logger.warn(`Bot ${this.name}: limite perdita giornaliera raggiunto, arresto`);
      notifier.notify(`🛑 <b>${this.name}</b>: limite perdita giornaliera raggiunto, bot fermato.`);
      this.stop();
    }
  }

  getState() {
    let stats = null;
    try { stats = db.getBotStats(this.id); } catch { /* noop */ }
    return {
      id: this.id, name: this.name, coin: this.coin, network: this.network,
      status: this.status, inPosition: !!this.position,
      position: this.position, dailyPnl: this.dailyPnl,
      lastEval: this.lastEval, lastError: this.lastError, config: this.config,
      stats
    };
  }

  _emit() {
    try { this.onUpdate(this.getState()); } catch { /* noop */ }
  }
}

export default PerpsBot;
