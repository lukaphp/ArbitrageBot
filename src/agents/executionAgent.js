/**
 * EXECUTION AGENT (unico esecutore)
 * =================================
 *
 * L'UNICO componente che esegue azioni sul mercato. Consuma azioni GIÀ approvate
 * (umano + RiskAgent) e le traduce in chiamate a hyperliquidClient / botManager.
 *
 * Proprietà di sicurezza: le proposte dell'AI possono SOLO ridurre il rischio in
 * automatico (pause_bot / close / tighten_sl). Le azioni che AUMENTANO il rischio
 * (open / nuove strategie) NON sono auto-eseguite: restano suggerimenti che
 * l'utente configura a mano. L'unica eccezione è un `open` esplicito con size già
 * definita, comunque passato dal RiskAgent.
 *
 * Idempotente: una stessa azione (per id) non viene eseguita due volte.
 */

import client from '../perps/hyperliquidClient.js';
import marketData from '../perps/marketData.js';
import riskManager from '../perps/riskManager.js';
import db from '../db/database.js';
import bus, { EVENTS } from './bus.js';
import logger from '../utils/logger.js';

class ExecutionAgent {
  constructor() {
    this.executed = new Set(); // id azioni già eseguite (idempotenza in-process)
  }

  /**
   * Esegue un'azione approvata. action: { id, type, coin, side?, size?, leverage?,
   * triggerPx?, botId?, masterAddress?, network? }
   * @returns { ok, result?, error?, skipped? }
   */
  async execute(action) {
    if (action.id && this.executed.has(action.id)) {
      logger.info('⏭️  ExecutionAgent: azione già eseguita, salto', { id: action.id });
      return { ok: true, skipped: true };
    }
    if (action.id) this.executed.add(action.id);

    try {
      let result;
      switch (action.type) {
        case 'pause_bot':       result = await this._pauseBot(action); break;
        case 'close':
        case 'close_suggestion': result = await this._close(action); break;
        case 'tighten_sl':      result = await this._tightenSl(action); break;
        case 'open':            result = await this._open(action); break;
        default:
          // Tipi non auto-eseguibili (es. new_strategy_candidate): solo registrati.
          db.insertAudit('executionAgent', 'action.noop', { type: action.type, coin: action.coin });
          return { ok: true, result: { noop: true, message: 'Tipo non auto-eseguibile: configura manualmente.' } };
      }
      db.insertAudit('executionAgent', 'order.filled', { type: action.type, coin: action.coin, result });
      bus.publish(EVENTS.ORDER_FILLED, { action, result });
      return { ok: true, result };
    } catch (e) {
      if (action.id) this.executed.delete(action.id); // consenti retry su errore
      db.insertAudit('executionAgent', 'order.error', { type: action.type, coin: action.coin, error: e.message });
      bus.publish(EVENTS.ORDER_ERROR, { action, error: e.message });
      logger.error('ExecutionAgent: errore esecuzione', e.message);
      return { ok: false, error: e.message };
    }
  }

  async _pauseBot(action) {
    if (!action.botId) throw new Error('pause_bot richiede botId');
    const { default: botManager } = await import('../perps/botManager.js'); // lazy: evita cicli
    botManager.stopBot(action.botId);
    return { paused: action.botId };
  }

  async _close(action) {
    const { masterAddress, coin, network } = action;
    if (!masterAddress || !coin) throw new Error('close richiede masterAddress e coin');
    const r = await client.closePosition({ masterAddress, coin }, network);
    if (r.error) throw new Error(r.error);
    return { closed: coin };
  }

  async _tightenSl(action) {
    const { masterAddress, coin, side, size, triggerPx, network } = action;
    if (!masterAddress || !coin || !triggerPx || !size) {
      throw new Error('tighten_sl richiede masterAddress, coin, size, triggerPx');
    }
    // Chiudere un long = sell; chiudere uno short = buy.
    const closeIsBuy = side === 'short';
    const market = marketData.getMarkets().find(m => m.coin === coin);
    const sz = riskManager.roundSize(size, market?.szDecimals ?? 3);
    const r = await client.placeTriggerOrder({
      masterAddress, coin, isBuy: closeIsBuy, size: sz, triggerPx, tpsl: 'sl'
    }, network);
    if (r.error) throw new Error(r.error);
    return { slPlaced: triggerPx };
  }

  async _open(action) {
    const { masterAddress, coin, side, size, leverage, network } = action;
    if (!masterAddress || !coin || !side || !size) {
      throw new Error('open richiede masterAddress, coin, side, size');
    }
    if (leverage) {
      await client.setLeverage(masterAddress, coin, leverage, action.marginMode || 'cross', network);
    }
    const order = await client.placeMarketOrder({
      masterAddress, coin, isBuy: side === 'long', size, slippage: action.slippage ?? 0.02
    }, network);
    if (order.error) throw new Error(order.error);
    return { opened: { coin, side, size, avgPx: order.avgPx } };
  }
}

export default new ExecutionAgent();
