---
name: project-working-tree-condiviso
description: Negli sprint eseguiti in parallelo il working tree è condiviso con Bruno e Joshua — npm test e npm run lint possono fallire su file loro a metà modifica, non sui miei
metadata:
  type: project
---

Quando il PO avvia uno sprint "in parallelo", io, Bruno e Joshua lavoriamo sullo **stesso working
tree**, non su branch separati. Quindi `npm test` e `npm run lint` possono fallire su file che non ho
toccato, semplicemente perché un altro è a metà di una modifica.

**Why:** Sprint 4, 10 agosto 2026. A metà lavoro `npm run lint` è andato rosso su
`src/db/database.js` (`SyntaxError: missing ) after argument list`) e 17 test sono caduti. Era Bruno
a metà delle migrazioni `chat_sessions`/`chat_messages` — 179 righe aggiunte e un `exec()` non
chiuso. Mezz'ora dopo, senza che io toccassi niente, la suite era verde: 328 test, 98 file lintati
(erano 88 all'inizio della sessione). Ho perso tempo a sospettare le mie modifiche.

**How to apply:**
1. Rosso inatteso ⇒ prima `git status --short` e `git diff --stat -- <file rotto>`. Se il file non è
   mio, non è mio problema: non "aggiustarlo", non è nemmeno finito.
2. Nel frattempo verifica il tuo perimetro:
   `node --test test/<i miei>.test.js` più i test frontend preesistenti
   (`walletPerpsUi`, `networkBrandingUi`, `killSwitchUi`, `strategyExportImportUi`, `chartRefresh`),
   e `node --check` sui file che hai toccato.
3. Rilancia la suite completa **prima di chiudere**: è quella che finisce nel report. Vedi
   [[feedback-verifica-dod-frontend]].
4. Corollario utile: se una route backend da cui dipendo non esiste quando comincio, può esistere
   quando finisco. Prima di scrivere le note di stato **ricontrolla `src/server.js`** e riconcilia —
   è lì che ho trovato che Bruno aveva aggiunto `GET /api/advisor/status` appositamente per la UI e
   che il contratto del budget usava `monthlyLimitUsd`. Vedi
   [[feedback-riconciliare-contratto-api]].
