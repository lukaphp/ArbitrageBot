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

    const plan = riskManager.sizePosition(this.config, account.accountValue, snapshot.price, szDecimals);
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
  }

  async _placeTpSl() {
    if (!this.position) return;
    const closeIsBuy = this.position.side === 'short'; // chiudere short = buy; chiudere long = sell
    try {
      if (this.position.tpPx) {
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
    // Stop automatico se superato il limite di perdita giornaliera
    const maxDailyLoss = this.config.risk?.maxDailyLossUsd ?? HYPERLIQUID_CONFIG.risk.maxDailyLossUsd;
    if (this.dailyPnl <= -Math.abs(maxDailyLoss)) {
      logger.warn(`Bot ${this.name}: limite perdita giornaliera raggiunto, arresto`);
      this.stop();
    }
  }

  getState() {
    return {
      id: this.id, name: this.name, coin: this.coin, network: this.network,
      status: this.status, inPosition: !!this.position,
      position: this.position, dailyPnl: this.dailyPnl,
      lastEval: this.lastEval, lastError: this.lastError, config: this.config
    };
  }

  _emit() {
    try { this.onUpdate(this.getState()); } catch { /* noop */ }
  }
}

export default PerpsBot;
