/**
 * ML TRAINER AGENT
 * ================
 *
 * Riaddestra periodicamente i modelli ML usati dai bot (gate mlGate) e traccia
 * l'accuratezza-vs-baseline nel tempo, così il modello non invecchia silenziosamente
 * in cache. Se l'edge scende sotto soglia, allerta via Telegram: il gate ML
 * smetterà comunque di filtrare (hasEdge=false), ma l'utente viene avvisato.
 *
 * Cadenza configurabile (AGENT_ML_RETRAIN_MIN, default 360 = 6h). On-demand via
 * runOnce(). Supervisionato dal runtime (tick in try/catch).
 */

import predictor from '../perps/predictor.js';
import botManager from '../perps/botManager.js';
import notifier from '../perps/notifier.js';
import db from '../db/database.js';
import logger from '../utils/logger.js';

const EDGE_MIN = 0.02; // soglia di edge sopra la baseline (coerente con predict())

class MlTrainer {
  constructor() {
    this.name = 'ml-trainer';
    this.lastRunAt = null;
    this.lastResults = [];
    this.lastAlertTs = new Map(); // `${coin}_${interval}` -> ts (throttle alert)
  }

  get intervalMs() {
    const min = parseInt(process.env.AGENT_ML_RETRAIN_MIN, 10) || 360;
    return min * 60 * 1000;
  }

  /** Coppie (coin, interval) usate dai bot con gate ML attivo. */
  _targets() {
    const seen = new Set();
    const targets = [];
    for (const s of botManager.listStates()) {
      const g = s.config?.mlGate;
      if (!g || !g.enabled) continue;
      const interval = g.interval || s.config.candleInterval || '15m';
      const key = `${s.coin}_${interval}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ coin: s.coin, interval });
    }
    return targets;
  }

  async tick() {
    const targets = this._targets();
    if (!targets.length) return;
    this.lastRunAt = Date.now();
    const results = [];
    for (const { coin, interval } of targets) {
      try {
        const model = await predictor.train(coin, interval, { retrain: true });
        if (model.error) { results.push({ coin, interval, error: model.error }); continue; }
        const edge = model.quality.accuracy - model.quality.baseline;
        results.push({ coin, interval, accuracy: model.quality.accuracy, baseline: model.quality.baseline, edge });
        if (edge < EDGE_MIN) this._maybeAlert(coin, interval, edge);
      } catch (e) {
        results.push({ coin, interval, error: e.message });
      }
    }
    this.lastResults = results;
    db.insertAudit('ml-trainer', 'retrain.completed', { targets: targets.length, results });
    logger.info(`🧠 ML retrain: ${results.length} modelli aggiornati`);
  }

  /** Esecuzione on-demand (es. da API). */
  async runOnce() { await this.tick(); return this.lastResults; }

  _maybeAlert(coin, interval, edge) {
    const key = `${coin}_${interval}`;
    const now = Date.now();
    const last = this.lastAlertTs.get(key) || 0;
    if (now - last < 12 * 60 * 60 * 1000) return; // max 1 ogni 12h
    this.lastAlertTs.set(key, now);
    notifier.notify(`📉 <b>ML</b> ${coin}/${interval}: edge sceso a ${(edge * 100).toFixed(1)}pt sopra la baseline (sotto ${(EDGE_MIN * 100)}pt). Il modello non ha più vantaggio: rivedi la strategia.`);
  }

  status() {
    return { lastRunAt: this.lastRunAt, lastResults: this.lastResults, targets: this._targets().length };
  }
}

export default new MlTrainer();
