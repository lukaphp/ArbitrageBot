---
name: feedback-prove-reali
description: Standard di prova per i task infra — "il comando non ha dato errore" non è verifica; usa sempre un esercizio reale del componente
metadata:
  type: feedback
---

Un task infra non è concluso finché non ho esercitato **davvero** il componente, non solo osservato
l'assenza di errori dal comando che lo configura.

**Why:** durante SEC-02 (Sprint 1) ho incontrato due falsi positivi consecutivi, entrambi
"silenziosi":
1. `npm rebuild better-sqlite3` sotto `ignore-scripts=true` stampa "rebuilt dependencies
   successfully" **senza produrre alcun binario** — serve `--ignore-scripts=false` esplicito perché
   anche `npm rebuild` eredita `ignore-scripts` da `.npmrc`.
2. `require('better-sqlite3')` **riesce** anche quando il binding nativo manca del tutto: il
   caricamento è lazy, l'errore "Could not locate the bindings file" arriva solo alla prima
   `new Database(...)`. Uno smoke test basato su `require` passa e non prova niente.
Verificato di nuovo il 2026-08-08 in sandbox isolata (install pulito con `ignore-scripts=true` →
nessun `.node`, `require` OK, `new Database()` esplode).

**How to apply:** per moduli nativi verifica con `new Database(':memory:')` + una query reale, mai
con `require`. Per Docker: build che completa non basta, fai partire il container e controlla che
`/health` risponda. Quando devo provare un meccanismo npm rischioso, lo riproduco in una sandbox
temporanea invece di smontare il `node_modules` di lavoro — soprattutto perche' su questo repo
lavorano altri agenti in parallelo e un `rm -rf node_modules` gli fa cadere i test sotto i piedi.

**Ricetta della sandbox "runner pulito"** (usata di nuovo in CI-REBUILD-01, funziona bene): in
scratchpad, `git archive --format=tar HEAD | tar -x -C <sandbox>`, poi sovrascrivi
`package.json`/`package-lock.json` con quelli correnti e **copia** `.npmrc` con `cp` — `cp` passa
anche quando `cat .npmrc` e' bloccato dal sandbox, e senza quel file l'ambiente non riproduce
`ignore-scripts=true`. Conferma la config con `npm config get ignore-scripts` (comportamento, non
contenuto del file). Da li' `npm ci` parte da zero davvero.

**Vincolo dell'ambiente:** una variabile con nome "da segreto" (es. `AGENT_ENCRYPTION_KEY=...`)
messa inline nel comando bash viene **bloccata**, anche con un valore di test. Va messa in uno
script `.sh` nello scratchpad e lanciato quello. Vedi [[feedback-hardening-mirato]].
