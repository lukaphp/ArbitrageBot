---
name: project-tree-condiviso-mai-git-stash
description: Durante uno sprint il working tree è condiviso con gli altri agenti del team — mai usare git stash per verificare il rosso prima del fix
metadata:
  type: project
---

Durante uno sprint gli altri membri del team (Maya, Joshua) lavorano **nello stesso working tree
git**, in parallelo. Un `git stash push -- src/` per "provare che il test fallisce senza il fix"
mette da parte anche il lavoro non committato degli altri.

**Why:** mi è capitato in Sprint 4 (DEBT-01). Ho fatto `git stash push -- src/` per confrontare il
conteggio dei test e ho portato via le modifiche di Joshua a `src/perps/metrics.js`, facendo fallire
il suo `test/metricsExposition.test.js` appena aggiunto. Lo `stash pop` è andato a buon fine, ma è
stato un rischio inutile: se avessi fatto altre operazioni git in mezzo, avrei potuto perdere lavoro
di un altro. Corollario dello stesso fatto: un conteggio totale dei test che cresce senza che io
abbia aggiunto niente **non è un bug mio** — è un collega che ha aggiunto un file di test.

**How to apply:** ottieni il rosso-prima-del-fix **scrivendo il test prima** (test-first) ed
eseguendolo: è la stessa evidenza, senza toccare il tree. Quando il test nasce DOPO il fix (capita
sulle storie piccole, dove implementare è più rapido che impostare il test), il rosso si dimostra su
un **worktree git separato**: `git worktree add --detach <scratchpad>/red HEAD`, un symlink a
`node_modules`, copia dei soli file di test nuovi, `node --test`. Nessuna riga del tree condiviso si
muove, e alla fine `git worktree remove --force`. Se il difetto non è esprimibile come test sul
codice pre-fix (una funzione che ancora non esiste), lo si osserva con uno script che mostra il
comportamento vecchio (es. "cooldown in memoria: true, persistito: null") — vale come evidenza,
la mancanza di un export no. Se serve davvero confrontare due stati nello stesso tree, copia il file
in `scratchpad` e modifica la copia, oppure `git stash push -- <singolo file mio>` e solo quello. Prima di qualunque operazione git che sposta file, guarda `git status --short`: se
compaiono file di altri (`public/`, `deploy/`, `src/perps/metrics.js`, test non tuoi), fermati.
Vale anche per il conteggio dei test in `npm test`: confronta i **nomi** dei test, non i totali
([[feedback-seam-di-test]]).
