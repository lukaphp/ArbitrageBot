---
name: project-ci-binding-nativo
description: Gap aperto trovato il 2026-08-08 — la CI fa npm ci sotto ignore-scripts ma non ricompila better-sqlite3, quindi i test DB non hanno il binding
metadata:
  type: project
---

Effetto collaterale di SEC-02 rimasto aperto alla review dello Sprint 1: `.npmrc`
(`ignore-scripts=true`) vale anche fuori dal Dockerfile, ma **solo il Dockerfile** ricompila
`better-sqlite3`. Non lo fanno né `.github/workflows/ci.yml` (`npm ci` → `npm test`, nessun rebuild)
né la documentazione per chi clona da zero. Lo script `rebuild:native` esiste in `package.json` ma al
2026-08-08 non è referenziato da nessun workflow o doc.

**Why:** in locale il problema non si vede perché il `.node` è rimasto da un install precedente
all'introduzione di `.npmrc` — `npm test` passa (66/66) su una macchina di sviluppo e fallirebbe su
un runner pulito. `cache: 'npm'` di setup-node non aiuta: mette in cache i tarball, non il binario
compilato. I test che lo toccano sono quelli che istanziano davvero SQLite (`riskPersistence`,
`botDca`).

**How to apply:** se il PO/team chiede perché la CI è rossa su questo branch, o se qualcuno segnala
"i test non partono su una macchina nuova", questa è la causa prima da controllare. Il fix è
aggiungere lo step `npm run rebuild:native` dopo `npm ci` (CI + istruzioni di setup), non allentare
`.npmrc`. Verificare comunque lo stato attuale del workflow prima di proporlo: potrebbe essere già
stato sistemato. Vedi [[feedback-prove-reali]], [[feedback-hardening-mirato]].
