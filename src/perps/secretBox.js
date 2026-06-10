/**
 * SECRET BOX (cifratura a riposo)
 * ===============================
 *
 * Cifratura simmetrica AES-256-GCM con chiave derivata da AGENT_ENCRYPTION_KEY
 * (stesso schema usato per le chiavi agent). Usata per cifrare segreti
 * persistiti su DB (es. token Telegram) così non restano in chiaro nel file.
 *
 * Formato: base64( iv[12] | authTag[16] | ciphertext ). Compatibile byte-per-byte
 * con lo schema di agentWallet.
 */

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function deriveKey() {
  const secret = process.env.AGENT_ENCRYPTION_KEY || 'arbitragebot-perps-dev-key';
  return crypto.createHash('sha256').update(secret).digest();
}

export function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(payload) {
  if (!payload) return '';
  const key = deriveKey();
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export default { encrypt, decrypt };
