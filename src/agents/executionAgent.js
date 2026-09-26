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
import { validateTunePatch } from './tunePatch.js';

class ExecutionAgent {
  constructor() {
    this.executed = new Set(); // cache hot in-process (l'autorità è il DB)
  }

  /** True se l'azione è già stata eseguita (cache in-memory O persistenza DB). */
  _alreadyExecuted(id) {
    if (!id) return false;
    if (this.executed.has(id)) return true;
    return db.wasActionExecuted(id);
  }

  /**
   * Esegue un'azione approvata. action: { id, type, coin, side?, size?, leverage?,
   * triggerPx?, botId?, masterAddress?, network? }
   *
   * Idempotenza PERSISTITA: l'id eseguito è registrato su DB (executed_actions),
   * così non viene rieseguito nemmeno dopo un riavvio del processo.
   * @returns { ok, result?, error?, skipped? }
   */
  async execute(action) {
    if (this._alreadyExecuted(action.id)) {
      logger.info('⏭️  ExecutionAgent: azione già eseguita, salto', { id: action.id });
      return { ok: true, skipped: true };
    }
    // Prenota subito l'id (DB + cache) per bloccare invii concorrenti/duplicati.
    if (action.id) { this.executed.add(action.id); db.markActionExecuted(action.id); }

    try {
      let result;
      switch (action.type) {
        case 'pause_bot':       result = await this._pauseBot(action); break;
        case 'close':
        case 'close_suggestion': result = await this._close(action); break;
        case 'tighten_sl':      result = await this._tightenSl(action); break;
        case 'open':            result = await this._open(action); break;
        case 'tune_params':     result = await this._tuneParams(action); break;
        default:
          // Tipi non auto-eseguibili (es. new_strategy_candidate): solo registrati.
          // Non è una vera esecuzione: libera la prenotazione idempotenza.
          if (action.id) { this.executed.delete(action.id); db.unmarkActionExecuted(action.id); }
          db.insertAudit('executionAgent', 'action.noop', { type: action.type, coin: action.coin });
          return { ok: true, result: { noop: true, message: 'Tipo non auto-eseguibile: configura manualmente.' } };
      }

      // Un handler può concludere che NON c'era nulla da eseguire (es. una
      // proposta `tune_params` diagnostica, senza patch applicabile). È lo
      // stesso esito del ramo `default`, raggiunto però dopo aver guardato il
      // contenuto dell'azione e non solo il suo tipo — quindi riceve lo stesso
      // trattamento: prenotazione dell'idempotenza RILASCIATA (non è successo
      // niente da non ripetere), audit `action.noop`, nessun `ORDER_FILLED` sul
      // bus. Senza questo ramo una proposta puramente diagnostica lascerebbe in
      // `executed_actions` la traccia di un'esecuzione mai avvenuta e
      // annuncerebbe un ordine riempito che non esiste.
      if (result?.noop === true) {
        if (action.id) { this.executed.delete(action.id); db.unmarkActionExecuted(action.id); }
        db.insertAudit('executionAgent', 'action.noop', { type: action.type, coin: action.coin, message: result.message });
        return { ok: true, result };
      }

      db.insertAudit('executionAgent', 'order.filled', { type: action.type, coin: action.coin, result });
      bus.publish(EVENTS.ORDER_FILLED, { action, result });
      return { ok: true, result };
    } catch (e) {
      // Errore: libera la prenotazione (DB + cache) per consentire un retry.
      if (action.id) { this.executed.delete(action.id); db.unmarkActionExecuted(action.id); }
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

  /**
   * ISSUE #55 — `if (r.error) throw` non era una verifica completa.
   *
   * `closePosition` → `placeMarketOrder` è un limit IoC: su un book sottile
   * Hyperliquid non lancia, RISOLVE con l'ordine rifiutato e `oid: null`. Il
   * messaggio d'errore c'è quasi sempre — ed è il caso che `r.error`
   * intercettava — ma un oid nullo senza messaggio e un riempimento PARZIALE
   * passavano entrambi per successo: `order.filled` in audit, `ORDER_FILLED` sul
   * bus, proposta segnata `approved` e la notifica «✅ Proposta eseguita», con la
   * posizione ancora aperta sull'exchange.
   *
   * LANCIARE è la cosa giusta qui, e non serve nessun meccanismo di ritentativo
   * proprio: il `catch` di `execute()` rilascia già la prenotazione di
   * idempotenza (cache + `unmarkActionExecuted`), scrive `order.error` e
   * pubblica `ORDER_ERROR` invece di `ORDER_FILLED`; `proposals.approve` lascia
   * allora la proposta `pending`. Il ritentativo è quindi una nuova approvazione
   * UMANA, non un loop automatico — nessun rischio del ciclo di riconciliazione
   * fittizia visto su NEAR-PERP, dove a richiamare la chiusura era un tick.
   *
   * Un riempimento parziale lancia anch'esso: l'azione approvata era «chiudi la
   * posizione», e mezza posizione chiusa non è quell'azione. Il messaggio dice
   * quanto è passato e quanto resta, perché il residuo cambia cosa deve fare la
   * persona che rilegge la proposta.
   */
  async _close(action) {
    const { masterAddress, coin, network } = action;
    if (!masterAddress || !coin) throw new Error('close richiede masterAddress e coin');
    const r = await client.closePosition({ masterAddress, coin }, network);
    const verdict = riskManager.interpretCloseResult(r, r?.requestedSz ?? action.size);
    if (verdict.outcome === 'rejected') {
      throw new Error(`chiusura di ${coin} NON eseguita: ${verdict.reason} — posizione ancora aperta`);
    }
    if (verdict.outcome === 'partial') {
      throw new Error(`chiusura di ${coin} PARZIALE: ${verdict.reason} — restano ${verdict.remaining} aperti`);
    }
    return { closed: coin, filled: verdict.filled, sizeKnown: verdict.sizeKnown };
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

  /**
   * TUNING DI CONFIGURAZIONE approvato a mano (proposta `tune_params`).
   *
   * Perché il click APPLICA davvero invece di lasciare un promemoria. Le
   * proposte che restano suggerimenti (`new_strategy_candidate`) lo restano
   * perché descrivono una strategia intera, con size e leva: lì "configura a
   * mano" è una protezione, non un fastidio. Qui la modifica è un singolo campo
   * già scelto e già validato, e lasciarla da riportare a mano avrebbe due
   * effetti sgradevoli — l'operatore la riscrive con un refuso, oppure non la
   * riscrive affatto e la proposta diventa l'ennesima riga che scade senza
   * conseguenze. Una coda advisory serve se approvare produce l'effetto.
   *
   * Ciò che rende sicuro applicare è il RESTRINGIMENTO, non la fiducia:
   * `validateTunePatch` ammette solo `candleInterval`, e solo su un valore della
   * whitelist. Non passa di qui nessun campo che cambi il denaro a rischio, per
   * cui l'invariante dichiarata in cima a questo file — l'auto-esecuzione non
   * aumenta mai l'esposizione — non viene toccata: cambia ogni quanto il bot
   * guarda il mercato, non quanto ci mette sopra.
   *
   * La validazione è rifatta QUI, sul lato che scrive, anche se il watcher l'ha
   * già fatta quando ha creato la proposta: fra i due momenti c'è una riga in
   * `proposals` e nessuno garantisce che sia arrivata da lì. Una patch fuori
   * whitelist LANCIA — finisce in `order.error` nell'audit e torna come errore a
   * chi ha cliccato — invece di essere ripulita e applicata a metà.
   *
   * La fusione con la config esistente non è duplicata: è
   * `botManager.applyConfigPatch`, lo stesso identico percorso di
   * `update_strategy_params` (merge di un livello + ricarica dell'istanza +
   * emit UI), così i due modi di modificare una config non possono divergere.
   */
  async _tuneParams(action) {
    if (!action.botId) throw new Error('tune_params richiede botId');

    const patch = action.patch || null;
    if (!patch) {
      // Proposta diagnostica: dice PERCHÉ il bot è fermo quando nessun parametro
      // lo sbloccherebbe (nessuna regola d'ingresso, intervallo già al minimo).
      // Non è un fallimento: è l'esito corretto, e va detto così invece di
      // fingere un'applicazione riuscita.
      return {
        noop: true,
        botId: action.botId,
        message: 'Nessun parametro applicabile: la proposta è diagnostica, la modifica va decisa a mano.'
      };
    }

    const v = validateTunePatch(patch);
    if (!v.ok) {
      throw new Error(`Patch di tuning rifiutata (fuori dai parametri modificabili): ${v.errors.join(' ')}`);
    }

    const { default: botManager } = await import('../perps/botManager.js'); // lazy: evita cicli
    const { previousConfig, config } = await botManager.applyConfigPatch(action.botId, patch, { reason: 'tune_params' });

    const changed = {};
    for (const k of Object.keys(patch)) changed[k] = { da: previousConfig?.[k] ?? null, a: config?.[k] ?? null };
    logger.info(`🎚️  Tuning applicato al bot ${action.botId}`, changed);
    return { botId: action.botId, tuned: changed };
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
