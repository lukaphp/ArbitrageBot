#!/usr/bin/env node
/**
 * Genera l'hash della password per l'autenticazione single-user.
 *
 * Uso:
 *   node scripts/hash-password.js 'la-mia-password-forte'
 *   node scripts/hash-password.js            (chiede la password in modo interattivo)
 *
 * Incolla l'output in .env come APP_PASSWORD_HASH=...
 */

import { hashPassword } from '../src/middleware/auth.js';
import readline from 'readline';

function output(pw) {
  if (!pw || pw.length < 8) {
    console.error('❌ Usa una password di almeno 8 caratteri.');
    process.exit(1);
  }
  console.log('\nAPP_PASSWORD_HASH=' + hashPassword(pw) + '\n');
}

const arg = process.argv[2];
if (arg) {
  output(arg);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Password: ', (pw) => { rl.close(); output(pw.trim()); });
}
