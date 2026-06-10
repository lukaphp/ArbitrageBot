import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/perps/retry.js';

test('ritorna subito al primo successo', async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return 'ok'; }, { retries: 3, baseMs: 1 });
  assert.equal(r, 'ok');
  assert.equal(calls, 1);
});

test('ritenta gli errori transitori (429) e poi riesce', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 3) { const e = new Error('rate'); e.response = { status: 429, headers: {} }; throw e; }
    return 'recovered';
  }, { retries: 5, baseMs: 1 });
  assert.equal(r, 'recovered');
  assert.equal(calls, 3);
});

test('NON ritenta i 4xx non-transitori (es. 400)', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls++; const e = new Error('bad'); e.response = { status: 400, headers: {} }; throw e;
  }, { retries: 5, baseMs: 1 }));
  assert.equal(calls, 1);
});

test('si arrende dopo retries tentativi', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls++; const e = new Error('boom'); e.code = 'ETIMEDOUT'; throw e;
  }, { retries: 2, baseMs: 1 }));
  assert.equal(calls, 3); // 1 iniziale + 2 retry
});
