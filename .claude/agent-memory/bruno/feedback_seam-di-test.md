---
name: feedback-seam-di-test
description: Come si testa in questo repo — paperBroker + DB temporaneo, fake dei soli metodi WS del client, CLI come processo figlio, rotte Express e ponte loopback /internal/*; trappole di flake (ultima riga per ts, straggler fire-and-forget, success:true senza mutazione)
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
  **Trappola di falso verde**, verificata: un file che importa `src/server.js` e che fallisce a
  **top level** (import inesistente, `await import()` che rigetta) viene contato come **PASSATO** —
  `src/server.js` installa `process.on('uncaughtException')` → `server.stop()`, il processo esce con 0
  e `node --test` vede un file senza subtest. Un intero file di test può sparire senza un rosso: se
  scrivi il test PRIMA del fix e vedi «pass 1» con zero subtest, non è verde, è morto in import.
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
- **Diagnostica del Monitor:** `_diagRule` è privato ma `getMonitor()` è pubblico e lo mappa su
  `entryRules`/`exitRules` — è lo stesso percorso dell'endpoint `/api/perps/bots/:id/monitor`, quindi si
  testa da lì invece di chiamare il metodo privato. Con `marketData.getSnapshot` sostituito, `PerpsBot`
  è istanziabile senza altri singleton (vedi `botMonitorWarmup.test.js`, `botMonitorDiag.test.js`).
- **Mai selezionare "l'ultima riga" per posizione** quando il test ne scrive più d'una nello stesso tick:
  `listTradesBy`/`listTrades` ordinano `ORDER BY ts DESC` su **millisecondi**, e due scritture nello stesso
  ms si invertono a caso. `…{limit: 1})[0]` era il flake ~1-su-8 di `botFillSize.test.js`; `listTrades(n)`
  è peggio, non filtra nemmeno per bot. Seleziona per **identità**: `hl_oid` (la tabella `trades` lo ha
  già, e il broker restituisce l'oid), oppure filtra per `botId` e assert anche sul **conteggio** delle
  righe. Attenzione: `insertTrade` fa `hlOid: trade.hlOid || null`, quindi un oid `0` diventerebbe NULL —
  sul paperBroker `oidSeq` parte da 1, ma non dare per scontato che un oid sia truthy.
- **Ponte loopback tra processi (`/internal/*`):** l'osservabile è la **richiesta HTTP**, non la funzione
  che la fa (spiare un export non intercetta i chiamanti interni, che usano il binding locale). Si
  sostituisce `http.request` filtrando su `options.path` e si **delega all'originale** tutto il resto.
  Intercetta l'intero prefisso `/internal/`, non la singola rotta: un bot avviato in un test ha `io` null
  e quindi fa partire POST **vere** verso la porta 3000 — con l'app accesa in locale finirebbero nella
  dashboard reale, indistinguibili da eventi veri.
- **Asserzioni sul sorgente**, quando la proprietà non è osservabile a runtime: «l'estrazione è reale
  e non una copia», «l'allowlist non è generata da `TOOL_DEFS`», «`riskAgent.js` non sa che esiste
  l'advisor». Togli i commenti prima di cercare (`/\*…\*/` e `//…`), altrimenti un commento che
  *nomina* la cosa vietata fa fallire il test.

**Verifica di onestà, sempre:** ripristina temporaneamente il bug e controlla che il test **fallisca**
(o, meglio, scrivi il test prima del fix — nel working tree condiviso non si stasha,
[[project-tree-condiviso-mai-git-stash]]). Se passa anche col bug rimesso, non copre ciò che dichiara.

**Corollario: `success: true` non prova che sia successo qualcosa.** Molti handler hanno un ramo
"era già in quello stato" che ritorna successo **senza** mutare nulla e senza gli effetti collaterali
che il test vuole osservare (`bot_control('stop')` su un bot già fermo esce prima di
`notifyExpressReload`). Se l'assertion è un **contatore** di effetti fire-and-forget, quel contatore
può essere soddisfatto dallo **straggler del subtest precedente**: basta una microtask di ritardo
(un `await import(...)` dentro la funzione notificante) perché la chiamata vecchia cada *dopo* il tuo
`reset()` e sembri la tua. Porta il sistema nello stato in cui l'azione muta davvero, e assert **anche
sul cambio di stato osservabile** (`data.status === 'stopped'`), non solo sul flag di successo.

**Corollario: un fix di concorrenza va provato anche nel verso opposto.** Un cancello che blocca la
race è verde anche se ha serializzato *tutto* — la regressione di concorrenza si nasconde dietro il
test di correttezza. Serve un secondo caso, sotto la soglia del limite, che asserisca che i due
attori sono **contemporaneamente dentro** la finestra critica (col seam del cancello su
`setLeverage`: `counters.leverage === 2` *prima* di aprire il cancello). Attenzione al punto in cui
si misura: `_openPosition` ha diversi `await` prima di `setLeverage` (conferma MTF, gate ML), quindi
un assert sincrono subito dopo la chiamata legge 0 — serve cedere l'event loop qualche giro
(`for (…) await new Promise(r => setImmediate(r))`) prima di misurare. Lo stesso `settle()` rende
deterministico il caso di race: senza, chi arriva secondo dipende dallo scheduler.

**Corollario: un'asserzione su testo libero dev'essere falsificabile dal caso opposto.** `assert.match(state, /aperta/i)`
doveva provare che l'osservazione avveniva DOPO l'esecuzione — ma «nessuna posizione **aperta**», cioè
il testo prodotto proprio dal caso anticipato, lo soddisfa. Stesso difetto su `/chius/i`, soddisfatto da
«chiusura richiesta ma la posizione risulta ancora aperta». Su una stringa composta, assert su un dato che
nell'altro ramo **non esiste** (la size e il prezzo d'ingresso reali, che prima del fill non ci sono) e
aggiungi la negazione esplicita dell'altro ramo. Si scopre solo mutando il codice: il test era verde con e
senza il difetto.

**Corollario: un test può SPENDERE DAVVERO.** `config.js` fa `dotenv.config()`, quindi ogni chiave presente
nel file di ambiente locale è viva dentro `npm test`, e i file che avviano bot veri (`mcpServer.test.js`)
arrivano al primo tick. Per un canale a pagamento non basta sperare che la chiave non ci sia: il cancello è
`process.env.NODE_TEST_CONTEXT` (lo imposta il runner di `node --test`) **più** la condizione "nessun
trasporto iniettato", così i test del modulo — che il trasporto lo iniettano — continuano a coprire il
percorso vero.

**Corollario: controlla di essere davvero ENTRATO nel ramo che asserisci.** Un caso "sano" costruito con
la condizione per caso *soddisfatta* esce sul ramo felice e non esercita mai il codice sotto test — es.
prezzo 46.80 con soglia `< 50` non produce nessun messaggio di gap da formattare. Scegli input che
rendono la condizione genuinamente **non** soddisfatta, e assert anche su `met: false` per fissarlo.
