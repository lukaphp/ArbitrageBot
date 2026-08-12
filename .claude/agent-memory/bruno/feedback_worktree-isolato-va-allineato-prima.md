---
name: worktree-isolato-va-allineato-prima
description: Se il dispatch arriva in un worktree isolato, verifica prima di tutto che sia allineato al branch di sprint — può essere decine di commit indietro e non contenere il codice da modificare
metadata:
  type: feedback
---

Quando il dispatch arriva in un worktree isolato (`.claude/worktrees/agent-*`),
**prima di leggere o scrivere qualunque cosa** controlla che il branch del worktree
sia allineato a quello di sprint. Se è indietro e non ha commit propri, allinealo
con un `merge --ff-only` dopo aver verificato che il tuo `HEAD` sia un antenato.

**Why:** in Release 2 · Sprint 2 il worktree era **56 commit indietro** rispetto a
`feat/perps-hardening`. Non conteneva `docs/KB/BACKLOG/` (quindi né `sprint2.md`
con i criteri di accettazione, né il meccanismo di stato `sprint2-status/`), né
`src/agents/providers/`, né `src/agents/advisor/` — cioè il codice che **tre delle
quattro storie assegnate** devono modificare, e nemmeno il mio lavoro di Sprint 1.
Anche `.claude/agent-memory/bruno/` risultava vuoto, pur essendo tracciato in git:
i miei ricordi ricomparivano solo dopo l'allineamento. Senza il controllo avrei
concluso che il codice "non esiste" e avrei riscritto da zero cose già in
produzione, oppure avrei dichiarato la storia bloccata per il motivo sbagliato.

**How to apply:**

- Segnale d'allarme: file o directory citati dal task che "non esistono", oppure il
  `git log` iniziale del prompt che non combacia con `git log` reale.
- Sequenza sicura, tutta dentro il worktree: `git log --oneline HEAD..<branch>` per
  misurare il ritardo, `git log --oneline <branch>..HEAD` **vuoto** e
  `git merge-base --is-ancestor HEAD <branch>` per accertarsi di non avere lavoro
  proprio, `git status --porcelain` pulito, poi `git merge --ff-only <branch>`.
- **Non** fare `cd` nel checkout condiviso per operazioni git: il sandbox lo
  rifiuta, ed è giusto (vedi [[tree-condiviso-mai-git-stash]]). Le letture di file
  dal checkout condiviso passano, le scritture no — anche per
  `.claude/agent-memory/`, che va aggiornato nella **copia del worktree**.
- Il branch di sprint è già in checkout nel tree condiviso, quindi non puoi
  checkoutarlo: il fast-forward del *tuo* branch su di esso è la mossa giusta.
