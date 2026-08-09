#!/usr/bin/env node
/**
 * Lint di sintassi leggero (cross-platform): esegue `node --check` su tutti i
 * file .js sotto le radici elencate in `roots`. Non sostituisce ESLint ma
 * intercetta errori di sintassi/parse in CI senza dipendenze aggiuntive.
 *
 * PERCHÉ `public` È IN ELENCO (LINT-01)
 * ------------------------------------
 * Prima ne era fuori, quindi ~2000 righe di frontend (`perps.js`, `app.js`…)
 * non passavano mai da un controllo di sintassi: un errore di parse lì supera la
 * CI e rompe l'interfaccia in silenzio in produzione, perché il server parte
 * comunque — se ne accorge solo l'utente davanti a una pagina morta.
 *
 * Nota su come vengono interpretati: con `"type": "module"` nel package.json di
 * radice, `node --check` parsa anche i file di `public/` come ESM, quindi in
 * strict mode. È più severo di come il browser li carica (sono `<script>`
 * classici): costrutti sloppy-mode — `with`, letterali ottali `0755`, parametri
 * duplicati — verrebbero segnalati qui pur essendo accettati dal browser. Al
 * momento tutti i file passano; se un giorno uno di questi fallisse, è questa la
 * ragione, non un errore di sintassi vero.
 */
import { execFileSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import path from 'path';

const roots = ['src', 'test', 'scripts', 'public'];
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules') continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
}

for (const r of roots) {
  try { walk(r); } catch { /* dir assente: salta */ }
}

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${f}\n${e.stderr?.toString() || e.message}`);
  }
}

if (failed) {
  console.error(`\n❌ Lint fallito su ${failed}/${files.length} file`);
  process.exit(1);
}
console.log(`✅ Lint OK: ${files.length} file senza errori di sintassi`);
