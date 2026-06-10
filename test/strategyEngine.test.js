import { test } from 'node:test';
import assert from 'node:assert/strict';
import strategyEngine from '../src/perps/strategyEngine.js';

const candles = Array.from({ length: 60 }, (_, i) => ({ o: 100, h: 101, l: 99, c: 100 + i * 0.01 }));

test('regola price: apre long se prezzo sotto soglia', () => {
  const config = { entryRules: [{ type: 'price', op: '<', value: 200, signal: 'long' }] };
  const dec = strategyEngine.evaluate(config, { coin: 'X-PERP', price: 100, candles }, { inPosition: false });
  assert.equal(dec.action, 'open_long');
});

test('regola price: hold se condizione non soddisfatta', () => {
  const config = { entryRules: [{ type: 'price', op: '<', value: 50, signal: 'long' }] };
  const dec = strategyEngine.evaluate(config, { coin: 'X-PERP', price: 100, candles }, { inPosition: false });
  assert.equal(dec.action, 'hold');
});

test('direzione "short" blocca un segnale long', () => {
  const config = { direction: 'short', entryRules: [{ type: 'price', op: '<', value: 200, signal: 'long' }] };
  const dec = strategyEngine.evaluate(config, { coin: 'X-PERP', price: 100, candles }, { inPosition: false });
  assert.equal(dec.action, 'hold');
});

test('in posizione: chiude se regola di uscita soddisfatta', () => {
  const config = { exitRules: [{ type: 'price', op: '>', value: 50, signal: 'close' }] };
  const dec = strategyEngine.evaluate(config, { coin: 'X-PERP', price: 100, candles }, { inPosition: true, side: 'long' });
  assert.equal(dec.action, 'close');
});

test('logic "all": apre solo se tutte le regole sono vere', () => {
  const config = {
    logic: 'all',
    entryRules: [
      { type: 'price', op: '<', value: 200, signal: 'long' },
      { type: 'price', op: '>', value: 50, signal: 'long' }
    ]
  };
  const dec = strategyEngine.evaluate(config, { coin: 'X-PERP', price: 100, candles }, { inPosition: false });
  assert.equal(dec.action, 'open_long');
});

test('nessuna regola d\'ingresso → hold', () => {
  const dec = strategyEngine.evaluate({ entryRules: [] }, { coin: 'X-PERP', price: 100, candles }, { inPosition: false });
  assert.equal(dec.action, 'hold');
});
