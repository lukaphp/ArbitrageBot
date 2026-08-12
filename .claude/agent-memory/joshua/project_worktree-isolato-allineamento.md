---
name: worktree-isolato-allineamento
description: I dispatch su questo repo partono spesso da un worktree isolato molto indietro — controlla e fai fast-forward prima di scrivere, mai git stash
metadata:
  type: project
---

Un dispatch di agente su questo repo parte in un worktree isolato
(`.claude/worktrees/agent-*`) che può essere **decine di commit indietro** rispetto al
branch di lavoro `feat/perps-hardening`. È successo a Bruno (56 commit) e a me (59) nello
stesso sprint.

**Why:** un worktree vecchio può non contenere affatto i file che la storia deve
modificare — nel mio caso mancavano `docs/KB/BACKLOG` (quindi lo sprint e il meccanismo di
stato) e `src/agents/providers/`. Iniziare a scrivere lì produce lavoro su una base che non
esiste più e conflitti garantiti.

**How to apply:** prima riga di ogni dispatch, prima di leggere o scrivere qualsiasi cosa:

1. `git log --oneline -5` e `git branch --show-current` — il branch del worktree ha un nome
   proprio, non è `feat/perps-hardening`.
2. `git merge-base --is-ancestor HEAD feat/perps-hardening` e
   `git rev-list --count feat/perps-hardening..HEAD` — conferma di essere un antenato
   stretto **senza commit propri**.
3. Solo allora `git merge --ff-only feat/perps-hardening`.

**Mai `git stash`**: il tree è condiviso e si rischia di mettere via lavoro di un collega.
Se il fast-forward non è possibile, fermati e segnalalo invece di forzare.

Nota operativa: da un worktree isolato i comandi bash non possono fare `cd` nel checkout
condiviso, e comandi composti troppo complessi vengono rifiutati — per script multi-riga
scrivi un file `.sh` nello scratchpad e lancia quello.
