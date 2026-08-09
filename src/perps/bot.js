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
    this._lastCooldownNotifyUntil = null; // episodio di cooldown già notificato (una notifica per episodio, non per tick)
    this.dailyKey = this._todayKey();
    // PnL giornaliero PERSISTITO: sopravvive ai riavvii (il limite di perdita
    // giornaliera non riparte da zero dopo un restart a metà giornata).
    this.dailyPnl = db.getDailyPnl(this.id, this.dailyKey);

    // Stato posizione locale (riallineato da Hyperliquid a ogni tick)
    this.position = null; // { id, side, size, entryPx, originalEntryPx, dcaCount, tpPx, slPx, slOid, openedAt }

    // SEC-08: true mentre `_openPosition` sta piazzando l'ordine di mercato.
    // Tra il fill sull'exchange e l'assegnazione di `this.position` la posizione
    // è già "live" ma non ancora tracciata in memoria: senza questo flag
    // `_reconcile` la leggerebbe come posizione estranea da adottare.
    this._opening = false;

    const open = db.getOpenPositionByBot(this.id);
    if (open) this.position = this._hydratePosition(open);
  }

  /**
   * Costruisce lo stato posizione in memoria da una riga `positions`.
   *
   * Unico punto di conversione riga-DB → `this.position`: lo usano sia il
   * costruttore (riavvio del processo) sia `_reconcile` quando ritrova una riga
   * aperta già esistente (SEC-08). Averne due copie divergenti significherebbe
   * che dopo un riavvio il bot gestisce una posizione con campi diversi da
   * quelli con cui l'ha adottata.
   */
  _hydratePosition(row) {
    const trailing = row.trailing_json ? JSON.parse(row.trailing_json) : {};
    return {
      id: row.id, side: row.side, size: row.size, entryPx: row.entry_px,
      // originalEntryPx: retrocompat per posizioni aperte prima di SEC-01 (mai
      // scritto in DB) → ripiega su entry_px, corretto finché non c'è stata
      // ancora nessuna DCA (dopo la prima, il valore vero è persistito qui).
      originalEntryPx: trailing.originalEntryPx ?? row.entry_px,
      dcaCount: trailing.dcaCount || 0,
      tpPx: row.tp_px, slPx: row.sl_px, openedAt: row.opened_at,
      slOid: trailing.slOid || null
    };
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
      await this._reconcile(livePos, snapshot);

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

  /**
   * Allinea this.position con la posizione reale su Hyperliquid.
   *
   * SEC-08 — "non tracciata" non è la stessa cosa di "non in memoria".
   * La versione precedente trattava OGNI posizione live senza `this.position`
   * come estranea e ne inseriva una nuova riga in `positions` con `tp_px`/`sl_px`
   * nulli. Ma la posizione può essere già del bot e già registrata, e la memoria
   * essere vuota solo temporaneamente:
   *
   *  1. `_openPosition` è a metà: l'ordine di mercato si è riempito (posizione
   *     già live sull'exchange) ma `this.position` non è ancora assegnato → il
   *     flag `_opening`;
   *  2. l'istanza in memoria è stata sostituita mentre un tick era in volo
   *     (`botManager.updateBot` costruisce un nuovo PerpsBot senza attendere il
   *     tick precedente): la nuova istanza nasce con `position = null` e la riga
   *     in DB compare subito dopo → il controllo sulla riga `open` in DB.
   *
   * Il risultato osservato sul VPS il 9 agosto era due righe in `positions` per
   * una sola posizione da 1.31 SOL e tre trigger reduce-only vivi sull'exchange.
   * L'adozione legittima (posizione aperta a mano, o ritrovata al riavvio senza
   * stato locale) resta: qui si distingue il caso, non si rimuove la funzione.
   *
   * @param snapshot passato solo per l'ATR degli stop adattivi di una posizione adottata.
   */
  async _reconcile(livePos, snapshot = null) {
    if (!livePos && this.position) {
      // Posizione chiusa esternamente (TP/SL scattati o chiusura manuale)
      await this._registerClose('chiusa (TP/SL o esterna)', this.position.lastUnrealized || 0);
    } else if (livePos && this.position) {
      this.position.size = livePos.size;
      this.position.lastUnrealized = livePos.unrealizedPnl;
    } else if (livePos && !this.position) {
      // (1) Apertura in corso in questa stessa istanza: la posizione live è
      // quella che stiamo aprendo noi. Lo stato lo scrive `_openPosition`.
      if (this._opening) {
        logger.debug(`Bot ${this.name}: posizione live durante un'apertura in corso, adozione saltata`);
        return;
      }

      // (2) Riga aperta già presente in DB per questo bot+coin: la posizione è
      // già tracciata, manca solo lo stato in memoria → si RIPRENDE quella riga,
      // non se ne crea una seconda. Il controllo e l'eventuale INSERT stanno
      // dentro un singolo metodo sincrono del DB (vedi insertPositionIfNoneOpen).
      const { id, created, row } = db.insertPositionIfNoneOpen({
        botId: this.id, coin: this.coin, side: livePos.side,
        size: livePos.size, entryPx: livePos.entryPx, leverage: livePos.leverage
      });

      if (!created) {
        this.position = this._hydratePosition(row);
        this.position.size = livePos.size;           // l'exchange è la fonte di verità sulla size
        this.position.lastUnrealized = livePos.unrealizedPnl;
        if (this.position.entryPx == null) this.position.entryPx = livePos.entryPx;
        // Non è un errore silenziabile: significa che la finestra di race si è
        // aperta davvero. Loggato E notificato — una sola volta per episodio,
        // perché dal tick successivo si passa dal ramo di semplice sync.
        logger.warn(`Bot ${this.name}: posizione live già tracciata dalla riga #${id} (entry DB ${this.position.entryPx} · entry live ${livePos.entryPx}), riprendo quella invece di duplicarla`);
        notifier.notify(`ℹ️ <b>${this.name}</b>: stato posizione ${this.coin} riagganciato alla riga esistente #${id} (nessun duplicato creato). Verificare che TP/SL attivi siano uno solo per tipo.`);
        // La protezione viene comunque garantita dal giro di `_manageOpen`
        // (`_ensureStopLoss`) di questo stesso tick.
        return;
      }

      // (3) Adozione legittima: nessuna riga aperta, nessuna apertura in corso.
      // Posizione aperta a mano fuori dal bot, o ritrovata dopo un riavvio senza
      // stato locale. Riceve TP/SL PROPRI: senza, resterebbe con tp_px/sl_px
      // nulli e protetta solo da eventuali trigger preesistenti (il difetto che
      // ha prodotto la riga orfana sul VPS).
      const atrVal = this._usesAtr() ? ind.atr(snapshot?.candles || [], this.config.atrPeriod || 14) : null;
      const { tpPx, slPx } = riskManager.computeTpSl(livePos.entryPx, livePos.side, this.config, { atr: atrVal });
      this.position = {
        id, side: livePos.side, size: livePos.size, entryPx: livePos.entryPx,
        originalEntryPx: livePos.entryPx, dcaCount: 0,
        tpPx, slPx, slOid: null, openedAt: Date.now(),
        lastUnrealized: livePos.unrealizedPnl
      };
      db.updatePosition(id, { tp_px: tpPx, sl_px: slPx, trailing_json: this._trailingJson() });

      logger.warn(`Bot ${this.name}: adottata posizione non tracciata ${livePos.side} ${livePos.size} ${this.coin} @ ${livePos.entryPx} (riga #${id})`);
      notifier.notify(`🔎 <b>${this.name}</b>: adottata posizione non tracciata <b>${String(livePos.side).toUpperCase()}</b> ${livePos.size} ${this.coin} @ ${livePos.entryPx}\nTP ${tpPx ? tpPx.toFixed(2) : '—'} · SL ${slPx ? slPx.toFixed(2) : '—'}`);

      // Piazza TP/SL e cancella eventuali trigger preesistenti (place-then-cancel):
      // una posizione adottata può portarsi dietro ordini stale di chi l'ha aperta.
      await this._replaceTpSl(tpPx, slPx, 'adozione posizione non tracciata');
      await this._ensureStopLoss();
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
      // Una notifica per EPISODIO di cooldown, non per tick: senza `cooldownUntil`
      // a distinguere un episodio dal successivo, un bot in cooldown per un'ora
      // intera con un tick ogni pochi secondi manda la stessa notifica a raffica
      // (incidente reale, 9-10 agosto — l'utente ha dovuto chiudere tutto per
      // fermare il flusso). Stesso principio già applicato al watchdog WS (WS-01).
      if (pf.cooldownUntil && pf.cooldownUntil !== this._lastCooldownNotifyUntil) {
        this._lastCooldownNotifyUntil = pf.cooldownUntil;
        notifier.notify(`⏸️ <b>${this.name}</b>: ${pf.reason}`);
      }
      return;
    }

    // SEC-08: da qui in poi la posizione può esistere sull'exchange senza essere
    // ancora in `this.position`. Il flag copre l'intera finestra (leva → fill →
    // riga in DB → stato in memoria → trigger) e viene azzerato nel `finally`
    // anche se l'apertura fallisce a metà: se restasse alzato, `_reconcile` non
    // adotterebbe più nessuna posizione per il resto della vita del processo.
    this._opening = true;
    try {
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

      // SEC-08: mai una seconda riga `open` per lo stesso bot+coin. Se una riga
      // esiste già, qualcuno ha registrato questa stessa apertura mentre eravamo
      // in attesa del fill (tipicamente un'altra istanza dello stesso bot, vedi
      // botManager.updateBot): si riusa quella riga.
      const { id: posId, created, row } = db.insertPositionIfNoneOpen({
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

      if (created) {
        // Piazza i trigger TP/SL (reduce-only). Ordine di chiusura: opposto al lato.
        await this._placeTpSl();
      } else {
        // Riga preesistente allineata all'apertura appena eseguita, e trigger
        // ri-piazzati con place-then-cancel: gli eventuali TP/SL già sul book
        // (dimensionati su uno stato diverso) vengono rimossi solo DOPO che i
        // nuovi sono attivi. Un allineamento del genere non passa in silenzio.
        db.updatePosition(posId, {
          entry_px: entryPx, size: plan.size, tp_px: tpPx, sl_px: slPx,
          opened_at: this.position.openedAt, trailing_json: this._trailingJson()
        });
        logger.warn(`Bot ${this.name}: riga posizione #${posId} già aperta (side DB ${row?.side}) all'apertura di ${side} ${plan.size} ${this.coin} — riusata invece di duplicarla`);
        notifier.notify(`⚠️ <b>${this.name}</b>: all'apertura su ${this.coin} esisteva già la riga posizione #${posId} — riusata (nessun duplicato). Verificare i trigger attivi sull'exchange.`);
        await this._replaceTpSl(tpPx, slPx, 'riga posizione preesistente all\'apertura');
      }
      // Garanzia: nessuna posizione resta senza stop loss (chiude se non riesce a piazzarlo).
      await this._ensureStopLoss();

      logger.info(`🟢 Bot ${this.name}: aperta ${side} ${plan.size} ${this.coin} @ ${entryPx}`);
      notifier.notify(`🟢 <b>${this.name}</b> ha aperto <b>${side.toUpperCase()}</b> ${plan.size} ${this.coin} @ ${entryPx}\nTP ${tpPx ? tpPx.toFixed(2) : '—'} · SL ${slPx ? slPx.toFixed(2) : '—'}`);
    } finally {
      this._opening = false;
    }
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

  /**
   * Serializza `trailing_json` facendo MERGE col contenuto già persistito, MAI un
   * overwrite (TRAIL-01).
   *
   * In quel campo non vive solo `slOid`: ci sono anche `originalEntryPx` e
   * `dcaCount`, scritti dal fix di SEC-01. Sovrascriverlo col solo `{ slOid }`
   * non dà problemi a runtime — i valori restano corretti in memoria — ma dopo un
   * RIAVVIO il costruttore li rilegge dal DB e `dcaCount` torna a 0: il bot può
   * eseguire più step di DCA di quanti configurati, impegnando capitale non
   * previsto su una posizione già in perdita.
   *
   * Lo stato in memoria è la fonte di verità a runtime e vince sul persistito; le
   * eventuali chiavi sconosciute già presenti in DB vengono preservate.
   */
  _trailingJson(extra = {}) {
    let persisted = {};
    try {
      const row = db.getPosition(this.position?.id);
      if (row?.trailing_json) persisted = JSON.parse(row.trailing_json) || {};
    } catch (error) {
      // Un trailing_json illeggibile non blocca la scrittura del nuovo stato, ma
      // non passa in silenzio: senza traccia, la perdita di
      // originalEntryPx/dcaCount resterebbe invisibile fino al riavvio.
      logger.warn(`Bot ${this.name}: trailing_json esistente non leggibile, riscrivo dallo stato in memoria`, error.message);
    }
    return JSON.stringify({
      ...persisted,
      originalEntryPx: this.position?.originalEntryPx ?? persisted.originalEntryPx ?? null,
      dcaCount: this.position?.dcaCount ?? persisted.dcaCount ?? 0,
      slOid: this.position?.slOid ?? null,
      ...extra
    });
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
        db.updatePosition(this.position.id, { trailing_json: this._trailingJson() });
      }
    } catch (error) {
      logger.warn(`Bot ${this.name}: errore piazzamento TP/SL`, error.message);
    }
  }

  /** Tutti gli ordini SL (trigger reduce-only "stop") attivi per questo mercato. */
  async _findStopOrders() {
    const orders = await this.broker.getFrontendOpenOrders(this.masterAddress, this.network);
    const sameCoin = o => o.coin === this.coin || `${o.coin}-PERP` === this.coin || o.coin === this.coin.replace('-PERP', '');
    return (orders || []).filter(o => sameCoin(o) && o.isTrigger && /stop/i.test(o.orderType || ''));
  }

  /** Trova l'ordine SL (trigger reduce-only) attivo per questa posizione, se c'è. */
  async _findStopOrder() {
    const stops = await this._findStopOrders();
    return stops.find(o => o.oid === this.position?.slOid) || stops[0] || null;
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
   * Se invece ne trova PIÙ DI UNO, tiene quello tracciato e cancella gli altri
   * (SEC-08): girando a ogni tick, è anche il punto in cui uno stato già sporco
   * — come i 2 SL trovati sul VPS — rientra da solo, senza cancellazioni a mano.
   * No-op se la strategia non prevede SL.
   */
  async _ensureStopLoss() {
    if (!this.position || !this.position.slPx) return;
    try {
      // SEC-08 — pulizia degli SL orfani. Una posizione ha esattamente UN stop
      // loss: più di uno significa che un ri-piazzamento ha lasciato indietro il
      // precedente (è lo stato trovato sul VPS: 2 SL vivi per una posizione da
      // 1.31 SOL). Ne teniamo uno — quello che stiamo tracciando, se c'è — e
      // cancelliamo gli altri: l'ordine di cancellazione parte solo su ordini in
      // eccesso, quindi la posizione non resta mai senza protezione.
      const stops = await this._findStopOrders();
      if (stops.length) {
        const keep = stops.find(o => o.oid === this.position.slOid) || stops[0];
        const previousOid = this.position.slOid;
        this.position.slOid = keep.oid;
        if (keep.oid !== previousOid) {
          db.updatePosition(this.position.id, { trailing_json: this._trailingJson() });
        }
        const extra = stops.filter(o => o.oid !== keep.oid);
        if (extra.length) {
          logger.warn(`Bot ${this.name}: ${extra.length} stop loss in eccesso su ${this.coin} (oid ${extra.map(o => o.oid).join(', ')}), mantengo ${keep.oid} e cancello gli altri`);
          notifier.notify(`🧹 <b>${this.name}</b>: trovati ${stops.length} stop loss attivi su ${this.coin} per una sola posizione — mantengo quello tracciato (${keep.oid}) e cancello ${extra.length} ordine/i orfano/i.`);
          for (const o of extra) {
            await this.broker.cancelOrder({ masterAddress: this.masterAddress, coin: this.coin, oid: o.oid }, this.network)
              .catch(err => logger.error(`Bot ${this.name}: cancellazione SL orfano ${o.oid} fallita`, err.message));
          }
        }
        return;
      }

      // SL assente: tentativo di ripiazzamento immediato.
      logger.warn(`Bot ${this.name}: stop loss assente, ripiazzo…`);
      const closeIsBuy = this.position.side === 'short';
      const res = await this.broker.placeTriggerOrder({
        masterAddress: this.masterAddress, coin: this.coin, isBuy: closeIsBuy,
        size: this.position.size, triggerPx: this.position.slPx, tpsl: 'sl'
      }, this.network);
      this.position.slOid = res.oid;
      db.updatePosition(this.position.id, { trailing_json: this._trailingJson() });

      // Verifica finale: se ancora non c'è, chiusura di sicurezza.
      const stop = await this._findStopOrder();
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
        db.updatePosition(this.position.id, { sl_px: roundedSl, trailing_json: this._trailingJson() });
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
      await this._replaceTpSl(updated.tpPx, updated.slPx, `DCA #${this.position.dcaCount}`);
    } catch (error) {
      logger.debug(`Bot ${this.name}: DCA fallito`, error.message);
    }
  }

  /**
   * Sostituisce i trigger TP/SL della posizione con quelli passati, sulla size
   * corrente. Segue la STESSA sequenza PLACE-THEN-CANCEL usata dal trailing stop
   * qui sotto: i nuovi trigger vengono piazzati PRIMA di cancellare i vecchi,
   * così la posizione non resta mai scoperta nemmeno per un istante.
   * Se il ri-piazzamento fallisce, i vecchi trigger restano intatti — meglio una
   * protezione parziale che nessuna — e l'errore è loggato E notificato via
   * Telegram, mai in silenzio.
   *
   * Due chiamanti, stessa sequenza (SEC-01 + SEC-08):
   *  - dopo un'aggiunta DCA, con size ed entry medio già ricalcolati da
   *    `riskManager.applyDcaFill`;
   *  - all'adozione di una posizione non tracciata, che può portarsi dietro
   *    trigger stale di chi l'ha aperta.
   * Nel secondo caso l'oid del vecchio SL non è noto (non l'abbiamo piazzato
   * noi), quindi va cercato sul book invece di leggerlo da `this.position.slOid`:
   * senza questo, un SL estraneo resterebbe vivo accanto a quello nuovo — cioè
   * esattamente l'ordine orfano osservato sul VPS.
   *
   * @param reason contesto usato nei log/notifiche (es. 'DCA', 'adozione…').
   */
  async _replaceTpSl(tpPx, slPx, reason = 'aggiornamento') {
    if (!this.position) return;
    const closeIsBuy = this.position.side === 'short';
    try {
      const oldTpOrders = await this._findTpOrders();
      const oldSlOid = this.position.slOid ?? (await this._findStopOrder())?.oid ?? null;

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
        trailing_json: this._trailingJson()
      });

      // 3) CANCEL: solo ora rimuovo i vecchi trigger (mai prima del punto 1-2).
      for (const o of oldTpOrders) {
        await this.broker.cancelOrder({ masterAddress: this.masterAddress, coin: this.coin, oid: o.oid }, this.network).catch(() => {});
      }
      if (oldSlOid && oldSlOid !== newSlOid) {
        await this.broker.cancelOrder({ masterAddress: this.masterAddress, coin: this.coin, oid: oldSlOid }, this.network).catch(() => {});
      }

      logger.info(`🎯 Bot ${this.name}: TP/SL ri-piazzati (${reason}) → size ${this.position.size} @ entry ${this.position.entryPx.toFixed(4)} (TP ${tpPx ?? '—'} · SL ${slPx ?? '—'})`);
    } catch (error) {
      logger.error(`Bot ${this.name}: ri-piazzamento TP/SL fallito (${reason})`, error.message);
      notifier.notify(`⚠️ <b>${this.name}</b>: ri-piazzamento TP/SL fallito su ${this.coin} (${reason}) — la posizione potrebbe non essere protetta per intero, verificare manualmente i trigger attivi.`);
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
