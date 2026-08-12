---
name: project-working-tree-condiviso
description: Il modello di esecuzione parallela è cambiato — da working tree condiviso (Release 1) a un worktree isolato per agente da allineare in fast-forward (Release 2 · Sprint 2)
metadata:
  type: project
---

Gli sprint "in parallelo" hanno avuto **due modelli diversi**, e la differenza cambia cosa devo fare
all'avvio e come devo leggere un rosso.

**Modello attuale (Release 2 · Sprint 2, 12 agosto 2026): worktree ISOLATO per agente.** Vengo
lanciata in `.claude/worktrees/agent-*` su un branch mio, e può essere **decine di commit indietro**
rispetto al branch di sprint (a me 56). Indietro di tanto che mancavano `docs/KB/BACKLOG` — quindi
`sprint2.md` con i criteri di accettazione e il meccanismo di stato — e perfino
`.claude/agent-memory/maya/`, che è tracciato in git: **i miei stessi ricordi ricomparivano solo dopo
l'allineamento**. Senza il controllo avrei concluso che il codice da modificare "non esiste".

**Modello precedente (Release 1 · Sprint 4): working tree condiviso.** Lì `npm test`/`npm run lint`
potevano essere rossi su file di altri a metà modifica: mi è successo con `src/db/database.js`
(`SyntaxError`) e 17 test caduti mentre Bruno era a metà delle migrazioni delle tabelle chat. Persi
tempo a sospettare le mie modifiche.

**How to apply:**

1. **Sempre, come prima cosa:** `git branch --show-current`, `git log --oneline -3` e confronta col
   `git log` che il prompt riporta. Se non combaciano sono in un worktree indietro.
   Sequenza sicura: `git log --oneline <branch>..HEAD` **vuoto** +
   `git merge-base --is-ancestor HEAD <branch>` + `git status --porcelain` pulito ⇒
   `git merge --ff-only <branch>`. Mai `git stash`, mai `cd` nel checkout condiviso per operazioni
   git (il sandbox lo rifiuta, ed è giusto). Le **letture** di file dal checkout condiviso passano, le
   scritture no — anche per `.claude/agent-memory/`, che va aggiornato nella copia del worktree.
2. Rosso inatteso: `git status --short` e `git diff --stat -- <file rotto>`. Nel modello isolato un
   rosso è quasi sempre **mio**, non di un collega — il lavoro degli altri arriva come commit già
   verdi, non come file a metà. Non liquidarlo come "roba di Bruno" senza guardare.
3. Verifica il perimetro con `node --test test/<i miei>.test.js` e `node --check`, poi **rilancia la
   suite completa prima di chiudere**: è quel numero che finisce nel report. Vedi
   [[feedback-verifica-dod-frontend]].
4. **Corollario che resta valido in entrambi i modelli:** ciò da cui dipendo può cambiare mentre
   lavoro. Nel modello isolato non cambia sotto i piedi, ma è arrivato *insieme al fast-forward* e va
   letto: prima di scrivere le note di stato rileggi `src/server.js` e il diff dei colleghi sui file
   che sono anche miei. In Sprint 2 Bruno aveva toccato `public/index.html` e `public/perps.js` per un
   fix di onestà nel modale del preventivo — 13 righe, nessun conflitto col mio lavoro, ma da leggere
   prima di scriverci sopra e da nominare in review. Vedi [[feedback-riconciliare-contratto-api]].
