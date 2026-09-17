import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, withTimeout } from '../src/perps/retry.js';

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

// --- Timeout esplicito ---------------------------------------------------
// Una fn() che non si risolve MAI (è il caso reale: il rate limiter interno
// dell'SDK Hyperliquid fa morire di fame le richieste di peso 20 e la loro
// promise resta pendente per sempre) deve diventare un errore gestito, non un
// blocco infinito: `withRetry` da sola non può accorgersene, perché ritenta
// solo DOPO un errore.

test('withTimeout: una fn che non si risolve mai diventa un errore', async () => {
  const started = Date.now();
  await assert.rejects(
    () => withTimeout(() => new Promise(() => { /* mai */ }), 30, 'mai'),
    err => {
      assert.match(err.message, /timeout/i);
      assert.equal(err.code, 'ETIMEDOUT'); // transitorio ⇒ ritentabile
      return true;
    }
  );
  assert.ok(Date.now() - started < 2000);
});

test('withTimeout: lascia passare il risultato se la fn risponde in tempo', async () => {
  assert.equal(await withTimeout(async () => 'ok', 1000, 'veloce'), 'ok');
});

test('withTimeout: propaga l\'errore della fn senza mascherarlo', async () => {
  await assert.rejects(
    () => withTimeout(async () => { throw new Error('errore vero'); }, 1000, 'x'),
    /errore vero/
  );
});

test('withTimeout: ms nullo o zero disattiva il timeout (nessun timer appeso)', async () => {
  assert.equal(await withTimeout(async () => 'ok', 0, 'x'), 'ok');
  assert.equal(await withTimeout(async () => 'ok', null, 'x'), 'ok');
});

test('withRetry: timeoutMs ritenta la fn appesa e poi si arrende', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(() => {
    calls++;
    return new Promise(() => { /* mai */ });
  }, { retries: 2, baseMs: 1, timeoutMs: 20, metric: null }), /timeout/i);
  assert.equal(calls, 3); // 1 iniziale + 2 retry, nessuno dei quali si è mai risolto
});

test('withRetry: una fn che risponde prima del timeout non viene disturbata', async () => {
  const r = await withRetry(async () => 'ok', { retries: 2, baseMs: 1, timeoutMs: 1000 });
  assert.equal(r, 'ok');
});

// Se il timer del timeout non venisse cancellato dopo una fn veloce, questo
// processo di test resterebbe vivo per tutta la durata del timeout: la suite
// deve terminare da sola (regressione di `npm test` che non finiva mai).
test('withRetry: il timer del timeout non tiene vivo il processo', async () => {
  await withRetry(async () => 'ok', { retries: 0, timeoutMs: 60_000 });
  assert.ok(true);
});
