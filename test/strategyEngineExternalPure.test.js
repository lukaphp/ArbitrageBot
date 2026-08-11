/**
 * QUAL-01 item 1 — valutazione di sola lettura senza effetti collaterali.
 * =====================================================================
 *
 * `evaluate()` leggeva i segnali esterni con `_consumeExternal()`, che modifica la
 * coda (elimina i segnali scaduti). Qualunque percorso DIAGNOSTICO che valuti lo
 * stesso snapshot cambiava quindi ciò che il tick successivo avrebbe visto.
 *
 * PRECISAZIONE sul difetto, verificata sul codice: il segnale NON veniva
 * consumato quando c'era un match — solo eliminato se scaduto. Il caso descritto
 * dall'audit ("la seconda valutazione non lo trova perché la prima l'ha
 * consumato") non poteva verificarsi in quella forma, e la semantica di consumo
 * non è stata cambiata: farlo cambierebbe il comportamento di trading (un webhook
 * che oggi vale 5 minuti smetterebbe di valere dopo il primo tick), fuori scope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import strategyEngine from '../src/perps/strategyEngine.js';

const CONFIG = { entryRules: [{ type: 'external', signal: 'long' }], direction: 'both' };
const snapshot = (coin) => ({ coin, price: 100, candles: [], funding: null });

test('_checkExternal è puro: non rimuove nulla dalla coda, nemmeno se scaduto', () => {
  const coin = 'PURE1-PERP';
  strategyEngine.pushExternalSignal(coin, 'long');
  assert.equal(strategyEngine._checkExternal(coin), 'long');
  assert.equal(strategyEngine.externalSignals.has(coin), true, 'la coda è intatta');

  // Segnale scaduto: `_checkExternal` lo ignora ma NON lo elimina…
  strategyEngine.externalSignals.set(coin, { signal: 'long', ts: Date.now() - 10 * 60 * 1000 });
  assert.equal(strategyEngine._checkExternal(coin), null, 'scaduto: non vale');
  assert.equal(strategyEngine.externalSignals.has(coin), true,
    'una lettura pura non deve modificare la coda');

  // …mentre `_consumeExternal` (percorso di trading reale) fa la pulizia come prima.
  assert.equal(strategyEngine._consumeExternal(coin), null);
  assert.equal(strategyEngine.externalSignals.has(coin), false, 'pulizia invariata nel loop reale');
});

test('evaluate({ consume: false }): stesso verdetto, zero effetti collaterali', () => {
  const coin = 'PURE2-PERP';
  strategyEngine.externalSignals.set(coin, { signal: 'long', ts: Date.now() - 10 * 60 * 1000 });

  const diag = strategyEngine.evaluate(CONFIG, snapshot(coin), {}, { consume: false });
  assert.equal(diag.action, 'hold', 'segnale scaduto: nessun ingresso');
  assert.equal(strategyEngine.externalSignals.has(coin), true,
    'la diagnostica non ha ripulito la coda al posto del loop');

  const real = strategyEngine.evaluate(CONFIG, snapshot(coin), {});
  assert.equal(real.action, 'hold');
  assert.equal(strategyEngine.externalSignals.has(coin), false,
    'il loop reale mantiene il comportamento di sempre');
});

test('segnale valido: stesso esito dalle due strade (nessuna divergenza di verdetto)', () => {
  const coin = 'PURE3-PERP';
  strategyEngine.pushExternalSignal(coin, 'long');

  const diag = strategyEngine.evaluate(CONFIG, snapshot(coin), {}, { consume: false });
  const real = strategyEngine.evaluate(CONFIG, snapshot(coin), {});
  assert.equal(diag.action, 'open_long');
  assert.equal(real.action, 'open_long');
  assert.equal(diag.reason, real.reason);
});

test('la firma di evaluate() resta compatibile con i chiamanti esistenti', () => {
  // bot.js e backtester.js chiamano evaluate(config, snapshot, state): il quarto
  // parametro non deve essere obbligatorio né cambiare il default.
  const coin = 'PURE4-PERP';
  strategyEngine.pushExternalSignal(coin, 'long');
  const decision = strategyEngine.evaluate(CONFIG, snapshot(coin), { inPosition: false });
  assert.equal(decision.action, 'open_long');
});
