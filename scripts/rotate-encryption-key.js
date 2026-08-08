#!/usr/bin/env node
/**
 * ROTAZIONE DELLA CHIAVE DI CIFRATURA A RIPOSO
 * ===========================================
 *
 * Ri-cifra con la chiave corrente tutti i segreti conservati nel DB che sono
 * ancora legati a una chiave precedente (o al formato legacy senza versione):
 *   - agent_wallets.encrypted_key   chiavi agent Hyperliquid
 *   - settings.telegram_config      token del bot Telegram (campo tokenEnc)
 *
 * PROCEDURA
 * ---------
 *  1. Backup:  ./scripts/backup.sh
 *  2. Nel file di configurazione:
 *       - sposta il segreto attuale in AGENT_ENCRYPTION_KEYS_OLD come "<id>:<segreto>"
 *       - metti il nuovo segreto in AGENT_ENCRYPTION_KEY   (openssl rand -hex 32)
 *       - incrementa AGENT_ENCRYPTION_KEY_ID
 *  3. Verifica:  node scripts/rotate-encryption-key.js
 *  4. Applica:   node scripts/rotate-encryption-key.js --apply
 *  5. Riavvia l'app. Dopo qualche giorno di esercizio puoi togliere la vecchia
 *     chiave da AGENT_ENCRYPTION_KEYS_OLD.
 *
 * Senza --apply lo script non scrive nulla: mostra soltanto cosa farebbe.
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { decrypt, encrypt, currentKeyId, keyIdOf, needsReencryption } from '../src/perps/secretBox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/perps.db');

const label = id => (id === null ? 'legacy (senza versione)' : `v${id}`);

function main() {
  const db = new Database(DB_PATH);
  const target = currentKeyId();

  console.log(`Database        : ${DB_PATH}`);
  console.log(`Chiave corrente : v${target}`);
  console.log(`Modalità        : ${APPLY ? 'APPLICA (scrive sul DB)' : 'verifica (nessuna scrittura)'}`);
  console.log('');

  let scanned = 0, todo = 0, done = 0;
  const failures = [];

  /**
   * Ri-cifra un singolo valore. Ritorna il nuovo ciphertext, oppure null se è
   * già aggiornato. Solleva se il valore non è decifrabile: in quel caso NON si
   * scrive nulla, perché sovrascrivere significherebbe perdere il segreto.
   */
  const rotateValue = (enc) => {
    if (!enc) return null;
    scanned++;
    if (!needsReencryption(enc)) return null;
    todo++;
    const plain = decrypt(enc);   // se fallisce, l'eccezione ferma questo record
    return encrypt(plain);
  };

  // ---- Chiavi agent ----
  // NB: la colonna è `master_address` (vedi lo schema in src/db/database.js), non
  // `address`: con il nome sbagliato questa query lanciava "no such column" e la
  // rotazione delle chiavi agent non era eseguibile affatto.
  const wallets = db.prepare('SELECT rowid AS rid, master_address, network, encrypted_key FROM agent_wallets').all();
  const updWallet = db.prepare('UPDATE agent_wallets SET encrypted_key = ? WHERE rowid = ?');
  for (const w of wallets) {
    const from = label(keyIdOf(w.encrypted_key));
    try {
      const next = rotateValue(w.encrypted_key);
      if (!next) continue;
      console.log(`  agent ${String(w.master_address || w.rid).slice(0, 12)}… : ${from} → v${target}`);
      if (APPLY) { updWallet.run(next, w.rid); done++; }
    } catch (e) {
      failures.push(`agent_wallets rowid=${w.rid} ${w.network || ''} (${from}): ${e.message}`);
    }
  }

  // ---- Token Telegram ----
  const row = db.prepare("SELECT value FROM settings WHERE key = 'telegram_config'").get();
  if (row?.value) {
    let cfg = null;
    try { cfg = JSON.parse(row.value); } catch { failures.push('telegram_config: JSON illeggibile'); }
    if (cfg?.tokenEnc) {
      const from = label(keyIdOf(cfg.tokenEnc));
      try {
        const next = rotateValue(cfg.tokenEnc);
        if (next) {
          console.log(`  token Telegram          : ${from} → v${target}`);
          if (APPLY) {
            cfg.tokenEnc = next;
            db.prepare("UPDATE settings SET value = ? WHERE key = 'telegram_config'").run(JSON.stringify(cfg));
            done++;
          }
        }
      } catch (e) {
        failures.push(`telegram_config (${from}): ${e.message}`);
      }
    }
  }

  console.log('');
  console.log(`Segreti esaminati        : ${scanned}`);
  console.log(`Da ri-cifrare            : ${todo}`);
  console.log(`Ri-cifrati               : ${APPLY ? done : 0}`);

  if (failures.length) {
    console.log('');
    console.log(`⚠️  ${failures.length} segreti NON decifrabili (lasciati intatti):`);
    failures.forEach(f => console.log(`   - ${f}`));
    console.log('   Aggiungi la chiave mancante ad AGENT_ENCRYPTION_KEYS_OLD e riprova.');
    db.close();
    process.exit(1);
  }

  if (!todo) console.log('\n✅ Tutto già cifrato con la chiave corrente: niente da fare.');
  else if (!APPLY) console.log('\nRilancia con --apply per scrivere le modifiche.');
  else console.log('\n✅ Rotazione completata. Riavvia l\'app e verifica che i bot operino.');

  db.close();
}

main();
