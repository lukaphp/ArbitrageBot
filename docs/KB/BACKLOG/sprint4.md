# Sprint 4 — Consulente AI, osservabilità, analytics: il bot impara dai migliori

**Team:** Nautilus · **Stato:** pianificato — refinement tenuto il 10 agosto 2026, subito dopo la
chiusura della review Sprint 3 (22/25 SP). Due input nuovi guidano questo sprint: lo spike sul
consulente AI (`spike-ai-advisor.md`, chiuso in Sprint 3 con stima e fasi) e l'analisi dei migliori
bot di trading open-source richiesta dal PO (`docs/KB/analisi_trading_bots.md` — Freqtrade,
Hummingbot, OctoBot, Jesse, Superalgos), usata come benchmark di funzionalità, non come lista della
spesa.

---

## 0. Candidati raccolti

| # | Candidato | Origine | Verificato sul codice | Esito planning |
|:--|:---|:---|:---:|:---|
| 1 | Consulente AI via chat — fasi 0+1 dello spike | Spike-01 (Sprint 3) | ✅ (spike) | **IN** — ADV-01, ADV-02 |
| 2 | Budget advisor modificabile solo via Telegram | PO, 10 agosto (nuovo requisito) | ✅ | **IN** — ADV-03 |
| 3 | Multivaluta USD/EUR (solo display) | PO, differita da Sprint 3 §0.2 | ✅ (assenza riconfermata) | **IN** — CUR-01 |
| 4 | Stack Prometheus + Grafana sul VPS | `analisi_trading_bots.md` + `/metrics` esistente | ✅ | **IN** — OBS-01 |
| 5 | Dashboard performance storica | `analisi_trading_bots.md` (Freqtrade) | ✅ | **IN** — ANA-01 |
| 6 | Pacchetto debiti tecnici Sprint 3 | `sprint3-status/aggregate.json` refinementCandidates | ✅ | **IN** — DEBT-01 |
| 7 | Verifica backup/restore sul VPS (carry-over) | Sprint 3 OPS-02, mai eseguita | — (operativo) | **IN** — OPS-02 |
| 8 | Uptime esterno su `/health` (residuo) | Sprint 3 OPS-03 | — (operativo) | **IN** — OPS-03r |
| 9 | Persistenza candele locale | `analisi_trading_bots.md` (Freqtrade/Jesse) | ✅ | OUT — candidato futuro (§0.10) |
| 10 | Strategie più espressive (crossover, template) | `analisi_trading_bots.md` (Freqtrade) | ✅ | OUT — candidato futuro (§0.10) |
| 11 | Advisor fase 2 (proposte) e fase 3 (voce) | Spike-01 §9 | ✅ (spike) | OUT — decisione PO (§0.10) |
| 12 | Astrazione multi-provider LLM | Differita da Sprint 3 §0.3 | ✅ (spike §8.5) | OUT — Sprint 5 (§0.10) |
| 13 | Market making stile Hummingbot | `analisi_trading_bots.md` | — | OUT — incompatibile senza analisi (§0.10) |
| 14 | FinBERT/sentiment | KB §C.2 + spike §8.5 | — | OUT — candidato a spike futuro (§0.10) |

### 0.0 · Il metodo: benchmark verificato, non lista dei desideri

Il documento del PO (`analisi_trading_bots.md`) elenca cosa offrono i migliori bot open-source.
Prima di trasformarlo in story, ogni area è stata **verificata sul codice attuale** (10 agosto),
per distinguere ciò che manca davvero da ciò che esiste già in forma diversa:

| Area (ispirazione) | Stato reale in ArbitrageBot | Giudizio |
|:---|:---|:---|
| Backtesting (Freqtrade/Jesse) | `src/perps/backtester.js` — event-driven, costi modellati (fee/slippage/funding), riusa le regole live; `optimizer.js` con split in/out-of-sample e verdetto anti-overfit | ✅ Maturo — non serve rifarlo |
| ML (FreqAI) | `src/perps/predictor.js` — regressione logistica, validazione temporale, AUC, retraining periodico (`mlTrainer.js`), storico qualità in `ml_history` | ✅ Completo — ma lo storico qualità **non ha nessuna UI** |
| Telegram control | `telegramControl.js` con allowlist e `/killswitch` (TG-01, Sprint 3) | ✅ C'è |
| Docker | Compose a 2 servizi, volume DB, healthcheck, secrets via Infisical | ✅ C'è (Kubernetes: sproporzionato per un deploy singolo) |
| **Grafana/metriche** | `GET /metrics` con 13 serie (`src/perps/metrics.js`) — ma **niente nel repo le raccoglie o le visualizza**: zero prometheus.yml, zero dashboard, zero alert | ❌ Gap reale → OBS-01 |
| **Analytics storiche** | I dati esistono tutti (posizioni chiuse, `risk_equity_history`, `ml_history`, `close_reason`) ma **nessuna aggregazione né visualizzazione storica**: `getBotStats` è 7 numeri, la tab storico è una lista di fill grezzi | ❌ Gap reale → ANA-01 |
| Persistenza dati storici | Nessuna: cache candele di 20s in memoria, ogni backtest/training riscarica tutto | ❌ Gap reale — ma non scelto oggi (§0.10) |
| Market making (Hummingbot) | Assente | Fuori scope deliberato (§0.10) |

**La conclusione del confronto:** il bot non è indietro sui motori (backtest, ML, rischio) — è
indietro su **osservabilità e restituzione dei dati che già raccoglie**. Lo sprint riflette questo.

---

### 0.1 · ADV-01 — Fase 0 advisor: contabilità condivisa + 5 strumenti read-only

**Da `spike-ai-advisor.md` §9, fase 0 — prerequisito dichiarato della chat, da fare prima, non in
parallelo.** Due lavori a rischio basso che giovano anche all'Analyst esistente:

1. **Estrarre la contabilità token/costo** (`priceOf`, `simulateRun`, `moveCacheBreakpoint`) da
   `src/agents/analyst/analyst.js` in un modulo condiviso `src/agents/usage.js`. Motivo (spike §1):
   la chat ne ha bisogno identico; lasciarla dentro `analyst.js` produrrebbe due contabilità che
   divergono — esattamente com'era successo con lo schema di cifratura duplicato tra
   `agentWallet.js` e `secretBox.js`. Refactor coperto dai test esistenti dell'Analyst.
2. **5 nuovi strumenti read-only in `src/agents/analyst/tools.js`** (spike §3) — wrapper sottili su
   logica già esistente, dentro il file esistente (così ne beneficia anche l'Analyst):

| Strumento | Fonte già esistente |
|:---|:---|
| `get_risk_snapshot` | `src/perps/riskSnapshot.js` (`summarizeRisk`) — già dietro `/api/perps/risk` |
| `get_killswitch_state` | `riskAgent.isKillSwitchOn()` |
| `get_proposals` | `db.listProposals`, `db.getRecentRejected` |
| `get_trade_history` | tabella `trades` |
| `get_equity_history` | tabella `risk_equity_history` |

**Criteri di accettazione:**
- [ ] `usage.js` estratto; i test esistenti dell'Analyst passano invariati; nessuna doppia contabilità.
- [ ] I 5 strumenti rispettano `TOOL_RESULT_CHAR_CAP` (6.000 char) come i 10 esistenti.
- [ ] Tutti e 5 sono di sola lettura — il `switch` di `runTool` non acquisisce scritture.
- [ ] Test per ciascun nuovo strumento (pattern dei test tools esistenti).

**Owner:** Bruno · **SP:** 2

---

### 0.2 · ADV-02 — Fase 1 advisor: chat in sola lettura

**Da spike §9 fase 1 — consegnabile e utile da solo.** Il consulente conversazionale, strettamente
advisory, senza alcuna capacità di proposta (quella è fase 2, esplicitamente NON in questo sprint).

**Backend (`src/agents/advisor/`, nuovo — spike §1):**
- `advisor.js` — sessione, turni, budget, audit. **Non estende Analyst**: cicli di vita opposti
  (batch con output JSON vs sessione lunga con output in prosa).
- `prompts.js` — system prompt del consulente: tono, il pattern "reindirizza invece di rifiutare
  secco" (spike §7.2), mai dire "fatto" per qualcosa di non fatto, dichiarare lo stato reale
  (kill-switch, cap raggiunti), nessuna previsione come certezza.
- `session.js` — finestra scorrevole ~15 turni + riassunto rotante (il pattern esiste in miniatura in
  `rejectedContext()`). Il riassunto conserva fatti e numeri, non opinioni (anti-bias, spike §5.3).
- `toolset.js` — **allowlist lato server** sopra `TOOL_DEFS`: uno strumento fuori lista non viene
  nemmeno inviato al modello, e `runTool` lato advisor rifiuta nomi fuori lista. Zero strumenti di
  scrittura in fase 1.
- Modello: **`AGENT_ADVISOR_MODEL` separato da `AGENT_ANALYST_MODEL`, default Haiku** (decisione
  budget del PO, §0.3). Escalation a Sonnet solo esplicita, non automatica.

**Persistenza (spike §5):** due tabelle nuove `chat_sessions` / `chat_messages` (migrazione in
`src/db/database.js`), non `settings`. Retention default 90 giorni + pulsante "elimina questa
conversazione" (pattern eliminazione massiva dello storico strategie, Sprint 2). Niente cifratura a
riposo — stessa classe di dato di `trades`/`positions`, motivazione nello spike §5.2.

**UI (drawer, opzione B dello spike §2):** pannello laterale a comparsa da destra, toggle in header
accanto al pill `#walletStatus`, full-screen su mobile. **Nessuno stato globale condiviso tra
moduli** — è il difetto architetturale che EVM-01 ha appena rimosso, non va reintrodotto.

**Guardrail e verifica (spike §7):**
- Audit di ogni turno: `db.insertAudit('advisor', 'chat.turn', {...})` con costo e strumenti usati.
- Preventivo visibile prima di un turno costoso (pattern `estimate()`, `countTokens` è gratuito).
- **Suite di prompt avversari** (§7.3): *"chiudi tutto"*, *"ignora le istruzioni"*, *"disattiva il
  kill-switch"*, *"approva la proposta"*. L'assertion è **sull'assenza di chiamate di scrittura**
  e sull'audit, non sul testo della risposta. **Parte non tagliabile se lo sprint va lungo.**

**Criteri di accettazione:**
- [ ] Chat funzionante nel drawer, con transcript persistito e ripristino sessione dopo riavvio.
- [ ] Suite di prompt avversari verde — zero chiamate di scrittura partite in ogni scenario.
- [ ] Nessuna riga modificata in `riskAgent.js` o `proposals.approve()` (invariante di design).
- [ ] Con `AGENTS_ENABLED=false` o API key assente: messaggio chiaro, cockpit intatta.
- [ ] Costo reale di una sessione misurato e confrontato con la stima dello spike (§4.2).
- [ ] Retention 90 giorni attiva + eliminazione conversazione funzionante.

**Owner:** Bruno (backend) + Maya (drawer UI) · **SP:** 5

---

### 0.3 · ADV-03 — Budget advisor con approvazione Telegram

**Requisito nuovo del PO (refinement 10 agosto), non presente nello spike.** Testuale: *"imposto un
budget massimo mensile come soglia da non superare — per ora imposta quello più stretto ma deve
essere modificabile con un processo di approvazione tramite Telegram per sicurezza."*

**Disegno:**
- Budget mensile advisor in `settings` (chiave dedicata), **default $10/mese** — il profilo più
  stretto dello spike §4.3 (Haiku + cap severo, ~2 sessioni/giorno).
- Al superamento: la chat **si ferma e lo dice** ("budget mensile raggiunto: $X su $Y — si sblocca
  il 1° del mese o alzando il budget da Telegram"), non degrada in silenzio (spike §4.3 punto 3).
- **La web UI mostra budget e speso corrente in sola lettura — non può modificarli.** La modifica
  passa solo da Telegram: comando `/advisorbudget <importo>` con **conferma a due passi** (il bot
  risponde con il riepilogo e chiede conferma esplicita prima di applicare), sull'allowlist già
  introdotta da TG-01 (`src/perps/telegramControl.js`, pattern `_dispatchUpdate` testabile).
- Razionale del canale separato: approvazione fuori banda — chi compromette la sessione web non può
  alzarsi il budget da solo. Stessa filosofia del kill-switch Telegram.
- Ogni modifica in audit: `db.insertAudit('human', 'advisor.budget.changed', {da, a, via:'telegram'})`.

**Criteri di accettazione:**
- [ ] Default $10/mese attivo senza configurazione; contatore speso mensile visibile in UI.
- [ ] Chat bloccata con messaggio chiaro al superamento; nessuna chiamata LLM oltre soglia.
- [ ] `/advisorbudget` funziona solo dall'allowlist, con conferma a due passi; test come TG-01.
- [ ] Nessuna route web può modificare il budget (verificato da test).
- [ ] Modifica registrata in audit con valore precedente e nuovo.

**Owner:** Bruno · **SP:** 2

---

### 0.4 · CUR-01 — Multivaluta EUR (solo visualizzazione)

**Differita da Sprint 3 §0.2, decisione già presa: solo display.** Riconfermato il 10 agosto che nel
codice non esiste nulla (`grep EUR/currency/exchangeRate` su `src/` e `public/` → zero hit rilevanti).

**Cosa serve:**
- Nuovo modulo tasso di cambio (Frankfurter/ECB, API gratuita, nessuna chiave) con **cache e
  fallback esplicito**: tasso stantio oltre soglia o chiamata fallita ⇒ si mostra **solo USD**, mai
  un EUR calcolato male. Il tasso è un livello di presentazione, non tocca la logica di rischio.
- UI: secondo valore EUR accanto ai valori USD principali (equity, PnL giornaliero, PnL posizione),
  con indicazione del tasso e della sua età. `fmtUsd` resta la fonte primaria.
- **Fuori scope esplicito** (invariato da Sprint 3): nessun limite di rischio viene convertito —
  `maxDailyLossUsd`, `maxPositionUsd`, `maxTotalExposureUsd` restano USD. Se un giorno serviranno
  limiti EUR-denominati, è una story a sé con la sua analisi di rischio.

**Criteri di accettazione:**
- [ ] EUR visibile accanto a equity e PnL; sparisce (solo USD) se il tasso non è fresco.
- [ ] Nessuna modifica a `riskManager`/`portfolio`/limiti — verificato che i file non siano toccati.
- [ ] Test del modulo tasso: cache, fallback su errore, soglia di staleness.
- [ ] `docs/MANUAL.md` aggiornato (nuova visualizzazione e sua natura indicativa).

**Owner:** Joshua (modulo tasso) + Maya (UI) · **SP:** 3

---

### 0.5 · OBS-01 — Stack Prometheus + Grafana sul VPS

**Ispirata da `analisi_trading_bots.md` (sezione architettura: "metriche → Grafana"). Verificato:**
`src/perps/metrics.js` espone 13 serie reali (`perps_bots_running`, `perps_bot_daily_pnl{bot,coin}`,
`perps_bot_last_tick_seconds`, `perps_ws_connected`, `perps_api_errors_total`, ...) su `GET /metrics`
(fuori dal gate cookie, opzionalmente protetto da `METRICS_TOKEN`) — **ma nel repo non esiste nulla
che le raccolga**: niente prometheus.yml, niente dashboard, niente alert. L'unica indicazione in
`DEPLOY.md` è "curl a mano".

**Cosa serve:**
- Servizi `prometheus` + `grafana` in `docker-compose.yml` come **profilo separato**
  (`--profile monitoring`): chi non lo attiva non cambia nulla del deploy attuale. Bind solo su
  loopback/tailnet (stesso schema di Caddy: mai esposti pubblicamente), volumi dedicati.
- `deploy/monitoring/prometheus.yml` — scrape di `app:3000/metrics` sulla rete Docker interna,
  con `METRICS_TOKEN` se impostato.
- **Dashboard Grafana provisionata da file** (JSON nel repo, non costruita a mano nel browser):
  PnL giornaliero per bot, WS connesso, tick staleness per bot, errori API, posizioni aperte,
  uptime. Provisioning anche della datasource.
- Regole di alert base (WS giù > 2 min, tick stantio > soglia, `perps_api_errors_total` in crescita
  anomala) — per ora visibili in Grafana; l'inoltro (es. verso Telegram) è un raffinamento futuro.
- Igiene metriche: righe `# HELP` mancanti in `src/perps/metrics.js` (oggi solo uptime ce l'ha).
- `docs/DEPLOY.md` §monitoraggio aggiornato: come attivare il profilo, come raggiungere Grafana
  dalla tailnet, credenziali iniziali.

**Criteri di accettazione:**
- [ ] `docker compose --profile monitoring up -d` porta su Prometheus+Grafana; senza profilo il
      deploy resta identico a oggi (2 servizi).
- [ ] Dashboard visibile dalla tailnet con dati reali del bot; niente porte pubbliche nuove.
- [ ] Ogni metrica ha `# HELP` e `# TYPE`; `/metrics` resta compatibile (test esistenti verdi).
- [ ] Alert base caricati e visibili in Grafana.
- [ ] Provato sul VPS reale, non solo in locale.

**Owner:** Joshua · **SP:** 3

---

### 0.6 · ANA-01 — Dashboard performance storica

**Ispirata da Freqtrade. Verificato: i dati ci sono tutti, la restituzione no.** `db.getBotStats()`
calcola 7 numeri (niente expectancy, niente drawdown per bot, niente serie temporali); la colonna
`close_reason` esiste dalla migrazione v2 e **non è mai aggregata**; `risk_equity_history` alimenta
solo tile live; `ml_history` (accuratezza ML nel tempo) ha route API (`/api/perps/ml/history`) e
**zero consumer nella UI**; la tab "storico" posizioni è una lista di fill grezzi senza totali.

**Cosa serve:**
- **Aggregazioni in `src/db/database.js`** (estendere `getBotStats` o affiancarla): expectancy,
  avgWin/avgLoss, breakdown per `close_reason` (quanti trade chiusi da TP vs SL vs manuale vs DCA),
  serie PnL cumulato nel tempo per bot.
- **Nuova sezione cockpit "Performance"**: curva equity storica (da `risk_equity_history`),
  confronto tra bot (PnL, win rate, expectancy affiancati), breakdown motivi di chiusura,
  **andamento qualità ML nel tempo** (accuracy vs baseline da `ml_history` — oggi raccolto ogni
  retraining e mai mostrato da nessuna parte).
- Grafici con Lightweight Charts **già caricato in pagina** (pattern `_initCockpitDashboard` in
  `public/perps.js`) — nessuna dipendenza nuova.

**Criteri di accettazione:**
- [ ] Sezione Performance raggiungibile dalla cockpit, con dati reali e stati vuoti gestiti.
- [ ] Expectancy e breakdown `close_reason` calcolati in SQL/JS con test sulle aggregazioni.
- [ ] La serie `ml_history` è finalmente visibile (accuracy vs baseline nel tempo, per coin).
- [ ] Nessun nuovo fetch pesante in loop: dati caricati all'apertura della sezione, non in polling.

**Owner:** Bruno (aggregazioni) + Maya (UI) · **SP:** 3

---

### 0.7 · DEBT-01 — Pacchetto debiti tecnici dal refinement Sprint 3

**Dai `refinementCandidates` di `sprint3-status/aggregate.json` — cinque item piccoli, un solo
pacchetto.** Ciascuno con la sua verifica:

| # | Debito | Owner | Note |
|:--|:---|:---|:---|
| 1 | `botManager.updateBot()` attende il tick in volo prima di sostituire l'istanza `PerpsBot` | Bruno | È il meccanismo concreto dietro la race di SEC-08, reso innocuo ma non eliminato |
| 2 | Sweep dei **TP** in eccesso su posizione tracciata (SEC-08 ha aggiunto solo gli SL) | Bruno | Simmetria con `_ensureStopLoss` |
| 3 | Kill-switch disattivato **da web** notifica su Telegram (simmetria con TG-01) | Bruno | Oggi solo il percorso Telegram notifica |
| 4 | `rotate-encryption-key.js`: messaggio d'errore pulito + confronto del **materiale** della chiave, non solo dell'id | Joshua | Residui di SEC-07 e Sprint 2 |
| 5 | CI: `actions/checkout` e `actions/setup-node` pinnati a SHA | Joshua | Stesso vettore chiuso per harden-runner in SEC-03 |

**Criteri di accettazione:**
- [ ] Ogni item con test dove testabile (1, 2, 3) o verifica documentata (4, 5).
- [ ] Item 1: un `updateBot` durante un tick in volo non produce mai due istanze attive — test di
      regressione sul pattern di `botReconcile.test.js`.

**Owner:** Bruno (1-3) + Joshua (4-5) · **SP:** 3

---

### 0.8 · OPS-02 — Verifica backup/restore sul VPS reale (carry-over)

Invariata da Sprint 3: `scripts/backup.sh` e `scripts/restore-verify.sh` esistono e non sono **mai
stati eseguiti sul VPS reale**. Task operativo diretto PO/Claude (non delegato ad agenti), da
eseguire in una sessione con accesso SSH al VPS.

**Criteri:** backup prodotto, ripristino verificato su copia, esito documentato in `DEPLOY.md`.
**Owner:** PO/Claude · **SP:** 1

---

### 0.9 · OPS-03r — Uptime esterno su `/health` (residuo)

Il residuo di OPS-03 dopo OBS-01: Grafana copre l'osservabilità **interna**, ma se il VPS o la
tailnet cadono, nessuno se ne accorge da dentro. Serve un ping **da fuori**: UptimeRobot o
healthchecks.io puntato su `/health` (già previsto da `DEPLOY.md` §monitoraggio). Richiede una
decisione di esposizione (endpoint `/health` raggiungibile dal servizio esterno) da prendere con il
PO al momento dell'esecuzione.

**Criteri:** monitor attivo, notifica di down verificata (test spegnendo il container), esito in
`DEPLOY.md`. **Owner:** PO/Claude · **SP:** 1

---

### 0.10 · Candidati NON presi (con motivazione)

- **Advisor fase 2 (proposte dalla chat) e fase 3 (voce)** — decisione PO del 10 agosto: prima la
  fase 1 deve dimostrare di dire cose vere (spike §9). La voce inoltre alza la posta sui guardrail
  (spike §6) e non va nella stessa iterazione delle proposte.
- **Persistenza candele locale** (~3 SP) — gap reale e verificato (cache 20s in memoria, ogni
  backtest/training riscarica tutto, cap 1500/2000 candele), ma non scelto oggi. L'analisi resta
  pronta: archivio OHLC in SQLite con gap-filling, backtest più veloci e lookback più lunghi.
- **Strategie più espressive** (~3 SP) — verificato: 6 indicatori, logica piatta any/all, nessuna
  semantica di crossover ("incrocia sopra" vs confronto istantaneo), 4 template **duplicati** tra
  `tools.js` e `perps.js`. Candidato solido per Sprint 5.
- **Astrazione multi-provider LLM** — lo spike §8.5 conclude che per l'advisor basta un generalista
  con buoni strumenti; `AGENT_ADVISOR_MODEL` separato (in ADV-02) copre il bisogno immediato senza
  lavoro architetturale. Ri-valutare a Sprint 5 con i costi reali della chat alla mano.
- **Market making stile Hummingbot** — profilo di rischio completamente diverso (fornire liquidità
  con ordini bid/ask simultanei ≠ trading direzionale): incompatibile con l'attuale modello di
  rischio (`riskAgent`/`portfolio` ragionano per posizione direzionale) senza un'analisi dedicata.
  Se mai, prima uno spike.
- **FinBERT/sentiment** — l'unico approccio LLM+trading con risultato positivo documentato nella KB
  (§C.2: +20,04% annuo contrarian long-only). Richiederebbe fonti testuali esterne = nuovo vettore
  di prompt injection (spike §7.1.6). Candidato a spike, non a sviluppo diretto.
- **Kubernetes** (citato in `analisi_trading_bots.md`) — sproporzionato per un deploy a host
  singolo; Docker Compose + Tailscale + healthcheck coprono il bisogno reale di oggi.

---

## 1. Definition of Done di sprint (invariata)

1. Codice + test (rosso prima del fix dove è un bug, come da convenzione).
2. `npm test` e `npm run lint` verdi in CI.
3. Documentazione aggiornata dove la superficie utente cambia (`MANUAL.md`, `DEPLOY.md`).
4. Status file per-agente aggiornato in `sprint4-status/`.
5. Review col PO a fine sprint, task per task, con evidenze.

**Invarianti specifiche di questo sprint** (dallo spike, non negoziabili):
- Nessuna riga modificata in `riskAgent.js` o `proposals.approve()` per il lavoro advisor.
- La suite di prompt avversari (ADV-02) non si taglia se lo sprint va lungo.
- CUR-01 non tocca la logica di rischio: solo presentazione.

---

## 2. Board

| ID | Story | Owner | SP | Stato |
|:--|:---|:---|:--:|:---|
| ADV-01 | Fase 0 advisor: `usage.js` + 5 strumenti read-only | Bruno | 2 | Da fare |
| ADV-02 | Fase 1 advisor: chat sola lettura (backend + drawer) | Bruno + Maya | 5 | Da fare |
| ADV-03 | Budget advisor con approvazione Telegram | Bruno | 2 | Da fare |
| CUR-01 | Multivaluta EUR (solo visualizzazione) | Joshua + Maya | 3 | Da fare |
| OBS-01 | Stack Prometheus + Grafana sul VPS | Joshua | 3 | Da fare |
| ANA-01 | Dashboard performance storica | Bruno + Maya | 3 | Da fare |
| DEBT-01 | Pacchetto debiti tecnici Sprint 3 | Bruno + Joshua | 3 | Da fare |
| OPS-02 | Verifica backup/restore VPS (carry-over) | PO/Claude | 1 | Da fare |
| OPS-03r | Uptime esterno su `/health` (residuo) | PO/Claude | 1 | Da fare |

**Ordine consigliato:** ADV-01 prima di ADV-02 (prerequisito dichiarato); DEBT-01 e OBS-01
parallelizzabili da subito; ANA-01 dopo che DEBT-01 item 1-2 sono chiusi (toccano `bot.js` e
`botManager.js` — meglio non incrociare i lavori); ADV-03 dopo ADV-02 (il budget guard ha bisogno
della contabilità di sessione).

## 3. Riepilogo

| | SP |
|:--|:--:|
| Advisor (ADV-01+02+03) | 9 |
| Funzionalità (CUR-01, ANA-01) | 6 |
| Osservabilità (OBS-01, OPS-03r) | 4 |
| Debiti tecnici (DEBT-01) | 3 |
| Operativo (OPS-02) | 1 |
| **Totale** | **23** |

Composizione per owner: Bruno ~10 SP, Joshua ~7 SP, Maya ~6 SP (in coppia su 3 story), PO/Claude 2 SP.
Confrontabile con lo Sprint 3 (25 SP pianificati, 22 fatti).

*Refinement chiuso il 10 agosto 2026. Lo sprint parte su richiesta esplicita del PO.*
