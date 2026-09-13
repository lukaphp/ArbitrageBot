/**
 * Diagnostica del Monitor — formattazione dei valori non disponibili.
 * ==================================================================
 *
 * Bug segnalato dalla WebUI: nella card "Monitor" le condizioni d'ingresso
 * mostravano `deve scendere di NaN pt (ora 46.80 pt, soglia — pt)`.
 *
 * La causa è in `_diagRule` (`src/perps/bot.js`): l'helper locale `fmt`
 * guardava solo `null`, mentre `num` guardava già sia `null` sia `NaN`. Con una
 * regola priva di soglia (`rule.value` non impostato) `Math.abs(cur - target)`
 * vale `NaN`, e `NaN == null` è `false`: si finiva su `NaN.toFixed(2)` → la
 * stringa `"NaN"` a schermo. Il frontend non c'entra: `_renderMonitor`/`ruleRow`
 * interpolano `hint`/`current`/`target` senza fare calcoli.
 *
 * `fmt` è condiviso da tutti i rami di `_diagRule` (price, funding, rsi, adx,
 * ema/sma, macd, bollinger): qui si verifica su due unità diverse ($ e pt) per
 * fissare il comportamento dell'helper, non di un singolo tipo di regola.
 *
 * Il segnaposto atteso è `'—'`, lo stesso già usato in tutto il metodo per
 * "valore non disponibile" — nessuna stringa nuova introdotta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import marketData from '../src/perps/marketData.js';
import * as ind from '../src/perps/indicators.js';
import db from '../src/db/database.js';
import { PerpsBot } from '../src/perps/bot.js';

// DB isolato: la diagnostica non deve mai toccare data/perps.db.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-mondiag-'));
db.dbPath = path.join(tempDir, 'perps.db');

const PRICE = 46.8;
client.getMid = async () => PRICE;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

/**
 * Serie reale (non finta): 30 chiusure miste che danno RSI(14) = 49.32, cioè un
 * `cur` numerico valido. Serve perché il bug si manifesta solo quando il valore
 * corrente C'È e manca la soglia: se `cur` fosse `null` `gapHint` uscirebbe
 * prima con "dato non ancora disponibile" e il NaN non si vedrebbe mai.
 */
const CLOSES = [
  100, 101, 100.5, 102, 101.2, 103, 102.4, 104, 103.1, 105,
  104.2, 103.5, 104.8, 103.9, 105.2, 104.1, 103.2, 104.5, 103.6, 102.8,
  103.9, 102.7, 104.1, 103.0, 102.2, 103.4, 102.5, 101.8, 102.9, 101.9
];
const CANDLES = CLOSES.map((c, i) => ({
  t: i, o: String(c), h: String(c + 0.5), l: String(c - 0.5), c: String(c), v: '1'
}));

const RSI_NOW = ind.rsi(CANDLES, 14);

marketData.getSnapshot = async () => ({ coin: 'MD-PERP', price: PRICE, candles: CANDLES, funding: null });
marketData.getMarkets = () => [];

function bot(config) {
  return new PerpsBot({
    id: `md-${Math.random().toString(36).slice(2)}`, name: 'MonDiag', coin: 'MD-PERP', network: 'testnet',
    master_address: '0xMONDIAG', config_json: JSON.stringify({ paper: true, ...config })
  }, () => {});
}

test('la serie di prova produce davvero un RSI numerico (premessa del caso)', () => {
  assert.equal(RSI_NOW, 49.32, 'se cambia la serie, cambiano le stringhe attese sotto');
});

test('regola RSI senza soglia: nessun "NaN" a schermo, ma il segnaposto —', async () => {
  // `value` assente: è esattamente la configurazione che produceva il bug.
  const b = bot({ entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.equal(rule.met, false, 'senza soglia la condizione non può risultare soddisfatta');
  assert.ok(!rule.hint.includes('NaN'), `hint non deve contenere "NaN", ricevuto: ${rule.hint}`);
  assert.equal(rule.hint, 'deve scendere di — pt (ora 49.32 pt, soglia — pt)');
  assert.equal(rule.current, '49.32', 'il valore corrente resta leggibile: manca la soglia, non il dato');
});

test('stesso caso con op ">": copre anche il ramo "salire"', async () => {
  const b = bot({ entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '>', signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.ok(!rule.hint.includes('NaN'), `hint non deve contenere "NaN", ricevuto: ${rule.hint}`);
  assert.equal(rule.hint, 'deve salire di — pt (ora 49.32 pt, soglia — pt)');
});

test('regola price senza soglia: fmt è condiviso, il fix vale per ogni unità', async () => {
  const b = bot({ entryRules: [{ type: 'price', op: '<', signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.ok(!rule.hint.includes('NaN'), `hint non deve contenere "NaN", ricevuto: ${rule.hint}`);
  assert.equal(rule.hint, 'deve scendere di —$ (ora 46.80$, soglia —$)');
});

test('le regole d\'uscita passano dallo stesso helper', async () => {
  const b = bot({
    entryRules: [{ type: 'price', op: '>', value: 1, signal: 'long' }],
    exitRules: [{ type: 'indicator', indicator: 'adx', period: 14, op: '<', signal: 'close' }]
  });

  const rule = (await b.getMonitor()).exitRules[0];

  assert.ok(!rule.hint.includes('NaN'), `hint non deve contenere "NaN", ricevuto: ${rule.hint}`);
  assert.match(rule.hint, /soglia — pt/);
});

// ---- La pill `target` (soglia configurata) ---------------------------------
//
// Secondo giro, stessa famiglia di bug: `target` nei rami RSI/ADX era costruito
// come `${rule.op} ${rule.value}` senza passare da `fmt`, quindi con la soglia
// mancante la card mostrava "< undefined". Il ramo `price` (e `ema`/`sma`) usava
// già `fmt` ed era corretto: qui i rami divergenti vengono allineati.

test('RSI senza soglia: la pill target dice "< —", non "< undefined"', async () => {
  const b = bot({ entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.ok(!rule.target.includes('undefined'), `target non deve contenere "undefined", ricevuto: ${rule.target}`);
  assert.equal(rule.target, '< —');
});

test('ADX senza soglia: stesso ramo, stesso segnaposto', async () => {
  const b = bot({ entryRules: [{ type: 'indicator', indicator: 'adx', period: 14, op: '>', signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.ok(!rule.target.includes('undefined'), `target non deve contenere "undefined", ricevuto: ${rule.target}`);
  assert.equal(rule.target, '> —');
});

test('nessun campo esposto dal monitor contiene "undefined" o "NaN"', async () => {
  // Rete di sicurezza sull'intero oggetto della regola, non solo sui due campi
  // che sapevamo bacati: se un altro ramo interpola un valore mancante, si vede qui.
  const b = bot({
    entryRules: [
      { type: 'indicator', indicator: 'rsi', period: 14, op: '<', signal: 'long' },
      { type: 'indicator', indicator: 'adx', period: 14, op: '>', signal: 'long' },
      { type: 'price', op: '<', signal: 'long' }
    ]
  });

  for (const rule of (await b.getMonitor()).entryRules) {
    const dump = JSON.stringify(rule);
    assert.ok(!dump.includes('undefined'), `regola con "undefined" a schermo: ${dump}`);
    assert.ok(!dump.includes('NaN'), `regola con "NaN" a schermo: ${dump}`);
  }
});

test('funding: la soglia NON passa da fmt, i 4 decimali si vedono ancora', async () => {
  // `fmt` arrotonda a 2 decimali: su una soglia di funding 0.0001 direbbe "0.00",
  // cioè una cosa falsa. Il ramo funding usa un formatter che preserva il valore.
  const b = bot({ entryRules: [{ type: 'funding', op: '<', value: 0.0001, signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.equal(rule.target, '< 0.0001', 'la soglia di funding non va arrotondata a 2 decimali');
});

test('funding senza soglia: "< —" invece di "< undefined"', async () => {
  const b = bot({ entryRules: [{ type: 'funding', op: '<', signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.equal(rule.target, '< —');
  assert.ok(!JSON.stringify(rule).includes('undefined'));
});

// ---- Non-regressione: il formato normale non deve cambiare -----------------

test('soglia valida: il gap resta calcolato e formattato come prima', async () => {
  const b = bot({ entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.equal(rule.met, false, 'RSI 49.32 non è < 30');
  assert.equal(rule.hint, 'deve scendere di 19.32 pt (ora 49.32 pt, soglia 30.00 pt)');
  // Passare `target` da `fmt` cambia di proposito la pill da "< 30" a "< 30.00":
  // è la stessa forma già usata dai rami price/ema/sma, e `target` è solo display
  // (unico consumatore: la pill `mon-rule-target` in public/perps.js).
  assert.equal(rule.target, '< 30.00');
});

test('soglia valida su price: due decimali e unità invariati', async () => {
  // Soglia 40 e non 50: a prezzo 46.80 un `< 50` sarebbe già soddisfatto e
  // `gapHint` uscirebbe sul ramo "condizione soddisfatta", senza formattare nulla.
  const b = bot({ entryRules: [{ type: 'price', op: '<', value: 40, signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.equal(rule.met, false);
  assert.equal(rule.hint, 'deve scendere di 6.80$ (ora 46.80$, soglia 40.00$)');
  assert.equal(rule.target, '< 40.00');
});

test('condizione soddisfatta: il ramo felice non passa da fmt', async () => {
  const b = bot({ entryRules: [{ type: 'price', op: '<', value: 100, signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.equal(rule.met, true);
  assert.equal(rule.hint, '✅ condizione soddisfatta');
});

test('valori ≥ 1000: resta l\'arrotondamento senza decimali', async () => {
  const b = bot({ entryRules: [{ type: 'price', op: '>', value: 50000, signal: 'long' }] });

  const rule = (await b.getMonitor()).entryRules[0];

  assert.equal(rule.hint, 'deve salire di 49953$ (ora 46.80$, soglia 50000$)',
    'il ramo toFixed(0) sopra 1000 non deve essere toccato dal fix');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
