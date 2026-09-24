---
name: npm-test-non-termina
description: `npm test` che non termina — risolto il 2026-09-15 chiudendo le SDK hyperliquid nel teardown; resta il rebuild nativo su Mac arm64 e la tecnica per trovare chi tiene vivo il processo
metadata:
  type: project
---

Due ostacoli storici **prima** di poter dichiarare "suite verde". Il primo è ancora vivo, il secondo
è chiuso.

1. **`better-sqlite3` compilato per l'architettura sbagliata** (Darwin arm64). Sintomo: decine di
   test rossi con `ERR_DLOPEN_FAILED … have 'x86_64', need 'arm64'`. Rimedio già nel repo:
   `npm run rebuild:native`. Tocca solo `node_modules`, niente da committare.
2. **`npm test` non esce mai — RISOLTO il 2026-09-15.** Causa: `test/mcpServer.test.js` avvia bot
   veri, il primo tick apre un'SDK `hyperliquid` di lettura, e l'SDK avvia un `setInterval` di 60s
   ref'd (`SymbolConversion.startPeriodicRefresh`); le SDK in `hyperliquidClient.readSdks` non
   venivano mai chiuse (`closeWs()` copriva solo le WebSocket). **Non** erano i timer dei bot:
   `bot.stop()` li azzera. Fix: `hyperliquidClient.closeAllSdks()` chiamato in un `test.after`.
   Da qui in poi `npm test` esce da solo in ~7s e **`--test-force-exit` non serve più**: se torna ad
   appendersi è una regressione nuova, non questa — misurala, non aggiungere il flag.

**Why:** senza saperlo si conclude o che la suite è rotta (caso 1) o che è lentissima e la si
interrompe a metà (caso 2) — in entrambi i casi si dichiara un esito che non si è mai visto, che è
esattamente ciò che la DoD di questo progetto vuole evitare.

**How to apply:** per capire *chi* tiene vivo il processo, avvolgi `setInterval`/`setTimeout` in un
modulo passato a `--import` registrandone lo stack di creazione, e stampa i soli handle ancora ref'd
da un timer `unref`-ato: in trenta secondi dice il colpevole con nome e riga, e ha già smentito due
volte l'ipotesi "plausibile" (i timer dei bot sopravvissuti a `db.deleteBot`). L'ipotesi plausibile
sull'origine di un handle vivo si **misura**, non si adotta — vale anche quando arriva da un collega
che ha diagnosticato bene tutto il resto. Prima di spiegare un rosso che cambia tra due run guarda
`git log`: il working tree è condiviso ([[tree-condiviso-mai-git-stash]]); "flake" è la spiegazione
da dare **ultima**. Vedi anche [[feedback-seam-di-test]].
