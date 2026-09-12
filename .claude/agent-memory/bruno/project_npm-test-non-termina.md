---
name: npm-test-non-termina
description: Su Mac arm64 `npm test` non termina (timer dell'SDK hyperliquid lasciato vivo da mcpServer.test.js) e better-sqlite3 va ricompilato — come ottenere comunque un esito onesto della suite
metadata:
  type: project
---

Due ostacoli che si incontrano **prima** di poter dichiarare "suite verde", entrambi d'ambiente e non
di codice. Verificati il 2026-09-12 su Darwin arm64, Node 22.

1. **`better-sqlite3` compilato per l'architettura sbagliata.** Sintomo: ~95 test su 467 rossi con
   `ERR_DLOPEN_FAILED … have 'x86_64', need 'arm64'`. Rimedio già presente nel repo:
   `npm run rebuild:native`. Tocca solo `node_modules`, niente da committare.
2. **`npm test` non esce mai.** Non è lentezza: dopo l'ultimo test il processo resta appeso.
   `test/mcpServer.test.js` lascia vivo un `setInterval` da 60s creato dentro l'SDK `hyperliquid`
   (`startPeriodicRefresh`, in `node_modules/hyperliquid/dist/index.mjs`), non `unref`-ato e mai
   chiuso. Il file si appende anche eseguito da solo.

**Why:** senza saperlo si conclude o che la suite è rotta (caso 1) o che è lentissima e la si
interrompe a metà (caso 2) — in entrambi i casi si finisce per dichiarare un esito che non si è mai
visto, che è esattamente ciò che la DoD di questo progetto vuole evitare.

**How to apply:** rebuild nativo una volta, poi esegui la suite con
`node --test --test-force-exit test/*.test.js` invece di `npm test`, e **dichiara nel report che hai
usato quella variante e perché**. Misura sempre un **baseline prima di toccare i file** — e prima di
spiegare un rosso che cambia tra due run, **guarda `git log`**: il working tree è condiviso e i
colleghi committano mentre lavori ([[tree-condiviso-mai-git-stash]]). Il 2026-09-12 ho visto 4 rossi
di UI (drawer advisor ×2, tab Performance ×2) sparire tra due run e stavo per dichiararli *flake*:
erano invece un bug vero — sandbox `node:vm` senza `location`/`history` — corretto da un altro nel
frattempo. Un rosso intermittente in questa suite esiste (il DCA con fill parziale in
`botFillSize.test.js`), ma "flake" è la spiegazione da dare **ultima**, non la prima. Per capire *chi* tiene
vivo il processo: importa il file di test da uno script e stampa
`process.getActiveResourcesInfo()` da un timer `unref`-ato, oppure avvolgi `setInterval`/`setTimeout`
per registrarne lo stack. Se qualcuno decide di sistemarlo, le due strade sono `--test-force-exit`
nello script npm o chiudere il client nel teardown del test. Vedi anche [[feedback-seam-di-test]].
