/**
 * STRATEGY ENGINE (auto-pilot)
 * ============================
 *
 * Valuta le regole di un bot su uno snapshot di mercato e produce un segnale:
 *   { action: 'open_long' | 'open_short' | 'close' | 'hold', reason }
 *
 * Tipi di regola supportati (entryRules / exitRules):
 *   - indicator : { indicator:'rsi'|'ema'|'sma'|'macd'|'bollinger', period, op, value,
 *                   compareToPrice?, cond?, signal }
 *   - price     : { op:'<'|'>'|'<='|'>=', value, signal }
 *   - funding   : { op, value, signal }
 *   - external  : { signal }  → soddisfatta da un segnale webhook in coda
 *
 * Combinazione regole d'ingresso: config.logic = 'any' (default) | 'all'.
 */

import * as ind from './indicators.js';
import logger from '../utils/logger.js';

function applyOp(a, op, b) {
  if (a === null || a === undefined || isNaN(a)) return false;
  switch (op) {
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    case '==': return a === b;
    default: return false;
  }
}

class StrategyEngine {
  constructor() {
    // Coda di segnali esterni (webhook) per coin: coin -> { signal, ts }
    this.externalSignals = new Map();
  }

  pushExternalSignal(coin, signal) {
    this.externalSignals.set(coin, { signal, ts: Date.now() });
    logger.info('📨 Segnale esterno ricevuto', { coin, signal });
  }

  _consumeExternal(coin) {
    const s = this.externalSignals.get(coin);
    if (!s) return null;
    // I segnali esterni scadono dopo 5 minuti.
    if (Date.now() - s.ts > 5 * 60 * 1000) {
      this.externalSignals.delete(coin);
      return null;
    }
    return s.signal;
  }

  /** Valuta una singola regola. Ritorna { match, signal }. */
  _evalRule(rule, ctx) {
    const { price, candles, funding } = ctx;
    switch (rule.type) {
      case 'price':
        return { match: applyOp(price, rule.op, rule.value), signal: rule.signal };

      case 'funding':
        return { match: applyOp(funding, rule.op, rule.value), signal: rule.signal };

      case 'external': {
        const ext = ctx.external;
        return { match: ext && ext === rule.signal, signal: rule.signal };
      }

      case 'indicator': {
        const period = rule.period;
        // Se il backtester ha precalcolato le serie, leggi il valore alla barra
        // corrente (O(1)) invece di ricalcolare l'indicatore sull'intero prefisso.
        const pre = ctx.precomputed ? ctx.precomputed[ind.ruleKey(rule)] : undefined;
        let val = null;
        switch (rule.indicator) {
          case 'rsi': val = pre !== undefined ? pre : ind.rsi(candles, period || 14); break;
          case 'ema': val = pre !== undefined ? pre : ind.ema(candles, period || 20); break;
          case 'sma': val = pre !== undefined ? pre : ind.sma(candles, period || 20); break;
          case 'macd': {
            const m = pre !== undefined ? pre : ind.macd(candles, rule.params);
            if (!m) return { match: false, signal: rule.signal };
            // cond: 'bullish' (hist>0) | 'bearish' (hist<0)
            const match = rule.cond === 'bearish' ? m.histogram < 0 : m.histogram > 0;
            return { match, signal: rule.signal };
          }
          case 'bollinger': {
            const b = pre !== undefined ? pre : ind.bollinger(candles, rule.params);
            if (!b) return { match: false, signal: rule.signal };
            const match = rule.cond === 'above_upper' ? price > b.upper : price < b.lower;
            return { match, signal: rule.signal };
          }
          default: return { match: false, signal: rule.signal };
        }
        // ema/sma: confronto opzionale prezzo vs indicatore
        if (rule.compareToPrice) {
          return { match: applyOp(price, rule.op, val), signal: rule.signal };
        }
        return { match: applyOp(val, rule.op, rule.value), signal: rule.signal };
      }

      default:
        return { match: false, signal: rule.signal };
    }
  }

  /**
   * @param {object} config  configurazione bot
   * @param {object} snapshot { coin, price, candles, funding }
   * @param {object} state    { inPosition, side }
   */
  evaluate(config, snapshot, state = {}) {
    const ctx = {
      price: snapshot.price,
      candles: snapshot.candles,
      funding: snapshot.funding ?? null,
      external: this._consumeExternal(snapshot.coin),
      precomputed: snapshot.precomputed // valori indicatori già pronti (backtest)
    };

    // --- In posizione: valuta le regole di uscita ---
    if (state.inPosition) {
      const exitRules = config.exitRules || [];
      for (const rule of exitRules) {
        const { match } = this._evalRule(rule, ctx);
        if (match) {
          return { action: 'close', reason: `Regola di uscita: ${rule.type} ${rule.indicator || ''}` };
        }
      }
      // Uscita su segnale esterno opposto
      if (ctx.external === 'close') {
        return { action: 'close', reason: 'Segnale esterno: close' };
      }
      return { action: 'hold', reason: 'In posizione, nessuna regola di uscita soddisfatta' };
    }

    // --- Flat: valuta le regole d'ingresso ---
    const entryRules = config.entryRules || [];
    if (!entryRules.length) {
      return { action: 'hold', reason: 'Nessuna regola d\'ingresso configurata' };
    }

    const logic = config.logic || 'any';
    const results = entryRules.map(r => ({ rule: r, ...this._evalRule(r, ctx) }));

    let chosenSignal = null;
    let reason = '';

    if (logic === 'all') {
      // Tutte vere e coerenti su un unico segnale
      const signals = [...new Set(results.map(r => r.signal))];
      if (signals.length === 1 && results.every(r => r.match)) {
        chosenSignal = signals[0];
        reason = 'Tutte le regole d\'ingresso soddisfatte';
      }
    } else {
      const hit = results.find(r => r.match);
      if (hit) {
        chosenSignal = hit.signal;
        reason = `Regola soddisfatta: ${hit.rule.type} ${hit.rule.indicator || ''}`.trim();
      }
    }

    if (!chosenSignal) {
      return { action: 'hold', reason: 'Nessun segnale d\'ingresso' };
    }

    // Rispetta la direzione consentita
    const dir = config.direction || 'both';
    if (chosenSignal === 'long' && dir !== 'short') {
      return { action: 'open_long', reason };
    }
    if (chosenSignal === 'short' && dir !== 'long') {
      return { action: 'open_short', reason };
    }
    return { action: 'hold', reason: `Segnale ${chosenSignal} non consentito (direzione: ${dir})` };
  }
}

export default new StrategyEngine();
