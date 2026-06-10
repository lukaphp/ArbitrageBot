import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../src/perps/secretBox.js';

test('round-trip cifratura/decifratura', () => {
  const plain = '123456:ABC-DEF_token-segreto';
  const enc = encrypt(plain);
  assert.notEqual(enc, plain);
  assert.equal(decrypt(enc), plain);
});

test('il testo in chiaro non compare nel blob cifrato', () => {
  const enc = encrypt('super-secret-value');
  assert.ok(!enc.includes('super-secret-value'));
});

test('stringa vuota → vuota', () => {
  assert.equal(encrypt(''), '');
  assert.equal(decrypt(''), '');
});

test('due cifrature dello stesso testo differiscono (IV casuale)', () => {
  assert.notEqual(encrypt('x'), encrypt('x'));
});
