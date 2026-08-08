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
temporanea (package finto con script `install` che scrive un file marker) invece di smontare il
`node_modules` di lavoro. Vedi [[feedback-hardening-mirato]].
