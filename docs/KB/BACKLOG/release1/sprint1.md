# Sprint 1 — Hardening di Sicurezza e Correttezza

**Branch:** `feat/perps-hardening` · **Fonte:** [istruzioni-hardening-claude.md](istruzioni-hardening-claude.md)
**Data di redazione:** 7 agosto 2026 · **Durata proposta:** 1 settimana
**Story point totali:** 19 · **Backlog originale:** 5 task → **2 chiusi come non-problemi**, 1 riformulato, 5 nuovi derivati

---

## 0. Esito del triage: cosa è davvero una minaccia

Ogni task del backlog è stato verificato **contro il codice reale**, non accettato come premessa. Risultato:

| Task originale | Premessa del backlog | Verifica sul codice | Esito |
|:---|:---|:---|:---|
| **1 — Supply chain npm** | Rischio typosquatting/postinstall | Nessun pacchetto malevolo presente; `npm ci` già usato in CI e Dockerfile. **Ma**: nessun `.npmrc`, nessun `npm audit` in CI, **3 dipendenze con install script** | 🟠 **Minaccia reale ma latente** → in sprint |
| **2 — Infisical di default** | `.env` in chiaro è bersaglio primario | Vero come rischio, **ma la soluzione proposta è dannosa** (vedi §3.2) | 🟡 **Parzialmente accolto** (solo il warning) |
| **3 — TP/SL come trigger order** | "Potrebbero essere solo nel loop locale" | **Falso**: sono già trigger order nativi su Hyperliquid. **Ma** esiste un buco specifico su DCA | 🔴 **Riformulato** → il buco DCA è la vera minaccia |
| **4 — Base di calcolo del sizing** | "Potrebbe usare il margine libero" | **Falso**: usa `accountValue` (equity totale), non `withdrawable`. Un solo chiamante | 🟢 **Chiuso** (resta un guard difensivo da 1 SP) |
| **5 — Webhook esposto** | "Superficie d'attacco pubblica" | **Falso**: l'endpoint è dietro `requireAuth` + rate limit + secret opzionale. **Non è raggiungibile dall'esterno** | 🟡 **Invertito**: il problema è che *non funziona*, non che è esposto |

**In una riga:** delle 5 minacce ipotizzate, **due non esistono** (3 e 4), **una è invertita** (5), **una è reale** (1), **una ha la soluzione sbagliata** (2). La minaccia più concreta con denaro a rischio **non era nel backlog**: è il buco DCA emerso durante la verifica (SEC-01).

---

## 1. Sprint Goal

> Chiudere l'unico difetto di correttezza che lascia capitale non protetto (DCA + trigger order),
> mitigare l'unico vettore di supply chain realmente aperto (install script npm), e risolvere
> l'ambiguità del webhook — decidendo se è una feature pubblica o interna, e allineando codice e
> documentazione alla decisione.

**Non-goal dello sprint:** rifattorizzazioni architetturali, nuove strategie, cambi di deployment.

---

## 2. Task board

Legenda tipo: 🐛 bug · 🔒 security · 🧪 test · 📄 docs · ⚙️ chore

---

### 🔴 SEC-01 · TP/SL non ri-piazzati dopo un'aggiunta DCA

| | |
|:---|:---|
| **Tipo** | 🐛 bug — correttezza, capitale a rischio |
| **Story Point** | **5** |
| **Priorità** | P0 — blocca il rilascio mainnet |
| **File** | [`src/perps/bot.js`](../../../src/perps/bot.js) (`_maybeDca`, `_placeTpSl`), [`src/perps/riskManager.js`](../../../src/perps/riskManager.js) |
| **Origine** | Non presente nel backlog originale — emerso dalla verifica del Task 3 |

**Descrizione.** All'apertura, il bot piazza i trigger TP e SL con `size: this.position.size` e prezzi
calcolati sull'`entryPx` iniziale ([bot.js:238](../../../src/perps/bot.js#L238),
[bot.js:334-343](../../../src/perps/bot.js#L334-L343)). `_maybeDca`
([bot.js:437-466](../../../src/perps/bot.js#L437-L466)) incrementa `this.position.size` dopo ogni
aggiunta, ma **non ricalcola i prezzi né ri-piazza i trigger con la nuova size**.

**Impatto.** Dopo la prima aggiunta DCA la posizione è più grande dei trigger che dovrebbero
chiuderla: **lo stop loss copre solo la size originale, il resto resta scoperto**. Con `steps: 3` e
`sizeMultiplier: 1` la posizione può arrivare a 4× la size protetta dallo stop. Il trailing stop
maschera parzialmente il problema per l'SL (ri-piazza con la size corrente), ma **il TP non viene mai
aggiornato** e senza trailing non c'è alcuna mitigazione.

È esattamente lo scenario che il Task 3 del backlog voleva evitare — solo che la causa non è
l'architettura (già corretta), è questa specifica omissione.

**Criteri di accettazione**

- [ ] Dopo ogni aggiunta DCA, i trigger TP e SL sono cancellati e ri-piazzati con la **size totale** aggiornata.
- [ ] `entryPx` della posizione è aggiornato al **prezzo medio ponderato** dopo ogni aggiunta.
- [ ] TP e SL sono **ricalcolati** sul nuovo prezzo medio (sia in modalità `percent` sia `atr`).
- [ ] La sequenza rispetta l'ordine sicuro già usato dal trailing: **piazza il nuovo, poi cancella il vecchio** — mai il contrario (una posizione non deve mai restare senza stop, nemmeno per un istante).
- [ ] Le soglie progressive del DCA continuano a essere calcolate sull'**ingresso originale**, non sul prezzo medio (altrimenti gli step si comprimono). Comportamento attuale da preservare esplicitamente.
- [ ] Se il ri-piazzamento fallisce, l'evento è loggato **e notificato via Telegram**: una posizione parzialmente scoperta non deve restare silenziosa.
- [ ] Test unitario in `test/` che copre: apertura → 2 aggiunte DCA → verifica size e prezzi dei trigger risultanti.

**Dipendenze.** Nessuna esterna. Va fatto **prima** di qualsiasi uso del DCA in mainnet.

**Rischi**

| Rischio | Mit. |
|:---|:---|
| Il cancel/replace introduce una finestra senza stop | Ordine obbligatorio: place-then-cancel, come già fa `_updateTrailing` |
| Più chiamate firmate → collisione di nonce | `execQueue` serializza già per master address; verificare che il nuovo percorso ci passi |
| Interazione con `partialTp` (ladder di trigger multipli) | Testare esplicitamente DCA + partial TP insieme: è la combinazione meno battuta |
| Rate limit Hyperliquid su cancel/place ripetuti | Il DCA ha `steps` bassi; monitorare `api_errors_total` |

---

### 🔒 SEC-02 · Blocco degli script postinstall npm (`.npmrc` + allowlist)

| | |
|:---|:---|
| **Tipo** | 🔒 security |
| **Story Point** | **3** |
| **Priorità** | P1 |
| **File** | nuovo `.npmrc`, [`Dockerfile`](../../../Dockerfile), [`package.json`](../../../package.json) |
| **Origine** | Task 1 del backlog (punto 2) |

**Descrizione.** Non esiste `.npmrc`: gli script `postinstall` di **qualsiasi** dipendenza —
comprese quelle transitive — vengono eseguiti a ogni `npm ci`. È il vettore esatto del caso
documentato in [INDEX.md §D.1](../index/INDEX.md).

**Stato verificato.** Tre pacchetti dichiarano `hasInstallScript` nel lockfile:

| Pacchetto | Natura | Necessario? |
|:---|:---|:---|
| `better-sqlite3` | Modulo nativo, compila con node-gyp | ✅ **Sì**, senza script non funziona |
| `fsevents` | Watcher macOS, dipendenza opzionale di dev | ❌ No in produzione (`--omit=dev`) |
| `hyperliquid` | **SDK di trading di terze parti** | ⚠️ **Da verificare cosa fa** |

> ⚠️ Il fatto che l'SDK di trading — il pacchetto che parla con l'exchange dove stanno i soldi —
> abbia uno script di installazione merita un'occhiata diretta al suo contenuto prima di
> allowlistarlo. Non è un'accusa: è il minimo dovuto data la posizione che occupa.

**Criteri di accettazione**

- [ ] `.npmrc` in root con `ignore-scripts=true`.
- [ ] Lo script di installazione di `better-sqlite3` è abilitato **selettivamente** (rebuild esplicito nel `Dockerfile`, es. `npm rebuild better-sqlite3`), non riabilitando gli script in blocco.
- [ ] Ispezionato e documentato cosa fa lo script di `hyperliquid`; decisione (allowlist o rebuild esplicito) motivata in commento.
- [ ] `docker compose build` completa e l'app parte: **il test è funzionale, non "il comando non ha dato errore"**.
- [ ] `npm test` verde in locale dopo un `npm ci` pulito con la nuova configurazione.

**Dipendenze esterne.** Nessuna. Ma richiede un **rebuild completo dell'immagine** per la verifica.

**Rischi**

| Rischio | Mit. |
|:---|:---|
| `better-sqlite3` non compila → **app morta** | Verifica su build pulita prima del merge; è il rischio principale di questo task |
| Un pacchetto transitivo dipendeva silenziosamente dal suo postinstall | Suite di test come rete; `npm ci` pulito da zero, non incrementale |
| Falso senso di sicurezza | `ignore-scripts` non protegge dal codice eseguito a **runtime** (`import`): è metà della difesa, l'altra metà è la review del lockfile (SEC-03) |

---

### 🔒 SEC-03 · Audit delle dipendenze in CI + review del lockfile

| | |
|:---|:---|
| **Tipo** | 🔒 security / ⚙️ chore |
| **Story Point** | **2** |
| **Priorità** | P1 |
| **File** | [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml), `CONTRIBUTING.md` (nuovo) |
| **Origine** | Task 1 del backlog (punti 1, 4, 5) |

**Descrizione.** La CI esegue già `npm ci` ✅ ma **non fa alcun audit**. Manca inoltre una regola
scritta sulla review del `package-lock.json`, che è il punto d'ingresso reale di questa classe di
attacco: un typosquat entra come dipendenza **transitiva** e non compare mai in `package.json`.

**Criteri di accettazione**

- [ ] Step `npm audit --audit-level=high` bloccante in `ci.yml`.
- [ ] Step `npm audit signatures` (verifica delle firme del registry).
- [ ] `step-security/harden-runner` con `egress-policy: audit` in prima battuta, poi `block` con allowlist una volta raccolti gli endpoint reali. **Non partire da `block`**: rompe la CI al primo giro e si finisce per disattivarlo.
- [ ] `CONTRIBUTING.md` con la regola: ogni PR che tocca `package-lock.json` richiede ispezione riga per riga dei pacchetti aggiunti (download count, data di pubblicazione, presenza di install script, distanza di edit dal nome di un pacchetto noto).

**Dipendenze esterne.** ⚠️ `step-security/harden-runner` è una **GitHub Action di terze parti** —
va pinnata a uno SHA, non a un tag mobile. Aggiungere una dipendenza di supply chain per difendersi
dalla supply chain va fatto con la stessa cautela che si sta cercando di imporre.

**Rischi**

| Rischio | Mit. |
|:---|:---|
| `npm audit` fallisce su una vulnerabilità senza fix → CI rossa permanente | Partire da `--audit-level=high`; se emerge rumore, valutare `--omit=dev` |
| Harden-runner in `block` rompe la CI | Fase `audit` per una settimana prima di passare a `block` |

---

### 🟡 SEC-04 · Webhook: decidere se è pubblico, e allinearvi codice e documentazione

| | |
|:---|:---|
| **Tipo** | 🔒 security / 📄 docs |
| **Story Point** | **5** (opzione A) · **2** (opzione B) |
| **Priorità** | P1 |
| **File** | [`src/server.js`](../../../src/server.js#L1096), [`docs/MANUAL.md`](../../MANUAL.md), [`public/manual.html`](../../../public/manual.html) |
| **Origine** | Task 5 del backlog — **premessa da correggere** |

**Descrizione — la premessa del backlog è sbagliata.** Il task presuppone un endpoint "esposto
pubblicamente senza barriere". La verifica dice il contrario: `/api/perps/webhook` è dietro
**tre** livelli:

1. gate `requireAuth` su tutte le `/api/*` tranne login/logout/status ([server.js:156-163](../../../src/server.js#L156-L163));
2. rate limit globale 300 req/min su `/api` ([server.js:143](../../../src/server.js#L143));
3. `PERPS_WEBHOOK_SECRET` opzionale nel body.

**Il problema reale è l'opposto:** TradingView e TrendSpider **non possono chiamarlo**, perché non
hanno un cookie di sessione. La feature è documentata (anche nel manuale che ho appena scritto) ma
**non utilizzabile per il suo scopo**. È debito di coerenza, non un buco di sicurezza.

**Serve una decisione di prodotto:**

| | Opzione A — aprirlo davvero | Opzione B — tenerlo interno |
|:---|:---|:---|
| **Cosa** | Whitelist del path fuori dal gate cookie + HMAC obbligatorio | Nessuna modifica al gate |
| **SP** | 5 | 2 |
| **Pro** | Sblocca l'integrazione con fonti esterne | Zero nuova superficie d'attacco |
| **Contro** | Nuovo endpoint pubblico che **scatena ordini reali** | La feature `external` resta di fatto inutilizzabile dall'esterno |

**Raccomandazione: opzione B per lo Sprint 1.** Non c'è oggi un'integrazione esterna in esercizio, e
aprire un endpoint che innesca ordini non è una cosa da infilare in uno sprint di hardening — è un
progetto con il suo modello di minaccia. Correggere la documentazione costa 2 SP e chiude
l'incoerenza subito; l'apertura si pianifica quando serve davvero.

**Criteri di accettazione — opzione B (raccomandata)**

- [ ] `MANUAL.md` e `manual.html`: la sezione webhook dichiara che l'endpoint **richiede sessione autenticata** e non è raggiungibile da servizi esterni allo stato attuale.
- [ ] Commento in `server.js` sopra la rotta che documenta la scelta e cosa serve per aprirla.
- [ ] Confronto del secret in **tempo costante** (`crypto.timingSafeEqual`) invece di `!==`: costa nulla e toglie un dettaglio sbagliato dal codice.

**Criteri di accettazione aggiuntivi — opzione A (se scelta)**

- [ ] HMAC-SHA256 su corpo grezzo, header `X-Signature`, chiave da secret manager.
- [ ] **Timestamp nel payload firmato** + rifiuto oltre 5 minuti → anti-replay. *(Nota: il TTL attuale di 5 minuti è lato ricezione — scade il segnale in coda — e **non protegge dal replay**: un payload ricatturato e re-inviato viene accettato come nuovo.)*
- [ ] Rate limit dedicato più stretto del globale.
- [ ] Whitelist esplicita del path in `publicApi`, con test che verifica che **nessun altro** endpoint sia stato aperto per errore.

**Rischi**

| Rischio | Mit. |
|:---|:---|
| *(opz. A)* Aprire il path sbaglia il match e scopre altre rotte | Match esatto sulla stringa, test di regressione sull'auth |
| *(opz. B)* La feature resta inerte e qualcuno la "riscopre" tra sei mesi | Il commento nel codice è parte dei criteri di accettazione |

---

### 🟢 SEC-05 · Guard difensivo su `sizePosition`

| | |
|:---|:---|
| **Tipo** | 🔒 security / 🐛 robustezza |
| **Story Point** | **1** |
| **Priorità** | P2 |
| **File** | [`src/perps/riskManager.js`](../../../src/perps/riskManager.js#L25) |
| **Origine** | Task 4 del backlog — **il bug descritto non esiste**, resta il guard |

**Descrizione.** Il bug ipotizzato dal backlog (uso del margine libero al posto dell'equity totale)
**non è presente**. Verifica:

```
bot.js:176      const equity = account.equity ?? account.accountValue;
client.js:271   equity: accountValue + spotUsdc      // accountValue = marginSummary.accountValue
client.js:274   withdrawable: ...                    // ← esiste, ma NON viene usato per il sizing
```

`accountValue` è il valore totale del conto (depositi + PnL non realizzato), non il margine libero.
`sizePosition` ha inoltre **un solo chiamante** ([bot.js:177](../../../src/perps/bot.js#L177)): la
rotta degli ordini manuali calcola la size dal notionale indicato dall'utente e non passa di qui.

**Resta però** che `sizePosition` non valida `equity`: con un valore `undefined` o `NaN` il calcolo
propaga `NaN` fino a `roundSize`, e il cap `notionalUsd > maxPos` non scatta (ogni confronto con
`NaN` è falso). L'ordine verrebbe respinto dall'exchange, ma è un fallimento silenzioso in un punto
dove il fallimento deve essere rumoroso.

**Criteri di accettazione**

- [ ] `sizePosition` solleva un errore esplicito se `equity` non è un numero finito e positivo, o se `price` non è valido.
- [ ] Test in `test/riskManager.test.js` per i casi `undefined`, `NaN`, `0`, negativo.
- [ ] Il commento della funzione documenta che `equity` è **account value totale**, così la prossima persona non deve ri-dedurlo.

**Dipendenze.** Nessuna. **Rischi.** Trascurabili — solo il rischio di rendere fatale un caso che
prima passava silenziosamente, che è l'obiettivo.

---

### 🟡 SEC-06 · Warning esplicito quando la produzione parte senza secret manager

| | |
|:---|:---|
| **Tipo** | 🔒 security |
| **Story Point** | **2** |
| **Priorità** | P2 |
| **File** | [`src/config/config.js`](../../../src/config/config.js) (`validateConfig`), [`scripts/docker-entrypoint.sh`](../../../scripts/docker-entrypoint.sh) |
| **Origine** | Task 2 del backlog — **accolto solo parzialmente** |

**Descrizione — perché il Task 2 non va implementato come scritto.** Il backlog chiede di rendere
Infisical il default di `npm start` e `npm dev`. **Sconsigliato**, per tre ragioni concrete:

1. **Rompe lo sviluppo locale**: chiunque cloni il repo si trova `npm start` che fallisce senza un'istanza Infisical. Il progetto ha già la scelta esplicita e documentata di funzionare in locale con file.
2. **Duplica una logica che esiste già e funziona meglio**: [`docker-entrypoint.sh`](../../../scripts/docker-entrypoint.sh) attiva Infisical alla presenza di `INFISICAL_TOKEN` e **fallisce forte** se il token c'è ma la CLI manca. `restart.sh` fa lo stesso con `.infisical.json`. La scelta corretta è già fatta al livello giusto: il deploy, non `package.json`.
3. **Confonde ambiente e strumento**: usare Infisical è una decisione di *deployment*, non una proprietà del pacchetto npm.

Quello che **ha senso** del Task 2 è il punto 2.2: il warning.

**Criteri di accettazione**

- [ ] Con `NODE_ENV=production`, se i segreti **non** provengono da un secret manager, l'avvio stampa un warning visibile (banner, non una riga persa nel log).
- [ ] Il warning è **informativo, non bloccante**: l'app deve continuare a partire. Un deploy esistente non va rotto da un messaggio.
- [ ] `DEPLOY.md` §9 rimanda a questo comportamento.

**Dipendenze esterne.** Nessuna. Il rilevamento si basa su `INFISICAL_TOKEN` / `.infisical.json`,
già disponibili.

**Rischi.** Basso. Unico: warning fatigue se troppo verboso → mostrarlo **una sola volta all'avvio**.

---

### 📄 DOC-01 · Allineamento della documentazione e chiusura del backlog

| | |
|:---|:---|
| **Tipo** | 📄 docs |
| **Story Point** | **1** |
| **Priorità** | P2 |
| **File** | [`docs/KB/index/INDEX.md`](../index/INDEX.md), [`istruzioni-hardening-claude.md`](istruzioni-hardening-claude.md) |

**Criteri di accettazione**

- [ ] Task 3 e Task 4 del backlog originale marcati **chiusi con evidenza** (riferimento a file e riga), non semplicemente cancellati: la prossima persona che legge il backlog deve capire *perché* sono stati chiusi.
- [ ] Task 5 annotato con la premessa corretta.
- [ ] Backlog in `INDEX.md` §3 riallineato agli esiti di questo sprint.

---

## 3. Riepilogo e pianificazione

### 3.1 Story point e ordine di esecuzione

| ID | Titolo | SP | Priorità | Blocca |
|:---|:---|:--:|:---:|:---|
| **SEC-01** | TP/SL dopo aggiunta DCA | 5 | P0 | Uso del DCA in mainnet |
| **SEC-02** | `.npmrc` + allowlist install script | 3 | P1 | SEC-03 (ordine consigliato) |
| **SEC-04** | Webhook: decisione + allineamento | 2–5 | P1 | — |
| **SEC-03** | Audit dipendenze in CI | 2 | P1 | — |
| **SEC-06** | Warning secret manager | 2 | P2 | — |
| **SEC-05** | Guard su `sizePosition` | 1 | P2 | — |
| **DOC-01** | Allineamento documentazione | 1 | P2 | Tutti (va fatto per ultimo) |
| | **Totale** | **19** *(16 con SEC-04 opz. B)* | | |

**Sequenza consigliata:** SEC-01 → SEC-05 (stesso contesto, risk manager) → SEC-02 → SEC-03 →
SEC-06 → SEC-04 → DOC-01.

SEC-01 va per primo perché è l'unico con capitale a rischio. SEC-02 prima di SEC-03 perché conviene
sistemare la configurazione locale prima di renderla bloccante in CI.

### 3.2 Grafo delle dipendenze

```
SEC-01 ──┐
SEC-05 ──┤
SEC-02 ──┼──► DOC-01   (chiusura, per ultimo)
SEC-03 ──┤
SEC-06 ──┤
SEC-04 ──┘

SEC-02 ──► SEC-03   (soft: conviene, non è bloccante)
```

Nessuna dipendenza circolare. SEC-01, SEC-04, SEC-05 e SEC-06 sono **parallelizzabili**: toccano file
diversi e non condividono stato.

### 3.3 Dipendenze esterne

| Dipendenza | Task | Natura | Nota |
|:---|:---|:---|:---|
| Toolchain di build Docker | SEC-02 | Bloccante per la verifica | `better-sqlite3` deve compilare con `ignore-scripts` attivo |
| `step-security/harden-runner` | SEC-03 | Action di terze parti | **Pinnare a SHA**, mai a tag mobile |
| Registry npm (audit signatures) | SEC-03 | Servizio esterno | Un disservizio del registry rende la CI rossa |
| Testnet Hyperliquid | SEC-01 | Ambiente di verifica | Serve un ciclo DCA reale end-to-end |
| **Decisione di prodotto** | SEC-04 | 🧑 **Umana** | Opzione A o B: nessuno sviluppo prima della risposta |

### 3.4 Risk register di sprint

| # | Rischio | Prob. | Impatto | Mitigazione |
|:--|:---|:---:|:---:|:---|
| R1 | `ignore-scripts` rompe la build di `better-sqlite3` → app non parte | Media | **Alto** | Verifica su build Docker pulita prima del merge; rollback = rimuovere `.npmrc` |
| R2 | La fix DCA introduce una finestra senza stop durante cancel/replace | Bassa | **Critico** | Place-then-cancel obbligatorio; test dedicato |
| R3 | La fix DCA rompe l'interazione con `partialTp` o il trailing | Media | Alto | Test della combinazione, non solo del caso isolato |
| R4 | `npm audit` blocca la CI su vulnerabilità senza patch | Media | Medio | `--audit-level=high`; eventuale allowlist temporanea documentata |
| R5 | SEC-04 resta fermo in attesa della decisione di prodotto | Media | Basso | Default a opzione B se non arriva risposta entro metà sprint |
| R6 | Lo sprint scivola su rifattorizzazioni non richieste | Media | Medio | Non-goal dichiarati nello Sprint Goal; ogni scoperta nuova va in backlog, non in sprint |

### 3.5 Definition of Done

Per **ogni** task:

- [ ] `npm test` verde (11 suite esistenti, nessuna regressione).
- [ ] `npm run lint` verde.
- [ ] Nessuna regressione su `execQueue` (nonce persistito e monotono) e sulla coda di esecuzione — è la raccomandazione esplicita del protocollo di sviluppo del backlog.
- [ ] Separazione preservata tra motore decisionale (`strategyEngine`) e controlli deterministici di rischio (`riskManager`, `portfolio`, `riskAgent`).
- [ ] Commit con messaggio che spiega **il perché**, non solo il cosa.
- [ ] Documentazione aggiornata se il comportamento osservabile cambia.

Per lo **sprint**:

- [ ] SEC-01 verificato su **testnet** con un ciclo DCA completo: apertura → 2 aggiunte → verifica su Hyperliquid che i trigger abbiano la size totale corretta.
- [ ] Immagine Docker ricostruita da zero e avviata con successo.
- [ ] `npm run secrets:check` verde.
- [ ] Checklist GO-LIVE di [DEPLOY.md §7](../../DEPLOY.md#7-checklist-go-live-mainnet) rieseguita.

---

## 4. Fuori sprint — chiuso con evidenza

Registrato qui perché un backlog cancellato senza motivazione torna a riproporsi.

### ✅ Task 3 (originale) — "TP/SL potrebbero essere solo nel loop locale"

**Chiuso: non è così.** I trigger sono nativi su Hyperliquid in entrambi i percorsi:

- ordini manuali → `placeTriggerOrder` per TP e SL ([server.js:1032-1037](../../../src/server.js#L1032-L1037));
- bot → `placeTriggerOrder` ([bot.js:334-343](../../../src/perps/bot.js#L334-L343));
- trailing → piazza il nuovo trigger, aggiorna il DB, **poi** cancella il vecchio ([bot.js:418-429](../../../src/perps/bot.js#L418-L429)) — già l'ordine sicuro richiesto dal punto 3.3 del backlog.

Gli stop **sopravvivono a un crash del server**. L'unica lacuna reale è il caso DCA → SEC-01.

### ✅ Task 4 (originale) — "Il sizing potrebbe usare il margine libero"

**Chiuso: non è così.** Il sizing usa `accountValue` (equity totale), `withdrawable` esiste
nell'oggetto account ma **non viene mai usato per il sizing**. Un solo chiamante. Resta il guard
difensivo → SEC-05.

> **Nota minore, non azionata in questo sprint.** `equity = accountValue + spotUsdc` include il saldo
> Spot. Sull'account unificato Hyperliquid è difendibile, ma gli USDC Spot non sono margine finché
> non vengono trasferiti: su un conto con molto Spot e poco Perp il sizing percentuale risulta più
> generoso del margine realmente disponibile. Da valutare separatamente — è una scelta di prodotto,
> non un bug.

### ⛔️ Task 2 (originale), punto 1 — "Infisical come default di `npm start`"

**Non implementato, per scelta motivata** (vedi SEC-06 §descrizione). Il punto 2 del task — il
warning — è accolto in SEC-06. Il punto 3 — documentazione — è **già stato fatto**:
[DEPLOY.md §9](../../DEPLOY.md#9-segreti-gestiti-con-infisical-self-hosted-vps) copre installazione,
collegamento, verifica e l'avvertenza sulla co-locazione.
