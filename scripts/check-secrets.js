#!/usr/bin/env node
/**
 * VERIFICA DEI SEGRETI DISPONIBILI AL PROCESSO
 * ===========================================
 *
 * Controlla che l'ambiente contenga tutto ciò che serve all'app, senza mai
 * stampare un valore: solo nome, stato (presente/assente) e lunghezza.
 *
 * Uso:
 *   node scripts/check-secrets.js                  # legge il file locale
 *   infisical run -- node scripts/check-secrets.js # legge da Infisical
 *
 * Il secondo comando è il modo giusto per confermare che la migrazione verso
 * Infisical sia completa PRIMA di rimuovere il file locale.
 */

import 'dotenv/config';

const CRITICO = 'critico', IMPORTANTE = 'importante', OPZIONALE = 'opzionale';

const VARS = [
  // Compromissione = accesso al trading o ai fondi
  ['AGENT_ENCRYPTION_KEY', CRITICO, 'cifra le chiavi agent a riposo', 32],
  ['SESSION_SECRET', CRITICO, 'firma i token di sessione del pannello', 16],
  ['APP_PASSWORD_HASH', CRITICO, 'hash della password del pannello', 0],
  // Compromissione = costo economico o abuso
  ['ANTHROPIC_API_KEY', IMPORTANTE, "chiave dell'Analyst AI", 0],
  ['TELEGRAM_BOT_TOKEN', OPZIONALE, 'notifiche (di norma salvato cifrato su DB)', 0],
  // Configurazione non segreta ma necessaria
  ['APP_ORIGIN', IMPORTANTE, 'origine consentita per CORS/cookie', 0],
  ['HYPERLIQUID_NETWORK', IMPORTANTE, 'testnet | mainnet', 0],
  ['NODE_ENV', IMPORTANTE, "ambiente d'esecuzione", 0],
  ['PORT', OPZIONALE, 'porta del server', 0],
  // Solo per la demo EVM, disattivata di default
  ['COINGECKO_API_KEY', OPZIONALE, 'demo EVM', 0],
  ['ONEINCH_API_KEY', OPZIONALE, 'demo EVM', 0],
  ['MORALIS_API_KEY', OPZIONALE, 'demo EVM', 0]
];

const isProd = process.env.NODE_ENV === 'production';
let missingCritical = 0;

console.log(`Ambiente: ${process.env.NODE_ENV || '(non impostato)'}\n`);
console.log('  stato  variabile                  liv.        note');
console.log('  ' + '-'.repeat(74));

for (const [name, level, desc, minLen] of VARS) {
  const v = process.env[name];
  const present = typeof v === 'string' && v.length > 0;
  const tooShort = present && minLen > 0 && v.length < minLen;

  // Le critiche contano come mancanti solo in produzione: in sviluppo l'app ha
  // fallback espliciti e deve poter girare senza configurazione completa.
  const blocking = level === CRITICO && isProd && (!present || tooShort);
  if (blocking) missingCritical++;

  const icon = !present ? (level === CRITICO && isProd ? '  ✗  ' : '  –  ')
    : tooShort ? '  ⚠  ' : '  ✓  ';
  const note = !present ? desc
    : tooShort ? `TROPPO CORTA: ${v.length} caratteri, minimo ${minLen}`
    : `${desc} (${v.length} caratteri)`;

  console.log(`${icon}  ${name.padEnd(26)} ${level.padEnd(11)} ${note}`);
}

console.log('');
if (missingCritical) {
  console.log(`❌ ${missingCritical} segreti critici mancanti o non validi: in produzione l'avvio verrà rifiutato.`);
  process.exit(1);
}
console.log('✅ Nessun segreto critico mancante per questo ambiente.');
console.log('   Nota: questo comando non stampa mai un valore, solo la sua lunghezza.');
