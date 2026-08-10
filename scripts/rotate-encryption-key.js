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

/**
 * Errore già formulato per un operatore: viene stampato come messaggio, non come
 * stack trace (vedi il catch in fondo al file).
 */
class CleanError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'CleanError';
    this.hint = hint;
  }
}

/**
 * Apre il DB traducendo gli errori di better-sqlite3 in indicazioni operative.
 * Senza questo, un DB_PATH sbagliato produceva uno stack trace di
 * `lib/database.js` — vero ma inutile per chi sta ruotando una chiave in
 * produzione con il backup appena fatto e nessuna voglia di leggere JS.
 */
function openDb() {
  let db;
  try {
    db = new Database(DB_PATH);
  } catch (e) {
    throw new CleanError(
      `impossibile aprire il database "${DB_PATH}": ${e.message}`,
      'Controlla DB_PATH (dentro il container è /app/data/perps.db) e i permessi del file.'
    );
  }
  // La tabella deve esistere *prima* di annunciare qualunque conteggio: se manca,
  // il DB indicato non è quello dell'app (o non è mai stato inizializzato) e
  // proseguire stampa numeri che non significano niente.
  const hasWallets = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_wallets'"
  ).get();
  if (!hasWallets) {
    db.close();
    throw new CleanError(
      `il database "${DB_PATH}" non contiene la tabella agent_wallets.`,
      'Probabilmente è il file sbagliato: verifica DB_PATH, oppure avvia una volta l\'app ' +
      'per creare lo schema.'
    );
  }
  return db;
}

/** Ritorna l'exit code: 0 tutto a posto, 1 se qualche segreto non è decifrabile. */
function main(db) {
  const target = currentKeyId();

  console.log(`Database        : ${DB_PATH}`);
  console.log(`Chiave corrente : v${target}`);
  console.log(`Modalità        : ${APPLY ? 'APPLICA (scrive sul DB)' : 'verifica (nessuna scrittura)'}`);
  console.log('');

  let scanned = 0, todo = 0, done = 0, verified = 0;
  const failures = [];

  /**
   * Ri-cifra un singolo valore. Ritorna il nuovo ciphertext, oppure null se è
   * già aggiornato. Solleva se il valore non è decifrabile: in quel caso NON si
   * scrive nulla, perché sovrascrivere significherebbe perdere il segreto.
   *
   * PERCHÉ SI DECIFRA SEMPRE, ANCHE QUANDO L'ID COMBACIA
   * ----------------------------------------------------
   * `needsReencryption()` confronta solo l'**id** della chiave (il prefisso
   * `v<n>:`). Se si sostituisce il segreto in AGENT_ENCRYPTION_KEY senza
   * incrementare AGENT_ENCRYPTION_KEY_ID, i vecchi ciphertext restano marcati con
   * l'id corrente: il confronto per id li dichiara "già a posto" e lo script
   * usciva con "Tutto già cifrato con la chiave corrente" — mentre in realtà
   * quei segreti non erano più decifrabili da nessuno. Il danno si scopriva al
   * riavvio dell'app, quando i bot non riuscivano più a firmare.
   * Decifrare ogni valore verifica il **materiale** della chiave, non la sua
   * etichetta: l'unica prova che il dato è davvero leggibile con la chiave
   * configurata adesso. Il costo è irrilevante (una AES-GCM per segreto, su un
   * DB che ne ha una manciata) rispetto a un falso "tutto ok".
   */
  const rotateValue = (enc) => {
    if (!enc) return null;
    scanned++;
    const plain = decrypt(enc);   // se fallisce, l'eccezione ferma questo record
    verified++;
    if (!needsReencryption(enc)) return null;
    todo++;
    return encrypt(plain);
  };

  /**
   * Traduce un fallimento di decifratura in una diagnosi. Il caso subdolo è
   * "id corretto, materiale sbagliato": l'errore nativo di AES-GCM
   * ("unable to authenticate data") non dice all'operatore cosa ha combinato.
   */
  const diagnose = (enc, err) => {
    if (keyIdOf(enc) !== target) return err.message;
    return (
      `marcato v${target}, cioè la versione corrente, ma NON decifrabile con il materiale ` +
      `di AGENT_ENCRYPTION_KEY: il segreto è stato sostituito riusando lo stesso ` +
      `AGENT_ENCRYPTION_KEY_ID. Rimetti in AGENT_ENCRYPTION_KEY il segreto che ha prodotto ` +
      `questi dati, poi ruota nell'ordine giusto (quello vecchio in AGENT_ENCRYPTION_KEYS_OLD ` +
      `come "${target}:<segreto>", il nuovo in AGENT_ENCRYPTION_KEY con ` +
      `AGENT_ENCRYPTION_KEY_ID=${target + 1}): un id non va mai riusato per un materiale ` +
      `diverso. [${err.message}]`
    );
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
      failures.push(`agent_wallets rowid=${w.rid} ${w.network || ''} (${from}): ${diagnose(w.encrypted_key, e)}`);
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
        failures.push(`telegram_config (${from}): ${diagnose(cfg.tokenEnc, e)}`);
      }
    }
  }

  console.log('');
  console.log(`Segreti esaminati        : ${scanned}`);
  console.log(`Decifrabili (materiale)  : ${verified}`);
  console.log(`Da ri-cifrare            : ${todo}`);
  console.log(`Ri-cifrati               : ${APPLY ? done : 0}`);

  if (failures.length) {
    console.log('');
    console.log(`⚠️  ${failures.length} segreti NON decifrabili (lasciati intatti):`);
    failures.forEach(f => console.log(`   - ${f}`));
    console.log('   Aggiungi la chiave mancante ad AGENT_ENCRYPTION_KEYS_OLD e riprova.');
    return 1;
  }

  // "niente da fare" ora vuol dire due cose: nessun id da aggiornare *e* ogni
  // segreto davvero decifrabile con la chiave configurata adesso.
  if (!todo) {
    const suffix = verified ? ` (${verified} segreti verificati col materiale in uso)` : '';
    console.log(`\n✅ Tutto già cifrato con la chiave corrente${suffix}: niente da fare.`);
  } else if (!APPLY) console.log('\nRilancia con --apply per scrivere le modifiche.');
  else console.log('\n✅ Rotazione completata. Riavvia l\'app e verifica che i bot operino.');

  return 0;
}

// Nessuna eccezione deve arrivare all'utente come stack trace: chi lancia questo
// script sta manipolando le chiavi che proteggono i wallet agent, e uno stack
// trace di better-sqlite3 o di secretBox non gli dice se il DB è stato scritto
// o no. Qualunque errore non previsto diventa un messaggio + exit 1 (nessuna
// scrittura parziale è possibile: si scrive solo dentro main con --apply, un
// record per volta, e ogni fallimento di un record è già gestito lì).
let db;
try {
  db = openDb();
  process.exitCode = main(db);
} catch (e) {
  if (e instanceof CleanError) {
    console.error(`\n❌ Rotazione non eseguita: ${e.message}`);
    if (e.hint) console.error(`   ${e.hint}`);
  } else {
    console.error(`\n❌ Rotazione interrotta da un errore inatteso: ${e.message}`);
    console.error('   Nessuna modifica applicata oltre a quelle già elencate sopra.');
    console.error('   Dettaglio tecnico (per un report): ' + String(e.stack || '').split('\n')[1]?.trim());
  }
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { /* già chiuso o mai aperto: irrilevante qui */ }
}
