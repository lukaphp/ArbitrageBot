#!/usr/bin/env node
/**
 * Lint di sintassi leggero (cross-platform): esegue `node --check` su tutti i
 * file .js sotto src/ e test/. Non sostituisce ESLint ma intercetta errori di
 * sintassi/parse in CI senza dipendenze aggiuntive.
 */
import { execFileSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import path from 'path';

const roots = ['src', 'test', 'scripts'];
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
