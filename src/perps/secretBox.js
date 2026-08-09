/**
 * SECRET BOX (cifratura a riposo, con versioning della chiave)
 * ============================================================
 *
 * Cifratura simmetrica AES-256-GCM per i segreti persistiti su DB: chiavi agent
 * Hyperliquid (`agent_wallets.encrypted_key`) e token Telegram.
 *
 * PERCHÉ IL VERSIONING
 * --------------------
 * Senza un identificativo di chiave nel ciphertext, cambiare AGENT_ENCRYPTION_KEY
 * rende i dati esistenti indecifrabili: in pratica la chiave non è ruotabile e,
 * se trapela, non esiste una risposta all'incidente. Marcando ogni ciphertext con
 * l'id della chiave che l'ha prodotto si possono tenere le vecchie chiavi per la
 * sola decifratura mentre le nuove scritture usano già quella corrente.
 *
 * FORMATO
 * -------
 *   v<id>:base64( iv[12] | authTag[16] | ciphertext )
 *
 * I valori scritti prima di questa modifica non hanno prefisso: restano leggibili
 * (vedi `decrypt`), così l'aggiornamento non richiede alcuna migrazione forzata.
 *
 * CONFIGURAZIONE
 * --------------
 *   AGENT_ENCRYPTION_KEY       segreto corrente, usato per cifrare
 *   AGENT_ENCRYPTION_KEY_ID    id del segreto corrente (default 1)
 *   AGENT_ENCRYPTION_KEYS_OLD  chiavi precedenti, SOLO per decifrare, nel formato
 *                              "1:vecchioSegreto;2:altroSegreto"
 *
 * Per ruotare: sposta il segreto attuale in AGENT_ENCRYPTION_KEYS_OLD col suo id,
 * metti il nuovo in AGENT_ENCRYPTION_KEY, incrementa AGENT_ENCRYPTION_KEY_ID e
 * lancia `node scripts/rotate-encryption-key.js --apply`.
 *
 * FALLBACK DI SVILUPPO E FAIL-FAST IN PRODUZIONE (SEC-07)
 * ------------------------------------------------------
 * Fuori produzione, se AGENT_ENCRYPTION_KEY manca si usa DEV_FALLBACK: serve a
 * far girare test e sviluppo locale senza configurazione. In produzione quel
 * fallback è un rischio silenzioso — cifrerebbe chiavi agent e token Telegram
 * con un segreto scritto nel sorgente, quindi pubblico — perciò qui si solleva
 * un errore invece di ripiegarci.
 *
 * Perché il controllo vive ANCHE qui e non solo in `validateConfig()`: quello è
 * il gate d'avvio del server, ma secretBox viene usato anche da percorsi che non
 * ci passano (`notifier.js` per il token Telegram,
 * `scripts/rotate-encryption-key.js` lanciato a mano nel container). Questa è la
 * difesa in profondità sull'unico punto dove il fallback può entrare in gioco,
 * non un doppione: la soglia (≥32 caratteri) è deliberatamente la stessa di
 * `validateConfig()`, così i due controlli non possono divergere in un caso in
 * cui uno passa e l'altro no.
 */

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const DEV_FALLBACK = 'arbitragebot-perps-dev-key';
const HEADER_LEN = 28; // iv[12] + authTag[16]
const VERSIONED = /^v(\d+):([\s\S]*)$/;
// Stessa soglia di validateConfig() in src/config/config.js — se cambia là, va
// cambiata anche qui (o i due controlli divergono).
const MIN_SECRET_LEN = 32;

/**
 * Segreto corrente da cui derivare la chiave di cifratura.
 *
 * In produzione un segreto assente o troppo corto interrompe l'operazione con un
 * errore esplicito; fuori produzione resta il comportamento storico, cioè il
 * fallback SOLO quando la variabile è assente/vuota (un segreto corto ma
 * presente continua a essere usato così com'è: le suite esistenti — secretBox,
 * rotateEncryptionKey — si appoggiano a segreti di test e non devono cambiare
 * significato).
 */
function currentSecret() {
  const secret = process.env.AGENT_ENCRYPTION_KEY || '';

  if (process.env.NODE_ENV === 'production' && secret.length < MIN_SECRET_LEN) {
    throw new Error(
      'AGENT_ENCRYPTION_KEY mancante o troppo corta ' +
      `(richiesti ≥${MIN_SECRET_LEN} caratteri) con NODE_ENV=production. ` +
      'Nessun fallback di sviluppo in produzione: cifrerebbe le chiavi agent con ' +
      'un segreto presente nel sorgente. Genera la chiave con `openssl rand -hex 32` ' +
      'e impostala nell\'ambiente (vedi docs/DEPLOY.md §2).'
    );
  }

  return secret || DEV_FALLBACK;
}

/**
 * Derivazione identica allo schema originale: indispensabile perché i ciphertext
 * legacy restino decifrabili. Adeguata per un segreto ad alta entropia
 * (`openssl rand -hex 32`); non usare passphrase deboli.
 */
function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

/** Portachiavi: la chiave corrente (cifra e decifra) più le vecchie (solo decifra). */
function keyRing() {
  const currentId = parseInt(process.env.AGENT_ENCRYPTION_KEY_ID, 10) || 1;
  const ring = new Map([[currentId, deriveKey(currentSecret())]]);

  for (const entry of String(process.env.AGENT_ENCRYPTION_KEYS_OLD || '').split(';')) {
    const s = entry.trim();
    const sep = s.indexOf(':');
    if (sep < 1) continue;
    const id = parseInt(s.slice(0, sep), 10);
    const secret = s.slice(sep + 1);
    // La chiave corrente vince sempre: una voce con lo stesso id non la sovrascrive.
    if (!Number.isInteger(id) || !secret || ring.has(id)) continue;
    ring.set(id, deriveKey(secret));
  }
  return { currentId, ring };
}

function open(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length <= HEADER_LEN) throw new Error('payload cifrato malformato o troncato');
  const decipher = crypto.createDecipheriv(ALGO, key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, HEADER_LEN));
  return Buffer.concat([decipher.update(buf.subarray(HEADER_LEN)), decipher.final()]).toString('utf8');
}

export function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  const { currentId, ring } = keyRing();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, ring.get(currentId), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v${currentId}:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

export function decrypt(payload) {
  if (!payload) return '';
  const { ring } = keyRing();
  const m = VERSIONED.exec(payload);

  if (m) {
    const id = parseInt(m[1], 10);
    const key = ring.get(id);
    if (!key) {
      throw new Error(
        `Chiave di cifratura v${id} non disponibile. Per decifrare dati prodotti con quella ` +
        'versione aggiungila ad AGENT_ENCRYPTION_KEYS_OLD nel formato "id:segreto".'
      );
    }
    return open(key, m[2]);
  }

  // Formato legacy (nessun prefisso): non sappiamo quale chiave l'ha prodotto,
  // quindi le proviamo tutte. Il tag GCM fa fallire in modo netto quelle sbagliate.
  let lastErr = null;
  for (const key of ring.values()) {
    try { return open(key, payload); } catch (e) { lastErr = e; }
  }
  throw new Error(
    'Impossibile decifrare un valore in formato legacy: nessuna delle chiavi note è corretta. ' +
    `Ultimo errore: ${lastErr?.message || 'n/d'}`
  );
}

/** Id della chiave con cui vengono cifrate le nuove scritture. */
export function currentKeyId() {
  return keyRing().currentId;
}

/** Id della chiave che ha prodotto un ciphertext; `null` se in formato legacy. */
export function keyIdOf(payload) {
  const m = VERSIONED.exec(payload || '');
  return m ? parseInt(m[1], 10) : null;
}

/** True se il valore andrebbe ri-cifrato con la chiave corrente. */
export function needsReencryption(payload) {
  if (!payload) return false;
  return keyIdOf(payload) !== currentKeyId();
}

export default { encrypt, decrypt, currentKeyId, keyIdOf, needsReencryption };
