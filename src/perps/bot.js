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
import paperBroker from './paperBroker.js';
import marketData from './marketData.js';
import strategyEngine from './strategyEngine.js';
import riskManager from './riskManager.js';
import portfolio from './portfolio.js';
import notifier from './notifier.js';
import predictor from './predictor.js';
import * as ind from './indicators.js';
import metrics from './metrics.js';
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

    // Broker di esecuzione: reale (client) o simulato (paperBroker) se paper-mode.
    // I prezzi/segnali restano sempre reali e live; solo l'esecuzione è simulata.
    this.paper = !!this.config.paper;
    this.broker = this.paper ? paperBroker : client;

    this.status = 'stopped';
    this.timer = null;
    this.busy = false;
    this.lastEval = null;
    this.lastError = null;
    this.lastTickAt = 0;       // per il watchdog (rileva bot "fermi")
    this.tickErrors = 0;       // contatore errori di tick (metriche)
    this.dailyKey = this._todayKey();
    // PnL giornaliero PERSISTITO: sopravvive ai riavvii (il limite di perdita
    // giornaliera non riparte da zero dopo un restart a metà giornata).
    this.dailyPnl = db.getDailyPnl(this.id, this.dailyKey);

    // Stato posizione locale (riallineato da Hyperliquid a ogni tick)
    this.position = null; // { id, side, size, entryPx, originalEntryPx, dcaCount, tpPx, slPx, slOid, openedAt }
    const open = db.getOpenPositionByBot(this.id);
    if (open) {
      const trailing = open.trailing_json ? JSON.parse(open.trailing_json) : {};
      this.position = {
        id: open.id, side: open.side, size: open.size, entryPx: open.entry_px,
        // originalEntryPx: retrocompat per posizioni aperte prima di SEC-01 (mai
        // scritto in DB) → ripiega su entry_px, corretto finché non c'è stata
        // ancora nessuna DCA (dopo la prima, il valore vero è persistito qui).
        originalEntryPx: trailing.originalEntryPx ?? open.entry_px,
        dcaCount: trailing.dcaCount || 0,
        tpPx: open.tp_px, slPx: open.sl_px, openedAt: open.opened_at,
        slOid: trailing.slOid || null
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
      // Nuovo giorno: ricarica l'eventuale valore persistito (di norma 0).
      this.dailyPnl = db.getDailyPnl(this.id, key);
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
      const account = await this.broker.getAccount(this.masterAddress, this.network);
      const livePos = account.positions.find(p => p.coin === this.coin || `${p.coin}-PERP` === this.coin);
      await this._reconcile(livePos);

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
      this.tickErrors++;
      metrics.inc('tick_errors_total');
      logger.error(`Bot ${this.name} tick error`, error.message);
    } finally {
      this.lastTickAt = Date.now();
      this.busy = false;
      this._emit();
    }
  }

  /** Allinea this.position con la posizione reale su Hyperliquid. */
  async _reconcile(livePos) {
    if (!livePos && this.position) {
      // Posizione chiusa esternamente (TP/SL scattati o chiusura manuale)
      await this._registerClose('chiusa (TP/SL o esterna)', this.position.lastUnrealized || 0);
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
        tpPx: null, slPx: null, slOid: null, openedAt: Date.now()
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

    // Gate ML (opzionale): apre solo se il modello concorda con la direzione
    if (!(await this._mlConfirm(side))) {
      this.lastEval = { action: 'hold', reason: 'Gate ML: probabilità non favorevole alla direzione', ts: Date.now() };
      return;
    }

    // Cooldown per-strategia: dopo N perdite consecutive, pausa di M minuti
    // dall'ultima chiusura prima di poter riaprire (evita re-entry impulsivi).
    const cd = this._cooldownBlock();
    if (cd) {
      this.lastEval = { action: 'hold', reason: cd, ts: Date.now() };
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

    await this.broker.setLeverage(this.masterAddress, this.coin, leverage,
      this.config.marginMode || 'cross', this.network);

    const isBuy = side === 'long';
    const order = await this.broker.placeMarketOrder({
      masterAddress: this.masterAddress, coin: this.coin, isBuy, size: plan.size,
      slippage: this.config.slippage ?? 0.02
    }, this.network);

    if (order.error) {
      logger.error(`Bot ${this.name}: ordine rifiutato`, order.error);
      return;
    }

    const entryPx = order.avgPx || snapshot.price;
    // ATR corrente per gli stop adattivi (mode 'atr'); null se non configurati.
    const atrVal = this._usesAtr() ? ind.atr(snapshot.candles, this.config.atrPeriod || 14) : null;
    const { tpPx, slPx } = riskManager.computeTpSl(entryPx, side, this.config, { atr: atrVal });

    const posId = db.insertPosition({
      botId: this.id, coin: this.coin, side, size: plan.size,
      entryPx, leverage, tpPx, slPx
    });
    db.insertTrade({ botId: this.id, coin: this.coin, side, px: entryPx, sz: plan.size, hlOid: order.oid });

    this.position = {
      id: posId, side, size: plan.size, entryPx,
      originalEntryPx: entryPx, // immutabile: riferimento per le soglie progressive del DCA (mai il prezzo medio)
      dcaCount: 0,
      tpPx, slPx, slOid: null, openedAt: Date.now()
    };

    // Piazza i trigger TP/SL (reduce-only). Ordine di chiusura: opposto al lato.
    await this._placeTpSl();
    // Garanzia: nessuna posizione resta senza stop loss (chiude se non riesce a piazzarlo).
    await this._ensureStopLoss();

    logger.info(`🟢 Bot ${this.name}: aperta ${side} ${plan.size} ${this.coin} @ ${entryPx}`);
    notifier.notify(`🟢 <b>${this.name}</b> ha aperto <b>${side.toUpperCase()}</b> ${plan.size} ${this.coin} @ ${entryPx}\nTP ${tpPx ? tpPx.toFixed(2) : '—'} · SL ${slPx ? slPx.toFixed(2) : '—'}`);
  }

  /** True se la strategia usa stop/trailing ATR (per calcolare l'ATR solo se serve). */
  _usesAtr() {
    const c = this.config;
    return c.sl?.mode === 'atr' || c.tp?.mode === 'atr' || c.trailing?.mode === 'atr';
  }

  /**
   * Cooldown per-strategia: se le ultime `afterLosses` chiusure sono perdite e
   * l'ultima è avvenuta da meno di `minutes`, blocca l'apertura. Ritorna la
   * motivazione (stringa) se bloccato, altrimenti null.
   */
  _cooldownBlock() {
    const cd = this.config.cooldown;
    if (!cd || !cd.minutes) return null;
    const afterLosses = cd.afterLosses || 1;
    if (db.getConsecutiveLosses(this.id) < afterLosses) return null;
    const last = db.getOpenPositionByBot(this.id); // null se flat
    if (last) return null;
    const lastClosed = db.lastClosedAt(this.id);
    if (!lastClosed) return null;
    const elapsedMin = (Date.now() - lastClosed) / 60000;
    if (elapsedMin >= cd.minutes) return null;
    const left = Math.ceil(cd.minutes - elapsedMin);
    return `Cooldown post-perdite: riapertura tra ~${left} min`;
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

  /** Gate ML: true se il modello concorda col lato (o se disattivato/senza edge). */
  async _mlConfirm(side) {
    const gate = this.config.mlGate;
    if (!gate || !gate.enabled) return true;
    try {
      const interval = gate.interval || this.config.candleInterval || '15m';
      const minProb = gate.minProb ?? 0.55;
      const res = await predictor.predict(this.coin, interval);
      if (res.error || res.probUp == null) return true; // modello assente/errore → non bloccare
      // Se il modello non ha edge sopra la baseline, non filtrare (onestà)
      if (res.hasEdge === false) return true;
      return side === 'long' ? res.probUp >= minProb : res.probUp <= (1 - minProb);
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
            await this.broker.placeTriggerOrder({
              masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
              size: sz, triggerPx: st.px, tpsl: 'tp'
            }, this.network);
          }
        }
      } else if (this.position.tpPx) {
        await this.broker.placeTriggerOrder({
          masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
          size: this.position.size, triggerPx: this.position.tpPx, tpsl: 'tp'
        }, this.network);
      }
      if (this.position.slPx) {
        const res = await this.broker.placeTriggerOrder({
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

  /** Trova l'ordine SL (trigger reduce-only) attivo per questa posizione, se c'è. */
  async _findStopOrder() {
    const orders = await this.broker.getFrontendOpenOrders(this.masterAddress, this.network);
    const sameCoin = o => o.coin === this.coin || `${o.coin}-PERP` === this.coin || o.coin === this.coin.replace('-PERP', '');
    return (orders || []).find(o => sameCoin(o) && o.isTrigger && /stop/i.test(o.orderType || '')) || null;
  }

  /** Trova gli ordini TP (trigger reduce-only, non-stop) attivi per questa posizione — può essere più di uno con partialTp. */
  async _findTpOrders() {
    const orders = await this.broker.getFrontendOpenOrders(this.masterAddress, this.network);
    const sameCoin = o => o.coin === this.coin || `${o.coin}-PERP` === this.coin || o.coin === this.coin.replace('-PERP', '');
    return (orders || []).filter(o => sameCoin(o) && o.isTrigger && !/stop/i.test(o.orderType || ''));
  }

  /**
   * GARANZIA DI PROTEZIONE: verifica che esista uno stop loss attivo sul book.
   * Se manca (ordine fallito, crash tra fill e trigger, cancellazione) prova a
   * ripiazzarlo; se ancora assente CHIUDE la posizione per non lasciarla nuda.
   * No-op se la strategia non prevede SL.
   */
  async _ensureStopLoss() {
    if (!this.position || !this.position.slPx) return;
    try {
      let stop = await this._findStopOrder();
      if (stop) { this.position.slOid = stop.oid; return; }

      // SL assente: tentativo di ripiazzamento immediato.
      logger.warn(`Bot ${this.name}: stop loss assente, ripiazzo…`);
      const closeIsBuy = this.position.side === 'short';
      const res = await this.broker.placeTriggerOrder({
        masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
        size: this.position.size, triggerPx: this.position.slPx, tpsl: 'sl'
      }, this.network);
      this.position.slOid = res.oid;
      db.updatePosition(this.position.id, { trailing_json: JSON.stringify({ slOid: res.oid }) });

      // Verifica finale: se ancora non c'è, chiusura di sicurezza.
      stop = await this._findStopOrder();
      if (!stop && !res.oid) {
        logger.error(`Bot ${this.name}: impossibile garantire lo stop loss, chiusura di sicurezza`);
        notifier.notify(`⚠️ <b>${this.name}</b>: stop loss non piazzabile su ${this.coin} → chiudo la posizione per sicurezza.`);
        await this._closeNow('SL non garantito (chiusura di sicurezza)');
      }
    } catch (error) {
      logger.error(`Bot ${this.name}: errore verifica stop loss`, error.message);
      // In caso di errore irriducibile, è più prudente chiudere che restare nudi.
      try {
        notifier.notify(`⚠️ <b>${this.name}</b>: errore nel garantire lo stop loss → chiudo la posizione.`);
        await this._closeNow('errore verifica SL (chiusura di sicurezza)');
      } catch { /* noop */ }
    }
  }

  async _manageOpen(snapshot, account, decision) {
    // Uscita su segnale strategia
    if (decision.action === 'close') {
      await this._closeNow(decision.reason);
      return;
    }
    // Guardia continua: assicura che lo stop loss sia attivo a ogni tick.
    await this._ensureStopLoss();
    if (!this.position) return; // _ensureStopLoss può aver chiuso per sicurezza
    // DCA: aggiunge alla posizione su movimento avverso (mediazione del prezzo)
    await this._maybeDca(snapshot);
    // Trailing stop — PLACE-THEN-CANCEL: piazza il nuovo trigger PRIMA di
    // cancellare il vecchio, così non esiste mai una finestra senza SL.
    const atrVal = this._usesAtr() ? ind.atr(snapshot.candles, this.config.atrPeriod || 14) : null;
    const newSl = riskManager.computeTrailing(this.position, snapshot.price, this.config, { atr: atrVal });
    if (newSl != null) {
      const roundedSl = client.roundPx(newSl);
      const closeIsBuy = this.position.side === 'short';
      try {
        const res = await this.broker.placeTriggerOrder({
          masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
          size: this.position.size, triggerPx: roundedSl, tpsl: 'sl'
        }, this.network);
        const oldOid = this.position.slOid;
        this.position.slPx = roundedSl;
        this.position.slOid = res.oid;
        db.updatePosition(this.position.id, { sl_px: roundedSl, trailing_json: JSON.stringify({ slOid: res.oid }) });
        // Solo ora rimuovo il vecchio SL (se diverso da quello nuovo).
        if (oldOid && res.oid && oldOid !== res.oid) {
          await this.broker.cancelOrder({ masterAddress: this.masterAddress, coin: this.coin, oid: oldOid }, this.network).catch(() => {});
        }
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
    // Soglia progressiva calcolata SEMPRE sull'ingresso ORIGINALE (immutabile),
    // MAI sul prezzo medio aggiornato dopo una mediazione: se usassimo il
    // prezzo medio, ogni aggiunta DCA sposterebbe in avanti il riferimento e
    // gli step successivi scatterebbero sempre più vicini tra loro (si
    // "comprimono"), invece di restare distanziati come da configurazione.
    const originalEntry = this.position.originalEntryPx ?? this.position.entryPx;
    const adverse = this.position.side === 'long'
      ? (originalEntry - snapshot.price) / originalEntry
      : (snapshot.price - originalEntry) / originalEntry;
    // Soglia progressiva: step 1 a stepPercent, step 2 a 2×stepPercent, ...
    if (adverse * 100 < dca.stepPercent * (done + 1)) return;
    try {
      const market = marketData.getMarkets().find(m => m.coin === this.coin);
      const szDec = market?.szDecimals ?? 3;
      const addSize = riskManager.roundSize(this.position.size * (dca.sizeMultiplier || 1), szDec);
      if (addSize <= 0) return;
      const order = await this.broker.placeMarketOrder({
        masterAddress: this.masterAddress, coin: this.coin,
        isBuy: this.position.side === 'long', size: addSize, slippage: this.config.slippage ?? 0.02
      }, this.network);
      if (order.error) return;

      const fillPx = order.avgPx || snapshot.price;
      // Prezzo medio ponderato + TP/SL ricalcolati sul nuovo entry (stessa
      // modalità percent/atr già configurata) — calcolo puro, testato in
      // isolamento in test/riskManager.test.js.
      const atrVal = this._usesAtr() ? ind.atr(snapshot.candles, this.config.atrPeriod || 14) : null;
      const updated = riskManager.applyDcaFill(this.position, fillPx, addSize, this.config, { atr: atrVal });

      this.position.dcaCount = done + 1;
      this.position.entryPx = updated.entryPx;
      this.position.size = updated.size;

      db.insertTrade({ botId: this.id, coin: this.coin, side: this.position.side, px: fillPx, sz: addSize, hlOid: order.oid });
      logger.info(`➕ Bot ${this.name}: DCA #${this.position.dcaCount} +${addSize} ${this.coin} → nuovo entry medio ${updated.entryPx.toFixed(4)}`);
      notifier.notify(`➕ <b>${this.name}</b>: DCA #${this.position.dcaCount} (+${addSize} ${this.coin}) — entry medio ${updated.entryPx.toFixed(4)}`);

      // TP/SL erano dimensionati sulla size PRECEDENTE: senza ri-piazzarli
      // sulla size totale aggiornata, la parte aggiunta con questa DCA
      // resterebbe scoperta da qualunque protezione.
      await this._repriceTpSlAfterDca(updated.tpPx, updated.slPx);
    } catch (error) {
      logger.debug(`Bot ${this.name}: DCA fallito`, error.message);
    }
  }

  /**
   * Ri-piazza TP/SL con la size e i prezzi già ricalcolati (da
   * riskManager.applyDcaFill) dopo un'aggiunta DCA. Segue la STESSA sequenza
   * PLACE-THEN-CANCEL già usata dal trailing stop qui sotto: i nuovi trigger
   * vengono piazzati PRIMA di cancellare i vecchi, così la posizione non
   * resta mai scoperta nemmeno per un istante.
   * Se il ri-piazzamento fallisce, i vecchi trigger (dimensionati sulla size
   * precedente) restano intatti — meglio una protezione parziale che nessuna
   * — e l'errore è loggato E notificato via Telegram, mai in silenzio.
   */
  async _repriceTpSlAfterDca(tpPx, slPx) {
    if (!this.position) return;
    const closeIsBuy = this.position.side === 'short';
    try {
      const oldTpOrders = await this._findTpOrders();
      const oldSlOid = this.position.slOid;

      // 1) PLACE: nuovi trigger sulla size totale aggiornata.
      const ladder = this.config.partialTp;
      if (Array.isArray(ladder) && ladder.length) {
        const steps = riskManager.computeTpLadder(this.position.entryPx, this.position.side, ladder);
        const market = marketData.getMarkets().find(m => m.coin === this.coin);
        const szDec = market?.szDecimals ?? 3;
        for (const st of steps) {
          const sz = riskManager.roundSize(this.position.size * st.portion, szDec);
          if (sz > 0) {
            await this.broker.placeTriggerOrder({
              masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
              size: sz, triggerPx: st.px, tpsl: 'tp'
            }, this.network);
          }
        }
      } else if (tpPx) {
        await this.broker.placeTriggerOrder({
          masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
          size: this.position.size, triggerPx: tpPx, tpsl: 'tp'
        }, this.network);
      }

      let newSlOid = null;
      if (slPx) {
        const res = await this.broker.placeTriggerOrder({
          masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
          size: this.position.size, triggerPx: slPx, tpsl: 'sl'
        }, this.network);
        newSlOid = res.oid;
      }

      // 2) Stato/DB aggiornati SUBITO dopo il piazzamento (ancora prima di
      // cancellare i vecchi trigger): da qui in poi la posizione è coperta
      // dai nuovi trigger, non più da quelli vecchi.
      this.position.tpPx = tpPx;
      this.position.slPx = slPx;
      this.position.slOid = newSlOid;
      db.updatePosition(this.position.id, {
        entry_px: this.position.entryPx, size: this.position.size, tp_px: tpPx, sl_px: slPx,
        trailing_json: JSON.stringify({
          slOid: newSlOid, originalEntryPx: this.position.originalEntryPx, dcaCount: this.position.dcaCount
        })
      });

      // 3) CANCEL: solo ora rimuovo i vecchi trigger (mai prima del punto 1-2).
      for (const o of oldTpOrders) {
        await this.broker.cancelOrder({ masterAddress: this.masterAddress, coin: this.coin, oid: o.oid }, this.network).catch(() => {});
      }
      if (oldSlOid && oldSlOid !== newSlOid) {
        await this.broker.cancelOrder({ masterAddress: this.masterAddress, coin: this.coin, oid: oldSlOid }, this.network).catch(() => {});
      }

      logger.info(`🎯 Bot ${this.name}: TP/SL ri-piazzati dopo DCA → size ${this.position.size} @ entry medio ${this.position.entryPx.toFixed(4)} (TP ${tpPx ?? '—'} · SL ${slPx ?? '—'})`);
    } catch (error) {
      logger.error(`Bot ${this.name}: ri-piazzamento TP/SL dopo DCA fallito`, error.message);
      notifier.notify(`⚠️ <b>${this.name}</b>: ri-piazzamento TP/SL dopo DCA fallito su ${this.coin} — la size aggiunta potrebbe non essere protetta, verificare manualmente i trigger attivi.`);
    }
  }

  async _closeNow(reason) {
    try {
      await this.broker.closePosition({ masterAddress: this.masterAddress, coin: this.coin }, this.network);
      await this._registerClose(reason, this.position?.lastUnrealized || 0);
      logger.info(`🔴 Bot ${this.name}: posizione chiusa (${reason})`);
    } catch (error) {
      logger.error(`Bot ${this.name}: errore chiusura`, error.message);
    }
  }

  /**
   * Registra la chiusura di una posizione usando il PnL REALE dai fill
   * (closedPnl − fee), non l'unrealized dell'ultimo tick. Se i fill di chiusura
   * non sono ancora visibili, ripiega su `fallbackPnl` (l'unrealized noto).
   */
  async _registerClose(reason, fallbackPnl = 0) {
    if (!this.position) return;
    const openedAt = this.position.openedAt;
    let net = fallbackPnl;
    let fee = 0;
    try {
      const real = await this.broker.getRealizedPnl(this.masterAddress, this.coin, openedAt, this.network);
      if (real) { net = real.net; fee = real.fee; }
    } catch (e) {
      logger.debug(`Bot ${this.name}: PnL reale non disponibile, uso fallback`, e.message);
    }

    db.updatePosition(this.position.id, {
      status: 'closed', pnl: net, fee, close_reason: reason, closed_at: Date.now()
    });

    // Aggiorna e PERSISTE il PnL giornaliero (sopravvive ai riavvii).
    this.dailyPnl += net;
    db.setDailyPnl(this.id, this.dailyKey, this.dailyPnl);
    this.position = null;

    const emoji = net >= 0 ? '✅' : '🔻';
    const feeStr = fee ? ` · fee ${fee.toFixed(2)}$` : '';
    notifier.notify(`🔴 <b>${this.name}</b> ha chiuso (${reason}) — PnL ${emoji} ${net.toFixed(2)}$${feeStr} · giornaliero ${this.dailyPnl.toFixed(2)}$`);

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
      status: this.status, inPosition: !!this.position, paper: this.paper,
      position: this.position, dailyPnl: this.dailyPnl,
      lastEval: this.lastEval, lastError: this.lastError, config: this.config,
      lastTickAt: this.lastTickAt, tickErrors: this.tickErrors,
      stats
    };
  }

  /**
   * Diagnostica live: cosa sta "guardando" il bot in questo momento e quanto
   * manca a far scattare un ingresso. Serve per capire perché è fermo.
   */
  async getMonitor() {
    const interval = this.config.candleInterval || '15m';
    const needFunding = [...(this.config.entryRules || []), ...(this.config.exitRules || [])].some(r => r.type === 'funding');
    let snapshot;
    try {
      snapshot = await marketData.getSnapshot(this.coin, { interval, withFunding: needFunding });
    } catch {
      snapshot = { price: marketData.getMid(this.coin), candles: [], funding: null };
    }
    const ctx = { price: snapshot.price, candles: snapshot.candles || [], funding: snapshot.funding };

    return {
      id: this.id, name: this.name, coin: this.coin, interval,
      status: this.status, direction: this.config.direction || 'both',
      logic: this.config.logic || 'any',
      price: snapshot.price, funding: snapshot.funding,
      candles: ctx.candles.length,
      inPosition: !!this.position,
      position: this.position ? {
        side: this.position.side, size: this.position.size, entryPx: this.position.entryPx,
        tpPx: this.position.tpPx, slPx: this.position.slPx
      } : null,
      dailyPnl: this.dailyPnl,
      lastEval: this.lastEval,
      lastError: this.lastError,
      entryRules: (this.config.entryRules || []).map(r => this._diagRule(r, ctx)),
      exitRules: (this.config.exitRules || []).map(r => this._diagRule(r, ctx)),
      gates: {
        mtf: this.config.mtfConfirm?.interval ? { interval: this.config.mtfConfirm.interval, period: this.config.mtfConfirm.period || 50 } : null,
        ml: this.config.mlGate?.enabled ? { interval: this.config.mlGate.interval || interval, minProb: this.config.mlGate.minProb ?? 0.55 } : null,
        partialTp: !!(this.config.partialTp && this.config.partialTp.length),
        dca: !!this.config.dca
      },
      loopIntervalMs: HYPERLIQUID_CONFIG.botLoopInterval,
      ts: Date.now()
    };
  }

  /** Diagnostica di una singola regola: valore corrente, condizione, distanza. */
  _diagRule(rule, ctx) {
    const { price, candles, funding } = ctx;
    const num = n => (n == null || isNaN(n)) ? null : n;
    const fmt = n => n == null ? '—' : (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
    const cmp = (a, op, b) => {
      if (a == null || isNaN(a)) return null;
      return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : op === '==' ? a === b : null;
    };
    const gapHint = (cur, op, target, unit = '') => {
      if (cur == null) return 'dato non ancora disponibile';
      if (cmp(cur, op, target)) return '✅ condizione soddisfatta';
      const verso = (op === '<' || op === '<=') ? 'scendere' : 'salire';
      return `deve ${verso} di ${fmt(Math.abs(cur - target))}${unit} (ora ${fmt(cur)}${unit}, soglia ${fmt(target)}${unit})`;
    };

    const base = { type: rule.type, signal: rule.signal };

    if (rule.type === 'price') {
      const met = cmp(price, rule.op, rule.value);
      return { ...base, label: 'Prezzo', current: fmt(price), target: `${rule.op} ${fmt(rule.value)}`, met: !!met, hint: gapHint(price, rule.op, rule.value, '$') };
    }
    if (rule.type === 'funding') {
      const met = cmp(funding, rule.op, rule.value);
      return { ...base, label: 'Funding', current: funding == null ? '—' : (funding * 100).toFixed(4) + '%', target: `${rule.op} ${rule.value}`, met: !!met, hint: gapHint(funding, rule.op, rule.value) };
    }
    if (rule.type === 'external') {
      return { ...base, label: 'Segnale esterno', current: '—', target: `webhook '${rule.signal}'`, met: false, hint: 'in attesa di un segnale webhook' };
    }
    if (rule.type === 'indicator') {
      const p = rule.period;
      switch (rule.indicator) {
        case 'rsi': {
          const v = num(ind.rsi(candles, p || 14));
          const met = cmp(v, rule.op, rule.value);
          return { ...base, label: `RSI(${p || 14})`, current: fmt(v), target: `${rule.op} ${rule.value}`, met: !!met, hint: gapHint(v, rule.op, rule.value, ' pt') };
        }
        case 'adx': {
          const v = num(ind.adx(candles, p || 14));
          const met = cmp(v, rule.op, rule.value);
          return { ...base, label: `ADX(${p || 14})`, current: fmt(v), target: `${rule.op} ${rule.value}`, met: !!met, hint: gapHint(v, rule.op, rule.value, ' pt') };
        }
        case 'ema':
        case 'sma': {
          const fn = rule.indicator === 'ema' ? ind.ema : ind.sma;
          const v = num(fn(candles, p || 20));
          if (rule.compareToPrice) {
            const met = cmp(price, rule.op, v);
            return { ...base, label: `Prezzo vs ${rule.indicator.toUpperCase()}(${p || 20})`, current: `${fmt(price)} vs ${fmt(v)}`, target: `prezzo ${rule.op} media`, met: !!met, hint: v == null ? 'dato non disponibile' : (met ? '✅ condizione soddisfatta' : `il prezzo deve ${rule.op === '>' ? 'superare' : 'scendere sotto'} ${fmt(v)} (ora ${fmt(price)})`) };
          }
          const met = cmp(v, rule.op, rule.value);
          return { ...base, label: `${rule.indicator.toUpperCase()}(${p || 20})`, current: fmt(v), target: `${rule.op} ${fmt(rule.value)}`, met: !!met, hint: gapHint(v, rule.op, rule.value) };
        }
        case 'macd': {
          const m = ind.macd(candles, rule.params);
          const hist = m ? num(m.histogram) : null;
          const met = rule.cond === 'bearish' ? (hist != null && hist < 0) : (hist != null && hist > 0);
          return { ...base, label: 'MACD', current: hist == null ? '—' : `hist ${fmt(hist)}`, target: rule.cond === 'bearish' ? 'istogramma < 0' : 'istogramma > 0', met, hint: hist == null ? 'dato non disponibile' : (met ? '✅ condizione soddisfatta' : `istogramma ${fmt(hist)} deve diventare ${rule.cond === 'bearish' ? 'negativo' : 'positivo'}`) };
        }
        case 'bollinger': {
          const bb = ind.bollinger(candles, rule.params);
          if (!bb) return { ...base, label: 'Bollinger', current: '—', target: rule.cond, met: false, hint: 'dato non disponibile' };
          const met = rule.cond === 'above_upper' ? price > bb.upper : price < bb.lower;
          const band = rule.cond === 'above_upper' ? bb.upper : bb.lower;
          return { ...base, label: 'Bollinger', current: `prezzo ${fmt(price)}`, target: rule.cond === 'above_upper' ? `> banda sup ${fmt(bb.upper)}` : `< banda inf ${fmt(bb.lower)}`, met, hint: met ? '✅ condizione soddisfatta' : `il prezzo deve ${rule.cond === 'above_upper' ? 'superare' : 'scendere sotto'} ${fmt(band)} (ora ${fmt(price)})` };
        }
        default:
          return { ...base, label: rule.indicator || 'indicatore', current: '—', target: '—', met: false, hint: 'tipo non riconosciuto' };
      }
    }
    return { ...base, label: rule.type, current: '—', target: '—', met: false, hint: '' };
  }

  _emit() {
    try { this.onUpdate(this.getState()); } catch { /* noop */ }
  }
}

export default PerpsBot;
