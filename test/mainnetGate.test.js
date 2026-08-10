/**
 * isMainnetAllowed() — unica fonte di verità per "mainnet è consentita".
 * =========================================================================
 *
 * Scoperto durante EVM-01 (9-10 agosto): POST /api/perps/network verificava
 * solo un flag `confirm` che il client si autoassegna col dialogo del
 * browser — mai ALLOW_MAINNET lato server. Lo switch a mainnet a runtime era
 * di fatto aperto anche su un deploy che dichiara di non volerlo permettere.
 * validateConfig() ora usa la stessa funzione, non una copia del controllo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMainnetAllowed } from '../src/config/config.js';

function withEnv(value, fn) {
  const prev = process.env.ALLOW_MAINNET;
  try {
    if (value === undefined) delete process.env.ALLOW_MAINNET;
    else process.env.ALLOW_MAINNET = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ALLOW_MAINNET;
    else process.env.ALLOW_MAINNET = prev;
  }
}

test('isMainnetAllowed(): false se ALLOW_MAINNET non è impostata', () => {
  withEnv(undefined, () => assert.equal(isMainnetAllowed(), false));
});

test('isMainnetAllowed(): false su qualunque valore diverso da "true" (stringa esatta)', () => {
  withEnv('1', () => assert.equal(isMainnetAllowed(), false));
  withEnv('yes', () => assert.equal(isMainnetAllowed(), false));
  withEnv('True', () => assert.equal(isMainnetAllowed(), false)); // case-sensitive di proposito
});

test('isMainnetAllowed(): true solo con la stringa esatta "true"', () => {
  withEnv('true', () => assert.equal(isMainnetAllowed(), true));
});
