---
name: project-working-tree-condiviso
description: Su questo repo piu' agenti lavorano nello stesso working tree in parallelo — come leggere una suite rossa e cosa non toccare mai
metadata:
  type: project
---

Gli sprint qui si eseguono con piu' agenti (Bruno backend, Maya frontend, io infra) che scrivono
**nello stesso working tree, contemporaneamente**. Non esistono branch separati per agente.

**Why:** durante lo Sprint 4 (2026-08-10) ho trovato `npm test` con 17 file rossi e `npm run lint`
fallito — nessuna delle due cose era colpa mia: `src/db/database.js` era a meta' di un'edit di
Bruno e ogni test che importa il DB cadeva di conseguenza. Un'ora dopo, senza che io toccassi
niente, la stessa suite era 388/388 verde. Se avessi "aggiustato" il file altrui avrei distrutto il
suo lavoro in corso.

**How to apply:**
- Suite rossa: **prima** isola. `node --check` sui miei file, poi `node --test` sulle mie sole
  suite. Se le mie passano e le altre falliscono per un `SyntaxError` in un file che non e' mio, e'
  lavoro in corso di qualcun altro — si aspetta e si ricontrolla, non si corregge.
- Nel riepilogo finale dichiara *quando* hai osservato la suite completa verde: e' uno stato che
  cambia sotto i piedi.
- File condivisi caldi: `src/server.js` (tutti aggiungono route), `docs/DEPLOY.md`/`MANUAL.md`.
  Usa edit mirate su ancore uniche, mai riscritture integrali del file.
- Non toccare mai il file di stato di un altro agente in `sprint4-status/`, ne' `aggregate.json`
  (e' di Roger).
- Non fare `rm -rf node_modules` ne' toccare `data/perps.db`: sono condivisi e in uso.

Vedi [[feedback-prove-reali]] per la ricetta di build isolata che ne discende.
