---
name: project-sprint1-consegna-bundled
description: Lo Sprint 1 è stato consegnato come un unico commit bundled con il lavoro di tutti gli agenti — verificare lo stato reale invece di fidarsi del brief
metadata:
  type: project
---

Il lavoro dello Sprint 1 (SEC-01…SEC-05, DOC-01, il manuale) è arrivato su `feat/perps-hardening`
come **un solo commit** che raccoglie il contributo di tutti gli agenti, non un commit per task.

**Why:** in preparazione della review dello Sprint 1 (2026-08-08) il brief diceva che le mie
modifiche a `src/server.js`, `docs/MANUAL.md` e `public/manual.html` erano ancora nel working tree.
Non era più vero: `git diff` era vuoto perché nel frattempo tutto era stato consolidato in un unico
commit. Un `git diff` a mani vuote non significa "il lavoro non c'è" — significa "cerca altrove".

**How to apply:** quando devo rivedere "le mie modifiche", non fermarmi a `git diff`. Confrontare
`git log --oneline` con lo snapshot di git status a inizio sessione (spesso già superato), poi
`git log -- <file>` e `git show <commit> -- <file>` per isolare la mia parte dal bundle. Conseguenza
pratica per le review: la granularità per task va ricostruita a mano dal diff del commit bundled,
non è leggibile dai messaggi di commit. Collegati: [[feedback-segnalare-fuori-perimetro]].
