import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { requireAuth, issueToken, COOKIE } from '../src/middleware/auth.js';

// #75 — requireAuth accetta come credenziale macchina SOLO HERMES_API_KEY, solo
// via header (Bearer o x-api-key), con confronto timing-safe. I due segreti
// crittografici (sessione e cifratura delle chiavi agent) non sono mai API key.
//
// Le variabili sono impostate qui dentro (non da riga di comando) e ripristinate
// dopo ogni test. Valori casuali: nessun segreto reale passa da questo file.

const VARS = ['APP_PASSWORD_HASH', 'SESSION_SECRET', 'AGENT_ENCRYPTION_KEY', 'HERMES_API_KEY'];
let saved;
let SESSION;
let ENCRYPTION;
let MACHINE;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  SESSION = crypto.randomBytes(32).toString('hex');
  ENCRYPTION = crypto.randomBytes(32).toString('hex');
  MACHINE = crypto.randomBytes(32).toString('hex');
  // Un hash qualsiasi basta: isAuthEnabled() guarda solo la presenza.
  process.env.APP_PASSWORD_HASH = 'scrypt$00$00';
  process.env.SESSION_SECRET = SESSION;
  process.env.AGENT_ENCRYPTION_KEY = ENCRYPTION;
  process.env.HERMES_API_KEY = MACHINE;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Esegue requireAuth su una richiesta finta; ritorna 'next' oppure lo status. */
function run({ headers = {}, query = {}, cookies = {} } = {}) {
  let outcome = null;
  const res = {
    status(code) { outcome = code; return this; },
    json() { return this; }
  };
  requireAuth({ headers, query, cookies }, res, () => { outcome = 'next'; });
  return outcome;
}

test('HERMES_API_KEY corretta via Bearer → passa', () => {
  assert.equal(run({ headers: { authorization: `Bearer ${MACHINE}` } }), 'next');
});

test('HERMES_API_KEY corretta via x-api-key → passa', () => {
  assert.equal(run({ headers: { 'x-api-key': MACHINE } }), 'next');
});

test('HERMES_API_KEY via query ?apiKey= → 401 (la query non è più un trasporto)', () => {
  assert.equal(run({ query: { apiKey: MACHINE } }), 401);
});

test('SESSION_SECRET come Bearer o x-api-key → 401', () => {
  assert.equal(run({ headers: { authorization: `Bearer ${SESSION}` } }), 401);
  assert.equal(run({ headers: { 'x-api-key': SESSION } }), 401);
});

test('AGENT_ENCRYPTION_KEY come Bearer o x-api-key → 401', () => {
  assert.equal(run({ headers: { authorization: `Bearer ${ENCRYPTION}` } }), 401);
  assert.equal(run({ headers: { 'x-api-key': ENCRYPTION } }), 401);
});

test('chiave sbagliata della stessa lunghezza → 401', () => {
  const wrong = crypto.randomBytes(32).toString('hex');
  assert.equal(wrong.length, MACHINE.length);
  assert.equal(run({ headers: { authorization: `Bearer ${wrong}` } }), 401);
  assert.equal(run({ headers: { 'x-api-key': wrong } }), 401);
});

test('HERMES_API_KEY non impostata: Bearer vuoto / x-api-key vuoto → 401', () => {
  delete process.env.HERMES_API_KEY;
  assert.equal(run({ headers: { authorization: 'Bearer ' } }), 401);
  assert.equal(run({ headers: { authorization: 'Bearer    ' } }), 401);
  assert.equal(run({ headers: { 'x-api-key': '' } }), 401);
});

test('HERMES_API_KEY vuota: Bearer vuoto → 401', () => {
  process.env.HERMES_API_KEY = '';
  assert.equal(run({ headers: { authorization: 'Bearer ' } }), 401);
  assert.equal(run({ headers: { 'x-api-key': '' } }), 401);
});

test('HERMES_API_KEY troppo corta (< 24 caratteri) → ignorata, 401 anche se combacia', () => {
  process.env.HERMES_API_KEY = 'corta-1234';
  assert.equal(run({ headers: { authorization: 'Bearer corta-1234' } }), 401);
  assert.equal(run({ headers: { 'x-api-key': 'corta-1234' } }), 401);
});

test('HERMES_API_KEY uguale a un segreto crittografico → ignorata, 401', () => {
  process.env.HERMES_API_KEY = ENCRYPTION;
  assert.equal(run({ headers: { 'x-api-key': ENCRYPTION } }), 401);
  process.env.HERMES_API_KEY = SESSION;
  assert.equal(run({ headers: { authorization: `Bearer ${SESSION}` } }), 401);
});

test('x-api-key non stringa (header ripetuto come array) → 401, nessuna eccezione', () => {
  assert.equal(run({ headers: { 'x-api-key': [MACHINE, MACHINE] } }), 401);
});

test('cookie di sessione valido → passa (percorso invariato)', () => {
  assert.equal(run({ cookies: { [COOKIE]: issueToken() } }), 'next');
});

test('token di sessione firmato via Bearer → passa (percorso invariato)', () => {
  assert.equal(run({ headers: { authorization: `Bearer ${issueToken()}` } }), 'next');
});

test('nessuna credenziale → 401', () => {
  assert.equal(run(), 401);
});
