---
name: project-runbook-documentato-non-e-eseguito
description: In questo repo un runbook scritto in docs/ non implica che sia mai stato eseguito — il runbook di rotazione chiavi era documentato bene e lo script non partiva affatto
metadata:
  type: project
---

Un percorso documentato in `docs/` (runbook, procedura di deploy, comando `npm run …`) **non** implica
che sia mai stato eseguito con successo nemmeno una volta.

**Why:** scoperto in TEST-01 (Sprint 2). `docs/DEPLOY.md §10` descrive in modo accurato e prudente la
rotazione della chiave di cifratura a riposo, ma `scripts/rotate-encryption-key.js` interrogava una
colonna inesistente (`address` invece di `master_address`): lanciava `no such column` al primo
`prepare()`, quindi la rotazione non era eseguibile **affatto**, nemmeno su un DB vuoto. Introdotto
insieme al versioning delle chiavi e mai esercitato, perché `scripts/` era interamente fuori dalla
suite di test. Effetto reale: la risposta all'incidente "la chiave è trapelata" non esisteva, pur
essendo documentata.

**How to apply:** quando un task riguarda uno script sotto `scripts/`, la prima cosa è **eseguirlo**
su dati temporanei (vedi il seam a processo figlio in [[feedback-seam-di-test]]), non leggerlo. Se un
task è dichiarato "di sola copertura, non riscrittura" e per coprirlo devi correggere un difetto che
impedisce l'esecuzione, fallo e segnala la deviazione dal criterio nel file di stato e nel report — non
scrivere un test che aggira il difetto per restare formalmente dentro il perimetro.
