/**
 * PREDICTOR (FreqAI-lite)
 * =======================
 *
 * Modello statistico LEGGERO — regressione logistica implementata a mano, senza
 * dipendenze pesanti — che stima la probabilità che il prezzo salga nelle
 * prossime candele a partire da feature tecniche (RSI, distanza da EMA, MACD,
 * Bollinger %b, ritorni recenti, volatilità).
 *
 * Ispirato a FreqAI di Freqtrade, ma volutamente trasparente e spiegabile.
 *
 * ⚠️ ONESTÀ: con dati di mercato l'accuratezza realistica è ~50-56%. Il modello
 * riporta sempre l'accuratezza in validation e la baseline (classe maggioritaria):
 * se l'accuratezza è ≈ baseline il modello NON ha edge e non va usato da solo.
 */

import * as ind from './indicators.js';
import { fetchCandles } from './backtester.js';
import db from '../db/database.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

const P = HYPERLIQUID_CONFIG.predictor;
const WARMUP = 35; // candele minime prima di poter calcolare le feature

const FEATURE_NAMES = ['rsi', 'emaFast', 'emaSlow', 'macdHist', 'bbPctB', 'ret1', 'ret3', 'ret5', 'vol10'];

// Cache in memoria: `${coin}_${interval}` -> model
const cache = new Map();

function sigmoid(z) {
  if (z < -30) return 0;
  if (z > 30) return 1;
  return 1 / (1 + Math.exp(-z));
}

function std(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const m = arr.reduce((s, v) => s + v, 0) / n;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / n);
}

/** Costruisce il vettore di feature alla candela i (o null se dati insufficienti). */
function featuresAt(candles, i) {
  if (i < WARMUP) return null;
  const slice = candles.slice(0, i + 1);
  const price = candles[i].c;

  const rsi = ind.rsi(slice, 14);
  const emaFast = ind.ema(slice, 12);
  const emaSlow = ind.ema(slice, 26);
  const macd = ind.macd(slice);
  const bb = ind.bollinger(slice, { period: 20 });
  if (rsi == null || emaFast == null || emaSlow == null || !macd || !bb) return null;

  const ret = (k) => i - k >= 0 ? (candles[i].c - candles[i - k].c) / candles[i - k].c : 0;
  const recentRets = [];
  for (let k = 1; k <= 10 && i - k >= 0; k++) recentRets.push((candles[i - k + 1].c - candles[i - k].c) / candles[i - k].c);

  return [
    (rsi - 50) / 50,
    (price - emaFast) / emaFast,
    (price - emaSlow) / emaSlow,
    macd.histogram / price,
    (bb.pb ?? 0.5) - 0.5,
    ret(1),
    ret(3),
    ret(5),
    std(recentRets)
  ];
}

/** Standardizza una matrice di feature; ritorna { X, mu, sigma }. */
function standardize(rows) {
  const d = rows[0].length;
  const mu = new Array(d).fill(0);
  const sigma = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mu[j] += r[j];
  for (let j = 0; j < d; j++) mu[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < d; j++) sigma[j] += (r[j] - mu[j]) ** 2;
  for (let j = 0; j < d; j++) sigma[j] = Math.sqrt(sigma[j] / rows.length) || 1;
  const X = rows.map(r => r.map((v, j) => (v - mu[j]) / sigma[j]));
  return { X, mu, sigma };
}

function applyStd(row, mu, sigma) {
  return row.map((v, j) => (v - mu[j]) / sigma[j]);
}

function predictProb(weights, xStd) {
  let z = weights[0]; // bias
  for (let j = 0; j < xStd.length; j++) z += weights[j + 1] * xStd[j];
  return sigmoid(z);
}

/** Discesa del gradiente con regolarizzazione L2. */
function trainLogistic(X, y, { epochs = 300, lr = 0.1, l2 = 0.001 } = {}) {
  const n = X.length;
  const d = X[0].length;
  const w = new Array(d + 1).fill(0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const p = predictProb(w, X[i]);
      const err = p - y[i];
      grad[0] += err;
      for (let j = 0; j < d; j++) grad[j + 1] += err * X[i][j];
    }
    w[0] -= lr * (grad[0] / n);
    for (let j = 1; j < w.length; j++) w[j] -= lr * (grad[j] / n + l2 * w[j]);
  }
  return w;
}

function accuracy(weights, X, y) {
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = predictProb(weights, X[i]) >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  return X.length ? correct / X.length : 0;
}

/** AUC (Mann-Whitney) su validation. */
function auc(weights, X, y) {
  const scores = X.map(x => predictProb(weights, x));
  const pos = [], neg = [];
  for (let i = 0; i < y.length; i++) (y[i] ? pos : neg).push(scores[i]);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const sp of pos) for (const sn of neg) wins += sp > sn ? 1 : (sp === sn ? 0.5 : 0);
  return wins / (pos.length * neg.length);
}

/**
 * Allena il modello su candele storiche.
 * @returns { weights, mu, sigma, quality, params, trainedAt, featureNames }
 */
export async function train(coin, interval, opts = {}) {
  const lookbackDays = opts.lookbackDays || P.lookbackDays;
  const lookforward = opts.lookforward || P.lookforward;
  const threshold = opts.threshold ?? P.threshold;

  let candles = await fetchCandles(coin, interval, lookbackDays);
  if (candles.length > P.candleCap) candles = candles.slice(candles.length - P.candleCap);
  if (candles.length < WARMUP + lookforward + 80) {
    return { error: 'Dati storici insufficienti per addestrare il modello', candles: candles.length };
  }

  // Costruzione dataset (feature → label)
  const rawRows = [], labels = [];
  for (let i = WARMUP; i < candles.length - lookforward; i++) {
    const f = featuresAt(candles, i);
    if (!f) continue;
    const fwdRet = (candles[i + lookforward].c - candles[i].c) / candles[i].c;
    rawRows.push(f);
    labels.push(fwdRet > threshold ? 1 : 0);
  }
  if (rawRows.length < 100) {
    return { error: 'Campioni insufficienti dopo il calcolo delle feature', samples: rawRows.length };
  }

  const { X, mu, sigma } = standardize(rawRows);

  // Split temporale train/validation (ultimo 20% = validation)
  const splitIdx = Math.floor(X.length * 0.8);
  const Xtr = X.slice(0, splitIdx), ytr = labels.slice(0, splitIdx);
  const Xva = X.slice(splitIdx), yva = labels.slice(splitIdx);

  const weights = trainLogistic(Xtr, ytr);

  const valAcc = accuracy(weights, Xva, yva);
  const posRate = yva.reduce((s, v) => s + v, 0) / yva.length;
  const baseline = Math.max(posRate, 1 - posRate);
  const valAuc = auc(weights, Xva, yva);

  const model = {
    coin, interval,
    weights, mu, sigma,
    featureNames: FEATURE_NAMES,
    params: { lookforward, threshold, lookbackDays },
    quality: {
      accuracy: valAcc,
      baseline,
      auc: valAuc,
      samples: X.length,
      valSamples: Xva.length,
      posRate
    },
    trainedAt: Date.now()
  };

  cache.set(`${coin}_${interval}`, model);
  try { db.setSetting(`ml_model_${coin}_${interval}`, JSON.stringify(model)); } catch (e) { logger.warn('ML: persistenza modello fallita', e.message); }

  logger.info(`🧠 Modello ML allenato ${coin}/${interval}: acc ${(valAcc * 100).toFixed(1)}% (baseline ${(baseline * 100).toFixed(1)}%, n=${X.length})`);
  return model;
}

/** Carica il modello da cache o DB (null se assente). */
export function getModel(coin, interval) {
  const key = `${coin}_${interval}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const raw = db.getSetting(`ml_model_${coin}_${interval}`);
    if (raw) {
      const m = JSON.parse(raw);
      cache.set(key, m);
      return m;
    }
  } catch { /* noop */ }
  return null;
}

/**
 * Stima la probabilità di rialzo per la candela più recente.
 * Riaddestra automaticamente se il modello manca.
 * @returns { probUp, model: { accuracy, baseline, auc, samples, trainedAt }, hasEdge }
 */
export async function predict(coin, interval, opts = {}) {
  let model = getModel(coin, interval);
  if (!model || opts.retrain) {
    model = await train(coin, interval, opts);
    if (model.error) return model;
  }

  const candles = await fetchCandles(coin, interval, opts.lookbackDays || P.lookbackDays);
  if (candles.length < WARMUP + 6) return { error: 'Dati insufficienti per la previsione' };

  const f = featuresAt(candles, candles.length - 1);
  if (!f) return { error: 'Feature non calcolabili sulla candela corrente' };

  const xStd = applyStd(f, model.mu, model.sigma);
  const probUp = predictProb(model.weights, xStd);
  const edgeMargin = model.quality.accuracy - model.quality.baseline;

  return {
    probUp,
    hasEdge: edgeMargin > 0.02, // almeno 2 punti sopra la baseline
    model: {
      accuracy: model.quality.accuracy,
      baseline: model.quality.baseline,
      auc: model.quality.auc,
      samples: model.quality.samples,
      trainedAt: model.trainedAt,
      params: model.params
    }
  };
}

export default { train, predict, getModel };
