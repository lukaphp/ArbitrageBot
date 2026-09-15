/**
 * Validazione di `config.partialTp` (scala di take profit parziali).
 * ==================================================================
 *
 * Il difetto chiuso qui: `validateStrategyConfig` girava su
 * `['tp', 'sl', 'trailing']` e NON guardava `partialTp`, che ha una forma
 * diversa (una lista di gradini, non un blocco `{enabled, mode, value}`). Una
 * scala malformata attraversava quindi in silenzio sia l'import di strategie sia
 * `update_strategy_params`, e arrivava intatta fino a `bot._placeTpSl`.
 *
 * Perché il silenzio è la parte grave, e non "tanto poi fallisce a valle":
 * `riskManager.computeTpLadder` FILTRA i gradini che non soddisfano
 * `portion > 0 && atPercent > 0`. Un gradino scritto male non produce un errore:
 * sparisce. Il bot opera con una scala di uscita diversa da quella scritta in
 * configurazione, e il solo modo di accorgersene è contare i trigger
 * sull'exchange — cioè guardare i soldi, non i log. I tre casi che contano sono
 * `portion` espressa come percentuale (50 invece di 0.5), un gradino non
 * numerico, e una somma delle porzioni oltre il 100% della posizione.
 *
 * Seam: funzione pura, nessun DB, nessuna rete. È lo stesso motivo per cui la
 * validazione vive in `strategySchema.js` e non dentro le route.
 *
 * Cosa NON copre: il comportamento di `_placeTpSl` con una scala valida — quello
 * è già coperto da `test/botTpSweep.test.js` sul percorso broker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateStrategyConfig } from '../src/perps/strategySchema.js';

/** Config minima valida a cui agganciare la sola variazione sotto esame. */
const withPartialTp = (partialTp) => ({
  candleInterval: '5m',
  entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30 }],
  partialTp
});

const errorsFor = (partialTp) => validateStrategyConfig(withPartialTp(partialTp));

test('partialTp assente: nessun errore (resta un campo opzionale)', () => {
  const cfg = withPartialTp(undefined);
  delete cfg.partialTp;
  assert.deepEqual(validateStrategyConfig(cfg), []);
});

test('partialTp valido: un gradino al 50% a +1.5% passa', () => {
  assert.deepEqual(errorsFor([{ portion: 0.5, atPercent: 1.5 }]), []);
});

test('partialTp valido: scala a più gradini con somma esattamente 1', () => {
  assert.deepEqual(errorsFor([
    { portion: 0.3, atPercent: 1 },
    { portion: 0.3, atPercent: 2 },
    { portion: 0.4, atPercent: 3 }
  ]), [], 'la somma 0.3+0.3+0.4 vale 1.0000000000000002 in virgola mobile: non deve essere un falso positivo');
});

test('partialTp lista vuota: ammessa (è "nessun parziale", non un errore)', () => {
  assert.deepEqual(errorsFor([]), []);
});

test('partialTp non è una lista → rifiutato', () => {
  const errs = errorsFor({ portion: 0.5, atPercent: 1.5 });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /deve essere una lista/);
});

test('portion espressa come PERCENTUALE (50 invece di 0.5) → rifiutata', () => {
  // Il caso che il filtro di computeTpLadder lascerebbe passare: 50 > 0, quindi
  // il gradino sopravvive e chiede di chiudere cinquanta volte la posizione.
  const errs = errorsFor([{ portion: 50, atPercent: 1.5 }]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /portion non valida: 50/);
  assert.match(errs[0], /0\.5 è metà, non 50/, 'il messaggio deve dire come si corregge, non solo che è sbagliato');
});

test('portion nulla o negativa → rifiutata (computeTpLadder la scarterebbe in silenzio)', () => {
  assert.match(errorsFor([{ portion: 0, atPercent: 1.5 }])[0], /portion non valida: 0/);
  assert.match(errorsFor([{ portion: -0.2, atPercent: 1.5 }])[0], /portion non valida: -0\.2/);
});

test('atPercent non numerico o non positivo → rifiutato', () => {
  assert.match(errorsFor([{ portion: 0.5, atPercent: '1.5' }])[0], /atPercent non valido: "1\.5"/);
  assert.match(errorsFor([{ portion: 0.5, atPercent: 0 }])[0], /atPercent non valido: 0/);
});

test('gradino che non è un oggetto → rifiutato, indicando QUALE gradino', () => {
  const errs = errorsFor([{ portion: 0.5, atPercent: 1.5 }, null]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /gradino 2/, 'l\'indice serve a trovare la voce rotta in una scala lunga');
});

test('somma delle portion oltre 1 → rifiutata (chiuderebbe più size di quanta ne esista)', () => {
  const errs = errorsFor([
    { portion: 0.6, atPercent: 1 },
    { portion: 0.6, atPercent: 2 }
  ]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /somma delle portion è 1\.2000/);
});

test('un gradino rotto NON viene conteggiato nella somma (niente doppio errore fuorviante)', () => {
  // portion: 50 è già segnalata come gradino invalido; sommarla darebbe anche
  // un secondo errore "somma oltre 1" che non aiuta a capire cosa correggere.
  const errs = errorsFor([{ portion: 50, atPercent: 1.5 }, { portion: 0.5, atPercent: 3 }]);
  assert.equal(errs.length, 1, `atteso un solo errore, ricevuti: ${JSON.stringify(errs)}`);
  assert.match(errs[0], /portion non valida/);
});

test('gli errori di partialTp portano il prefisso della voce, come tutti gli altri', () => {
  const errs = validateStrategyConfig(withPartialTp([{ portion: 2, atPercent: 1 }]), { prefix: 'voce 1 (SOL-PERP): ' });
  assert.match(errs[0], /^voce 1 \(SOL-PERP\): /);
});

test('la config della flotta reale (50% a +1.5%) passa insieme a trailing e sl', () => {
  // È esattamente il payload della Parte A: serve che la validazione nuova non
  // rifiuti la configurazione che si vuole spingere in produzione.
  const errs = validateStrategyConfig({
    candleInterval: '5m',
    entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30 }],
    leverage: 2,
    sl: { enabled: true, mode: 'percent', value: 1.5 },
    tp: { enabled: true, mode: 'percent', value: 3 },
    partialTp: [{ portion: 0.5, atPercent: 1.5 }],
    trailing: { enabled: true, mode: 'percent', value: 1.5 }
  });
  assert.deepEqual(errs, []);
});
