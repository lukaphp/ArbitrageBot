import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { encrypt, decrypt, currentKeyId, keyIdOf, needsReencryption } from '../src/perps/secretBox.js';

/** Esegue fn con un ambiente chiavi temporaneo, ripristinandolo sempre. */
function withKeys({ key, id, old }, fn) {
  const snap = {
    key: process.env.AGENT_ENCRYPTION_KEY,
    id: process.env.AGENT_ENCRYPTION_KEY_ID,
    old: process.env.AGENT_ENCRYPTION_KEYS_OLD
  };
  const set = (name, v) => { if (v === undefined) delete process.env[name]; else process.env[name] = v; };
  set('AGENT_ENCRYPTION_KEY', key);
  set('AGENT_ENCRYPTION_KEY_ID', id);
  set('AGENT_ENCRYPTION_KEYS_OLD', old);
  try { return fn(); } finally {
    set('AGENT_ENCRYPTION_KEY', snap.key);
    set('AGENT_ENCRYPTION_KEY_ID', snap.id);
    set('AGENT_ENCRYPTION_KEYS_OLD', snap.old);
  }
}

/** Esegue fn con un NODE_ENV temporaneo, ripristinandolo sempre. */
function withNodeEnv(value, fn) {
  const snap = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = value;
  try { return fn(); } finally {
    if (snap === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = snap;
  }
}

/** Produce un ciphertext nel formato PRE-versioning (nessun prefisso). */
function legacyEncrypt(secret, plaintext) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);

// ---- Comportamento di base (invariato) ----

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

// ---- Versioning ----

test('le nuove cifrature portano il prefisso della chiave corrente', () => {
  withKeys({ key: K1, id: '3' }, () => {
    const enc = encrypt('ciao');
    assert.ok(enc.startsWith('v3:'), `atteso prefisso v3:, ottenuto ${enc.slice(0, 6)}`);
    assert.equal(keyIdOf(enc), 3);
    assert.equal(currentKeyId(), 3);
    assert.equal(decrypt(enc), 'ciao');
  });
});

test('senza AGENT_ENCRYPTION_KEY_ID la chiave corrente è la v1', () => {
  withKeys({ key: K1 }, () => {
    assert.equal(currentKeyId(), 1);
    assert.ok(encrypt('x').startsWith('v1:'));
  });
});

// ---- Retrocompatibilità: nessuna migrazione forzata ----

test('un ciphertext legacy (senza prefisso) resta decifrabile', () => {
  const legacy = legacyEncrypt(K1, 'valore-storico');
  withKeys({ key: K1, id: '1' }, () => {
    assert.equal(keyIdOf(legacy), null);
    assert.equal(decrypt(legacy), 'valore-storico');
  });
});

test('un ciphertext legacy è decifrabile anche dopo la rotazione, via chiave vecchia', () => {
  const legacy = legacyEncrypt(K1, 'valore-storico');
  withKeys({ key: K2, id: '2', old: `1:${K1}` }, () => {
    assert.equal(decrypt(legacy), 'valore-storico');
  });
});

// ---- Rotazione ----

test('dopo la rotazione i dati vecchi si leggono e i nuovi usano la chiave nuova', () => {
  const oldEnc = withKeys({ key: K1, id: '1' }, () => encrypt('segreto-vecchio'));

  withKeys({ key: K2, id: '2', old: `1:${K1}` }, () => {
    // il vecchio si decifra ancora...
    assert.equal(decrypt(oldEnc), 'segreto-vecchio');
    // ...ed è segnalato come da ri-cifrare
    assert.equal(needsReencryption(oldEnc), true);

    // il nuovo nasce già sulla chiave corrente
    const newEnc = encrypt('segreto-nuovo');
    assert.ok(newEnc.startsWith('v2:'));
    assert.equal(needsReencryption(newEnc), false);
    assert.equal(decrypt(newEnc), 'segreto-nuovo');
  });
});

test('più chiavi vecchie contemporaneamente', () => {
  const e1 = withKeys({ key: K1, id: '1' }, () => encrypt('uno'));
  const e2 = withKeys({ key: K2, id: '2' }, () => encrypt('due'));
  const K3 = 'c'.repeat(64);
  withKeys({ key: K3, id: '3', old: `1:${K1};2:${K2}` }, () => {
    assert.equal(decrypt(e1), 'uno');
    assert.equal(decrypt(e2), 'due');
  });
});

test('un id di chiave sconosciuto fallisce con un messaggio azionabile', () => {
  const enc = withKeys({ key: K1, id: '7' }, () => encrypt('x'));
  withKeys({ key: K2, id: '2' }, () => {
    assert.throws(() => decrypt(enc), /v7 non disponibile[\s\S]*AGENT_ENCRYPTION_KEYS_OLD/);
  });
});

test('la chiave sbagliata fallisce invece di restituire spazzatura', () => {
  const enc = withKeys({ key: K1, id: '1' }, () => encrypt('x'));
  // stesso id, segreto diverso: il tag GCM deve rifiutare
  withKeys({ key: K2, id: '1' }, () => {
    assert.throws(() => decrypt(enc));
  });
});

test('legacy non decifrabile da nessuna chiave nota → errore esplicito', () => {
  const legacy = legacyEncrypt('segreto-mai-configurato', 'x');
  withKeys({ key: K1, id: '1' }, () => {
    assert.throws(() => decrypt(legacy), /formato legacy[\s\S]*nessuna delle chiavi note/);
  });
});

test('un payload troncato non passa per valido', () => {
  withKeys({ key: K1, id: '1' }, () => {
    assert.throws(() => decrypt('v1:' + Buffer.from('corto').toString('base64')), /malformato o troncato/);
  });
});

test('la chiave corrente non è sovrascrivibile da una voce omonima in KEYS_OLD', () => {
  const enc = withKeys({ key: K1, id: '1' }, () => encrypt('x'));
  // una voce "1:K2" non deve rimpiazzare la chiave corrente v1 (=K1)
  withKeys({ key: K1, id: '1', old: `1:${K2}` }, () => {
    assert.equal(decrypt(enc), 'x');
  });
});

// ---- SEC-07: fail-fast in produzione, fallback di sviluppo solo fuori produzione ----
//
// Il fallback hardcoded è comodo in sviluppo e pericoloso in produzione: cifrerebbe
// chiavi agent e token Telegram con un segreto leggibile nel sorgente. Questi test
// fissano il confine, perché è esattamente il tipo di regressione che non si nota —
// tutto continuerebbe a "funzionare".

const PROD_ERR = /AGENT_ENCRYPTION_KEY mancante o troppo corta[\s\S]*production/;

test('produzione senza chiave: encrypt fallisce in modo esplicito invece di usare il fallback', () => {
  withNodeEnv('production', () => {
    withKeys({ key: undefined, id: undefined, old: undefined }, () => {
      assert.throws(() => encrypt('token-vero'), PROD_ERR);
    });
  });
});

test('produzione senza chiave: anche decrypt e currentKeyId falliscono (nessun percorso di lettura silenzioso)', () => {
  // Un ciphertext prodotto in sviluppo con il fallback: in produzione non deve
  // essere leggibile "per caso" solo perché la chiave di sviluppo è nota.
  const encDev = withKeys({ key: undefined, id: '1' }, () => encrypt('valore'));

  withNodeEnv('production', () => {
    withKeys({ key: undefined, id: undefined, old: undefined }, () => {
      assert.throws(() => decrypt(encDev), PROD_ERR);
      assert.throws(() => currentKeyId(), PROD_ERR);
      assert.throws(() => needsReencryption(encDev), PROD_ERR);
    });
  });
});

test('produzione con chiave presente ma più corta di 32 caratteri: rifiutata', () => {
  withNodeEnv('production', () => {
    withKeys({ key: 'a'.repeat(31), id: '1' }, () => {
      assert.throws(() => encrypt('x'), PROD_ERR);
    });
  });
});

test('produzione con chiave valida: comportamento identico a prima (nessuna regressione sul deploy reale)', () => {
  // È il caso del VPS già configurato: la chiave c'è ed è lunga, quindi il
  // fail-fast non lo tocca — round-trip e versioning restano quelli.
  withNodeEnv('production', () => {
    withKeys({ key: K1, id: '2' }, () => {
      const enc = encrypt('chiave-agent');
      assert.ok(enc.startsWith('v2:'));
      assert.equal(decrypt(enc), 'chiave-agent');
      assert.equal(currentKeyId(), 2);
      assert.equal(needsReencryption(enc), false);
    });
  });
});

test('fuori produzione senza chiave: il fallback di sviluppo resta, comportamento invariato', () => {
  for (const env of [undefined, 'development', 'test']) {
    withNodeEnv(env, () => {
      withKeys({ key: undefined, id: undefined, old: undefined }, () => {
        const enc = encrypt('sviluppo');
        assert.ok(enc.startsWith('v1:'), `atteso v1: con NODE_ENV=${env}`);
        assert.equal(decrypt(enc), 'sviluppo');
      });
    });
  }
});

test('la chiave di produzione resta usabile come chiave vecchia dopo la rotazione', () => {
  // Verifica che il fail-fast guardi solo la chiave CORRENTE: una rotazione in
  // produzione deve poter ancora decifrare lo storico via KEYS_OLD.
  const oldEnc = withNodeEnv('production', () => withKeys({ key: K1, id: '1' }, () => encrypt('storico')));
  withNodeEnv('production', () => {
    withKeys({ key: K2, id: '2', old: `1:${K1}` }, () => {
      assert.equal(decrypt(oldEnc), 'storico');
      assert.equal(needsReencryption(oldEnc), true);
    });
  });
});
