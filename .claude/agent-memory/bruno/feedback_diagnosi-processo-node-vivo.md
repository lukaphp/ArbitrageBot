---
name: diagnosi-processo-node-vivo
description: Come ispezionare in sola lettura il processo Express vivo nel container del VPS (inspector CDP) quando "in isolamento funziona, nel processo lungo no"
metadata:
  type: feedback
---

Quando un'operazione funziona in un processo isolato e si blocca nel processo Express lungo, la
causa è quasi sempre uno **stato condiviso di processo** (un bucket, un pool, una cache), non la
rete. Il modo di vederlo è leggere quello stato **dentro il processo vivo**, non dedurlo.

**Why:** su un blocco infinito di `/api/perps/fills` (17/09/2026) le ipotesi ragionevoli — lock
SQLite, socket keep-alive morto, SDK rotta — erano tutte sbagliate; la prova decisiva è stata
leggere un contatore in memoria del processo in esecuzione. Senza quello avrei "corretto" a naso.

**How to apply:** ricetta che funziona su `app-app-1` (Debian slim, nessun tool extra):

1. **Aprire l'inspector**: nell'immagine non c'è il binario `kill` →
   `docker exec app-app-1 node -e "process.kill(1, 'SIGUSR1')"`. Ascolta su `127.0.0.1:9229` nel
   netns del container (non raggiungibile da fuori).
2. **Richiuderlo quando hai finito, senza riavviare niente**: `Runtime.evaluate` di
   `globalThis.require('inspector').close()`. Verificato il 17/09/2026 sul processo di produzione:
   9229 va in ECONNREFUSED, il processo resta vivo e sano (`/health` 200). Non serve aspettare il
   rebuild — e lasciare un debugger aperto su un processo che fa trading è un regresso di sicurezza
   introdotto da te. Verifica la chiusura con `/proc/net/tcp` (stato `0A` = LISTEN), non fidandoti
   del solo comando inviato, e ripulisci gli script che hai copiato in `/tmp` (alcuni emettono un
   token di sessione).
3. **Parlare CDP**: script node dentro il container, `ws` preso da `/app/node_modules/ws/index.js`,
   target da `http://127.0.0.1:9229/json/list`.
4. **`import()` dinamico NON funziona** in `Runtime.evaluate` (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`):
   i singleton ESM non si raggiungono importandoli. Due strade che funzionano:
   - `globalThis.require` **esiste** (lo imposta `hyperliquidClient.js`) → built-in raggiungibili,
     es. `require('https').globalAgent.sockets` per vedere le ClientRequest in volo;
   - per i **nostri** singleton: `Debugger.enable`, poi risalire le closure con
     `Runtime.getProperties` → `internalProperties` → `[[Scopes]]`. Percorso reale:
     `process._getActiveHandles()` → `Server` → `_events.request` (è **engine.io**, non Express) →
     scope `attach` → variabile `listeners` → l'app Express → `app._router.stack` → l'handler della
     rotta → nel suo scope `Module` ci sono tutti gli import del file. Da lì
     `Runtime.callFunctionOn` per leggere. **Solo lettura**: mai `Debugger.pause` su un processo
     che fa trading.
5. **Prima del livello applicativo**, `/proc/net/tcp{,6}` (leggibile senza tool): `st`, code tx/rx,
   timer e `retrnsmt` dicono subito se un socket sta ritrasmettendo (peer morto) o se non c'è
   proprio nessuna richiesta in volo — il che sposta il sospetto a monte della rete.
6. **Riprodurre offline** la parte sospetta con il codice reale della dipendenza (importando il
   `dist/` da `node_modules`): è quello che trasforma "ipotesi plausibile" in causa dimostrata, e
   costa meno di un test end-to-end fragile.

Corollario: l'app ascolta su **:3000** dentro il container (l'8080 è la mappatura sull'host).
Vedi [[hyperliquid-ratelimit-peso20]] e [[evidenza-gia-persistita]].
