/**
 * AUTENTICAZIONE (single-user)
 * ============================
 *
 * Protegge le API e Socket.IO con un'unica password (modello single-user).
 *
 * - La password NON è salvata in chiaro: in env c'è solo `APP_PASSWORD_HASH`
 *   nel formato `scrypt$<saltHex>$<hashHex>` (genera con scripts/hash-password.js).
 * - Dopo il login viene emesso un token di sessione firmato HMAC con
 *   `SESSION_SECRET`, salvato in un cookie httpOnly. Nessuno stato server-side.
 *
 * In sviluppo, se `APP_PASSWORD_HASH` non è impostato, l'auth è DISATTIVA per
 * comodità. In produzione `validateConfig` rende il hash obbligatorio, quindi
 * l'auth è sempre attiva.
 */

import crypto from 'crypto';
import logger from '../utils/logger.js';

const COOKIE_NAME = 'sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 ore
const SCRYPT_KEYLEN = 32;

function sessionSecret() {
  return process.env.SESSION_SECRET || 'dev-session-secret-change-me';
}

export function isAuthEnabled() {
  return !!process.env.APP_PASSWORD_HASH;
}

/** Genera un hash della password (`scrypt$salt$hash`). Usato dallo script CLI. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Verifica una password contro l'hash memorizzato (timing-safe). */
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = (stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function sign(data) {
  return crypto.createHmac('sha256', sessionSecret()).update(data).digest('hex');
}

/** Emette un token di sessione firmato con scadenza. */
export function issueToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Verifica firma + scadenza di un token. */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  // confronto timing-safe
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/'
  };
}

export const COOKIE = COOKIE_NAME;

/** Middleware Express: blocca le richieste non autenticate con 401. */
export function requireAuth(req, res, next) {
  if (!isAuthEnabled()) return next(); // auth disattivata (solo sviluppo)
  const token = req.cookies?.[COOKIE_NAME];
  if (verifyToken(token)) return next();
  return res.status(401).json({ success: false, error: 'Non autenticato' });
}

/** Estrae il cookie di sessione dall'handshake Socket.IO. */
function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Middleware Socket.IO: rifiuta connessioni non autenticate. */
export function socketAuth(socket, next) {
  if (!isAuthEnabled()) return next();
  const token = parseCookie(socket.handshake.headers?.cookie, COOKIE_NAME);
  if (verifyToken(token)) return next();
  logger.warn('Socket.IO: connessione non autenticata rifiutata', { id: socket.id });
  return next(new Error('Non autenticato'));
}

export default {
  isAuthEnabled, hashPassword, verifyPassword, issueToken, verifyToken,
  requireAuth, socketAuth, cookieOptions, COOKIE
};
