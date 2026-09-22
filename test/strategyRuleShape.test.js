/**
 * FORMA DELLE REGOLE DI STRATEGIA — OPS-FLEET-02
 * ==============================================
 *
 * Riproduce il difetto P1 della flotta OPS-FLEET-02: 6 bot RSI in esecuzione per
 * ~46 ore senza produrre MAI un segnale diverso da `hold`, mentre l'RSI reale di
 * mercato attraversava le soglie configurate decine di volte per coin.
 *
 * La config qui sotto NON è inventata: è copiata testualmente da
 * `bots.config_json` in produzione (BTC/SOL "JEV Verified Bot"). Rispetto al
 * formato canonico (`STRATEGY_TEMPLATES` in `agents/analyst/tools.js`) devia su
 * due campi, e **ognuna delle due deviazioni da sola** basta a inchiodare il bot
 * su `hold` per sempre:
 *
 *   1. manca `type: 'indicator'` → `_evalRule` finisce sul ramo `default` e
 *      ritorna `match:false` SENZA dire niente a nessuno;
 *   2. `signal: 'open_long'` invece di `'long'` → il controllo di direzione non
 *      riconosce il segnale e ritorna `hold` con la motivazione fuorviante
 *      «non consentito (direzione: both)», che è falsa: `both` consente tutto.
 *
 * Le candele sono sintetiche ma deterministiche: una discesa/salita monotona
 * porta l'RSI(14) agli estremi, quindi la soglia è attraversata senza ambiguità
 * e il test non dipende da dati di mercato scaricati a runtime.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import strategyEngine from '../src/perps/strategyEngine.js';
import * as ind from '../src/perps/indicators.js';
import { normalizeStrategyConfig } from '../src/perps/strategySchema.js';

/** Serie di candele con variazione percentuale costante: RSI(14) → 0 o → 100. */
function trendCandles(pct, n = 60, start = 100) {
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = px * (1 + pct);
    out.push({ t: 1758000000000 + i * 60000, o: String(o), h: String(Math.max(o, px)), l: String(Math.min(o, px)), c: String(px), v: '1' });
  }
  return out;
}

const giu = trendCandles(-0.005); // ipervenduto
const su = trendCandles(+0.005);  // ipercomprato

const snap = (candles) => ({
  coin: 'BTC-PERP',
  price: parseFloat(candles[candles.length - 1].c),
  candles,
  ts: Date.now()
});

const FLAT = { inPosition: false };

// Config testuale di produzione (BTC-PERP "JEV Verified Bot", soglie 30/70).
const PROD_BTC = {
  strategy: 'rsi_reversal',
  candleInterval: '1m',
  logic: 'any',
  leverage: 2,
  entryRules: [
    { indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'open_long' },
    { indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'open_short' }
  ]
};

test('le candele di prova attraversano davvero le soglie (premessa del test)', () => {
  assert.ok(ind.rsi(giu, 14) < 30, `RSI atteso < 30, ottenuto ${ind.rsi(giu, 14)}`);
  assert.ok(ind.rsi(su, 14) > 70, `RSI atteso > 70, ottenuto ${ind.rsi(su, 14)}`);
});

test('OPS-FLEET-02: la config reale di produzione apre long con RSI sotto soglia', () => {
  const dec = strategyEngine.evaluate(PROD_BTC, snap(giu), FLAT);
  assert.equal(dec.action, 'open_long', `atteso open_long, ottenuto ${dec.action} (${dec.reason})`);
});

test('OPS-FLEET-02: la config reale di produzione apre short con RSI sopra soglia', () => {
  const dec = strategyEngine.evaluate(PROD_BTC, snap(su), FLAT);
  assert.equal(dec.action, 'open_short', `atteso open_short, ottenuto ${dec.action} (${dec.reason})`);
});

test('difetto 1 isolato: regola indicator senza campo `type`', () => {
  const config = { logic: 'any', entryRules: [{ indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }] };
  assert.equal(strategyEngine.evaluate(config, snap(giu), FLAT).action, 'open_long');
});

test('difetto 2 isolato: signal `open_long`/`open_short` invece di `long`/`short`', () => {
  const long = { logic: 'any', entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'open_long' }] };
  const short = { logic: 'any', entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'open_short' }] };
  assert.equal(strategyEngine.evaluate(long, snap(giu), FLAT).action, 'open_long');
  assert.equal(strategyEngine.evaluate(short, snap(su), FLAT).action, 'open_short');
});

test('anche una regola price senza `type` ma con soglia resta NON riconosciuta (nessuna deduzione a indovinare)', () => {
  // `op`+`value` senza `indicator` è ambiguo (price? funding?): non si inventa un
  // tipo. Deve restare hold, ma il motivo deve dirlo invece di tacere.
  const config = { logic: 'any', entryRules: [{ op: '<', value: 999999, signal: 'long' }] };
  const dec = strategyEngine.evaluate(config, snap(giu), FLAT);
  assert.equal(dec.action, 'hold');
  assert.match(dec.reason, /non valutabil/i, `il motivo deve dichiarare la regola non valutabile, era: "${dec.reason}"`);
});

test('regola di uscita senza `type`: la posizione viene comunque chiusa', () => {
  // Stessa classe di difetto sul lato uscita — lì il costo è una posizione che
  // non si chiude mai sulla regola che l'operatore ha configurato.
  const config = { exitRules: [{ indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'close' }] };
  const dec = strategyEngine.evaluate(config, snap(su), { inPosition: true, side: 'long' });
  assert.equal(dec.action, 'close');
});

test('la direzione consentita continua a valere anche sui segnali normalizzati', () => {
  const config = { direction: 'short', logic: 'any', entryRules: [{ indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'open_long' }] };
  assert.equal(strategyEngine.evaluate(config, snap(giu), FLAT).action, 'hold');
});

test('normalizzazione pura: la config in ingresso non viene mutata', () => {
  const before = JSON.stringify(PROD_BTC);
  const { config, changes } = normalizeStrategyConfig(PROD_BTC);
  assert.equal(JSON.stringify(PROD_BTC), before, 'normalizeStrategyConfig ha mutato la config originale');
  assert.equal(config.entryRules[0].type, 'indicator');
  assert.equal(config.entryRules[0].signal, 'long');
  assert.equal(config.entryRules[1].signal, 'short');
  assert.ok(changes.length >= 2, 'le correzioni applicate devono essere riportate, non silenziose');
});

test('normalizzazione idempotente: una config già canonica non cambia e non segnala nulla', () => {
  const canon = {
    direction: 'both', logic: 'any',
    entryRules: [
      { type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' },
      { type: 'indicator', indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'short' }
    ],
    exitRules: []
  };
  const { config, changes } = normalizeStrategyConfig(canon);
  assert.equal(changes.length, 0);
  assert.deepEqual(config, canon);
  assert.equal(strategyEngine.evaluate(canon, snap(giu), FLAT).action, 'open_long');
});

test('regole non valutabili: elencate dal normalizzatore, non ignorate in silenzio', () => {
  const config = { entryRules: [{ type: 'pinco', op: '<', value: 1, signal: 'long' }, { indicator: 'rsi', op: '<', value: 30, signal: 'long' }] };
  const { unevaluable } = normalizeStrategyConfig(config);
  assert.equal(unevaluable.length, 1, 'solo la regola di tipo sconosciuto resta non valutabile');
  assert.match(unevaluable[0], /pinco/);
});
