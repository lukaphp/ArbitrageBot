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
 *
 * FORMA DELLE REGOLE (OPS-FLEET-02): `evaluate` canonicalizza la config prima di
 * valutarla — `normalizeStrategyConfig` in `strategySchema.js`. Motivo: una
 * regola in forma non canonica veniva scartata con `match:false`, cioè un bot
 * che non può aprire e che da fuori è indistinguibile da un bot in attesa del
 * segnale. Quello che resta NON valutabile non viene indovinato: viene detto,
 * nel log e nel `reason` dell'hold.
 */

import * as ind from './indicators.js';
import { normalizeStrategyConfig } from './strategySchema.js';
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
    // OPS-FLEET-02 — esito della normalizzazione per OGGETTO config. Memoizzare
    // serve a due cose: non rifare il lavoro a ogni tick (e per ogni barra del
    // backtester), e soprattutto LOGGARE UNA VOLTA SOLA per config invece che a
    // ogni valutazione. Un bot con loop di pochi secondi riempirebbe altrimenti
    // il log con la stessa riga per sempre — e un avviso ripetuto all'infinito
    // è rumore, cioè di nuovo silenzio.
    //
    // Chiave = identità dell'oggetto config, non il suo contenuto: `bot.config`
    // resta lo stesso oggetto per tutta la vita dell'istanza, e ogni percorso
    // che cambia la configurazione (`botManager.updateBot`, `mergeStrategyConfig`)
    // produce un oggetto NUOVO — quindi una config modificata viene rivalutata
    // e ri-segnalata da sé. WeakMap: nessuna ritenzione di config morte.
    this._normalized = new WeakMap();
  }

  /**
   * Config canonica per la valutazione (OPS-FLEET-02).
   *
   * Vedi `normalizeStrategyConfig` in `strategySchema.js` per COSA viene
   * corretto e perché. Qui c'è la parte non pura: dirlo. Una regola che il
   * motore non sa valutare è un bot che non può aprire una posizione — cioè un
   * guasto sul percorso dei soldi che, prima di questo fix, era indistinguibile
   * da «il mercato non ha ancora dato il segnale». Si logga a `error` proprio
   * perché il sintomo è l'assenza di eventi: non c'è nient'altro da guardare.
   */
  _canonical(config) {
    if (!config || typeof config !== 'object') return { config, unevaluable: [] };
    const cached = this._normalized.get(config);
    if (cached) return cached;

    const { config: normalized, changes, unevaluable } = normalizeStrategyConfig(config);
    if (changes.length) {
      logger.warn('⚠️  Regole di strategia in formato non canonico, interpretate comunque', { correzioni: changes });
    }
    if (unevaluable.length) {
      logger.error('🚨 Regole di strategia NON valutabili: finché restano così il bot non potrà aprire su quelle regole', { regole: unevaluable });
    }

    const entry = { config: normalized, unevaluable };
    this._normalized.set(config, entry);
    return entry;
  }

  pushExternalSignal(coin, signal) {
    this.externalSignals.set(coin, { signal, ts: Date.now() });
    logger.info('📨 Segnale esterno ricevuto', { coin, signal });
  }

  /**
   * QUAL-01 item 1 — lettura PURA del segnale esterno in coda: nessuna
   * modifica della coda, nemmeno per i segnali scaduti (che qui vengono
   * semplicemente ignorati). È la versione da usare in qualunque percorso
   * DIAGNOSTICO — `getMonitor()`, una UI, un test — dove chiedere "cosa vede il
   * bot in questo momento?" non deve poter cambiare ciò che il bot vedrà al
   * prossimo tick.
   *
   * Nota sul difetto reale, verificato sul codice: il segnale NON veniva
   * consumato alla lettura (solo eliminato se scaduto), quindi il caso descritto
   * dall'audit — "la seconda valutazione non trova più il segnale perché la prima
   * l'ha consumato" — non poteva accadere così com'era raccontato. Ciò che poteva
   * accadere è che un percorso di sola lettura modificasse la coda. La semantica
   * di consumo NON è stata cambiata: sarebbe un cambio di comportamento sul
   * percorso di trading (un webhook che oggi vale 5 minuti smetterebbe di valere
   * dopo il primo tick), fuori dallo scope di questo sprint.
   */
  _checkExternal(coin) {
    const s = this.externalSignals.get(coin);
    if (!s) return null;
    if (Date.now() - s.ts > 5 * 60 * 1000) return null; // scaduto: ignorato, non rimosso
    return s.signal;
  }

  /**
   * Lettura del segnale esterno CON effetto collaterale (pulizia dei segnali
   * scaduti). Solo per il loop di trading reale — vedi `_checkExternal` per la
   * versione pura.
   */
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

  /**
   * Motivo di un `hold`, con in coda le regole che non potevano essere valutate.
   *
   * `lastEval.reason` è ciò che l'operatore legge nella card del bot e in
   * `getMonitor`. «Nessun segnale d'ingresso» su una regola rotta è una risposta
   * vera e inutile: descrive il mercato quando il problema è la configurazione.
   * È la frase che ha coperto OPS-FLEET-02 per 46 ore.
   */
  _holdReason(base, unevaluable = []) {
    if (!unevaluable.length) return base;
    return `${base} — ATTENZIONE: ${unevaluable.length} regola/e non valutabile/i: ${unevaluable.join(' ')}`;
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
          case 'adx': val = pre !== undefined ? pre : ind.adx(candles, period || 14); break;
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
   * @param {object} rawConfig configurazione bot, in qualunque forma sia stata
   *   persistita: viene canonicalizzata qui (vedi `_canonical`).
   * @param {object} snapshot { coin, price, candles, funding }
   * @param {object} state    { inPosition, side }
   * @param {object} opts     { consume } — `consume: false` per una valutazione di
   *   sola lettura (diagnostica): stesso verdetto, nessuna modifica alla coda dei
   *   segnali esterni. Default `true`: il loop reale non cambia comportamento.
   */
  evaluate(rawConfig, snapshot, state = {}, { consume = true } = {}) {
    // OPS-FLEET-02 — unico punto di passaggio di OGNI decisione (bot live,
    // backtester, ottimizzatore, diagnostica): normalizzare qui vuol dire che
    // nessun consumatore può vedere una forma di regola diversa dagli altri.
    const { config, unevaluable } = this._canonical(rawConfig);
    const ctx = {
      price: snapshot.price,
      candles: snapshot.candles,
      funding: snapshot.funding ?? null,
      external: consume ? this._consumeExternal(snapshot.coin) : this._checkExternal(snapshot.coin),
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
      return { action: 'hold', reason: this._holdReason('In posizione, nessuna regola di uscita soddisfatta', unevaluable) };
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
      return { action: 'hold', reason: this._holdReason('Nessun segnale d\'ingresso', unevaluable) };
    }

    // Rispetta la direzione consentita
    const dir = config.direction || 'both';
    if (chosenSignal === 'long' && dir !== 'short') {
      return { action: 'open_long', reason };
    }
    if (chosenSignal === 'short' && dir !== 'long') {
      return { action: 'open_short', reason };
    }
    // Qui ci si arriva in due casi molto diversi, e confonderli è costato caro:
    // un segnale VALIDO bloccato dalla direzione consentita, oppure un segnale
    // che il motore non riconosce affatto. Con `direction: 'both'` il primo caso
    // è impossibile — dire «non consentito (direzione: both)» era letteralmente
    // falso, e mandava a cercare il problema nella direzione invece che nella
    // regola (OPS-FLEET-02).
    const noto = chosenSignal === 'long' || chosenSignal === 'short';
    return {
      action: 'hold',
      reason: noto
        ? `Segnale ${chosenSignal} non consentito (direzione: ${dir})`
        : `Segnale "${chosenSignal}" non riconosciuto (attesi: long, short): la regola non potrà mai aprire una posizione.`
    };
  }
}

export default new StrategyEngine();
