---
name: project-infisical-non-default
description: Decisione dello Sprint 1 — Infisical NON diventa il default di npm start; il backlog chiedeva il contrario ed è stato respinto motivatamente
metadata:
  type: project
---

Il backlog di hardening chiedeva di rendere Infisical il percorso di avvio predefinito
(`npm start` → `infisical run`). Respinto: avrebbe rotto lo sviluppo locale e duplicato una logica
già corretta in `docker-entrypoint.sh`/`restart.sh`, che si attivano da soli quando trovano le
credenziali Infisical. Al suo posto, SEC-06: un warning non bloccante all'avvio quando
`NODE_ENV=production` senza `INFISICAL_TOKEN`.

**Why:** l'integrazione secret manager è opt-in per scelta — un deploy con variabili Docker diritte
resta legittimo, va segnalato ma non impedito. Forzare il default avrebbe reso obbligatorio un tool
esterno anche per far girare il bot in locale.

**How to apply:** se la richiesta riemerge, la risposta di default resta questa a meno che il
contesto non sia cambiato in modo sostanziale (es. requisito di compliance esplicito). Gli script
`start:infisical`/`dev:infisical` restano disponibili per chi lo vuole esplicitamente.
