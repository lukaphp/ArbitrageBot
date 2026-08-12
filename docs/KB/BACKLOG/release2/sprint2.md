# Release 2 · Sprint 2 — Completamento Release 1 + Multi-provider Analyst (Epic B + Epic C)

**Team:** Nautilus · **Stato:** planning, 12 agosto 2026 — subito dopo la chiusura review di Sprint 1
(21/21 SP, `sprint1.md`) e durante la demo operativa isolata di Jordan sul VPS (ordini testnet reali,
in corso). Questo sprint copre **Epic B** (completamento operativo/debito residuo di Release 1, ora 19
SP dopo l'aggiunta di CRIT-05) ed **Epic C** (multi-provider anche per l'Analyst, 5 SP) — nessuna
dipendenza dura tra le due epiche, per questo pianificate insieme (`release2/README.md` §7).

**Nota di sequenziamento, decisa esplicitamente in planning:** la demo di Jordan sta girando in
parallelo a questo sprint, sullo stesso VPS ma su un'istanza Docker isolata (nessun conflitto di
codice o di deploy). L'unico punto di contatto è **CRIT-05** — il fix va sequenziato **per ultimo**,
dopo che la demo avrà prodotto il secondo campione (posizioni multiple/PnL non banale) che Bruno ha
chiesto nella sua indagine. Tutto il resto dello sprint procede senza vincoli di ordine verso la demo.

---

## 0. Candidati

| # | Story | Origine | Verificato sul codice (12 agosto) | Owner | SP |
|:--|:---|:---|:---:|:---|:--:|
| 1 | `harden-runner` da audit a block in CI | Sprint 2 R1, differito | ✅ ancora in `audit`, 10+ run puliti accumulati dal 9 agosto | Joshua | 2 |
| 2 | Verifica igiene `.npmrc` | Sprint 2 R1, differito | — (accesso sandbox-protetto, resta ispezione diretta) | PO | 1 |
| 3 | Verifica reale backup/restore sul VPS | Sprint 3 R1, mai eseguito | — (operativo, non di codice) | Claude | 1 |
| 4 | Uptime esterno su `/health` | Residuo Sprint 3/4 R1 | — (operativo) | Claude | 1 |
| 5 | Sessione reale `AGENTS_ENABLED=true`: costo vero conversazione advisor | Sprint 4 R1, dichiarato aperto | — (richiede spesa reale, decisione PO) | PO | 1 |
| 6 | Grafana (OBS-01) sul VPS reale, non solo Docker locale | Sprint 4 R1, dichiarato aperto | ✅ profilo `monitoring` già pronto in `docker-compose.yml`, mai attivato sul VPS | Claude | 1 |
| 7 | Suite avversaria ADV-02 vs modello vero DeepSeek/OpenRouter | Sprint 4 R1, dichiarato aperto | — (richiede chiave reale via Infisical) | Bruno | 2 |
| 8 | Cap tool-call per turno advisor | Trovato da Annie, review Sprint 4 | ✅ nessun cap oggi in `toolset.js`/`advisor.js` | Bruno | 1 |
| 9 | Card EXECUTION STATUS onesta (`cockpitFills`/`cockpitPending`/`cockpitRejectRate`) | `sprint4-status/aggregate.json` | ✅ confermato oggi: ancora `—` fissi, "Queue health: Stable" hardcoded | Maya | 2 |
| 10 | Formattazione importi negativi in `fmtUsd` | `sprint4-status/aggregate.json` | ✅ confermato oggi: `.replace('$-', '-$')` ripetuto a mano in almeno 2 punti (righe 510, 653) | Maya | 1 |
| 11 | Ordine sezioni MANUAL.md vs manual.html | `sprint4-status/aggregate.json` | ⚠️ conteggio sezioni invariato (22=22), ordine non ri-diffato oggi — carico dalla review Sprint 4 | Maya | 1 |
| 12 | Focus trap nel drawer del consulente | `sprint4-status/aggregate.json` | ✅ confermato oggi: nessun trap di focus in `perps.js` | Maya | 1 |
| 13 | Riverifica prezzi `pricing.models` (LLM-01) | `sprint4-status/aggregate.json` | ✅ valori attuali estratti, da confrontare coi listini pubblici | Joshua | 1 |
| 14 | **CRIT-05** — doppio conteggio equity | Demo operativa, 11-12 agosto | ✅ **confermato con prova diretta** (vedi `release2/README.md` Epic B) | Bruno | 3 |
| 15 | `analyst.js` → interfaccia `createChatCompletion` di `providers/` | Residuo LLM-01 | ✅ `providers/` esiste (anthropic.js, index.js, openaiCompatible.js), `analyst.js` non lo usa | Bruno | 3 |
| 16 | `AGENT_ANALYST_PROVIDER`, simmetrico a `AGENT_ADVISOR_PROVIDER` | Richiesta PO 11 agosto | ✅ pattern da replicare confermato in `config.js:302`/`advisor.js:81` | Bruno | incluso in #15 |
| 17 | `estimate()` senza `countTokens` (specifico Anthropic) | Conseguenza di #15 | ✅ confermato: `analyst.js:330-340` chiama `anthropic.messages.countTokens` diretto | Bruno | 2 |

**Totale: 24 SP** (19 Epic B + 5 Epic C). Cinque item (righe 2-5, 7) restano fuori dal perimetro degli
agenti — quattro per protezione sandbox/decisione di spesa (PO), due li eseguo direttamente io
(Claude) avendo accesso SSH al VPS già dimostrato in questa sessione, non delegabili a un subagent che
non ce l'ha.

---

## EPIC B — Completamento Release 1 e debito residuo (19 SP)

### 0.1 · CI-01 — `harden-runner` da audit a block

**Verificato.** `.github/workflows/*.yml` ha `harden-runner@v2.20.1` (SHA pinnato) in
`egress-policy: audit` dal 9 agosto (Sprint 1, SEC-03). 10+ run puliti da allora (`gh run list`,
verificato oggi) — abbondanza di dati per compilare l'allowlist, la dipendenza temporale che aveva
differito questa storia da Sprint 2 di Release 1 è ormai risolta.

**Cosa serve:** estrarre gli endpoint osservati dagli insight di harden-runner sui run recenti,
compilare `allowed-endpoints` esplicito, passare `egress-policy: block`. Nessuna sorpresa attesa (il
progetto non ha dipendenze di rete esotiche in CI), ma va verificato un run reale in `block` prima di
chiudere, non solo la configurazione.

**Criteri di accettazione:**
- [ ] Allowlist compilata dagli insight reali, non da una lista generica "npm + GitHub".
- [ ] `egress-policy: block` attivo, un run CI reale verde con la nuova policy.
- [ ] Nessun endpoint bloccato per errore (falso positivo) nel run di verifica.

**File:** `.github/workflows/*.yml`. **SP:** 2.

---

### 0.2 · CHORE-01 — Verifica igiene `.npmrc`

Nessun agente (incluso me, in questa sessione) ha accesso in lettura a `.npmrc` — protezione sandbox
esplicita del progetto. Resta un'ispezione diretta del PO: verificare che non contenga token o
registry non intenzionali, coerente con l'igiene generale dei segreti già applicata al resto del
repo (mai in chiaro, sempre fuori da git dove serve).

**Criteri di accettazione:**
- [ ] PO conferma il contenuto di `.npmrc` (nessun token in chiaro, nessun registry inatteso).

**Owner:** PO. **SP:** 1.

---

### 0.3 · OPS-02 — Verifica reale backup/restore sul VPS

Mai eseguito nonostante pianificato da Sprint 3 di Release 1. Eseguibile da me direttamente (accesso
SSH già dimostrato tutta questa sessione): eseguire `backup.sh`, verificare l'archivio prodotto,
eseguire `restore-verify.sh` su una copia, confermare che i dati tornano integri.

**Criteri di accettazione:**
- [ ] Backup reale eseguito sul VPS, archivio verificato non vuoto/non corrotto.
- [ ] Restore verificato su una copia separata (mai sovrascrivere il DB live nel test).
- [ ] Esito documentato in `docs/DEPLOY.md` (data dell'ultima verifica reale, non solo la procedura).

**Owner:** Claude (diretto). **SP:** 1.

---

### 0.4 · OPS-03r — Uptime esterno su `/health`

Residuo di Sprint 3/4: OBS-01 (Grafana) copre l'osservabilità interna, ma serve comunque un ping da
fuori la tailnet per sapere se il servizio è raggiungibile dall'esterno, non solo dall'interno.

**Criteri di accettazione:**
- [ ] Servizio di uptime esterno configurato (UptimeRobot/healthchecks.io o equivalente) su `/health`.
- [ ] Almeno un ciclo di verifica reale osservato (non solo configurato, anche controllato che risponda).
- [ ] Canale di alert configurato (email o Telegram) in caso di downtime rilevato dall'esterno.

**Owner:** Claude (diretto, con decisione minima del PO su quale servizio). **SP:** 1.

---

### 0.5 · ADV-OPS-01 — Costo reale di una sessione advisor

Prerequisito tecnico dichiarato anche per Epic D/E (`release2/README.md` §5): prima di moltiplicare i
canali che usano il budget dell'advisor (digest, commento su alert), serve sapere quanto costa
davvero una sessione, non solo la stima dello spike originale.

**Dipendenza esterna, da decidere col PO prima di eseguirla:** richiede `AGENTS_ENABLED=true` e una
chiave Anthropic reale sull'ambiente di test — spesa reale, seppur piccola. Non eseguibile da un
agente senza il via libera esplicito del PO sulla spesa.

**Criteri di accettazione:**
- [ ] Almeno 3-5 conversazioni advisor reali misurate (non simulate), costo per turno e per sessione
      registrato.
- [ ] Confronto esplicito con la stima dello spike (`spike-ai-advisor.md`), scarto documentato.
- [ ] Il numero reale, non la stima, diventa la base per dimensionare `AGENT_ADVISOR_MONTHLY_BUDGET_USD`
      quando Epic D aggiungerà nuovi canali.

**Owner:** PO. **SP:** 1.

---

### 0.6 · OBS-OPS-01 — Grafana sul VPS reale

Il profilo `monitoring` in `docker-compose.yml` (Prometheus + Grafana, `profiles: [monitoring]`) esiste
già da Sprint 4 ma non è mai stato acceso sul VPS reale, solo verificato in locale. Eseguibile da me
direttamente.

**Criteri di accettazione:**
- [ ] `docker compose --profile monitoring up -d` eseguito sul VPS reale.
- [ ] Dashboard Grafana raggiungibile in tailnet (stesso schema `tailscale serve` già in uso, porta
      separata come per la demo).
- [ ] Almeno un pannello (equity/PnL, WS connesso) verificato con dati reali, non solo il boot pulito.
- [ ] `docs/DEPLOY.md` §monitoraggio aggiornato con l'URL reale e la data della prima attivazione.

**Owner:** Claude (diretto). **SP:** 1.

---

### 0.7 · LLM-VAL-01 — Suite avversaria vs modello vero

Oggi la suite avversaria di ADV-02 (assert su "nessuna chiamata di scrittura partita") gira solo contro
il client finto nei test. Prima di dare all'advisor accesso reale a DeepSeek/OpenRouter in produzione,
va rieseguita contro un modello vero.

**Dipendenza esterna:** richiede una chiave reale DeepSeek o OpenRouter provisionata via Infisical —
il PO deve procurarla prima che Bruno possa eseguire questa storia.

**Criteri di accettazione:**
- [ ] Chiave reale provisionata via Infisical (non in chiaro nel repo o in env Docker diretto).
- [ ] Suite avversaria di `test/advisorAdversarial*.test.js` (o equivalente) rieseguita contro il
      modello vero, non il mock.
- [ ] Ogni caso della suite verificato: nessuna chiamata di scrittura è mai partita, indipendentemente
      dal testo prodotto dal modello.
- [ ] Esito documentato — se il modello vero si comporta diversamente dal mock in qualunque caso, va
      segnalato esplicitamente, non nascosto in un "tutto verde".

**File:** `src/agents/advisor/`, `test/`. **Owner:** Bruno. **SP:** 2.

---

### 0.8 · DEBT-02 — Cap tool-call per turno advisor

Trovato da Annie in review Sprint 4: il costo CPU locale di più tool-call nello stesso turno non è
contabilizzato dal budget monetario (che misura solo token/$), quindi un turno con molte chiamate
"gratuite" (tool read-only) può comunque pesare in latenza/CPU senza che nulla lo segnali.

**Criteri di accettazione:**
- [ ] Cap esplicito sul numero di tool-call per turno (env var, default ragionevole — coerente con
      `advisorMaxIterations` già esistente in `config.js`, verificare se è già lo stesso limite o va
      aggiunto un secondo cap distinto).
- [ ] Comportamento al superamento: il turno si ferma con un messaggio chiaro, stesso registro degli
      altri limiti dell'advisor (budget, non un errore grezzo).
- [ ] Test che verifica il cap con un mock che prova a fare più chiamate del limite.

**File:** `src/agents/advisor/`. **Owner:** Bruno. **SP:** 1.

---

### 0.9 · DEBT-03 — Card EXECUTION STATUS onesta

Confermato oggi: `public/index.html:187` ha `#cockpitFills`, `#cockpitPending`, `#cockpitRejectRate`
tutti fissi a `—`, e "Queue health" è testo statico `Stable` — la stessa classe di dato finto già
corretta da DEBT-UI-01 in Sprint 4 (allora sull'`index.html` generale, qui specificamente sulla card
execution).

**Criteri di accettazione:**
- [ ] I tre campi sono alimentati da dati reali (execQueue depth/warning già esposti da WARN-02,
      fill/reject rate da `trades`/proposte) o la card viene rimossa se il dato non è ricavabile
      onestamente — stessa disciplina di DEBT-UI-01: mai un numero finto o un dato disonesto.
- [ ] "Queue health" riflette lo stato reale della coda (`execQueue.depthSnapshot()`), non un testo
      fisso.
- [ ] Nessun altro punto della UI mostra ancora `Stable`/valori fissi per la stessa metrica.

**File:** `public/index.html`, `public/perps.js`. **Owner:** Maya. **SP:** 2.

---

### 0.10 · DEBT-04 — Formattazione importi negativi

Confermato oggi: `this.fmtUsd(value).replace('$-', '-$')` ripetuto identico in almeno 2 punti
(`public/perps.js:510,653`) invece di essere nella funzione `fmtUsd` stessa.

**Criteri di accettazione:**
- [ ] La logica del replace entra dentro `fmtUsd()` (o una variante esplicita), non più ripetuta nei
      chiamanti.
- [ ] Tutti i punti che oggi fanno il replace a mano vengono aggiornati per usare la funzione centrale.
- [ ] Test che verifica un valore negativo formattato correttamente (`-$12.34`, non `$-12.34`).

**File:** `public/perps.js`. **Owner:** Maya. **SP:** 1.

---

### 0.11 · DEBT-05 — Ordine sezioni MANUAL.md vs manual.html

Contenuti già allineati (verificato in Sprint 4), solo l'ordine delle sezioni differisce tra i due
file. Non ri-verificato riga per riga in questo planning (basso rischio, nessuna modifica recente a
nessuno dei due file) — da confermare all'avvio della storia.

**Criteri di accettazione:**
- [ ] Ordine delle sezioni in `manual.html` allineato a `MANUAL.md` (o viceversa, whichever è la fonte
      di verità — da dichiarare esplicitamente nella storia).
- [ ] Nessun contenuto perso o duplicato nel riordino.

**File:** `docs/MANUAL.md`, `public/manual.html`. **Owner:** Maya. **SP:** 1.

---

### 0.12 · DEBT-06 — Focus trap nel drawer del consulente

Confermato oggi: nessun meccanismo di focus trap nel drawer dell'advisor in `perps.js`. Con il drawer
aperto, il focus da tastiera può ancora uscire verso il resto della pagina — problema di accessibilità
isolato e piccolo.

**Criteri di accettazione:**
- [ ] Focus trap attivo quando il drawer è aperto (Tab/Shift+Tab restano dentro il drawer).
- [ ] Focus torna al trigger che ha aperto il drawer alla chiusura (Escape o click fuori).
- [ ] Nessuna regressione sul resto della navigazione da tastiera della cockpit.

**File:** `public/perps.js`. **Owner:** Maya. **SP:** 1.

---

### 0.13 · LLM-PRICE-01 — Riverifica prezzi `pricing.models`

Valori attuali (`src/config/config.js`, mai verificati contro un listino pubblico dal momento in cui
sono stati scritti in LLM-01, senza accesso rete all'epoca):

| Provider/modello | In ($/M) | Out ($/M) |
|:--|--:|--:|
| Opus | 15 | 75 |
| Sonnet | 3 | 15 |
| Haiku | 1 | 5 |
| DeepSeek Chat (diretto) | 0.27 | 1.10 |
| DeepSeek Reasoner (diretto) | 0.55 | 2.19 |
| DeepSeek Chat (via OpenRouter) | 0.27 | 1.10 |
| DeepSeek R1 (via OpenRouter) | 0.55 | 2.19 |

**Criteri di accettazione:**
- [ ] Ogni riga confrontata con il listino pubblico reale del provider alla data della verifica (non
      un valore ricordato/assunto).
- [ ] Scostamenti aggiornati come default in `config.js`, restando override-abili da env (nessun
      comportamento cambia per chi già imposta le proprie variabili).
- [ ] Data della verifica annotata in un commento nel codice — stesso pattern già usato per il SHA
      pinnato di harden-runner ("verificato via ... il 2026-08-07").

**File:** `src/config/config.js`. **Owner:** Joshua. **SP:** 1.

---

### 0.14 · CRIT-05 — Doppio conteggio equity *(sequenziata per ultima)*

Vedi `release2/README.md` Epic B per la diagnosi completa (Bruno, 11-12 agosto) e
`.claude/agent-memory/bruno/project_equity-doppio-conteggio-spot.md` per il dettaglio tecnico. Qui solo
i criteri di accettazione per l'implementazione.

**Vincolo di sequenza esplicito:** non iniziare questa storia finché la demo operativa di Jordan non
ha prodotto un secondo campione — posizioni multiple concorrenti e/o PnL non realizzato significativo
(in utile e in perdita) — come richiesto da Bruno stesso per confermare che `spot.hold ==
totalMarginUsed` regge anche fuori dal caso singolo verificato finora. Se la demo si conclude prima
che questo accada naturalmente, va simulato esplicitamente (es. aprendo una seconda posizione demo)
prima di procedere.

**Criteri di accettazione:**
- [ ] Secondo campione raccolto e verificato (vedi sopra) prima di scrivere codice.
- [ ] Funzione pura di composizione equity in `riskManager.js` (non calcolo inline in
      `hyperliquidClient.getAccount()`), stessa formula: `accountValue + (spot.total - spot.hold)`.
- [ ] Nuovo campo esplicito per lo spot disponibile (es. `spotAvailable`), **non** ridefinito il
      significato di `spotUsdc` esistente — consumato da `telegramControl.js`, `public/perps.js`,
      `agents/analyst/tools.js`, tutti da verificare che continuino a funzionare invariati.
- [ ] Test sulla **proprietà**, non su un valore fisso: "aprire una posizione non cambia l'equity (a
      meno delle fee)" — con almeno due fixture (una a conto piatto, una con posizione già aperta).
- [ ] `paperBroker.js` (che già ritorna `spotUsdc: 0`) verificato coerente senza modifiche.
- [ ] Verifica che `risk_equity_history`/drawdown/`marginPct` non producano più i falsi positivi
      quantificati nell'indagine (sovradimensionamento composto, drawdown fittizio, allarme di leva
      ritardato).
- [ ] Verificato anche su mainnet (oggi latente, `accountValue: 0`) che il fix non introduca una
      regressione sul caso a conto piatto che l'ha originato (commit `9e3a236`).

**File:** `src/perps/hyperliquidClient.js`, `src/perps/riskManager.js`. **Owner:** Bruno. **SP:** 3.

---

## EPIC C — Multi-provider anche per la strategia (5 SP)

### 0.15 · LLM-02/03 — Migrare l'Analyst a `providers/`

**Verificato.** `src/agents/providers/` esiste già (anthropic.js, index.js, openaiCompatible.js),
costruito e testato in Sprint 4 per l'advisor. `analyst.js` non lo usa — chiama Anthropic direttamente.
`AGENT_ADVISOR_PROVIDER` (`config.js:302`, letto in `advisor.js:81`) è il pattern simmetrico da
replicare come `AGENT_ANALYST_PROVIDER`.

**Criteri di accettazione:**
- [ ] `analyst.js` usa `createChatCompletion` di `providers/`, non più il client Anthropic diretto.
- [ ] `AGENT_ANALYST_PROVIDER` (default `anthropic`) simmetrico a `AGENT_ADVISOR_PROVIDER` — stesso
      nome di pattern, stesso default.
- [ ] **Zero regressioni sui test esistenti** dell'Analyst con provider Anthropic — stesso
      comportamento, cambia solo l'indirezione.
- [ ] Nessuna chiave nuova obbligatoria, nessun modello di default cambiato — stesso principio già
      rispettato in LLM-01 per l'advisor.
- [ ] `docs/DEPLOY.md`/`docs/MANUAL.md` aggiornati con la nuova variabile.

**File:** `src/agents/analyst/analyst.js`, `src/config/config.js`. **Owner:** Bruno. **SP:** 3
(comprende LLM-03).

---

### 0.16 · LLM-04 — Stima costo senza `countTokens`

**Verificato.** `analyst.js:330-340` (`estimate()`) chiama `anthropic.messages.countTokens`
direttamente — specifico Anthropic, non disponibile per DeepSeek/OpenRouter. Serve un'euristica
per-provider, stessa disciplina "preventivo prima di spendere" già applicata al resto del sistema.

**Criteri di accettazione:**
- [ ] Con provider Anthropic: comportamento invariato, continua a usare `countTokens` (esatto, gratuito
      — non ha senso sostituirlo con una stima peggiore quando l'esatto è gratis).
- [ ] Con provider non-Anthropic: euristica di stima dichiarata come tale (non spacciata per esatta),
      stesso ordine di grandezza verificato contro almeno un caso reale.
- [ ] `estimate()` non blocca né rallenta il preventivo per provider senza `countTokens`.

**File:** `src/agents/analyst/analyst.js`, `src/agents/usage.js`. **Owner:** Bruno. **SP:** 2.

---

## 1. Definition of Done di sprint

Per **ogni** storia di sviluppo (non le 5 dirette PO/Claude, che sono operative):

- [ ] `npm test` verde (suite esistente + nuove, nessuna regressione).
- [ ] `npm run lint` verde.
- [ ] Commit con messaggio che spiega il perché, non solo il cosa.
- [ ] Documentazione aggiornata se il comportamento osservabile cambia.
- [ ] Criteri di accettazione della storia verificati uno per uno, non dichiarati per blocco.

Per lo **sprint**:

- [ ] CRIT-05 non parte prima che il secondo campione dalla demo sia disponibile (vincolo esplicito
      §0.14) — se lo sprint si chiude prima che questo accada, CRIT-05 resta aperta, non forzata.
- [ ] LLM-VAL-01 e ADV-OPS-01 non partono senza la rispettiva decisione di spesa del PO — dipendenze
      esterne dichiarate, non presunte.
- [ ] Le 5 storie dirette (CHORE-01, OPS-02, OPS-03r, ADV-OPS-01, OBS-OPS-01) tracciate con la stessa
      disciplina delle altre, anche se non passano da un agente.

---

## 2. Grafo delle dipendenze

```
CI-01 ──┐
CHORE-01┤
DEBT-02 ┤
DEBT-03 ┤
DEBT-04 ┤
DEBT-05 ┤
DEBT-06 ┼──► (nessuna dipendenza dura tra loro — parallelizzabili per owner)
LLM-PRICE-01 ┤
LLM-02/03 ──► LLM-04   (LLM-04 presuppone l'astrazione provider già in uso)
OPS-02 ──┤
OPS-03r ─┤
OBS-OPS-01 ┘

ADV-OPS-01 ──► (prerequisito tecnico per Epic D/E, non per nulla in questo sprint — farla presto
                 comunque, per non bloccare il refinement del prossimo sprint)

LLM-VAL-01 ──► richiede chiave reale via Infisical (decisione PO, esterna)

Demo Jordan (in corso) ──► CRIT-05 (secondo campione necessario prima di iniziare)
```

---

## 3. Dipendenze esterne

| Dipendenza | Task | Natura |
|:---|:---|:---|
| Accesso VPS reale (SSH) | OPS-02, OPS-03r, OBS-OPS-01 | Eseguito da Claude direttamente in questa sessione, non da un subagent |
| Decisione di spesa reale | ADV-OPS-01 | Il PO deve autorizzare `AGENTS_ENABLED=true` con chiave reale sull'ambiente di test |
| Chiave DeepSeek/OpenRouter reale | LLM-VAL-01 | Da provisionare via Infisical, decisione del PO su quale provider |
| Servizio di uptime esterno (account) | OPS-03r | Decisione minima del PO (quale servizio) |
| Secondo campione equity dalla demo | CRIT-05 | Prodotto naturalmente dalla demo di Jordan in corso, non una dipendenza da procurarsi |

---

## 4. Risk register di sprint

| # | Rischio | Prob. | Impatto | Mitigazione |
|:--|:---|:---:|:---:|:---|
| R1 | CRIT-05 implementato prima che il secondo campione sia davvero verificato, sulla sola fretta di chiudere lo sprint | Media | Alto | Vincolo esplicito in DoD (§1) e nella storia stessa (§0.14) — nessuna eccezione per pressione di tempo |
| R2 | CI-01 in `block` introduce un falso positivo su un endpoint legittimo non ancora osservato nei run di audit | Bassa | Medio | Verifica esplicita di un run reale in `block` prima di chiudere, non solo la configurazione |
| R3 | LLM-02 introduce una regressione sottile sul comportamento dell'Analyst con Anthropic, mascherata da "l'astrazione funziona" | Media | Alto | Criterio esplicito "zero regressioni sui test esistenti", non solo "i nuovi test passano" |
| R4 | ADV-OPS-01/LLM-VAL-01 restano bloccate per settimane in attesa di una decisione di spesa del PO, rallentando indirettamente Epic D/E | Media | Basso ora | Segnalate come dipendenza esterna esplicita, non nascoste dentro lo sprint come se fossero pronte a partire |
| R5 | DEBT-03 (card EXECUTION STATUS) rimuove la card invece di alimentarla con dati reali, perdendo informazione utile in cockpit | Bassa | Basso | Criterio di accettazione lascia esplicitamente aperta la scelta "alimentare o rimuovere", decisione di Maya motivata, non un default silenzioso |

---

*Planning tenuto il 12 agosto 2026, in parallelo alla demo operativa isolata di Jordan (in corso).
Nessuna storia di questo sprint tocca l'istanza demo (porta 8091) né richiede di fermarla. Prossimo
passo: avvio dell'esecuzione, con lo stesso meccanismo di autonomia (`docs/KB/BACKLOG/release2/sprint2-status/`)
già usato per Sprint 1 — su richiesta separata del PO.*
