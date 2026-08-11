# Release 2 · Sprint 1 — Hardening mainnet (Epic A)

**Team:** Nautilus · **Stato:** review chiusa, 10/10 storie + 2 extra approvati (11 agosto 2026) — refinement tenuto l'11 agosto 2026, subito dopo la
definizione delle epiche di `docs/KB/BACKLOG/release2/README.md`. Questo sprint è **Epic A per intero**:
i 4 critici e i 5 importanti dell'audit indipendente (`docs/AUDIT_REPORT.md`), verificati riga per
riga sul codice reale prima di questo planning (`release2/README.md` §1), più un pacchetto di 5 minori.
Nessuna feature nuova in questo sprint — solo correttezza e resilienza su ciò che già esiste, per
decisione esplicita del PO ("prima epica, blocca le altre").

---

## 0. Candidati

| # | Story | Origine | Verificato sul codice | SP |
|:--|:---|:---|:---:|:--:|
| 1 | Size reale del fill, non pianificata | Audit CRIT-01 | ✅ (`order.totalSz` confermato nel parsing) | 3 |
| 2 | Cooldown di portafoglio persistito | Audit CRIT-02 | ✅ | 2 |
| 3 | Lock di apertura multi-bot stesso coin | Audit CRIT-03 | ✅ | 3 |
| 4 | Reazione immediata su SL non piazzabile | Audit CRIT-04 (declassato a WARN, vedi `release2/README.md` §1) | ✅, severità corretta | 1 |
| 5 | Rimuovere `console.log` di debug | Audit WARN-01 | ✅ | 1 |
| 6 | Bounds/monitoring su `execQueue` | Audit WARN-02 | ✅ | 2 |
| 7 | Slippage reale calcolato e loggato | Audit WARN-03 | ✅ | 2 |
| 8 | Warning esplicito su `DEV_FALLBACK` | Audit WARN-04 | ✅ | 1 |
| 9 | Stato esplicito "degraded" sul WS | Audit WARN-05 | ✅, portata corretta (il backoff esiste già) | 3 |
| 10 | Pacchetto qualità (5 minori) | Audit MINOR-01…05 | ✅ (spot-check) | 3 |

**Totale: 21 SP.** Owner: **Bruno** per tutte le 10 storie (stesso modulo concettuale, money-handling
code — un solo filo conduttore invece di frammentare la revisione). **Annie** revisore designata per
l'intero sprint, non solo un sottoinsieme: è la stessa classe di rischio delle storie advisor di
Sprint 4.

---

### 0.1 · Size reale del fill, non pianificata

**Verificato — non un'ipotesi.** `_openPosition()` in `src/perps/bot.js` scrive
`this.position = { size: plan.size, ... }` e `db.insertPositionIfNoneOpen({ ..., size: plan.size })`
usando sempre la size **pianificata**, mai quella davvero eseguita. Ho verificato
`_parseOrderResult()` in `hyperliquidClient.js:571-585`: la risposta **contiene già**
`totalSz` (`filled?.totalSz`), semplicemente non viene mai letta dal chiamante.

**Caso in più rispetto all'audit, trovato verificando il codice:** se l'ordine IOC non riempie
affatto (`filled` assente, `totalSz` `null`), oggi il bot aprirebbe comunque una posizione "fantasma"
di `plan.size` — peggio di un fill parziale mal dimensionato, è una posizione che **non esiste
sull'exchange** ma esiste nel DB e in memoria finché `_reconcile()` non la corregge al tick
successivo. Va trattato come caso a sé, non solo come "ratio basso".

**Cosa serve:**
- Dopo `placeMarketOrder`, leggere `order.totalSz`. Se `null` o `0`: **non aprire nulla** — loggare
  l'anomalia, notificare, e uscire senza scrivere posizione (il capitale pianificato non è mai stato
  impegnato, non c'è nulla da "correggere" più tardi).
- Se `0 < totalSz < plan.size` (fill parziale reale): usare `totalSz` per `position.size`,
  `insertPositionIfNoneOpen`, TP/SL — mai `plan.size`. Notificare con pianificato vs riempito.
- Propagare la size reale anche al DCA (`_maybeDca`/`_checkDca`, stesso pattern di lettura del fill).

**Criteri di accettazione:**
- [x] Fill pieno (`totalSz === plan.size`): comportamento identico a oggi, nessuna regressione.
- [x] Fill parziale: `position.size`, riga DB, TP/SL usano `totalSz`, non `plan.size`; notifica con i
      due valori.
- [x] Fill nullo/zero: nessuna posizione scritta in DB né in memoria; notifica dedicata; nessun TP/SL
      piazzato per una posizione inesistente.
- [x] Test che simula un broker con fill parziale e uno con fill nullo (mock su `placeMarketOrder`,
      pattern già usato in `test/botTpSweep.test.js`), verificati rossi prima del fix.
- [x] Stesso trattamento applicato al percorso DCA.

**File:** `src/perps/bot.js`. **SP:** 3.

---

### 0.2 · Cooldown di portafoglio persistito

**Verificato.** `class Portfolio { constructor() { this.cooldowns = new Map(); } }` in
`src/perps/portfolio.js:25-27` — puramente in-memoria. Un riavvio del processo (deploy, crash, OOM)
azzera qualunque cooldown attivo, riaprendo la finestra di re-entry impulsivo che il cooldown esiste
apposta per chiudere.

**Cosa serve:**
- Persistere in `settings` (stessa tabella chiave-valore già usata per `portfolio_limits`), non una
  tabella nuova — è un mapping `botId → timestamp`, la stessa forma di dato.
- Caricare all'avvio (`_loadPersistedCooldowns`), scartando i cooldown già scaduti (non serve
  riportare in memoria un timestamp nel passato).
- Scrivere subito quando un cooldown si attiva (`canOpen()`, ramo `consecutiveLosses >= L.maxConsecutiveLosses`).
- Fallimento di lettura/scrittura del DB: non deve mai impedire l'avvio del server — degradare a
  "parti senza cooldown pregressi", loggando l'anomalia (stesso principio già applicato altrove nel
  progetto per settings opzionali).

**Criteri di accettazione:**
- [x] Un cooldown attivo sopravvive a un riavvio del processo (test: attiva cooldown, ricrea l'istanza
      di `Portfolio`, verifica che sia ancora bloccato).
- [x] Un cooldown già scaduto al momento del riavvio non viene ripristinato.
- [x] Un DB non disponibile in lettura all'avvio non impedisce l'avvio del server (degrado, non crash).
- [x] Nessuna migrazione di schema: uso di `settings` esistente.

**File:** `src/perps/portfolio.js`. **SP:** 2.

---

### 0.3 · Lock di apertura per `(masterAddress, coin)`

**Verificato, causa precisata rispetto all'audit.** `placeMarketOrder()` **è** serializzato per
wallet via `execQueue.run()` (`hyperliquidClient.js:510`) — la firma e l'invio non collidono mai.
Il problema è **a monte**: `checkLimits()`, `portfolio.canOpen()` e `_cooldownBlock()` in
`_openPosition()` girano **prima** di entrare in `execQueue`, su uno snapshot `account` letto
all'inizio del tick. Due bot sullo stesso `(masterAddress, coin)` possono entrambi superare questi
controlli nello stesso istante (nessuno dei due vede ancora la posizione dell'altro), ed entrambi
arrivano a `placeMarketOrder` — che la serializza per la *firma*, non per l'*idoneità ad aprire*.
`insertPositionIfNoneOpen` intercetta il doppione **in DB dopo il fatto**: i due ordini sono già
sull'exchange.

**Cosa serve:**
- Lock esplicito per `(masterAddress.toLowerCase(), coin)` in un punto condiviso — **accanto** a
  `execQueue`, riusando la stessa istanza singleton (non un modulo parallelo con la sua logica).
- Acquisito subito prima del blocco `this._opening = true; try { ... }` in `_openPosition()` (già
  lì per SEC-08), rilasciato nello stesso `finally` esistente — un solo punto di gestione, non due
  flag paralleli che possono disallinearsi.
- Se il lock è già preso: uscita immediata con log, **stesso trattamento di un `canOpen()` fallito**
  (nessuna eccezione non gestita, nessuna notifica di errore — è un evento atteso in un sistema
  multi-bot, non un guasto).

**Criteri di accettazione:**
- [x] Due bot sullo stesso `(masterAddress, coin)` che tentano l'apertura nello stesso tick: solo uno
      arriva a `placeMarketOrder`, l'altro esce prima di firmare nulla (test con due chiamate
      concorrenti a `_openPosition()`, verificato che `broker.placeMarketOrder` sia chiamato una sola
      volta).
- [x] Il lock si rilascia **sempre** nel `finally`, anche se l'apertura fallisce a metà (stesso
      pattern già verificato per `this._opening` in SEC-08 — nessuna funzione nuova, estende quella
      esistente).
- [x] Bot su coin diversi sullo stesso master non si bloccano a vicenda (il lock è per coppia, non per
      wallet intero).
- [x] Nessuna modifica al comportamento di `execQueue.run()` per gli ordini di chiusura/trigger — il
      lock riguarda solo l'apertura.

**File:** `src/perps/execQueue.js`, `src/perps/bot.js`. **SP:** 3.

**Nota per il refinement in corso d'opera:** non duplicare la logica di serializzazione di
`execQueue` — il lock è un `Set` di chiavi, non una seconda coda di Promise.

---

### 0.4 · Reazione immediata su SL non piazzabile *(ex CRIT-04, declassato)*

**Verificato e corretto rispetto all'audit** (`release2/README.md` §1): il claim "aspetta il tick successivo
(10s)" è falso — `_ensureStopLoss()` in `bot.js` reagisce già nello stesso tick. Il problema reale è
più piccolo: quando `placeTriggerOrder` restituisce `res.oid === null` (fallimento immediato,
inequivocabile), il codice fa comunque una `_findStopOrder()` — una chiamata API in più, non un'attesa
di 10 secondi — prima di decidere di chiudere per sicurezza.

**Cosa serve:** se `res.oid` è `null` subito dopo `placeTriggerOrder`, saltare `_findStopOrder()` e
procedere direttamente a `_closeNow('SL non piazzabile (oid null)')` — la verifica extra ha senso solo
quando la risposta non è già di per sé conclusiva.

**Criteri di accettazione:**
- [x] `res.oid === null`: chiusura di sicurezza senza la chiamata `_findStopOrder()` intermedia (test
      che conta le chiamate al broker).
- [x] `res.oid` valorizzato: comportamento invariato, la verifica esistente resta.
- [x] Notifica esistente invariata nel testo (non cambia cosa viene comunicato, solo quanto in fretta).

**File:** `src/perps/bot.js`. **SP:** 1.

---

### 0.5 · Rimuovere il `console.log` di debug nel logger

**Verificato.** `src/utils/logger.js:29` — una riga di debug mai rimossa, stampata a ogni avvio,
l'unica del file che non passa dal formato strutturato del resto del logger.

**Criteri di accettazione:**
- [x] Riga rimossa. Nessun altro comportamento del logger cambia (verificato con i test esistenti del
      logger, se presenti, altrimenti verifica manuale dell'avvio).

**File:** `src/utils/logger.js`. **SP:** 1.

---

### 0.6 · Bounds e monitoraggio sulla profondità di `execQueue`

**Verificato.** `execQueue.js` è una chain di Promise senza alcun contatore di profondità. Con più
bot sullo stesso master attivi insieme, un ordine di chiusura urgente può restare in coda dietro
aperture non urgenti, senza che nessuno se ne accorga.

**Cosa serve (solo visibilità in questo sprint, non prioritizzazione — esplicitamente fuori scope,
candidato futuro):**
- Contatore di profondità per chiave (`masterAddress`) in `run()`.
- Warning loggato (e, se già esiste un canale comodo, in metrica Prometheus — `perps_execqueue_depth`
  o simile, coerente con le metriche già esposte in OBS-01) quando la profondità supera una soglia
  configurabile (default: 10).

**Criteri di accettazione:**
- [x] La profondità della coda è interrogabile/loggata quando supera la soglia.
- [x] Nessuna modifica al comportamento di serializzazione esistente — è solo osservabilità in più.
- [x] Test che accoda N funzioni lente e verifica che il warning scatti oltre soglia.

**File:** `src/perps/execQueue.js`. **SP:** 2.

---

### 0.7 · Slippage reale calcolato e loggato

**Verificato.** `bot.js:391` — `const entryPx = order.avgPx || snapshot.price;`: `snapshot.price`
(il prezzo di riferimento al momento della decisione) e `order.avgPx` (il prezzo medio di
esecuzione) sono **già entrambi disponibili nello stesso scope**, ma la differenza tra i due — lo
slippage reale — non viene mai calcolata né esposta.

**Cosa serve:**
- `realSlippagePct = Math.abs(order.avgPx - snapshot.price) / snapshot.price`, calcolato subito dopo
  il fill.
- Loggato sempre; incluso nel record `trades` (nuova colonna o campo nel JSON esistente, da scegliere
  in modo che non rompa `getBotStats()`/`getBotPerformance()` — additivo, non sostitutivo) per poterlo
  aggregare in futuro nella dashboard Performance (ANA-01, Sprint 4).
- Nessuna azione automatica sullo slippage alto in questo sprint (es. nessun blocco) — solo
  visibilità, coerente con lo scope "hardening", non "nuova policy di rischio".

**Criteri di accettazione:**
- [x] Slippage calcolato e loggato su ogni apertura reale (non sulle posizioni adottate da `_reconcile`,
      dove non c'è un `order` di riferimento).
- [x] Persistito in modo che sia recuperabile per un'aggregazione futura, senza rompere le query
      esistenti su `trades`/`positions`.
- [x] Test con `avgPx` uguale, leggermente diverso, e molto diverso da `snapshot.price`.

**File:** `src/perps/bot.js`, `src/db/database.js` (campo additivo). **SP:** 2.

---

### 0.8 · Warning esplicito su `DEV_FALLBACK` attivo

**Verificato.** `src/perps/secretBox.js:55,85` — `DEV_FALLBACK = 'arbitragebot-perps-dev-key'`,
noto a chiunque legga il repository. Il fail-fast in `NODE_ENV=production` (SEC-07, Sprint 3) è
corretto; il rischio residuo è uno **staging con dati reali** avviato senza `NODE_ENV=production`,
dove il fallback resta attivo in silenzio.

**Cosa serve:** un `console.warn`/`logger.warn` esplicito, ben visibile (non un log strutturato che
si perde tra gli altri), ogni volta che `secret()` ritorna `DEV_FALLBACK` invece della chiave vera —
non blocca l'avvio, rende impossibile non accorgersene.

**Criteri di accettazione:**
- [x] Warning visibile a ogni avvio in cui `DEV_FALLBACK` è in uso, fuori produzione.
- [x] Nessun warning quando `AGENT_ENCRYPTION_KEY` è impostata correttamente.
- [x] Nessun cambiamento al comportamento fail-fast già esistente in produzione.

**File:** `src/perps/secretBox.js`. **SP:** 1.

---

### 0.9 · Stato esplicito "degraded" sul reconnect WebSocket

**Verificato, portata corretta rispetto all'audit.** Il watchdog di `marketData.js` **non riparte
alla cieca**: ha già backoff minimo tra i tentativi (`lastWsAttemptAt`) e una notifica Telegram **una
per episodio**, non per tentativo (stesso principio di SEC-10). Quello che manca davvero è uno
**stato esplicito interrogabile** — oggi il sistema sa solo "sto ritentando", non "sono entrato in un
guasto persistente che probabilmente non si risolve da solo nei prossimi secondi".

**Cosa serve:**
- Uno stato a tre valori (`healthy` / `retrying` / `degraded`) invece del solo booleano di
  connessione attuale — `degraded` dopo N tentativi consecutivi falliti oltre una soglia di tempo
  (non un contatore assoluto: il backoff già rallenta i tentativi, quindi la soglia va espressa in
  tempo trascorso, non in numero di retry).
- Esposto in `getMonitor()`/`/api/perps/risk` (dove gli alert di rischio già vivono, `riskSnapshot.js`)
  e nella metrica Prometheus esistente `perps_ws_connected` — un valore aggiuntivo o una nuova serie,
  da decidere senza rompere il pannello Grafana già provisionato in OBS-01.
- Un solo alert **al passaggio** verso `degraded` (non un altro per ogni retry successivo, che è
  esattamente ciò che la notifica-per-episodio già evita) e uno al rientro in `healthy`.

**Criteri di accettazione:**
- [x] Lo stato passa a `degraded` dopo la soglia configurata di tempo in retry continuo, non al primo
      fallimento.
- [x] Un solo alert all'ingresso in `degraded`, un solo alert al ritorno a `healthy` — nessuna
      ripetizione per singolo tentativo di retry nel mezzo (test sullo stile di
      `test/portfolioCooldownNotify.test.js`, Sprint 3).
- [x] Lo stato è leggibile da un endpoint esistente, non ne serve uno nuovo se `riskSnapshot`/`/metrics`
      bastano.
- [x] Nessuna modifica al backoff/alla logica di retry già esistente — solo lo stato esplicito sopra.

**File:** `src/perps/hyperliquidClient.js`, `src/perps/marketData.js`, `src/perps/riskSnapshot.js`.
**SP:** 3.

---

### 0.10 · Pacchetto qualità (5 minori)

Non riletti singolarmente con lo stesso rigore dei critici/importanti (basso rischio, bassa
ambiguità) — presi per buoni dall'audit, ciascuno con test-first come da convenzione.

1. **`_consumeExternal()` con side effect nel contesto di valutazione** (`strategyEngine.js:44,118`)
   — se `evaluate()` gira due volte sullo stesso snapshot (loop + un percorso diagnostico, es.
   `getMonitor()`), la seconda chiamata non trova più il segnale esterno perché la prima l'ha già
   consumato. Separare `_checkExternal()` (puro, per la diagnostica) da `_consumeExternal()`
   (con side effect, solo nel loop reale).
2. **`portfolio.canOpen()` con side effect** (`portfolio.js`, ramo perdite consecutive) — una funzione
   il cui nome promette una verifica pura scrive anche lo stato. Separare in `canOpen()` (puro) e un
   `recordLoss(botId)` esplicito, chiamato quando la perdita è confermata.
3. **PaperBroker: stato non persistito** (`paperBroker.js:29`, `this.state = new Map()`) — un
   riavvio azzera un forward-test in corso. Serializzare in `settings` o una tabella dedicata.
4. **Nessun avviso sul warmup degli indicatori** — un bot con meno candele del periodo richiesto
   (es. RSI(14) serve 15 candele) resta silenziosamente su `hold`. Aggiungere in `getMonitor()` un
   campo `warmingUp: { candlesHave, candlesNeed }`.
5. **Notifiche Telegram senza retry** (`notifier.js:54-64`) — un 429 di Telegram fa perdere la
   notifica in silenzio. 1-2 retry con backoff breve per le notifiche urgenti (non per tutte: un
   digest non urgente non merita di intasare la coda su un rate-limit temporaneo).

**Criteri di accettazione:** un test per item, verificato rosso prima del fix dove applicabile (1, 2,
5 sono comportamento; 3, 4 sono più vicini a "verifica che il dato sopravviva/compaia").

**File:** `src/perps/strategyEngine.js`, `src/perps/portfolio.js`, `src/perps/paperBroker.js`,
`src/perps/bot.js`, `src/perps/indicators.js`, `src/perps/notifier.js`. **SP:** 3 (pacchetto).

---

## 1. Definition of Done di sprint (invariata)

1. Codice + test (rosso prima del fix dove è un bug, come da convenzione).
2. `npm test` e `npm run lint` verdi.
3. Documentazione aggiornata dove la superficie utente/operativa cambia (`MANUAL.md`, `DEPLOY.md` se
   emergono nuove variabili di configurazione — es. soglia di `degraded` per WARN-05).
4. Status file aggiornato in `docs/KB/BACKLOG/release2/sprint1-status/`.
5. Review col PO a fine sprint, task per task, con evidenze.

**Invarianti specifiche di questo sprint:**
- Nessuna storia introduce una feature nuova — solo correttezza/resilienza su codice esistente.
- CRIT-01 (0.1): il caso di fill nullo non deve mai scrivere una posizione "fantasma" — non solo il
  caso di fill parziale citato dall'audit.
- CRIT-03 (0.3): il lock riusa `execQueue`, non introduce una seconda struttura di serializzazione.
- WARN-05 (0.9): non tocca il backoff/la logica di retry già esistente, solo aggiunge lo stato
  esplicito.

---

## 2. Board

| ID | Story | Owner | SP | Stato |
|:--|:---|:---|:--:|:---|
| CRIT-01 | Size reale del fill, non pianificata | Bruno | 3 | Da fare |
| CRIT-02 | Cooldown di portafoglio persistito | Bruno | 2 | Da fare |
| CRIT-03 | Lock di apertura multi-bot stesso coin | Bruno | 3 | Da fare |
| WARN-06 | Reazione immediata su SL non piazzabile *(ex CRIT-04)* | Bruno | 1 | Da fare |
| WARN-01 | Rimuovere `console.log` debug | Bruno | 1 | Da fare |
| WARN-02 | Bounds/monitoring `execQueue` | Bruno | 2 | Da fare |
| WARN-03 | Slippage reale calcolato e loggato | Bruno | 2 | Da fare |
| WARN-04 | Warning esplicito `DEV_FALLBACK` | Bruno | 1 | Da fare |
| WARN-05 | Stato esplicito "degraded" sul WS | Bruno | 3 | Da fare |
| QUAL-01 | Pacchetto qualità (5 minori) | Bruno | 3 | Da fare |

**Ordine consigliato:** CRIT-01 e CRIT-03 toccano `_openPosition()` nello stesso file — farle in
sequenza, non in parallelo con sé stesse (ovvio, ma un solo owner lo garantisce comunque). WARN-06
tocca `_ensureStopLoss()`, indipendente dalle prime due. WARN-05 è la più isolata (file diversi,
`hyperliquidClient.js`/`marketData.js`) — buona candidata per iniziare mentre si ragiona sul disegno
del lock di CRIT-03. QUAL-01 per ultimo, a mente sgombra dai critici.

## 3. Riepilogo

| | SP |
|:--|:--:|
| Critici (CRIT-01, 02, 03) | 8 |
| Importanti (WARN-01…06) | 8 |
| Qualità (QUAL-01) | 3 |
| **Totale** | **21** |

Un solo owner (Bruno) per l'intero sprint, un solo revisore designato in planning (Annie) — poi
affiancata in review da **Jordan**, nuovo membro del team (analista di rischio quantitativo),
aggiunto come secondo revisore proprio su questo sprint per decisione della PO: due lenti
indipendenti su un'epica di sola correttezza/rischio, senza coordinamento tra loro.

## 4. Esito review (11 agosto 2026)

**21/21 SP completati e approvati dalla PO**, più 2 extra nati in seduta di review (senza stima SP
a sé, piccoli per costruzione). `npm test`: 551/551 verdi (era 460 a inizio sprint). Lint pulito su
125 file. Nessun commit fatto durante l'implementazione — tutto il lavoro è stato verificato sul
working tree prima di essere reso definitivo.

**Doppia revisione indipendente, non coordinata tra le due:**
- **Annie** (correttezza/test) — ha **riprodotto di persona** lo scenario "rosso prima" di CRIT-03
  disattivando il lock e osservando due ordini reali arrivare all'exchange; ha interrogato
  `data/perps.db` in sola lettura per confermare che il fix di PaperBroker (QUAL-01) non avesse
  toccato il database reale, invece di fidarsi della dichiarazione.
- **Jordan** (rischio quantitativo, primo incarico nel team) — per ciascuna storia critica ha
  verificato se il fix riduce davvero il rischio che dichiara di ridurre, non solo se il codice è
  corretto: ha confermato che CRIT-01 ridimensiona TP/SL sulla size reale in ogni punto, e ha letto
  CRIT-03 anche come sintomo di un problema di disegno a monte (perché esistono due bot sullo stesso
  mercato), non solo come una race da chiudere tecnicamente.

**Il finding più importante dello sprint**, confermato indipendentemente da entrambe le revisioni:
prima di questo sprint, **valutare** una proposta dell'Analyst — non aprirla, solo valutarla — poteva
innescare un'ora di cooldown reale su un bot, perché `riskAgent.evaluate()` chiamava la stessa
funzione (`portfolio.canOpen()`) usata per aprire posizioni davvero. Scoperto da Bruno come effetto
collaterale della separazione pura/impura di QUAL-01 item 2, non come obiettivo dichiarato della
storia. Jordan lo classifica **priorità 1**, più grave della classificazione "minore" ereditata
dall'audit originale: combinato con CRIT-02 (cooldown ora persistito), quei cooldown spuri sarebbero
diventati **permanenti** invece che transitori — la stessa classe di incidente di SEC-10 (9-10
agosto), ma innescata da una lettura, non da un'apertura.

**Due extra decisi in seduta di review, entrambi consegnati:**
- **CRIT-03-EXTRA** — warning esplicito (non un blocco) alla creazione di un bot su un mercato già
  coperto da un altro bot attivo, su segnalazione di Jordan. Verificato rosso su un worktree pulito
  (`git worktree add --detach`, non `git stash` — la disciplina imparata durante Sprint 4 sul
  working tree condiviso). Due gap adiacenti (avvio di un bot fermo, spostamento di un bot su
  `updateBot()`) dichiarati e lasciati aperti come refinement, non risolti di iniziativa.
- **CRIT-02-EXTRA** — guard su `getLimits()` con fallback conservativo ai `DEFAULTS` (mai un via
  libera sui limiti di rischio per un guasto del database) e validazione che il JSON letto sia
  davvero un oggetto, su segnalazione di Annie. Asimmetria voluta: `setLimits()` resta senza guard,
  perché rispondere "salvato" a un salvataggio mai avvenuto sarebbe peggio di un errore esplicito.

8 candidati di refinement raccolti per lo sprint successivo, in
`docs/KB/BACKLOG/release2/sprint1-status/aggregate.json` (default del cooldown non validato con
dati reali, aggregazione dello slippage per bot/mercato, copertura di `startBot()`/`updateBot()`
per il warning multi-bot, verifica che la migrazione di schema v3 giri pulita sul VPS reale).

*Refinement chiuso l'11 agosto 2026. Review chiusa l'11 agosto 2026 — 21/21 SP approvati.*
