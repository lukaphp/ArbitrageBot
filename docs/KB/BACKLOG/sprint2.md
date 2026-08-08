# Sprint 2 — Resilienza, Dipendenze e Copertura Test

**Branch:** `feat/perps-hardening` (da valutare se proseguire qui o aprire un nuovo branch) · **Team:** Nautilus
**Data di redazione:** 8 agosto 2026 · **Planning:** 8 agosto 2026 · **Story point totali:** 20 (16 + 4 aggiunti in planning)
**Origine:** scoperte emerse durante l'esecuzione e la review dello Sprint 1 — non un backlog esterno da verificare, ma un raccolto organico. Ogni voce cita la fonte.

---

## 0. Da dove viene questo backlog

A differenza dello Sprint 1 (nato da un documento di istruzioni esterno da verificare), questo backlog nasce da due fonti interne, entrambe già verificate sul codice reale prima di essere scritte qui:

| Fonte | Cosa ha prodotto |
|:---|:---|
| **Annie (SEC-03, audit CI)** | 7 candidati segnalati nel suo report di chiusura — di questi, **6 confermati azionabili**, **1 chiuso come non applicabile** (vedi nota sotto la tabella) |
| **Investigazione WebSocket Hyperliquid** (question del PO su "sembra connesso ma non lo è") | 1 gap di resilienza reale, verificato in produzione sul processo live (`perps_ws_connected 0` misurato direttamente, non dedotto) |

> **Candidato scartato:** Annie aveva segnalato "aggiungere harden-runner anche ad altri workflow, se ce ne sono". Verificato: `.github/workflows/` contiene **solo `ci.yml`**. Non c'è nient'altro da coprire — chiuso come non applicabile, non diventa un task.
>
> **Candidato ridotto a nota, non task:** "verificare `npm audit signatures` anche per pacchetti senza attestazioni provenance" — oggi 16/171 pacchetti hanno attestazioni; è una situazione dell'ecosistema npm (dipende da chi pubblica), non qualcosa che risolviamo lato nostro. Nessuna azione, resta come osservazione.

### 0.1 Planning (8 agosto) — prima sessione formale

Prima dell'avvio effettivo, il backlog sopra è stato sottoposto a planning col PO. Tre nuove story sono
emerse durante la **Sala Review dello Sprint 1** (non da questo documento, ma da ciascun membro del
team che rileggeva il proprio codice per prepararsi a presentarlo) e sono state proposte come
aggiunta allo sprint, non rimandate:

| Story | Origine | Decisione del PO |
|:---|:---|:---|
| TRAIL-01 | Bruno, ri-verificando `bot.js` per la sua sezione di review | **Aggiunta a Sprint 2**, story a sé |
| CI-REBUILD-01 | Joshua, ri-verificando `Dockerfile`/CI per la sua sezione | **Aggiunta a Sprint 2**, story a sé |
| DOC-02 | Maya, ri-verificando `manual.html`/`INDEX.md` per la sua sezione | **Aggiunta a Sprint 2**, story a sé |

Il PO ha esplicitamente scelto di **non accorpare** TRAIL-01 a WS-01 né CI-REBUILD-01 a DEP-01,
nonostante la vicinanza tematica — restano tracciabili singolarmente sulla board. Le 6 story
originali (§2) restano invariate, confermate senza modifiche.

---

## 1. Sprint Goal

> Chiudere il rischio operativo più concreto lasciato aperto dallo Sprint 1 (la CI che va rossa al primo push per vulnerabilità preesistenti), riportare il feed di mercato Hyperliquid a un'affidabilità che non dipenda dal fatto che il fallback REST stia silenziosamente coprendo un guasto, e colmare il vuoto di test sugli script che maneggiano le chiavi di cifratura.

**Non-goal dello sprint:** nuove feature, cambi di strategia, l'apertura del webhook (opzione A, valutata e scartata nello Sprint 1 — resta scartata finché non c'è un'integrazione esterna reale da servire).

---

## 2. Task board

---

### 🔴 WS-01 · Watchdog di riconnessione per il WebSocket Hyperliquid

| | |
|:---|:---|
| **Tipo** | 🔒 affidabilità / 🐛 bug |
| **Story Point** | **3** |
| **Priorità** | P1 — degrada silenziosamente la qualità dei dati usati dalle strategie |
| **File** | `src/perps/marketData.js`, `src/perps/hyperliquidClient.js`, `src/perps/metrics.js` |
| **Origine** | Investigazione diretta del PO ("sembra connesso ma non lo è") — vedi conversazione dell'8 agosto |

**Descrizione.** Verificato **sul processo in produzione**, non ipotizzato: `curl localhost:3000/metrics` → `perps_ws_connected 0` dopo ~28 ore di uptime, nonostante il log di avvio mostri una connessione riuscita e nessun errore successivo. Causa: `_startWs()` viene chiamato **una sola volta**, all'avvio del server (`marketData.start()`). Se il WebSocket cade — per qualunque motivo, anche dopo che l'SDK esaurisce i propri tentativi di riconnessione interni — non c'è nulla nel nostro codice che se ne accorga e lo ristabilisca. Il sistema resta silenziosamente sul fallback REST (funzionante, ma a latenza/freschezza più bassa) potenzialmente per giorni.

**Due difetti secondari trovati durante la stessa verifica:**
1. `ws_reconnects_total` (il contatore Prometheus pensato apposta per questo) è definito in `metrics.js` ma **non viene mai incrementato da nessuna parte del codice** — riporta sempre 0, dando una falsa rassicurazione.
2. La libreria SDK logga i propri tentativi di riconnessione interni con `console.error`/`console.warn` diretti, che **non passano dal nostro `logger`** — un drop del WS può non lasciare alcuna traccia in `logs/app.log`.

**Effetto collaterale utile:** un watchdog che periodicamente verifica `wsConnected()` e richiama `_startWs()` risolve *anche* un secondo gap architetturale non ancora manifestatosi in produzione ma reale: `hyperliquid.setNetwork()` (cambio rete testnet/mainnet a runtime) non ri-sottoscrive mai il WS per la nuova rete — oggi resterebbe silenziosamente disconnesso finché non riparte il server. Lo stesso watchdog copre entrambi i casi senza bisogno di due fix separati.

**Criteri di accettazione**

- [ ] Un controllo periodico (es. ogni 30-60s, intervallo configurabile) verifica `client.wsConnected()` per la rete corrente; se risulta `false`, richiama `_startWs()` per ristabilire la sottoscrizione.
- [ ] Prima di ristabilire, l'eventuale istanza SDK precedente per quella rete viene chiusa/rimossa da `wsSdks` (evitare accumulo di connessioni morte).
- [ ] `ws_reconnects_total` viene incrementato a ogni tentativo di riconnessione **riuscito**.
- [ ] Backoff minimo tra tentativi (evitare un "reconnect storm" se il problema è persistente/di rete).
- [ ] Gli eventi di errore/chiusura esposti dall'SDK (se disponibili via `sdk.ws.on('error'|'close', ...)`) sono agganciati al nostro `logger`, non lasciati solo alla console dell'SDK.
- [ ] Se il downtime del WS supera una soglia (es. 5 minuti), notifica Telegram — coerente con lo stile già usato altrove nel progetto (non deve diventare rumore: una notifica per episodio, non una per tentativo).
- [ ] Cambio rete (`setNetwork`) chiude la sottoscrizione WS della rete precedente e la ristabilisce per quella nuova.
- [ ] Test che simula `wsConnected()` che ritorna `false` per un periodo e verifica che il meccanismo di ripristino venga invocato (mockando i timer, non aspettando real-time).

**Dipendenze esterne.** Nessuna.

**Rischi**

| Rischio | Mitigazione |
|:---|:---|
| Watchdog troppo aggressivo → reconnect storm o rate limit lato Hyperliquid | Backoff minimo obbligatorio tra tentativi (criterio sopra) |
| Notifiche Telegram rumorose se il WS sfarfalla (connette/disconnette ripetutamente) | Soglia di downtime prima della notifica, non ogni singolo evento |
| Il watchdog stesso introduce un timer che sopravvive a `stop()` in modo scorretto | Verificare che venga ripulito in `marketData.stop()`, come già fa `pollTimer` |

---

### 🟠 DEP-01 · Aggiornamento delle dipendenze vulnerabili

| | |
|:---|:---|
| **Tipo** | 🔒 security / ⚙️ chore |
| **Story Point** | **5** |
| **Priorità** | P0 — blocca la CI per l'intero team, non solo per questo sprint |
| **File** | `package.json`, `package-lock.json` |
| **Origine** | Segnalato da Annie durante SEC-03; verificato di nuovo io stesso l'8 agosto — **17 vulnerabilità invariate** (7 moderate, 10 alte) |

**Descrizione.** La CI configurata in SEC-03 (`npm audit --audit-level=high`, bloccante) è corretta e già pronta — ma **fallisce oggi**, per vulnerabilità preesistenti allo Sprint 1, non introdotte da esso. Finché non si risolve, **ogni PR di chiunque risulterà rossa**, incluso il lavoro futuro di questo stesso sprint. È il task con l'effetto più immediato su tutto il resto del flusso di lavoro del team.

**Stato verificato (`npm audit --audit-level=high`, 8 agosto):**

| Pacchetto | Via | Fix |
|:---|:---|:---|
| `ws` (8.0.0–8.20.1) | `engine.io`, `ethers`, `socket.io-adapter` | `npm audit fix` (non-breaking) |
| `uuid` | `node-cron` (3.0.2–3.0.3) | Richiede `npm audit fix --force` → **aggiorna `node-cron` a 4.6.0 (breaking)** |
| altri (axios, path-to-regexp, ip-address, playwright, form-data, follow-redirects, body-parser/qs — dal report originale di Annie) | varie | da confermare pacchetto per pacchetto in fase di esecuzione |

**Nota sul breaking change.** `node-cron` è usato in un solo file, `src/index.js` (il modulo CLI legacy di scansione arbitraggio, non il core del bot Perps), con 3 chiamate a `cron.schedule()` con sintassi cron standard. Superficie di rischio contenuta — ma va comunque testato esplicitamente dopo l'aggiornamento, non assunto compatibile.

**Criteri di accettazione**

- [ ] `npm audit fix` applicato per le vulnerabilità non-breaking (`ws` e derivate).
- [ ] Aggiornamento di `node-cron` a 4.x valutato esplicitamente: le 3 chiamate a `cron.schedule()` in `src/index.js` verificate compatibili con la nuova API (lettura cambelog + test manuale delle schedulazioni).
- [ ] Le restanti vulnerabilità del report di Annie (axios, path-to-regexp, ip-address, playwright, form-data, follow-redirects, body-parser/qs) riverificate una per una: quali sono ancora presenti, quali richiedono breaking change, quali no.
- [ ] `npm audit --audit-level=high` **verde** al termine.
- [ ] `npm test` e `npm run lint` verdi dopo tutti gli aggiornamenti.
- [ ] Test manuale/mirato sul modulo CLI legacy (`src/index.js`) se `node-cron` viene aggiornato — non c'è oggi una suite automatica che lo copra.

**Dipendenze esterne.** Nessuna, ma è **bloccante** per la CI di tutto il resto dello Sprint 2 (va fatto per primo).

**Rischi**

| Rischio | Mitigazione |
|:---|:---|
| Aggiornamento di `node-cron` rompe la schedulazione CLI legacy | Test manuale esplicito delle 3 schedulazioni; il modulo non è nel percorso critico del bot Perps |
| Un aggiornamento a cascata introduce una regressione non coperta dai test esistenti | Rigirare l'intera suite (66 test) dopo ogni gruppo di aggiornamenti, non solo alla fine |
| Nuove vulnerabilità emergono nel frattempo (il campo si muove) | Rieseguire `npm audit` il giorno stesso dell'esecuzione, non fidarsi di questo documento se sono passati giorni |

---

### 🟡 CI-01 · harden-runner da `audit` a `block`

| | |
|:---|:---|
| **Tipo** | 🔒 security |
| **Story Point** | **2** |
| **Priorità** | P2 |
| **File** | `.github/workflows/ci.yml` |
| **Origine** | Segnalato da Annie — è il seguito naturale di SEC-03 |

**Descrizione.** SEC-03 ha introdotto `harden-runner` in modalità `egress-policy: audit` deliberatamente, per **osservare** gli endpoint legittimi contattati durante `npm ci` prima di bloccare qualunque cosa non prevista. Questo task chiude il ciclo: raccoglie gli endpoint osservati e passa a `block` con un'allowlist esplicita.

**Criteri di accettazione**

- [ ] Raccolti i log di **almeno 3-5 run** della CI in modalità `audit` (serve tempo reale che passi, non è immediato — vedi dipendenza sotto).
- [ ] Allowlist esplicita degli endpoint legittimi (minimo: `registry.npmjs.org`, verosimilmente `github.com` per checkout, altri da confermare dai log).
- [ ] `egress-policy` passato a `block` con l'allowlist.
- [ ] Verificato che un push successivo alla modifica non rompa la CI per un endpoint dimenticato.

**Dipendenze esterne.** ⏳ **Temporale**: serve che siano già girati alcuni run in modalità `audit` prima di poter compilare l'allowlist — non eseguibile il primo giorno dello sprint.

**Rischi**

| Rischio | Mitigazione |
|:---|:---|
| Un endpoint legittimo dimenticato nell'allowlist rompe la CI al primo push utile | Raccogliere log da run reali, non da una sola esecuzione |
| Un futuro aggiornamento di dipendenze introduce un nuovo endpoint (es. un nuovo registry mirror) | Documentare nel `CONTRIBUTING.md` (già esistente da SEC-03) che un cambio di allowlist è previsto e normale, non un sintomo di rottura |

---

### 🟡 TEST-01 · Copertura test per gli script di rotazione chiavi/segreti

| | |
|:---|:---|
| **Tipo** | 🧪 test |
| **Story Point** | **3** |
| **Priorità** | P1 — area a rischio alto (cifratura, chiavi agent) senza alcuna rete di sicurezza automatica |
| **File** | nuovo `test/rotateEncryptionKey.test.js`, nuovo `test/checkSecrets.test.js`, eventualmente refactor minimo di `scripts/rotate-encryption-key.js` e `scripts/check-secrets.js` per renderli testabili |
| **Origine** | Segnalato da Annie durante SEC-03 |

**Descrizione.** Verificato: `scripts/rotate-encryption-key.js` (ruota la chiave di cifratura a riposo — vedi `docs/DEPLOY.md` §10) e `scripts/check-secrets.js` **non hanno alcun test dedicato** in `test/`. Sono script CLI, non moduli con funzioni esportate — probabile motivo per cui sono rimasti fuori dalla suite finora. Toccano l'area più delicata del progetto (le chiavi che proteggono i wallet agent): un errore silenzioso qui non si manifesta come un crash, si manifesta come dati corrotti o irrecuperabili.

**Criteri di accettazione**

- [ ] `rotate-encryption-key.js`: se necessario per renderlo testabile, estrarre la logica di rotazione in funzioni esportabili (senza cambiare il comportamento CLI esistente — resta uno script eseguibile).
- [ ] Test che copre: rotazione riuscita (chiave vecchia → nuova, verificando che i dati cifrati restino leggibili), comportamento in modalità dry-run (senza `--apply`, nessuna scrittura), comportamento su un valore non decifrabile (deve essere lasciato intatto e segnalato, mai sovrascritto — è il comportamento già documentato, va solo verificato con un test).
- [ ] `check-secrets.js`: test che copre il caso di segreti critici mancanti in modalità produzione (deve uscire con codice ≠ 0) e il caso di ambiente di sviluppo senza configurazione completa (non deve bloccare).
- [ ] Nessuna modifica al comportamento osservabile degli script esistenti — questo è un task di **copertura**, non di riscrittura.
- [ ] `npm test` verde, includendo le nuove suite.

**Dipendenze esterne.** Nessuna.

**Rischi**

| Rischio | Mitigazione |
|:---|:---|
| Il refactoring per rendere gli script testabili introduce una regressione comportamentale | Testare manualmente lo script CLI (non solo le funzioni estratte) prima e dopo il refactor |
| I test manipolano davvero l'ambiente/chiavi durante l'esecuzione | Usare solo chiavi di test generate ad-hoc e un DB temporaneo (stesso pattern già in uso in `test/riskPersistence.test.js` e `test/botDca.test.js`) — mai toccare `data/perps.db` reale |

---

### ⚪️ OPS-01 · Rinnovo automatico degli SHA pinnati (GitHub Actions)

| | |
|:---|:---|
| **Tipo** | ⚙️ chore |
| **Story Point** | **2** |
| **Priorità** | P2 |
| **File** | nuovo `.github/dependabot.yml` (o config Renovate equivalente) |
| **Origine** | Segnalato da Annie — conseguenza diretta dell'aver pinnato `harden-runner` a SHA in SEC-03 |

**Descrizione.** Pinnare le GitHub Action a uno SHA specifico (fatto in SEC-03 per `harden-runner`) è la scelta corretta per la sicurezza, ma ha un costo: se nessuno rinnova manualmente lo SHA, il progetto resta bloccato su una versione sempre più vecchia. Serve automazione, non disciplina manuale.

**Criteri di accettazione**

- [ ] Dependabot (o Renovate) configurato per il package ecosystem `github-actions`.
- [ ] Verificato che apra PR per aggiornamenti di SHA pinnati (non silenziosamente su tag mobili — l'obiettivo è mantenere il pinning, solo automatizzarne il rinnovo).
- [ ] Cadenza ragionevole (settimanale o mensile, non ad ogni commit upstream).

**Dipendenze esterne.** Dependabot è un servizio GitHub nativo (nessuna dipendenza aggiuntiva da installare); se si sceglie Renovate, è un'app GitHub di terze parti da autorizzare esplicitamente.

**Rischi**

| Rischio | Mitigazione |
|:---|:---|
| PR automatiche di Dependabot non riviste finiscono per essere ignorate/accumularsi | Nessuna automazione di auto-merge in questo task — le PR vanno sempre riviste a mano, l'automazione è solo sulla *scoperta*, non sull'*applicazione* |

---

### ⚪️ CHORE-01 · Verifica igiene `.npmrc`

| | |
|:---|:---|
| **Tipo** | 🔒 security (verifica) |
| **Story Point** | **1** |
| **Priorità** | P2 |
| **File** | `.npmrc` |
| **Origine** | Segnalato da Annie: il file non tracciato è comparso nel working tree durante SEC-03 e il suo agente non ha potuto ispezionarlo (bloccato dai permessi di lettura, come me quando ho provato io stesso l'8 agosto — protezione del sandbox sui dotfile, corretta) |

**Descrizione.** Non è un'accusa, è un controllo dovuto: prima che `.npmrc` venga committato, va confermato che contenga solo `ignore-scripts=true` e i commenti relativi (come da SEC-02), e **non** righe tipo `//registry.npmjs.org/:_authToken=...` che esporrebbero un token del registry npm.

**Criteri di accettazione**

- [ ] `.npmrc` ispezionato da un umano (non da un agente — è protetto dal sandbox per una buona ragione) prima del primo commit.
- [ ] Confermata l'assenza di token/credenziali.
- [ ] Se il file è pulito, nessuna azione ulteriore — questo task chiude con una conferma, non necessariamente con una modifica.

**Dipendenze esterne.** Nessuna. **Rischi.** Trascurabili — è una verifica, non una modifica di codice.

---

### 🟠 TRAIL-01 · `trailing_json` perde `originalEntryPx`/`dcaCount` dopo un riavvio

| | |
|:---|:---|
| **Tipo** | 🐛 bug — correttezza, esposizione non voluta |
| **Story Point** | **2** |
| **Priorità** | P1 — non capitale immediatamente scoperto come SEC-01, ma può portare a più DCA di quanti configurati |
| **File** | `src/perps/bot.js` (`_placeTpSl`, `_ensureStopLoss`, il trailing stop) |
| **Origine** | Bruno, scoperto ri-verificando il proprio codice per la Sala Review dello Sprint 1 (non durante l'implementazione originale di SEC-01) |

**Descrizione.** Tre punti distinti di `bot.js` scrivono il campo `trailing_json` sovrascrivendolo col
solo `{ slOid }` — cancellando `originalEntryPx` e `dcaCount` che il fix di SEC-01 salva nello stesso
campo. A runtime nessun problema: i valori restano corretti in memoria finché il processo non si
riavvia. Il guaio emerge dopo un **riavvio** del bot su una posizione che ha già eseguito almeno una
mediazione DCA: `dcaCount` torna a 0, e il bot può eseguire più step di DCA di quanti configurati,
impegnando capitale non previsto.

**Criteri di accettazione**

- [ ] I tre punti che scrivono `trailing_json` fanno **merge** col contenuto esistente (`originalEntryPx`, `dcaCount` preservati), non un overwrite completo.
- [ ] Test che riproduce lo scenario: apre una posizione, esegue un'aggiunta DCA, fa scattare un aggiornamento di trailing stop, istanzia un **nuovo** `PerpsBot` sullo stesso DB (simula il riavvio), verifica che `dcaCount` sia ancora quello corretto.
- [ ] Nessuna regressione sul comportamento già testato in `test/botDca.test.js`.

**Dipendenze esterne.** Nessuna. **Dipendenza interna:** stesso file di SEC-01/SEC-05 — va assegnato a chi già conosce quel codice (Bruno), non parallelizzato con altri task sullo stesso file.

**Rischi**

| Rischio | Mitigazione |
|:---|:---|
| Il merge introduce una regressione sul trailing stop "normale" (senza DCA) | Rigirare `test/botDca.test.js` e l'intera suite dopo la modifica, non solo il nuovo test |
| Il fix tocca lo stesso file toccato pesantemente da SEC-01: rischio di conflitto se lavorato in parallelo con altro codice su `bot.js` | Nessun altro task Sprint 2 tocca `bot.js` — verificato, nessun conflitto reale |

---

### 🟠 CI-REBUILD-01 · La CI non ricompila `better-sqlite3`

| | |
|:---|:---|
| **Tipo** | 🔒 affidabilità CI |
| **Story Point** | **1** |
| **Priorità** | P1 — "verde da noi, rosso su un runner pulito" è un problema di fiducia nella CI, non solo tecnico |
| **File** | `.github/workflows/ci.yml` |
| **Origine** | Joshua, scoperto ri-verificando l'infrastruttura per la Sala Review dello Sprint 1 |

**Descrizione.** `.npmrc` (SEC-02) blocca gli script postinstall per tutto il repository, ma **solo il
`Dockerfile`** esegue `npm rebuild better-sqlite3 --ignore-scripts=false` dopo `npm ci`. La pipeline
CI fa solo `npm ci` + `npm test`, senza quel passaggio. In locale i test che aprono davvero SQLite
passano perché resta un binario compilato **prima** dell'introduzione di `.npmrc` — su un runner CI
realmente pulito (senza quello stato residuo) quei test fallirebbero.

**Criteri di accettazione**

- [ ] Aggiunto uno step CI che esegue `npm run rebuild:native` (già esistente in `package.json`, introdotto in SEC-02) dopo `npm ci` e prima di `npm test`.
- [ ] Verificato su un ambiente realmente pulito (`rm -rf node_modules` prima di `npm ci`, non solo in locale con cache residua) che i test SQLite passino.
- [ ] Le istruzioni di setup per chi clona il repo da zero menzionano il passaggio.

**Dipendenze esterne.** Nessuna. **Dipendenza interna:** stesso file di CI-01 — stesso proprietario (Joshua), eseguito in sequenza nella stessa sessione, non in parallelo con Annie su CI-01.

**Rischi**

| Rischio | Mitigazione |
|:---|:---|
| Il rebuild allunga i tempi della CI | Trascurabile: pochi secondi per un solo modulo nativo |
| Conflitto di modifica con CI-01 se eseguiti da agenti diversi in parallelo sullo stesso file | Stesso proprietario per entrambi (Joshua), sequenziale per costruzione |

---

### ⚪️ DOC-02 · Residuo in `INDEX.md:59` dopo DOC-01

| | |
|:---|:---|
| **Tipo** | 📄 docs |
| **Story Point** | **1** |
| **Priorità** | P3 — cosmetico, zero rischio operativo |
| **File** | `docs/KB/index/INDEX.md` |
| **Origine** | Maya, scoperto ri-verificando la documentazione per la Sala Review dello Sprint 1 |

**Descrizione.** La tabella di sintesi del backlog (riga 59) dice ancora *"il webhook esiste già →
estenderlo"*, in contraddizione diretta col riquadro corretto poche righe sotto nello stesso file
(che riflette la decisione SEC-04, opzione B: endpoint tenuto interno). Un residuo della chiusura di
DOC-01 non completamente propagato a quella riga specifica.

**Criteri di accettazione**

- [ ] La riga riflette lo stato reale: endpoint interno per scelta, non da estendere salvo decisione futura esplicita.
- [ ] Nessun'altra menzione contraddittoria del webhook nello stesso file.

**Dipendenze esterne.** Nessuna. **Rischi.** Nessuno — fix di una riga.

---

## 3. Riepilogo e pianificazione

### 3.1 Story point e ordine di esecuzione

| ID | Titolo | SP | Priorità | Owner | Blocca |
|:---|:---|:--:|:---:|:---|:---|
| **DEP-01** | Aggiornamento dipendenze vulnerabili | 5 | P0 | Joshua | CI di tutto lo sprint |
| **WS-01** | Watchdog riconnessione WebSocket | 3 | P1 | Bruno | — |
| **TEST-01** | Copertura test script segreti | 3 | P1 | Bruno (review: Annie) | — |
| **TRAIL-01** | `trailing_json` perde stato dopo riavvio | 2 | P1 | Bruno | — |
| **CI-01** | harden-runner audit → block | 2 | P2 | Joshua (review: Annie) | Serve tempo di osservazione |
| **OPS-01** | Rinnovo automatico SHA pinnati | 2 | P2 | Joshua | — |
| **CI-REBUILD-01** | La CI non ricompila better-sqlite3 | 1 | P1 | Joshua | — |
| **CHORE-01** | Verifica igiene .npmrc | 1 | P2 | PO | — |
| **DOC-02** | Residuo INDEX.md:59 | 1 | P3 | Maya | — |
| | **Totale** | **20** | | | |

**Sequenza consigliata:** DEP-01 → (WS-01 → TRAIL-01, stesso proprietario e file limitrofi, in sequenza) → (CI-REBUILD-01 → CI-01 → OPS-01, stesso proprietario, in sequenza) → (TEST-01, CHORE-01, DOC-02 in parallelo — file disgiunti da tutto il resto).

DEP-01 va per primo perché blocca la CI per l'intero team. TRAIL-01 segue WS-01 perché entrambi sono di Bruno; CI-REBUILD-01 precede CI-01 perché entrambi toccano `ci.yml` e sono di Joshua — farli in sequenza nella stessa sessione evita qualunque rischio di conflitto sullo stesso file.

### 3.2 Grafo delle dipendenze

```
DEP-01 ──► (sblocca la CI per tutto il resto)
             │
             ├── WS-01 ──► TRAIL-01     (Bruno, sequenziale: stesso file bot.js)
             ├── CI-REBUILD-01 ──► CI-01 ──► OPS-01   (Joshua, sequenziale: stesso file ci.yml)
             ├── TEST-01    (Bruno o parallelo — file disgiunti da bot.js)
             ├── CHORE-01   (PO, verifica rapida)
             └── DOC-02     (Maya, file disgiunto da tutto il resto)
```

Nessuna dipendenza circolare. Uniche sequenzialità **obbligate** (stesso file, stesso proprietario):
WS-01→TRAIL-01 e CI-REBUILD-01→CI-01→OPS-01. Tutto il resto è pienamente parallelizzabile una volta
sbloccata la CI da DEP-01.

### 3.3 Dipendenze esterne

| Dipendenza | Task | Natura | Nota |
|:---|:---|:---|:---|
| Tempo reale (run CI ripetuti) | CI-01 | Temporale | Non comprimibile: serve osservare traffico reale, non una singola esecuzione |
| Dependabot / Renovate | OPS-01 | Servizio GitHub (nativo o app terze parti) | Renovate richiede autorizzazione esplicita se scelto al posto di Dependabot |
| Registro npm (fix delle vulnerabilità) | DEP-01 | Servizio esterno | Le vulnerabilità e le fix disponibili possono cambiare tra la stesura di questo documento e l'esecuzione |

### 3.4 Risk register di sprint

| # | Rischio | Prob. | Impatto | Mitigazione |
|:--|:---|:---:|:---:|:---|
| R1 | Aggiornamento `node-cron` rompe la schedulazione CLI legacy | Bassa | Medio | Test manuale mirato; il modulo non è nel percorso critico del bot Perps |
| R2 | Watchdog WS troppo aggressivo genera reconnect storm | Bassa | Medio | Backoff obbligatorio tra tentativi |
| R3 | CI-01 parte con un'allowlist incompleta e rompe il primo push utile | Media | Basso | Raccogliere log da più run reali, non da uno solo |
| R4 | Refactoring per TEST-01 introduce una regressione negli script di rotazione chiavi | Bassa | **Alto** (area cifratura) | Test manuale CLI oltre ai test automatici; nessun test tocca `data/perps.db` reale |
| R5 | Nuove vulnerabilità emergono tra la stesura di questo doc e l'esecuzione | Media | Basso | Rieseguire `npm audit` il giorno dell'esecuzione, non fidarsi di questo documento se sono passati giorni |
| R6 | TRAIL-01 (merge su `trailing_json`) rompe il trailing stop "normale" senza DCA | Bassa | Medio | Rigirare `test/botDca.test.js` e l'intera suite, non solo il nuovo test mirato |
| R7 | CI-REBUILD-01 e CI-01 sullo stesso file (`ci.yml`) lavorati fuori sequenza generano conflitti | Bassa | Basso | Stesso proprietario (Joshua) per entrambi, ordine fissato nella sequenza consigliata |

### 3.5 Definition of Done

Per **ogni** task:

- [ ] `npm test` verde (suite esistente + eventuali nuove, nessuna regressione).
- [ ] `npm run lint` verde.
- [ ] Nessuna modifica al comportamento osservabile non esplicitamente prevista dal task (in particolare per TEST-01: è copertura, non riscrittura).
- [ ] Commit con messaggio che spiega il perché, non solo il cosa.
- [ ] Documentazione aggiornata se il comportamento osservabile cambia (in particolare `docs/DEPLOY.md` se cambia qualcosa nella gestione dei segreti o nel deploy).

Per lo **sprint**:

- [x] `npm audit --audit-level=high` verde — è il segnale che la CI di SEC-03 è finalmente utilizzabile senza rumore preesistente. **0 vulnerabilità a qualsiasi livello (DEP-01).**
- [x] Watchdog WS verificato con un test che simula un drop, non solo osservato "a occhio" sui log. **`test/marketDataWs.test.js`, 6 casi (WS-01).**
- [x] `perps_ws_reconnects_total` osservato incrementare almeno una volta in un test o in un ambiente di verifica. **Verificato in WS-01; nota aperta: conta anche le ri-sottoscrizioni volontarie da cambio rete, non solo i drop.**

---

## 4. Esito — Sprint 2 (review PO, 8 agosto 2026)

Review condotta sullo stesso modello dello Sprint 1: ogni membro presenta il proprio lavoro con
evidenza, il PO decide task per task. Integrazione verificata sull'intero albero: **87/87 test
verdi, lint pulito, `npm audit` a zero vulnerabilità a qualsiasi livello.**

| Task | Owner | SP | Esito |
|:---|:---|:--:|:---|
| DEP-01 | Joshua | 5 | ✅ **Done** — nessuna riserva |
| WS-01 | Bruno | 3 | ✅ **Done** — nessuna riserva |
| TRAIL-01 | Bruno | 2 | ✅ **Done** — nessuna riserva |
| TEST-01 | Bruno | 3 | ✅ **Done** — con deviazione approvata (vedi sotto) |
| OPS-01 | Joshua | 2 | ✅ **Done** — con scelta di scope confermata (vedi sotto) |
| CI-REBUILD-01 | Joshua | 1 | ✅ **Done** — nessuna riserva |
| DOC-02 | Maya | 1 | ✅ **Done** — nessuna riserva |
| CI-01 | Joshua | 2 | ⏸️ **Differito** — dipendenza temporale non comprimibile |
| CHORE-01 | PO | 1 | ⏳ **In attesa del PO** — nessun agente ha accesso a `.npmrc` |

**17 SP chiusi, 2 SP differiti, 1 SP in attesa di un'azione umana.**

### 4.1 Aggiunta dopo la review — UI-01

Scoperta dal PO **fuori dal ciclo di planning**, dopo la chiusura della review dello Sprint 2, e
chiusa subito su sua richiesta diretta invece di essere rimandata allo Sprint 3: un kill-switch che
nessuno sa come spegnere non è un difetto cosmetico. Non entra nel conteggio degli SP dello sprint
(17 SP restano il consuntivo della review): è un'attività extra tracciata qui per non perderne
la storia.

| Task | Owner | SP | Esito |
|:---|:---|:--:|:---|
| UI-01 | Maya | 1 | ✅ **Done** — aggiunta e chiusa dopo la review, su richiesta del PO |

#### 🐛 UI-01 · Il kill-switch non è disattivabile dall'interfaccia

| | |
|:---|:---|
| **Tipo** | 🐛 bug (operativo) |
| **Story Point** | **1** |
| **Priorità** | **P1** — un arresto d'emergenza che nessun operatore sa come revocare blocca il trading a tempo indefinito |
| **File** | `public/index.html`, `public/perps.js`, `docs/MANUAL.md` §6.4, `public/manual.html`, `test/killSwitchUi.test.js` |
| **Origine** | PO, fuori dal ciclo di planning — segnalato dopo la chiusura della review dello Sprint 2 |

**Descrizione.** `POST /api/agents/killswitch` (`src/server.js:1263`) accetta `{on:false}` e spegne il
kill-switch, ma **nessuna parte dell'interfaccia lo chiamava**. L'UI esponeva solo l'attivazione
(`perps.killSwitch()` → `POST /api/perps/killswitch`, sempre e solo `on:true`); nessun comando
Telegram lo disattivava e `docs/MANUAL.md` non documentava la disattivazione. Il flag persiste in
`settings.killswitch`: una volta attivato restava attivo **per sempre** — anche attraverso i riavvii
del server — finché qualcuno non chiamava l'endpoint dalla console del browser, cosa che nessun
operatore reale scoprirebbe da solo.

**Criteri di accettazione**

- [x] Bottone di riattivazione accanto al kill-switch in `public/index.html`, **visibile solo quando il kill-switch è attivo**.
- [x] `perps.resumeFromKillSwitch()` chiama `POST /api/agents/killswitch` con `{on:false}`, previa conferma (`window.confirm` nativo: siamo nell'app reale, non in un artifact sandboxed).
- [x] Lo stato mostrato (`killswitchState` + visibilità del bottone) si aggiorna subito dopo la chiamata, senza refresh manuale della pagina.
- [x] Verificato **sul codice** che la riattivazione non riavvii i bot: `riskAgent.setKillSwitch(false)` scrive solo il setting e la riga di audit, e `settings.killswitch` non ha altri lettori oltre a `isKillSwitchOn()`. I bot fermati dal kill-switch hanno `status='stopped'` persistito da `bot.stop()`, quindi non ripartono nemmeno al riavvio del server. Riavviarli resta una scelta separata dell'operatore.
- [x] `docs/MANUAL.md` §6.4 e la sezione corrispondente di `public/manual.html` documentano esplicitamente **come si spegne**, la persistenza del flag e il fatto che riattivare non riavvia i bot.
- [x] `npm test` verde (94/94, +7 casi in `test/killSwitchUi.test.js` — primo test su `public/*.js` del progetto, DOM finto in `node:vm`, nessuna dipendenza aggiunta), `npm run lint` verde, tag HTML bilanciati in entrambi i file toccati.

**Correzione collaterale, dentro lo stesso paragrafo riscritto.** Il manuale affermava *"il
kill-switch è raggiungibile anche da Telegram (`/chiuditutto`)"*: falso. `_cmdCloseAll` in
`src/perps/telegramControl.js:237` chiude le posizioni aperte e **non tocca né il kill-switch né i
bot**. Corretto in §6.4 e nella tabella comandi §16 (più i due riflessi in `manual.html`): non si
poteva documentare la disattivazione lasciando in piedi, nella stessa sezione, un canale di
attivazione che non esiste.

**Dipendenze esterne.** Nessuna. **Rischi.** Nessuno lato esecuzione: la rotta esisteva già e non è
stata modificata, il bug era l'assenza di un chiamante.

**Approvato dal PO** l'8 agosto, nessuna riserva. La lacuna emersa fuori perimetro — Telegram non ha
alcun comando per il kill-switch, né on né off — non viene chiusa ora: **promossa a story per lo
Sprint 3**, vedi `docs/KB/BACKLOG/sprint3.md`.

### Decisioni prese in review

1. **TEST-01** — Bruno, scrivendo i test, ha trovato che `scripts/rotate-encryption-key.js`
   leggeva una colonna DB inesistente (`address` invece di `master_address`, introdotta in
   `fbd5402`): la rotazione delle chiavi agent **non è mai stata eseguibile**, in nessun momento,
   nemmeno su un DB vuoto. Mai in produzione — il bug esisteva solo su `feat/perps-hardening`.
   Annie ha rifatto la verifica in modo indipendente (non si è fidata del resoconto) e confermato:
   bug reale, fix corretto, test genuini. **Il PO ha accettato il fix dentro TEST-01** invece di
   isolarlo in un task a sé. Nota aggiunta in `docs/DEPLOY.md` §10 per chi farà un audit
   retrospettivo del periodo 6-8 agosto.
2. **OPS-01** — Joshua ha escluso deliberatamente l'ecosistema npm da Dependabot (già coperto da
   audit bloccante in CI + review riga-per-riga obbligatoria del lockfile). **Il PO ha confermato
   la scelta.** Il criterio "apre PR per SHA pinnati" resta formalmente aperto fino al merge sul
   branch di default — non blocca la chiusura del task, si conferma con la prima PR automatica.
3. **CI-01** — dipendenza temporale reale (servono 3-5 run CI in modalità `audit` accumulate nel
   tempo, nessuna è mai partita). **Il PO ha scelto di farlo scivolare fuori dallo Sprint 2**,
   resta in backlog.
4. **CHORE-01** — nessun agente ha accesso a `.npmrc` per via della sandbox. Resta un'ispezione
   che solo il PO può fare di persona prima del primo commit.

### Portato avanti (refinement candidates, non azionati in questo sprint)

- Rating "Sforzo: Basso" per l'apertura del webhook a TrendSpider in `INDEX.md` §1.1, probabilmente
  sbagliato (Maya).
- Duplicato AOLM e typo nel nome file in `INDEX.md` §4, residui pre-Sprint-1 (Maya).
- `INDEX.md` §3/§B.1 descrivono ancora come aperto il bug TP/SL-dopo-DCA chiuso in SEC-01 (Maya).
- Contatore separato per riconnessioni da drop vs cambio rete volontario in WS-01, se utile (Bruno).
- `secretBox.js` ricade silenziosamente su una chiave di sviluppo hardcoded se la variabile di
  cifratura è assente — nessun test (Annie).
- `rotate-encryption-key.js` confronta solo l'id della chiave, non il materiale — disallineamento
  silenzioso non testato (Annie).
- `check-secrets.js`: solo 3 variabili su 12 esercitate dai test (Annie).

Stato consolidato: `docs/KB/BACKLOG/sprint2-status/aggregate.json`.
