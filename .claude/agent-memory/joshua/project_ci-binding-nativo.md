---
name: project-ci-binding-nativo
description: Il gap "CI non ricompila better-sqlite3" e' stato chiuso l'8 agosto 2026 (CI-REBUILD-01) — resta aperta la conseguenza sull'allowlist egress di CI-01
metadata:
  type: project
---

Il gap aperto dallo Sprint 1 (`.npmrc` con `ignore-scripts=true` valido per tutto il repo, ma solo
il `Dockerfile` ricompilava `better-sqlite3`) e' stato **chiuso l'8 agosto 2026** con CI-REBUILD-01:
step `npm run rebuild:native` in `ci.yml` subito dopo `npm ci`, piu' istruzioni di setup in `README`
e nella nuova sezione "Setup di un clone pulito" di `CONTRIBUTING`. Prova raccolta su una copia
pulita del repo, non dedotta: senza lo step 3 test rossi con "Could not locate the bindings file"
(`botDca`, `riskPersistence` x2), con lo step 66/66.

**Why:** era il classico "verde da noi, rosso su un runner pulito" — in locale il `.node` era
sopravvissuto da un install pre-SEC-02.

**How to apply:** non riproporre questo fix, e' fatto (stato `ready_for_review`, il passaggio a
`done` e' del PO). **Conseguenza ancora aperta, da portare a chi esegue CI-01:** l'install di
`better-sqlite3` e' `prebuild-install || node-gyp rebuild`, quindi il nuovo step scarica il binario
prebuilt dalle release GitHub. Passando `egress-policy` da `audit` a `block` servono in allowlist,
oltre a `registry.npmjs.org`, anche `github.com` e verosimilmente `api.github.com` /
`objects.githubusercontent.com`; se mancano, il rebuild non fallisce in modo evidente ma ripiega su
`node-gyp` (compilazione da sorgente) o si rompe. Da confermare sui log reali delle run in `audit`.
Vedi [[feedback-prove-reali]], [[feedback-hardening-mirato]].
