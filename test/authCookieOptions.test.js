import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieOptions } from '../src/middleware/auth.js';

// cookieOptions() legge process.env a ogni chiamata (nessun caching a livello
// modulo), quindi manipolare le variabili direttamente nel test è sicuro.
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('produzione senza override: cookie Secure (comportamento storico, dominio HTTPS pubblico)', () => {
  withEnv({ NODE_ENV: 'production', COOKIE_SECURE: undefined }, () => {
    assert.equal(cookieOptions().secure, true);
  });
});

test('produzione con COOKIE_SECURE=false: cookie NON Secure (deploy HTTP puro, es. Tailscale)', () => {
  withEnv({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }, () => {
    assert.equal(cookieOptions().secure, false);
  });
});

test('sviluppo senza override: cookie NON Secure (comportamento storico)', () => {
  withEnv({ NODE_ENV: 'development', COOKIE_SECURE: undefined }, () => {
    assert.equal(cookieOptions().secure, false);
  });
});

test('COOKIE_SECURE=false vince anche se NODE_ENV non è production', () => {
  withEnv({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }, () => {
    assert.equal(cookieOptions().secure, false);
  });
});

test('altri campi del cookie restano invariati indipendentemente da COOKIE_SECURE', () => {
  withEnv({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }, () => {
    const opts = cookieOptions();
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.sameSite, 'strict');
    assert.equal(opts.path, '/');
    assert.ok(opts.maxAge > 0);
  });
});
