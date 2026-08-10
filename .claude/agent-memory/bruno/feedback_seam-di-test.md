---
name: feedback-seam-di-test
description: Come si testa in questo repo — paperBroker + DB temporaneo, fake dei soli metodi WS del client, CLI eseguiti come processo figlio; e dichiarare sempre cosa resta scoperto
metadata:
  type: feedback
---

Seam di test consolidati in questo repo, in ordine di preferenza: usa il seam più vicino al codice
reale che riesci a reggere senza mock fragili, e **dichiara esplicitamente cosa resta scoperto**.

**Why:** un test end-to-end fragile che passa per il motivo sbagliato è peggio di un gap dichiarato.
Instanziare l'intero `PerpsBot` è spesso troppo intrecciato con altri singleton
(marketData/notifier/portfolio/predictor): in quel caso si estrae il calcolo puro in `riskManager.js`
e si testa isolato.

**How to apply:**
- **Exchange:** `paperBroker` (lo stesso usato in produzione per il forward-test). `getFrontendOpenOrders()`
  permette di ispezionare i trigger veri dopo un'azione — è così che si verifica il place-then-cancel
  ([[feedback-place-then-cancel]]).
- **DB:** `PerpsDatabase` con `dbPath` temporaneo (`fs.mkdtempSync`), oppure redirezione di `db.dbPath`
  prima del primo `init()` — mai `data/perps.db`. Alcuni metodi (`setSetting`) non fanno init lazy:
  chiama `db.init()` esplicitamente.
- **Timer:** `mock.timers.enable({ apis: ['setInterval', 'Date'] })` per tutto ciò che è periodico
  (watchdog, backoff, soglie di downtime). `setImmediate` lasciato **non** mockato è la via d'uscita
  per drenare le microtask di un tick asincrono prima delle assert.
- **WebSocket:** non simulabile fedelmente. Si sostituiscono i **soli** metodi WS di
  `hyperliquidClient` con un fake a stati (un `Set` delle reti "vive"), lasciando veri
  `getNetwork`/`setNetwork` così il percorso di cambio rete è esercitato davvero.
- **Script CLI (`scripts/`):** eseguili come **processo figlio** (`spawnSync`) su DB temporaneo e
  ambiente costruito da zero, invece di rifattorizzarli per poterli importare. Copre anche il parsing
  degli argomenti e gli exit code, che una funzione estratta non coprirebbe, e rispetta i task di sola
  copertura ("non riscrittura"). Neutralizza il file di configurazione locale con
  `DOTENV_CONFIG_PATH` su un file vuoto, altrimenti l'esito dipende da com'è configurata la macchina
  di chi lancia i test.
- **Prezzi:** `client.getMid = async () => MID` e `client.roundPx = (px) => …`.
- **Contatori Prometheus:** `metrics.get(name)` — evita `render()`, che importa `botManager`.
- **Rotte Express:** `src/server.js` è importabile in un test e **esporta l'app** (`export default
  server.app`). Si prende l'handler REALE dal router stack
  (`app._router.stack.find(l => l.route && l.route.path === p && l.route.methods[m])`,
  poi `layer.route.stack[0].handle`) e si invoca con req/res finti — nessun `listen`, nessun HTTP,
  nessuna dipendenza nuova, e il processo esce da solo (verificato con
  `process.getActiveResourcesInfo()`). Redirigi `db.dbPath` **prima** dell'import. Enumerare il
  router serve anche a dimostrare **l'assenza** di una rotta (es. «nessuna rotta web scrive il budget»).
- **Agenti che parlano con Claude:** `analyst/client.js` memoizza l'istanza Anthropic. In test si fa
  `const c = getClient(); c.messages.create = async (req) => …` e si esercita il loop di tool-use
  **vero** con uno script di risposte, senza rete. Basta una `ANTHROPIC_API_KEY` finta (il
  costruttore non la valida). Fondamentale: `config.js` fotografa l'ambiente al caricamento, quindi
  le env (`AGENTS_ENABLED`, `AGENT_*`) vanno impostate **prima** degli import — cioè tutti gli
  import diventano `await import()` dinamici, perché quelli statici sono issati in cima.
- **Tick di `PerpsBot` in volo:** sostituisci `marketData.getSnapshot` con un cancello
  (`await new Promise(r => gates.push(r))`): il numero di cancelli non rilasciati = numero di tick
  contemporaneamente in volo, cioè quante istanze sono attive. È l'osservabile per le race di
  `botManager` (DEBT-01).
- **Asserzioni sul sorgente**, quando la proprietà non è osservabile a runtime: «l'estrazione è reale
  e non una copia», «l'allowlist non è generata da `TOOL_DEFS`», «`riskAgent.js` non sa che esiste
  l'advisor». Togli i commenti prima di cercare (`/\*…\*/` e `//…`), altrimenti un commento che
  *nomina* la cosa vietata fa fallire il test.

**Verifica di onestà, sempre:** ripristina temporaneamente il bug e controlla che il test **fallisca**.
Se passa anche col bug rimesso, il test non copre ciò che dichiara.
