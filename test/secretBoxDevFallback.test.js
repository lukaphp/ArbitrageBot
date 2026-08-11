/**
 * WARN-04 — avviso esplicito quando è in uso il fallback di sviluppo.
 * =================================================================
 *
 * SEC-07 (Sprint 3) ha già chiuso il caso peggiore: con `NODE_ENV=production` e
 * chiave assente si solleva, non si ripiega. Il rischio che restava è uno
 * STAGING con dati reali avviato senza `NODE_ENV=production`: là il fallback —
 * una chiave scritta nel sorgente, quindi pubblica — resta attivo senza che nulla
 * lo dica.
 *
 * Nessun blocco: l'avviso non deve impedire lo sviluppo locale, deve rendere
 * impossibile non accorgersene.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import logger from '../src/utils/logger.js';
import { encrypt, decrypt, __resetDevFallbackWarning } from '../src/perps/secretBox.js';

const warnings = [];
const realWarn = logger.warn.bind(logger);
logger.warn = (message) => { warnings.push(String(message)); };

const KEY = 'AGENT_ENCRYPTION_KEY';
const savedKey = process.env[KEY];
const savedEnv = process.env.NODE_ENV;

function withEnv(key, nodeEnv, fn) {
  if (key === undefined) delete process.env[KEY]; else process.env[KEY] = key;
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  warnings.length = 0;
  __resetDevFallbackWarning();
  try { return fn(); } finally {
    if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
    if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
  }
}

const fallbackWarnings = () => warnings.filter(w => /FALLBACK DI SVILUPPO/.test(w));

test('chiave assente fuori produzione: avviso visibile, ma il fallback funziona', () => {
  withEnv(undefined, 'test', () => {
    const enc = encrypt('chiave-agent-finta');
    assert.equal(decrypt(enc), 'chiave-agent-finta', 'il fallback continua a funzionare (nessun blocco)');

    const warned = fallbackWarnings();
    assert.equal(warned.length, 1, 'un avviso emesso');
    assert.match(warned[0], /AGENT_ENCRYPTION_KEY/, 'dice quale variabile impostare');
    assert.match(warned[0], /pubblica|sorgente/i, 'e perché è un problema');
  });
});

test('l\'avviso è uno per processo, non uno per operazione di cifratura', () => {
  withEnv(undefined, 'test', () => {
    for (let i = 0; i < 5; i++) decrypt(encrypt(`v${i}`));
    assert.equal(fallbackWarnings().length, 1,
      'un avviso per avvio: uno per operazione diventerebbe rumore che si impara a ignorare');
  });
});

test('chiave impostata: nessun avviso', () => {
  withEnv('x'.repeat(64), 'test', () => {
    decrypt(encrypt('segreto'));
    assert.deepEqual(fallbackWarnings(), [], 'nessun avviso quando la chiave c\'è');
  });
});

test('produzione senza chiave: resta il fail-fast di SEC-07, non un avviso', () => {
  withEnv(undefined, 'production', () => {
    assert.throws(() => encrypt('segreto'), /AGENT_ENCRYPTION_KEY mancante o troppo corta/);
    assert.deepEqual(fallbackWarnings(), [],
      'in produzione non si avvisa e si va avanti: si interrompe (comportamento invariato)');
  });
});

test('produzione con chiave valida: nessun avviso e nessun errore', () => {
  withEnv('y'.repeat(64), 'production', () => {
    assert.equal(decrypt(encrypt('ok')), 'ok');
    assert.deepEqual(fallbackWarnings(), []);
  });
});

test.after(() => { logger.warn = realWarn; });
