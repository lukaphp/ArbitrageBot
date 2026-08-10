# Sprint 4 — Consulente AI, osservabilità, analytics: il bot impara dai migliori

**Team:** Nautilus · **Stato:** review chiusa, 28/28 SP approvati (10 agosto 2026) — refinement tenuto il 10 agosto 2026, subito dopo la
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
| 9 | Persistenza candele locale | `analisi_trading_bots.md` (Freqtrade/Jesse) | ✅ | OUT — candidato futuro (§0.11) |
| 10 | Strategie più espressive (crossover, template) | `analisi_trading_bots.md` (Freqtrade) | ✅ | OUT — candidato futuro (§0.11) |
| 11 | Advisor fase 2 (proposte) e fase 3 (voce) | Spike-01 §9 | ✅ (spike) | OUT — decisione PO (§0.11) |
| 12 | Astrazione multi-provider LLM (DeepSeek + valutazione OpenRouter) | PO, 10 agosto, durante la review — richiesta esplicita di riportarla dentro come **stretch** | ✅ (spike §8.5 + verifica diretta su client.js/advisor.js) | **IN, stretch** — LLM-01 (§0.10) |
| 13 | Market making stile Hummingbot | `analisi_trading_bots.md` | — | OUT — incompatibile senza analisi (§0.11) |
| 14 | FinBERT/sentiment | KB §C.2 + spike §8.5 | — | OUT — candidato a spike futuro (§0.11) |

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
| Persistenza dati storici | Nessuna: cache candele di 20s in memoria, ogni backtest/training riscarica tutto | ❌ Gap reale — ma non scelto oggi (§0.11) |
| Market making (Hummingbot) | Assente | Fuori scope deliberato (§0.11) |

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
- [x] `usage.js` estratto; i test esistenti dell'Analyst passano invariati; nessuna doppia contabilità.
- [x] I 5 strumenti rispettano `TOOL_RESULT_CHAR_CAP` (6.000 char) come i 10 esistenti.
- [x] Tutti e 5 sono di sola lettura — il `switch` di `runTool` non acquisisce scritture.
- [x] Test per ciascun nuovo strumento (pattern dei test tools esistenti).

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
- [x] Chat funzionante nel drawer, con transcript persistito e ripristino sessione dopo riavvio.
- [x] Suite di prompt avversari verde — zero chiamate di scrittura partite in ogni scenario.
- [x] Nessuna riga modificata in `riskAgent.js` o `proposals.approve()` (invariante di design).
- [x] Con `AGENTS_ENABLED=false` o API key assente: messaggio chiaro, cockpit intatta.
- [ ] Costo reale di una sessione misurato e confrontato con la stima dello spike (§4.2).
- [x] Retention 90 giorni attiva + eliminazione conversazione funzionante.

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
- [x] Default $10/mese attivo senza configurazione; contatore speso mensile visibile in UI.
- [x] Chat bloccata con messaggio chiaro al superamento; nessuna chiamata LLM oltre soglia.
- [x] `/advisorbudget` funziona solo dall'allowlist, con conferma a due passi; test come TG-01.
- [x] Nessuna route web può modificare il budget (verificato da test).
- [x] Modifica registrata in audit con valore precedente e nuovo.

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
- [x] EUR visibile accanto a equity e PnL; sparisce (solo USD) se il tasso non è fresco.
- [x] Nessuna modifica a `riskManager`/`portfolio`/limiti — verificato che i file non siano toccati.
- [x] Test del modulo tasso: cache, fallback su errore, soglia di staleness.
- [x] `docs/MANUAL.md` aggiornato (nuova visualizzazione e sua natura indicativa).

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
- [x] `docker compose --profile monitoring up -d` porta su Prometheus+Grafana; senza profilo il
      deploy resta identico a oggi (2 servizi).
- [x] Dashboard visibile dalla tailnet con dati reali del bot; niente porte pubbliche nuove.
- [x] Ogni metrica ha `# HELP` e `# TYPE`; `/metrics` resta compatibile (test esistenti verdi).
- [x] Alert base caricati e visibili in Grafana.
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
- [x] Sezione Performance raggiungibile dalla cockpit, con dati reali e stati vuoti gestiti.
- [x] Expectancy e breakdown `close_reason` calcolati in SQL/JS con test sulle aggregazioni.
- [x] La serie `ml_history` è finalmente visibile (accuracy vs baseline nel tempo, per coin).
- [x] Nessun nuovo fetch pesante in loop: dati caricati all'apertura della sezione, non in polling.

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
- [x] Ogni item con test dove testabile (1, 2, 3) o verifica documentata (4, 5).
- [x] Item 1: un `updateBot` durante un tick in volo non produce mai due istanze attive — test di
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

### 0.10 · LLM-01 — Astrazione multi-provider (DeepSeek + valutazione OpenRouter) — **stretch**

**Riportata dentro lo sprint su richiesta esplicita del PO durante la review**, come attività
*stretch* (extra, a bassa priorità — non fa slittare le altre 9 storie se non entra tutta). Lo spike
originale (§8.5) l'aveva rimandata perché "per l'advisor basta un generalista con buoni strumenti":
resta vero, ma qui l'obiettivo cambia — non è più "serve un modello migliore", è "**non dipendere da
un solo fornitore** e poter scegliere un modello più economico dove ha senso".

**Verificato sul codice, non ipotizzato.** `src/agents/analyst/client.js` è un wrapper di 16 righe
che istanzia pigramente l'SDK Anthropic; sia `analyst.js` che il nuovo `advisor.js` (ADV-01/02)
chiamano `anthropic.messages.create(...)` **nel formato nativo Anthropic**: blocchi di sistema con
`cache_control: { type: 'ephemeral' }` (i breakpoint di cache mobili su cui si regge tutta
l'ottimizzazione di costo di COST-01/ADV-01), risposte lette per `stop_reason === 'tool_use'` e
blocchi `type: 'tool_use'`/`tool_result'`. Non è un dettaglio implementativo isolabile: **collegare
un secondo fornitore richiede un adattatore vero**, non un cambio di URL.

#### La domanda del PO: DeepSeek diretto, o anche OpenRouter — motivazione della scelta

**DeepSeek** espone un'API compatibile con il formato OpenAI (chat completions, `tools`/`tool_calls`
in quel dialetto — diverso da quello Anthropic). Un adattatore diretto è scrivibile, ma è comunque un
adattatore **per singolo fornitore**: se domani si volesse anche Gemini, Groq o un modello Llama
locale, se ne scriverebbe un altro, e un altro ancora — esattamente il lavoro che sprint3.md §0.3
punto 2 descriveva come "richiede disegnare l'interfaccia comune... poi collegare candidati concreti
(Gemini, Groq, DeepSeek, locali)".

**OpenRouter** espone anch'esso il formato compatibile OpenAI, ma come **gateway verso decine di
modelli** (incluso DeepSeek stesso, `deepseek/deepseek-chat` e `deepseek/deepseek-r1`) dietro un'unica
chiave e un'unica forma di chiamata — il modello si sceglie cambiando una stringa, non scrivendo
codice nuovo.

**La mia raccomandazione, e perché:** costruire **un solo adattatore "compatibile OpenAI"**,
parametrizzato su `baseURL` + chiave — lo stesso identico codice funziona puntato su
`api.deepseek.com` (DeepSeek diretto) **o** su `openrouter.ai/api/v1` (OpenRouter). Non è una scelta
tra le due: è un disegno che le rende entrambe una riga di configurazione, non due percorsi di
codice. La configurazione decide quale usare, story per story o anche in produzione col cambio di
una variabile d'ambiente:

| | DeepSeek diretto | Via OpenRouter |
|:---|:---|:---|
| **Pro** | Nessun intermediario in più nella catena di fiducia; verosimilmente il prezzo più basso possibile per quel modello | Un solo punto di integrazione per *molti* modelli (Gemini, Llama, Grok, Qwen, lo stesso Claude); aggiungere un modello futuro è un cambio di stringa, non codice nuovo |
| **Contro** | Un adattatore per fornitore: il lavoro si ripete a ogni modello nuovo | Un fornitore terzo in più nella catena di disponibilità e fiducia — se OpenRouter ha un disservizio, **tutti** i modelli non-Anthropic instradati lì diventano irraggiungibili insieme, non uno alla volta; margine/prezzo non sempre trasparente, da verificare al momento dell'attivazione, non assunto qui |
| **Rischio condiviso da entrambi** | L'affidabilità del *tool-calling* varia per modello (non è una proprietà del solo trasporto): con l'architettura di questo progetto, dove ogni scrittura passa da una chiamata di strumento rigorosamente controllata (ADV-02, `toolset.js`), un modello che non rispetta bene il formato di function-calling è un rischio di correttezza, non solo di qualità delle risposte. **Prima di fidarsi di un modello nuovo con l'accesso agli strumenti, va fatto passare per intero dalla suite avversaria appena costruita in ADV-02** (`test/advisorGuardrails.test.js`) — è già lì, è già il test giusto, va solo rieseguito contro il nuovo adattatore. |

**Decisione:** costruire l'adattatore compatibile OpenAI in modo che supporti *entrambi* i percorsi
(DeepSeek diretto e OpenRouter) dietro la stessa interfaccia, con OpenRouter come **default
consigliato** per chi vuole provare più modelli senza scrivere altro codice, e DeepSeek diretto
disponibile per chi preferisce il percorso più corto. Nessuna delle due chiavi è obbligatoria:
esattamente come `ANTHROPIC_API_KEY` oggi, l'assenza della chiave disattiva quel fornitore senza
rompere nulla.

**Un rischio di correttezza specifico da non saltare:** il preventivo di costo (`usage.js`,
ADV-01) e il **budget mensile con soglia dura** appena costruito in ADV-03 dipendono da un
`costUsd` per turno calcolato sul listino prezzi Anthropic (`config.js`,
`HYPERLIQUID_CONFIG.agents.pricing`). Un turno su DeepSeek/OpenRouter con quel listino sbagliato
non farebbe scattare il budget al momento giusto — un bug silenzioso esattamente nella storia che il
PO ha voluto più cauta di tutte (approvazione Telegram a due passi). Serve una voce di prezzo per
modello, non un prezzo unico globale.

**Cosa serve, concretamente:**
- Interfaccia comune interna (nome indicativo: `createChatCompletion({system, messages, tools,
  model, maxTokens}) → {content, toolCalls, usage, stopReason}`), in un nuovo `src/agents/providers/`.
- Adattatore Anthropic: **refactor** del `client.js` esistente dietro l'interfaccia — comportamento
  identico a oggi (stessi breakpoint di cache, stesso formato), zero regressioni sui test Analyst/
  Advisor già verdi.
- Adattatore compatibile OpenAI: nuovo, parametrizzato su `baseURL`/chiave, usabile sia per
  `DEEPSEEK_API_KEY` (`https://api.deepseek.com`) sia per `OPENROUTER_API_KEY`
  (`https://openrouter.ai/api/v1`) — stesso codice, config diversa. Nessuna delle due obbligatoria.
- Traduzione dei blocchi `tool_use`/`tool_result` da/verso `tool_calls` in stile OpenAI — è la parte
  che giustifica l'adattatore, non un dettaglio.
- Tabella prezzi per modello (estensione di `HYPERLIQUID_CONFIG.agents.pricing`), usata da
  `usage.js`/`priceOf` — **obbligatoria prima di attivare qualunque fornitore diverso da Anthropic**,
  per non rompere il budget di ADV-03.
- La suite avversaria di ADV-02 (`test/advisorGuardrails.test.js`) va rieseguita contro il nuovo
  adattatore (con un client finto, stessa disciplina di questo sprint — nessuna spesa reale).
- **Non in questo stretch**: cambiare il modello di default per Analyst o Advisor (restano Claude),
  spendere denaro reale su DeepSeek/OpenRouter per validarne la qualità (decisione del PO, a parte,
  quando le chiavi saranno effettivamente provisionate via Infisical).

**Criteri di accettazione:**
- [x] Interfaccia comune con adattatore Anthropic (refactor, zero regressioni sui test esistenti) e
      adattatore compatibile OpenAI (nuovo).
- [x] L'adattatore OpenAI-compatibile funziona, a parità di codice, sia con `baseURL` DeepSeek sia
      con `baseURL` OpenRouter — verificato con un client HTTP finto per entrambe.
- [x] Tabella prezzi per modello estesa; `usage.js` la usa per calcolare `costUsd` in modo corretto
      per qualunque fornitore selezionato.
- [x] Nessuna chiave nuova obbligatoria: senza `DEEPSEEK_API_KEY`/`OPENROUTER_API_KEY` il
      comportamento è identico a oggi (solo Anthropic).
- [x] La suite avversaria di ADV-02 passa anche con l'adattatore OpenAI-compatibile (client finto).
- [x] `npm test`/lint verdi; nessuna chiamata di rete reale nei test; nessun modello di default
      cambiato.

**Owner:** Bruno (proprietario di `src/agents/`) · **SP:** 5 (stretch — può restare parzialmente
fatto a fine sprint senza bloccare la chiusura delle altre 9 storie).

---

### 0.11 · Candidati NON presi (con motivazione)

- **Advisor fase 2 (proposte dalla chat) e fase 3 (voce)** — decisione PO del 10 agosto: prima la
  fase 1 deve dimostrare di dire cose vere (spike §9). La voce inoltre alza la posta sui guardrail
  (spike §6) e non va nella stessa iterazione delle proposte.
- **Persistenza candele locale** (~3 SP) — gap reale e verificato (cache 20s in memoria, ogni
  backtest/training riscarica tutto, cap 1500/2000 candele), ma non scelto oggi. L'analisi resta
  pronta: archivio OHLC in SQLite con gap-filling, backtest più veloci e lookback più lunghi.
- **Strategie più espressive** (~3 SP) — verificato: 6 indicatori, logica piatta any/all, nessuna
  semantica di crossover ("incrocia sopra" vs confronto istantaneo), 4 template **duplicati** tra
  `tools.js` e `perps.js`. Candidato solido per Sprint 5.
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
| ADV-01 | Fase 0 advisor: `usage.js` + 5 strumenti read-only | Bruno | 2 | ✅ Fatto |
| ADV-02 | Fase 1 advisor: chat sola lettura (backend + drawer) | Bruno + Maya | 5 | ✅ Fatto* |
| ADV-03 | Budget advisor con approvazione Telegram | Bruno | 2 | ✅ Fatto |
| CUR-01 | Multivaluta EUR (solo visualizzazione) | Joshua + Maya | 3 | ✅ Fatto |
| OBS-01 | Stack Prometheus + Grafana sul VPS | Joshua | 3 | ✅ Fatto* |
| ANA-01 | Dashboard performance storica (+ breakdown TP/SL, extra) | Bruno + Maya | 3 | ✅ Fatto |
| DEBT-01 | Pacchetto debiti tecnici Sprint 3 | Bruno + Joshua | 3 | ✅ Fatto |
| DEBT-UI-01 | Rimozione dati finti da index.html (extra) | Maya | — | ✅ Fatto |
| LLM-01 | Astrazione multi-provider: DeepSeek + OpenRouter (**stretch**) | Bruno | 5 | ✅ Fatto |
| OPS-02 | Verifica backup/restore VPS (carry-over) | PO/Claude | 1 | ⏳ In attesa PO |
| OPS-03r | Uptime esterno su `/health` (residuo) | PO/Claude | 1 | ⏳ In attesa PO |

\* Un criterio resta genuinamente aperto in ciascuna: ADV-02 (costo reale di una sessione, serve il
PO con `AGENTS_ENABLED=true`), OBS-01 (prova sul VPS reale — si aggiunge a OPS-02). Non bloccano
l'approvazione, sono follow-up operativi dichiarati.

**Ordine consigliato:** ADV-01 prima di ADV-02 (prerequisito dichiarato); DEBT-01 e OBS-01
parallelizzabili da subito; ANA-01 dopo che DEBT-01 item 1-2 sono chiusi (toccano `bot.js` e
`botManager.js` — meglio non incrociare i lavori); ADV-03 dopo ADV-02 (il budget guard ha bisogno
della contabilità di sessione). *Seguito realmente in esecuzione, confermato dai log di sprint4-status/.*

## 3. Riepilogo

| | SP |
|:--|:--:|
| Advisor (ADV-01+02+03) | 9 |
| Funzionalità (CUR-01, ANA-01) | 6 |
| Osservabilità (OBS-01, OPS-03r) | 4 |
| Debiti tecnici (DEBT-01) | 3 |
| Operativo (OPS-02) | 1 |
| **Totale core** | **23** |
| LLM-01 (stretch, extra) | 5 |
| **Totale con stretch** | **28** |

Composizione per owner: Bruno ~10 SP, Joshua ~7 SP, Maya ~6 SP (in coppia su 3 story), PO/Claude 2 SP.
Confrontabile con lo Sprint 3 (25 SP pianificati, 22 fatti).

## 4. Esito review (10 agosto 2026)

**28/28 SP completati e approvati dal PO** (23 pianificati + 5 stretch, riportato dentro durante la
review stessa) — il primo sprint di questo team senza nemmeno un punto lasciato a metà. Review
guidata dal PO, con una verifica indipendente di Annie su ADV-01/02/03 e DEBT-01 item 1-2 (le storie
a più alto rischio di sicurezza dello sprint) e una verifica diretta del PO su tutto il resto,
incluso il codice reale dove il rischio lo giustificava (contratti API tra Bruno/Joshua/Maya,
invarianti `riskAgent.js`/`proposals.js`, DEBT-01 item 4-5 non coperti dal mandato di Annie).

**Tre extra decisi e consegnati nella stessa sessione di review** (non rimandati, salvo dove
esplicitamente motivato):
- **DEBT-UI-01** — dati finti nel markup di `index.html` (il refinement candidate più serio trovato
  da Maya) rimossi; nel farlo, 2 bug di comportamento reali corretti (fetch fallita che lasciava a
  schermo dati vecchi, "nessuna posizione" affermato prima di aver guardato).
- **ANA-01-EXTRA** — breakdown TP-vs-SL reale in `close_reason`, prima ritenuto non ricavabile:
  risolto ispezionando l'oid del fill di chiusura, con degrado esplicito a "non lo so" (mai
  un'etichetta sbagliata) quando l'oid non è determinabile o la posizione è ereditata da prima del
  fix. Storico pre-esistente non riscritto.
- **LLM-01** — l'astrazione multi-provider (differita a Sprint 5 in planning) riportata dentro come
  stretch su richiesta del PO, con valutazione scritta DeepSeek-diretto-vs-OpenRouter prima
  dell'implementazione (§0.10) e consegnata per intero, non solo iniziata.

**Un rilievo di sicurezza trovato e chiuso in seduta**: il parsing di `/advisorbudget` (ADV-03)
accettava ancora input ambigui (`1e10`, `50abc`, `0x10`) dopo un primo fix parziale — trovato
indipendentemente sia da Annie sia (più tardi, senza saperlo) riconfermato dal secondo giro di
Bruno, che ha chiuso la classe di bug invece dei singoli casi.

**Follow-up operativi non chiudibili in questa sessione** (nessuno bloccante, tutti dichiarati):
OPS-02/OPS-03r (invariati, mai eseguiti — ora comprendono anche la prova reale di OBS-01 sul VPS),
la misura di costo reale di una sessione advisor (ADV-02 criterio 5, serve `AGENTS_ENABLED=true`),
la validazione del tool-calling di DeepSeek/OpenRouter contro un modello vero (LLM-01, prima di
dargli accesso agli strumenti in produzione).

8 candidati di refinement raccolti per Sprint 5 in `sprint4-status/aggregate.json` (cap sul numero
di tool-call per turno advisor, EXECUTION STATUS card, formattazione importi negativi, ordine
sezioni MANUAL.md/manual.html, focus trap del drawer, riverifica prezzi LLM-01).

*Refinement chiuso il 10 agosto 2026. Review chiusa il 10 agosto 2026 — 28/28 SP approvati.*
