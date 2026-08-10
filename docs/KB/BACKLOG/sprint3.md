# Sprint 3 — Manutenzione dal vivo, ripulitura legacy, primo spike AI advisor

**Team:** Nautilus · **Stato:** pianificato — planning tenuto il 9 agosto 2026, subito dopo il primo
deploy reale del progetto (VPS + Tailscale + Infisical, vedi sessione del 9 agosto). Diversamente dagli
Sprint 1-2, buona parte di questo backlog nasce da bug e lacune trovate **durante un deploy vero**, non
da un'istruzione esterna o da una review di codice.

---

## 0. Candidati raccolti

| # | Candidato | Origine | Verificato sul codice | SP stimati |
|:--|:---|:---|:---:|:--:|
| 1 | Comando Telegram per il kill-switch (on/off) | Maya, durante UI-01 (Sprint 2, fuori planning) | ✅ | 1-2 |
| 2 | Gestione multivaluta USD/EUR | PO, 9 agosto | ✅ | 3-5 (se solo display) |
| 3 | Ottimizzazione costi Claude + LLM alternativi/verticalizzati trading | PO, 9 agosto | ✅ | da spacchettare — vedi §0.3 |
| 4 | Archiviazione/esportazione/importazione strategie | PO, 9 agosto | ✅ | 2-3 |
| 5 | **Spike** — consulente AI di portafoglio via chat (poi vocale) | PO, 9 agosto | — (analisi, non implementazione) | 2-3 |
| 6 | `npm run lint` non copre `public/*.js` | Maya (Sprint 2), promossa da Claude 9 agosto | ✅ | 1 |
| 7 | `secretBox.js`: fail-fast invece di ricadere su chiave di sviluppo | Annie (Sprint 2), promossa da Claude 9 agosto | ✅ | 1-2 |
| 8 | Ritirare/isolare il modulo demo EVM legacy (`DEMO_EVM_ENABLED`) | Claude, deploy 9 agosto — causa diretta di 2 bug corretti oggi | ✅ | 2-3 |
| 9 | Branding stantio ("Testnet Only" anche con mainnet supportata) | Claude, deploy 9 agosto | ✅ | 1 |
| 10 | Verifica backup/restore sul VPS reale (mai eseguita) | Claude, deploy 9 agosto | ✅ | 1 (operativo) |
| 11 | Monitoraggio esterno (uptime) mai collegato | Claude, deploy 9 agosto | ✅ | 1-2 |

### 0.1 · Comando Telegram per il kill-switch

**Descrizione.** UI-01 (Sprint 2) ha corretto l'assenza di un modo per **disattivare** il kill-switch
dall'interfaccia web. Nello stesso lavoro, Maya ha verificato che **Telegram non offre alcun comando
per il kill-switch**, né per attivarlo né per spegnerlo: `_cmdCloseAll` (`src/perps/telegramControl.js:237`,
comando `/chiuditutto`) chiude le posizioni aperte ma non tocca il flag `settings.killswitch` né ferma
i bot. Un operatore che ha accesso solo alla chat Telegram — lo scenario per cui il bot invia notifiche
in primo luogo — non può né fermare né riprendere le aperture da lì.

**Cosa serve, indicativamente** (da raffinare in planning):

- Un comando `/killswitch` (o due comandi distinti `/killswitchon` / `/killswitchoff`) che chiami
  `riskAgent.setKillSwitch(...)`, simmetrico a quanto ora esiste in `public/perps.js` per il web.
- Stessa cautela già applicata in UI-01: il comando di disattivazione non deve implicare il riavvio
  dei bot fermati — resta una scelta separata.
- Verificare chi può eseguire comandi Telegram sul bot (autenticazione/allowlist chat id, se esiste)
  prima di esporre un comando che sblocca le aperture — un kill-switch disattivabile da chiunque scriva
  al bot sarebbe un problema nuovo, non solo una feature mancante.

**File coinvolti (da confermare in planning):** `src/perps/telegramControl.js`, `docs/MANUAL.md` §16
(tabella comandi), `public/manual.html`.

**Origine:** Maya, refinement candidate lasciato in `docs/KB/BACKLOG/sprint2-status/maya.json`,
promosso a story su richiesta del PO l'8 agosto 2026 (vedi `sprint2.md` §4.1).

---

### 0.2 · Gestione multivaluta USD/EUR

**Verificato sul codice.** Oggi non esiste **nessuna** gestione valutaria: nessun riferimento a `EUR`,
`currency`, tasso di cambio in `src/` o `public/*.js`. Tutto — equity, PnL, margine, i limiti di rischio
(`PERPS_MAX_POSITION_USD`, `PERPS_MAX_DAILY_LOSS_USD`) — è USD, sia nella UI (`fmtUsd` in `perps.js`) sia
nella configurazione.

**Decisione di prodotto da prendere in planning, non qui.** Hyperliquid regola e liquida nativamente in
USDC: i limiti di rischio che il bot applica sono confronti diretti con quel numero. Due strade molto
diverse per costo e rischio:

| | Solo visualizzazione (consigliato) | Conversione strutturale |
|:---|:---|:---|
| **Cosa cambia** | Mostra un secondo valore in EUR accanto a quelli USD esistenti (tasso di cambio recuperato da un'API, es. Frankfurter/ECB, gratuita) | I limiti di rischio e la configurazione bot diventano EUR-denominati |
| **Rischio** | Nessuno — è un livello di presentazione, non tocca la logica di rischio | Alto: ogni conversione introduce un tasso di cambio come input silenzioso ai calcoli che decidono quanto capitale è a rischio — un tasso stantio o una chiamata fallita non deve mai tradursi in un limite calcolato male |
| **Sforzo stimato** | 3-5 SP | Non stimato — richiede prima una discussione di modello di rischio, non è un semplice moltiplicatore |

**Raccomandazione:** partire da "solo visualizzazione". Se in planning emerge che serve davvero operare
i *limiti* in EUR, è una story a sé con la sua analisi di rischio, non un'estensione di questa.

**File coinvolti (indicativo):** `public/perps.js` (helper `fmtUsd` e affini), nuovo modulo per il tasso
di cambio con cache/fallback, `docs/DEPLOY.md` se serve una nuova chiave API.

---

### 0.3 · Ottimizzazione costi Claude + LLM alternativi/verticalizzati

**Verificato sul codice — parte del lavoro di ottimizzazione esiste già.**
[`analyst.js`](../../../src/agents/analyst/analyst.js) ha già prompt caching esplicito (breakpoint
mobile sulla history, scrittura a 1.25x/rilettura a 0.1x), un preventivo di costo *typical/max* per run,
e un cap orario di chiamate (`AGENT_MAX_CALLS_PER_HOUR`). Non è terreno vergine — il margine di
risparmio aggiuntivo va misurato, non assunto.

**[`client.js`](../../../src/agents/analyst/client.js) è oggi un wrapper minimo dell'SDK Anthropic,
senza alcuna astrazione di provider** — 14 righe, nessun punto di estensione. Aggiungere un altro
modello non è "cambiare una chiave API": serve un'interfaccia comune (prompt, tool-calling se
disponibile, formato risposta) dietro cui inserire provider diversi.

**Tre attività molto diverse per rischio e sforzo, da tenere separate in planning:**

1. **Ottimizzazione dei costi Claude esistenti** — misurare dove va la spesa reale (per-run già tracciata
   in `proposals.cost_usd`), poi agire su leve già disponibili senza cambiare architettura: modello
   giusto per compito (`AGENT_ANALYST_MODEL` — verificare se serve davvero il modello attuale per ogni
   fase, o se una fase più leggera può girare su un modello più economico), cadenza (`AGENT_CADENCE_MIN`),
   cap di iterazioni. Piccolo, quasi privo di rischio architetturale.
2. **Astrazione multi-provider + LLM economici/gratuiti** — richiede disegnare l'interfaccia comune
   sopra, poi collegare candidati concreti (da valutare: Gemini free tier, Groq, DeepSeek, modelli locali
   via Ollama se la macchina lo permette). Lavoro architetturale reale, non stimabile senza prima
   scegliere l'interfaccia.
3. **LLM "verticalizzati sul trading"** — **da verificare, non assumere che esistano pronti all'uso**:
   la KB (`docs/KB/index/INDEX.md` §C.2) documenta un caso reale in cui un LLM generalista usato per
   segnali diretti ha prodotto un drawdown del −450%, e la lezione già interiorizzata in questo progetto
   è "le regole decidono, l'AI spiega" (`riskAgent.js` resta l'unico gate). Prima di integrare qualunque
   modello "esperto di trading", serve una ricerca su cosa esiste realmente in produzione (non solo
   paper/demo) — candidato per uno spike a sé, non per uno sviluppo diretto.

**Raccomandazione:** promuovere il punto 1 come story a sé stante di piccola taglia; i punti 2 e 3
restano candidati più grandi da scomporre ulteriormente in planning.

---

### 0.4 · Archiviazione, esportazione e importazione delle strategie

**Verificato sul codice — la base dati è già favorevole.** Ogni bot ha in
[`bots.config_json`](../../../src/db/database.js) l'intera configurazione di strategia (indicatori,
regole, parametri di rischio) come un unico blob JSON. Lo storico strategie (approvate/rifiutate, con
categorizzazione, eliminazione massiva e riciclo) esiste già nella UI — introdotto di recente (commit
`9ac4172`) sulla tabella `proposals` (`type = 'new_strategy_candidate'`).

**Cosa serve, indicativamente:**
- **Esportazione**: serializzare `config_json` (+ nome, coin, network) di un bot o di una voce dello
  storico in un file scaricabile — meccanismo semplice (Blob + `<a download>` lato client, o header
  `Content-Disposition` lato server).
- **Importazione**: caricare quel JSON e ricreare bot/candidatura, con validazione dello schema prima di
  scrivere (un JSON malformato o con campi mancanti non deve creare un bot con configurazione
  parzialmente vuota).
- **Archiviazione**: probabilmente già in parte coperta dallo storico strategie esistente — da chiarire
  in planning se "archiviare" significa altro rispetto a quello che c'è (es. archiviazione a lungo
  termine fuori dal DB principale).

**File coinvolti (indicativo):** `src/server.js` (nuove route export/import), `public/perps.js`
(pulsanti nella sezione storico strategie già esistente), eventualmente `src/db/database.js` se serve
un endpoint di validazione schema riusabile.

---

### 0.5 · Spike — consulente AI di portafoglio via chat (voce in fase successiva)

**Esplicitamente uno spike per lo Sprint 3, non sviluppo.** Il PO vuole prima capire *come* si potrebbe
costruire un consulente conversazionale — stile "esperto di finanza con cui dialogare" — prima di
impegnarsi a costruirlo; lo sviluppo vero e proprio è candidato per lo Sprint 4.

**Vincolo non negoziabile, già stabilito dall'architettura esistente e confermato dalla KB
(`INDEX.md` §C.1, "le regole decidono, l'AI spiega").** Un consulente conversazionale deve restare
**strettamente advisory**: stessa disciplina già applicata all'Analyst — mai un canale che possa
piazzare, modificare o chiudere posizioni senza passare dalla coda di approvazione esistente e dal gate
deterministico di `riskAgent.js`. Questo è un vincolo di design da rispettare nello spike, non una
scelta da rivalutare.

**Domande a cui lo spike deve rispondere (deliverable: un documento di analisi, non codice):**

1. **Relazione con l'Analyst esistente** — nuovo componente separato, o estensione conversazionale dello
   stesso `analyst.js`? Il pattern agentico con strumenti read-only (`tools.js`) è già lì e riusabile.
2. **Punto di integrazione UI** — dove vive la chat nella cockpit attuale (nuovo tab? pannello laterale?).
3. **Dati e strumenti necessari** — posizioni, snapshot di rischio, storico trade: tutti già esposti da
   API esistenti (`/api/perps/account`, `/api/perps/risk`, `/api/perps/fills`); da verificare se bastano
   o serve altro.
4. **Modello di conversazione e costo** — una chat turno-per-turno ha un profilo di costo e latenza
   molto diverso dal loop agentico periodico attuale (che gira ogni `AGENT_CADENCE_MIN` minuti, non a
   ogni messaggio utente). Da stimare separatamente, non assumere che la spesa attuale dell'Analyst sia
   indicativa.
5. **Memoria/contesto della conversazione** — quanto storico tenere, dove persisterlo.
6. **Voce (fase successiva, solo da mappare ora)** — opzioni indicativamente disponibili: Web Speech API
   del browser (gratuita, qualità variabile) vs. API STT/TTS a pagamento (qualità migliore, costo
   ricorrente). Nessuna scelta da fare ora, solo da elencare le opzioni con pro/contro di massima.
7. **Guardrail specifici della chat** — un'interfaccia conversazionale invita a "chiedere di fare"
   qualcosa in modo naturale; va esplicitato come il sistema rifiuta/reindirizza richieste che
   implicherebbero un'azione diretta, mantenendo la separazione proposta-poi-approvazione.

**File di riferimento per lo spike:** `src/agents/analyst/` (pattern agentico esistente da valutare per
riuso), `docs/KB/index/INDEX.md` §C (temi AI/LLM già survey-ati).

---

### 0.6 · `npm run lint` non copre `public/*.js`

**Verificato — e ha già dimostrato il suo costo oggi.** `scripts/lint-syntax.js` ha
`roots = ['src', 'test', 'scripts']`: l'intero perimetro frontend (`public/*.js`, `perps.js` da solo
~1900 righe) non passa mai da `node --check` in CI. Durante il deploy di oggi ho dovuto lanciarlo a mano
tre volte per verificare i miei stessi fix a `app.js`/`perps.js` — un errore di sintassi lì
supererebbe la CI e romperebbe l'interfaccia in silenzio in produzione.

**Fix:** aggiungere `'public'` a `roots`. Un solo rischio da verificare prima di attivarlo: che tutti i
file in `public/*.js` passino `node --check` così come sono oggi (verificato a mano durante UI-01 e nel
deploy di oggi per i file toccati — da ripetere su tutti prima di attivare la regola, potrebbe emergere
qualcosa in file non ancora controllati).

**File:** `scripts/lint-syntax.js`. **Origine:** Maya (Sprint 2, UI-01), promossa il 9 agosto.

---

### 0.7 · `secretBox.js`: fail-fast invece di ricadere su una chiave di sviluppo

**Verificato — rischio reale, non teorico.** Se `AGENT_ENCRYPTION_KEY` è assente o vuota, `secretBox.js`
usa una chiave di sviluppo **hardcoded nel sorgente** invece di rifiutarsi di partire. Utile per far
girare i test senza configurazione, pericoloso se succede per errore in produzione: qualunque dato
cifrato in quello stato è cifrato con una chiave pubblica, nota a chiunque legga il codice.

**Cosa serve:** applicare a `secretBox.js` la stessa disciplina già usata da `validateConfig()` per
`SESSION_SECRET`/`APP_PASSWORD_HASH`/`AGENT_ENCRYPTION_KEY` in `NODE_ENV=production` — fail-fast
esplicito invece di un fallback silenzioso. Il fallback di sviluppo resta per `NODE_ENV` diverso da
production, dove serve.

**File:** `src/perps/secretBox.js`, `src/config/config.js` (`validateConfig`).
**Origine:** Annie (Sprint 2, TEST-01), promossa il 9 agosto.

---

### 0.8 · Ritirare o isolare il modulo demo EVM legacy

**Scoperto durante il deploy di oggi, non ipotizzato.** `public/app.js` (`DEMO_EVM_ENABLED`, disattivato
di default) e il pannello Perps condividono **lo stesso pulsante e lo stesso stato di connessione
wallet** (`perps.connected`/`perps.address` sono getter su `app.isConnected`/`app.walletAddress`,
verificato nel codice). Questo ha causato **due bug reali corretti oggi**:

1. `connectWallet()` forzava MetaMask su Sepolia/BSC Testnet/Polygon Amoy — reti del vecchio bot
   multi-chain, irrilevanti per Hyperliquid — bloccando la connessione anche per chi voleva solo
   operare su Perps.
2. La card con il vero pulsante di connessione (`.wallet-section`) è `display:none` in modalità
   cockpit, senza che fosse rimasto alcun modo cliccabile equivalente — scoperto solo perché un utente
   reale non trovava nulla da premere.

Entrambi sono sintomi dello stesso problema di fondo: due funzionalità che non hanno più nulla a che
fare l'una con l'altra condividono codice e stato. Il prossimo cambiamento a uno dei due rischia di
rompere l'altro di nuovo, in un punto diverso.

**Decisione del PO (planning, 9 agosto): ritiro completo (opzione A).**

> ⚠️ **Da non confondere — due cose diverse chiamate entrambe "testnet".** Questo ritiro riguarda
> **solo** il wallet demo EVM (MetaMask forzato su Sepolia/BSC Testnet/Polygon Amoy — reti del vecchio
> bot multi-chain). **Non tocca** il selettore Testnet/Mainnet di Hyperliquid Perps
> (`perps.setNetwork('testnet'|'mainnet')`, i pulsanti "Testnet"/"Mainnet" nel pannello Account Perps) —
> quello resta, è la modalità di rete reale del progetto e va preservato esplicitamente. Verificare che
> nessuna rimozione tocchi `perps.js`, solo `app.js` e le rotte demo EVM.

**Cosa serve:**
- Rimuovere `public/app.js` e ogni riferimento nell'HTML (`.wallet-section`, gli script che lo caricano).
- Rimuovere le rotte demo EVM lato server (blocco `if (config.DEMO_EVM.enabled)` in `src/server.js`) e
  la config `DEMO_EVM` stessa se non serve altrove.
- **La connessione MetaMask per Perps deve continuare a funzionare** (approvazione agent, transfer
  spot→perp) — va ricostruita senza dipendere da `app.js`, non solo cancellata. È il motivo per cui
  questo task non è un semplice "elimina file": `connectWallet()`/`isConnected`/`walletAddress` vanno
  spostati o riscritti dentro `perps.js` stesso, oppure in un modulo condiviso minimo.
- Aggiornare `public/index.html`: il pill `#walletStatus` in header resta, ma senza più dipendere da
  `app.js` per il click handler.

**File coinvolti:** `public/app.js` (rimosso), `public/perps.js` (nuova sede della logica wallet),
`public/index.html`, `src/server.js`, `src/config/config.js`.
**Origine:** Claude, durante il deploy del 9 agosto (correzione dei due bug MetaMask).

---

### 0.9 · Branding stantio: "Testnet Only" anche con mainnet supportata

**Verificato.** `<title>🤖 Arbitrage Bot - Testnet Only</title>` e il badge `TESTNET ONLY` in
`public/index.html` non riflettono la realtà: l'app supporta mainnet con un gate esplicito
(`ALLOW_MAINNET`) e una checklist GO-LIVE dedicata (`DEPLOY.md` §7). È l'unico deploy reale fatto finora
(oggi), ed è già fuorviante: chiunque guardi la tab del browser penserebbe che mainnet non sia
un'opzione.

**Cosa serve:** titolo e badge dinamici in base a `HYPERLIQUID_NETWORK`/`ALLOW_MAINNET` (es. badge verde
"MAINNET" quando attivo, invece del rosso "TESTNET ONLY" fisso), o quantomeno un titolo che non affermi
il falso. Piccolo, ma è la prima cosa che si vede.

**File:** `public/index.html`. **Origine:** Claude, durante il deploy del 9 agosto.

---

### 0.10 · Verifica backup/restore mai eseguita sul VPS reale

**Non è un'ipotesi: è lo stato attuale del VPS appena messo in produzione.** `docs/DEPLOY.md` §5
descrive `backup.sh`/`restore-verify.sh`, ma su `vps-ec91eb11` non è mai girato nulla — nessun backup
esiste. Un crash del disco oggi perderebbe l'intero storico (bot, posizioni, trade, chiavi agent
cifrate) senza alcuna copia.

**Non è propriamente una "storia di sviluppo"**: gli script esistono già, è un'azione operativa da
eseguire (tipo CHORE-01 dello Sprint 2) più che scrivere codice — a meno che in planning emerga che
serve anche automatizzarla (cron + sincronizzazione fuori dal VPS, oggi manuale secondo la doc).

**File:** `scripts/backup.sh`, `scripts/restore-verify.sh`, `docs/DEPLOY.md` §5.
**Origine:** Claude, durante il deploy del 9 agosto.

---

### 0.11 · Nessun monitoraggio esterno collegato

**Verificato contro lo stato reale del deploy di oggi.** `docs/DEPLOY.md` §6 raccomanda di puntare
UptimeRobot o healthchecks.io su `/health` — non è mai stato fatto. Se il container si ferma, lo si
scopre solo aprendo il pannello. Telegram e `METRICS_TOKEN` invece **sono già a posto** (configurati
oggi durante la migrazione a Infisical) — manca solo il pezzo di uptime esterno.

**Cosa serve:** un account gratuito su un servizio di uptime esterno che punti a
`https://vps-ec91eb11.tail3a3dde.ts.net/health` (raggiungibile solo dalla tailnet — verificare se il
servizio scelto supporta un check dentro una rete privata, es. via un agente locale, o se serve
esporre `/health` separatamente). Decisione di prodotto minima (quale servizio) più configurazione,
non sviluppo.

**File:** `docs/DEPLOY.md` §6. **Origine:** Claude, durante il deploy del 9 agosto.

---

### 0.12 · Planning (9 agosto)

Delle 11 candidate raccolte in §0, il PO ne ha confermate **10 per lo Sprint 3** e rimandate **2** a
Sprint 4, con una decisione esplicita sul ritiro del demo EVM:

| Candidato | Decisione del PO |
|:---|:---|
| 0.2 — Multivaluta USD/EUR | **Rimandata a Sprint 4** — non urgente, nessun rischio operativo dietro |
| 0.3, punto 2 — Astrazione multi-provider LLM | **Rimandata a Sprint 4**, dopo lo spike consulente (0.5), che darà un terreno comune su dati/strumenti utile anche per scegliere provider alternativi |
| 0.8 — Demo EVM legacy | **Ritiro completo** (non isolamento) — con vincolo esplicito: il selettore Testnet/Mainnet di Hyperliquid Perps resta, va solo scollegato da `app.js` |
| Tutte le altre (0.1, 0.3 punto 1, 0.3 punto 3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.10, 0.11) | **Confermate in Sprint 3**, senza modifiche di scope |

Il punto 3 di 0.3 (ricerca su LLM verticalizzati) confluisce nello spike 0.5 (SPIKE-01): sono entrambe
attività di analisi, ha senso un solo documento invece di due.

---

## 1. Sprint Goal

> Portare a coerenza quello che il primo deploy reale ha messo a nudo — un sistema ora vivo senza rete
> di sicurezza operativa (backup, monitoraggio) e un modulo legacy che continua a rompere silenziosamente
> funzionalità che non c'entrano nulla con lui — mentre si getta le basi per due direzioni di prodotto
> nuove (esportabilità delle strategie, un primo studio su un consulente AI conversazionale) senza
> impegnarsi a costruirle prima di averle capite.

**Non-goal dello sprint:** implementare il consulente AI (solo lo spike), l'astrazione multi-provider
LLM, la gestione multivaluta strutturale (solo eventualmente in Sprint 4).

---

## 2. Task board

---

### 🔴 TG-01 · Comando Telegram per il kill-switch

| | |
|:---|:---|
| **Tipo** | 🐛 bug — funzionale |
| **Story Point** | **2** |
| **Priorità** | P1 |
| **Owner** | Bruno |
| **File** | `src/perps/telegramControl.js`, `docs/MANUAL.md` §16, `public/manual.html` |
| **Origine** | Maya (UI-01), promossa in planning — vedi §0.1 |

**Criteri di accettazione**
- [ ] Comando (`/killswitch on|off` o due comandi distinti) che chiama `riskAgent.setKillSwitch(...)`.
- [ ] La disattivazione non riavvia i bot fermati — resta una scelta separata (stesso vincolo di UI-01).
- [ ] Verificato chi può eseguire comandi Telegram sul bot prima di esporre un comando che sblocca le
      aperture (allowlist chat id, se esiste — se non esiste, va segnalato come rischio a parte, non
      silenziato).
- [ ] Test che copre on/off e il caso "chat non autorizzata", se l'allowlist esiste.
- [ ] `docs/MANUAL.md` §16 e `public/manual.html` aggiornati.

**Rischi:** un kill-switch disattivabile da chiunque scriva al bot è un problema nuovo, non solo una
feature mancante — il controllo di autorizzazione è parte dei criteri, non opzionale.

---

### 🟠 LINT-01 · `npm run lint` non copre `public/*.js`

| | |
|:---|:---|
| **Tipo** | ⚙️ chore — gap di CI |
| **Story Point** | **1** |
| **Priorità** | P1 |
| **Owner** | Joshua |
| **File** | `scripts/lint-syntax.js` |
| **Origine** | Maya (Sprint 2), promossa — vedi §0.6 |

**Criteri di accettazione**
- [ ] `'public'` aggiunto a `roots` in `scripts/lint-syntax.js`.
- [ ] Tutti i file `public/*.js` esistenti passano `node --check` **prima** di attivare la regola —
      verificarlo esplicitamente, non assumerlo.
- [ ] `npm run lint` verde dopo il cambio.

---

### 🔴 SEC-07 · `secretBox.js`: fail-fast invece di chiave di sviluppo

| | |
|:---|:---|
| **Tipo** | 🔒 security |
| **Story Point** | **2** |
| **Priorità** | P0 — rischio silenzioso su dati cifrati |
| **Owner** | Joshua |
| **File** | `src/perps/secretBox.js`, `src/config/config.js` |
| **Origine** | Annie (TEST-01), promossa — vedi §0.7 |

**Criteri di accettazione**
- [ ] In `NODE_ENV=production`, `secretBox.js` senza `AGENT_ENCRYPTION_KEY` valida fa fallire l'avvio
      (coerente con `validateConfig()` per `SESSION_SECRET`/`APP_PASSWORD_HASH`), non ricade sulla
      chiave di sviluppo.
- [ ] Il fallback di sviluppo resta **solo** fuori produzione (test, sviluppo locale).
- [ ] Test che copre entrambi i casi (production senza chiave → crash esplicito; sviluppo senza chiave →
      fallback, comportamento invariato).
- [ ] Verificato che il VPS reale (già in Infisical con `AGENT_ENCRYPTION_KEY` impostata) non sia
      impattato dal cambio — nessuna regressione sul deploy esistente.

**Rischi:** un fail-fast mal piazzato potrebbe rompere avvii legittimi se qualche percorso di codice si
aspetta ancora il fallback in produzione — va cercato esplicitamente, non assunto assente.

---

### 🔴 EVM-01 · Ritiro del modulo demo EVM legacy

| | |
|:---|:---|
| **Tipo** | 🐛 bug / 🧹 pulizia architetturale |
| **Story Point** | **3** |
| **Priorità** | P0 — causa diretta di 2 bug già corretti oggi, rischio di ripresentarsi |
| **Owner** | Maya (con Joshua per le rotte server) |
| **File** | `public/app.js` (rimosso), `public/perps.js`, `public/index.html`, `src/server.js`, `src/config/config.js` |
| **Origine** | Claude, deploy 9 agosto — vedi §0.8 |

**Criteri di accettazione**
- [ ] `public/app.js` e le rotte demo EVM (`if (config.DEMO_EVM.enabled)` in `src/server.js`) rimossi.
- [ ] **La connessione MetaMask per Perps continua a funzionare** (approvazione agent, transfer
      spot→perp) — `connectWallet()`/stato wallet spostati dentro `perps.js` o un modulo condiviso
      minimo, non semplicemente cancellati.
- [ ] **Il selettore Testnet/Mainnet di Hyperliquid Perps non è toccato** — verificato esplicitamente
      che `perps.setNetwork()` e i pulsanti di rete funzionino invariati dopo il cambio.
- [ ] `#walletStatus` in header resta cliccabile, senza dipendere da `app.js`.
- [ ] Test end-to-end (o manuale documentato, se non automatizzabile senza un vero wallet) del flusso:
      connetti → approva agent → verifica stato su UI.
- [ ] `npm test`/`npm run lint` verdi.

**Rischi:** è il task con più superficie di regressione dello sprint — tocca l'unico punto in cui
MetaMask e Perps si parlano. Va verificato con calma, non affrettato per chiudere lo sprint.

---

### 🔴 SEC-08 · `_reconcile()` duplica la posizione e lascia ordini orfani sull'exchange

| | |
|:---|:---|
| **Tipo** | 🐛 bug — correttezza, capitale a rischio (stessa famiglia di SEC-01, Sprint 1) |
| **Story Point** | **3** |
| **Priorità** | P0 |
| **Owner** | Bruno |
| **File** | `src/perps/bot.js` (`_reconcile`, `_openPosition`) |
| **Origine** | Claude, analisi live della piattaforma sul VPS (9 agosto) — non ipotizzato, riprodotto su dati reali |

**Descrizione.** Su una posizione SOL-PERP realmente aperta sul VPS, incrociando database, log e stato
live su Hyperliquid, sono risultati **tre ordini reduce-only attivi sull'exchange** per un'unica
posizione da 1.31 SOL — un TP (77.78) e **due SL** (75.865 e 75.863), invece di un TP e un SL soli.
Il database conferma: **due righe** in `positions` per la stessa apertura, la seconda con
`tpPx: null, slPx: null`.

**Causa.** `_reconcile()` ([bot.js:156-175](../../../src/perps/bot.js#L156-L175)) gira a ogni tick
*prima* della logica decisionale. Se trova una posizione live su Hyperliquid che non corrisponde a
`this.position` (in memoria), la tratta come "posizione aperta non tracciata" e ne inserisce una
**seconda copia** nel database, con `tpPx`/`slPx` nulli. Il problema: dentro `_openPosition()`
([bot.js:177](../../../src/perps/bot.js#L177)) l'ordine di mercato si riempie sull'exchange (quindi è
già "live") **prima** che `this.position` venga assegnato in memoria (riga 252) — una finestra reale,
non teorica, in cui `_reconcile()` può leggere una posizione che è **la stessa che il bot sta aprendo
in quel momento**, non una davvero estranea, e duplicarla.

La copia orfana, priva di TP/SL propri, viene poi gestita in parallelo dalla logica esistente e a un
certo punto si è vista assegnare un proprio SL (75.863, piazzato ~86 minuti dopo l'apertura) — senza
mai ricevere un TP, e senza che il vecchio ordine venisse cancellato. Risultato: tre ordini vivi per
una sola posizione reale.

**Perché è rilevante anche se il danno immediato è nullo.** Con un solo ordine che può davvero chiudere
la posizione, gli altri restano orfani senza causare un danno diretto stavolta. Ma su mainnet, con più
posizioni in gestione contemporaneamente, la stessa dinamica potrebbe generare confusione reale su
quale ordine protegge cosa — ed è la stessa classe di rischio che SEC-01 aveva già chiuso per il DCA:
qui il buco è nell'adozione di posizioni "non tracciate", non nel DCA.

**Criteri di accettazione**

- [ ] `_reconcile()` non crea una riga duplicata in `positions` quando la posizione live corrisponde a
      un'apertura già in corso dello stesso bot (la finestra di race dentro `_openPosition`).
- [ ] Prima di "adottare" una posizione non tracciata, il codice verifica che non esista già una riga
      **aperta** per quello stesso `bot_id`+`coin` — non solo confrontare `this.position` in memoria.
- [ ] Il caso legittimo di adozione resta funzionante: una posizione aperta manualmente fuori dal bot,
      o trovata al riavvio del processo senza stato locale, deve poter essere ancora adottata — il
      fix chiude la race, non rimuove la funzionalità.
- [ ] Una posizione adottata riceve comunque TP/SL propri (mai `tpPx`/`slPx` permanentemente `null`) —
      chiama `_placeTpSl()` o equivalente, non lascia la protezione a metà.
- [ ] Nessun ordine orfano resta sull'exchange dopo un'apertura: verificato che gli ordini stale
      vengano cancellati quando sostituiti.
- [ ] Test che riproduce la race (chiama `_reconcile` con una posizione live mentre `this.position` è
      ancora `null`, a metà di un'apertura simulata) e verifica che **non** crei una riga duplicata.
- [ ] Verificato — non assunto — che i tre ordini rimasti sul VPS live vengano ricondotti a uno stato
      pulito (due ordini, TP+SL), a mano o come conseguenza del fix.

**Rischi**

| Rischio | Mitigazione |
|:---|:---|
| Chiudere la race rompe il caso legittimo di adozione (bot riavviato con posizione già live) | Criterio di accettazione dedicato; test separato per il caso legittimo, non solo per quello duplicato |
| La pulizia manuale degli ordini live tocca capitale reale (anche se testnet) | Verificare prima con una lettura, non cancellare ordini alla cieca |

---

### ⚪️ BRAND-01 · Branding stantio ("Testnet Only" con mainnet supportata)

| | |
|:---|:---|
| **Tipo** | 📄 UI / coerenza |
| **Story Point** | **1** |
| **Priorità** | P2 |
| **Owner** | Maya |
| **File** | `public/index.html` |
| **Origine** | Claude, deploy 9 agosto — vedi §0.9 |

**Criteri di accettazione**
- [x] Titolo pagina e badge riflettono la rete reale (`HYPERLIQUID_NETWORK`/`ALLOW_MAINNET`), non un
      "TESTNET ONLY" fisso.
- [x] Nessuna affermazione falsa quando l'app gira in mainnet.

**Approvato dal PO** il 10 agosto, badge rosso "MAINNET · FONDI REALI" confermato (deviazione
dall'esempio verde del planning, per coerenza con l'enfasi su ciò che può costare denaro).

---

### 🔴 SEC-09 · `POST /api/perps/network` non verifica `ALLOW_MAINNET` lato server

| | |
|:---|:---|
| **Tipo** | 🔒 security |
| **Story Point** | **1** |
| **Priorità** | P0 |
| **Owner** | Claude (fix diretto in review, 10 agosto) |
| **File** | `src/config/config.js` (`isMainnetAllowed`, nuovo), `src/server.js` |
| **Origine** | Maya, durante EVM-01 — aggiunta il 10 agosto su decisione del PO in review, stesso trattamento di SEC-08 |

**Descrizione.** `validateConfig()` blocca l'avvio se la rete di *default* è mainnet senza
`ALLOW_MAINNET=true` — ma lo switch a **runtime** dal pannello (`POST /api/perps/network`)
verificava solo un flag `confirm` che il client si autoassegna dopo un dialogo di conferma nel
browser. Su un deploy con `ALLOW_MAINNET` assente (quindi dichiaratamente "solo testnet"), bastava
cliccare "Mainnet" e confermare il dialogo per passarci comunque — nessun gate lato server.

**Fix.** Nuova `isMainnetAllowed()` in `config.js`, unica fonte di verità, usata sia da
`validateConfig()` (refactored per non duplicare il controllo) sia dalla rotta, che ora rifiuta con
403 lo switch a mainnet se il flag non è `"true"`.

**Criteri di accettazione**
- [x] `POST /api/perps/network` rifiuta lo switch a mainnet se `ALLOW_MAINNET !== 'true'`, a
      prescindere dal dialogo di conferma lato client.
- [x] Stessa logica di `validateConfig()`, non una copia — un solo punto da mantenere.
- [x] Test dedicato (`test/mainnetGate.test.js`, 3 casi: assente, valore non esatto, `"true"` esatto).
- [x] `npm test` (197/197) e `npm run lint` verdi, nessuna regressione.

**Approvato dal PO** il 10 agosto.

---

### 🔴 SEC-10 · Notifica di cooldown a raffica, una per tick invece che per episodio

| | |
|:---|:---|
| **Tipo** | 🐛 bug — operativo, ha causato un incidente reale |
| **Story Point** | **1** |
| **Priorità** | P0 |
| **Owner** | Claude (fix diretto, 9-10 agosto) |
| **File** | `src/perps/portfolio.js`, `src/perps/bot.js` |
| **Origine** | PO — incidente reale il pomeriggio del 9 agosto |

**Descrizione.** Dopo 3 perdite consecutive, `portfolio.js` apre un cooldown di 60 minuti per quel
bot. `canOpen()` ritornava lo stesso messaggio "In cooldown fino alle…" a **ogni** tick bloccato —
senza alcun filtro, `bot.js` lo notificava via Telegram ogni volta. Con un tick ogni 10s e un
cooldown di un'ora, fino a **360 notifiche identiche**: il PO ha dovuto chiudere tutte le posizioni
solo per fermare il flusso, un pomeriggio di questo sprint.

**Fix.** `canOpen()` espone ora anche `cooldownUntil` (il timestamp grezzo, non solo la stringa
formattata). `bot.js` lo confronta con l'ultimo episodio già notificato: una notifica per episodio,
non per tick — stesso principio già applicato al watchdog WS (WS-01, Sprint 2).

**Criteri di accettazione**
- [x] Una sola notifica per episodio di cooldown, verificato con 5 tick consecutivi sullo stesso
      episodio → 1 notifica.
- [x] Un nuovo episodio (nuove 3 perdite consecutive) notifica di nuovo normalmente.
- [x] Test dedicato (`test/portfolioCooldownNotify.test.js`, 2 casi), verificato che fallisca senza
      il fix.
- [x] `npm test`/`npm run lint` verdi, nessuna regressione.

**Approvato dal PO** il 10 agosto — priorità massima per essere stato l'incidente che ha aperto la
review.

---

### ⚪️ OPS-02 · Verifica backup/restore sul VPS reale

| | |
|:---|:---|
| **Tipo** | ⚙️ operativo (non sviluppo) |
| **Story Point** | **1** |
| **Priorità** | P0 — sistema live senza alcun backup esistente |
| **Owner** | PO / Claude (accesso diretto al VPS — fuori dal perimetro degli agenti, stesso limite di CHORE-01 in Sprint 2) |
| **File** | `scripts/backup.sh`, `scripts/restore-verify.sh` (già esistenti, nessuna modifica di codice attesa) |
| **Origine** | Claude, deploy 9 agosto — vedi §0.10 |

**Criteri di accettazione**
- [ ] `backup.sh` eseguito almeno una volta sul VPS reale.
- [ ] `restore-verify.sh` eseguito ed esce con codice 0.
- [ ] Se emerge la necessità, valutare l'automazione (cron) come follow-up — non bloccante per questo
      task.

---

### ⚪️ OPS-03 · Monitoraggio esterno (uptime) collegato

| | |
|:---|:---|
| **Tipo** | ⚙️ operativo + configurazione minima |
| **Story Point** | **2** |
| **Priorità** | P1 |
| **Owner** | PO / Claude (stesso limite di accesso VPS di OPS-02) |
| **File** | `docs/DEPLOY.md` §6 |
| **Origine** | Claude, deploy 9 agosto — vedi §0.11 |

**Criteri di accettazione**
- [ ] Servizio di uptime esterno collegato a `/health` sul VPS.
- [ ] Verificato che il servizio scelto riesca a raggiungere l'host dentro la tailnet (agente locale o
      soluzione equivalente) — non dato per scontato.
- [ ] Almeno un test di allerta reale (ferma il container, verifica che arrivi una notifica).

---

### 🟠 STRAT-01 · Archiviazione, esportazione e importazione delle strategie

| | |
|:---|:---|
| **Tipo** | ✨ feature |
| **Story Point** | **3** |
| **Priorità** | P2 |
| **Owner** | Bruno (backend), Maya (UI) |
| **File** | `src/server.js`, `src/db/database.js`, `public/perps.js` |
| **Origine** | PO, 9 agosto — vedi §0.4 |

**Criteri di accettazione**
- [ ] Esportazione di un bot/voce storico come file JSON scaricabile (`config_json` + metadati).
- [ ] Importazione da JSON con **validazione dello schema prima di scrivere** — un file malformato non
      crea un bot con configurazione parzialmente vuota.
- [ ] UI nella sezione storico strategie già esistente (categorizzazione/riciclo/eliminazione, Sprint 2).
- [ ] Test su import di un file valido, uno malformato, uno con campi mancanti.
- [ ] Chiarito in planning (o rimandato a nota) se "archiviazione" richiede altro oltre allo storico già
      esistente.

---

### 🟡 COST-01 · Ottimizzazione dei costi Claude esistenti

| | |
|:---|:---|
| **Tipo** | ⚙️ ottimizzazione |
| **Story Point** | **2** |
| **Priorità** | P2 |
| **Owner** | Bruno |
| **File** | `src/agents/analyst/analyst.js`, `src/config/config.js` |
| **Origine** | PO, 9 agosto — vedi §0.3, punto 1 |

**Criteri di accettazione**
- [ ] Misurata la spesa reale attuale per run (già tracciata in `proposals.cost_usd`) come baseline —
      **prima** di ottimizzare, non dopo.
- [ ] Valutato se `AGENT_ANALYST_MODEL` è il modello giusto per ogni fase, o se una fase più leggera può
      usare un modello più economico.
- [ ] Valutata la cadenza (`AGENT_CADENCE_MIN`) e il cap di iterazioni per margini di risparmio senza
      perdita di qualità delle proposte.
- [ ] Nessuna modifica architetturale (niente astrazione multi-provider — quella è rimandata, §0.3
      punto 2).
- [ ] Risparmio stimato riportato in modo verificabile (baseline vs dopo), non solo dichiarato.

---

### 🟡 SPIKE-01 · Consulente AI di portafoglio — analisi (voce inclusa come mappatura)

| | |
|:---|:---|
| **Tipo** | 🔍 spike — solo analisi, nessun codice di produzione |
| **Story Point** | **3** |
| **Priorità** | P2 |
| **Owner** | Joshua |
| **File** | Nuovo documento in `docs/KB/BACKLOG/` (es. `spike-ai-advisor.md`) |
| **Origine** | PO, 9 agosto — vedi §0.5 (include anche la ricerca LLM verticalizzati, §0.3 punto 3) |

**Criteri di accettazione**
- [ ] Documento di analisi che risponde alle 7 domande elencate in §0.5 (relazione con l'Analyst,
      integrazione UI, dati/strumenti necessari, modello di conversazione e costo, memoria/contesto,
      mappatura opzioni voce, guardrail).
- [ ] Include la ricerca su LLM "verticalizzati sul trading" realmente in produzione (non solo
      paper/demo) — con fonti verificabili, non solo affermazioni.
- [ ] **Vincolo esplicito rispettato nel documento:** il disegno proposto resta strettamente advisory,
      mai un canale che bypassa la coda di approvazione o `riskAgent.js`.
- [ ] **Nessun codice di produzione** — se emergono prototipi utili durante l'analisi, restano fuori dal
      ramo principale o chiaramente marcati come sperimentali.
- [ ] Stima di sforzo/costo per un'eventuale implementazione in Sprint 4, basata sulle risposte date.

---

## 3. Riepilogo e pianificazione

### 3.1 Story point e ordine di esecuzione

| ID | Titolo | Owner | SP | Priorità | Stato |
|:---|:---|:---|:--:|:---:|:---|
| SEC-08 | `_reconcile()` duplica posizione, ordini orfani | Bruno | 3 | P0 | ✅ Fatto — pulizia live eseguita |
| SEC-09 | `ALLOW_MAINNET` non verificata a runtime | Claude | 1 | P0 | ✅ Fatto |
| SEC-10 | Notifica cooldown a raffica | Claude | 1 | P0 | ✅ Fatto |
| SEC-07 | secretBox fail-fast | Joshua | 2 | P0 | ✅ Fatto |
| EVM-01 | Ritiro demo EVM legacy | Maya + Joshua | 3 | P0 | ✅ Fatto — firma reale MetaMask da provare a mano |
| OPS-02 | Verifica backup/restore VPS | PO/Claude | 1 | P0 | ⏳ Non ancora eseguito |
| TG-01 | Comando Telegram kill-switch | Bruno | 2 | P1 | ✅ Fatto |
| LINT-01 | Lint copre `public/*.js` | Joshua | 1 | P1 | ✅ Fatto |
| OPS-03 | Monitoraggio esterno | PO/Claude | 2 | P1 | ⏳ Non ancora eseguito |
| STRAT-01 | Export/import strategie | Bruno + Maya | 3 | P2 | ✅ Fatto |
| COST-01 | Ottimizzazione costi Claude | Bruno | 2 | P2 | ✅ Fatto |
| SPIKE-01 | Spike consulente AI | Joshua | 3 | P2 | ✅ Fatto (analisi) |
| BRAND-01 | Branding stantio | Maya | 1 | P2 | ✅ Fatto |
| | **Totale** | | **25** | | **22/25 SP fatti, 3 in attesa (OPS-02/03)** |

**Sequenza consigliata:** SEC-08 per primo (capitale a rischio, priorità sopra tutto), poi SEC-07 e
OPS-02 (rischio operativo reale su un sistema già live) → EVM-01 (sblocca terreno pulito su
`perps.js` prima di STRAT-01) → il resto in parallelo per owner.

> **Nota:** SEC-08 aggiunta il 9 agosto, **dopo** la chiusura del planning (§0.12) — scoperta durante
> un'analisi dal vivo della piattaforma sul VPS, non nella sessione di planning stessa. Stesso
> trattamento delle scoperte post-review dello Sprint 2 (UI-01): entra comunque nello sprint per
> priorità, senza riaprire l'intera ceremony di planning.

### 3.2 Grafo delle dipendenze

```
SEC-08 ──┐
SEC-07 ──┤
OPS-02 ──┤
TG-01  ──┤
LINT-01 ─┼──► (nessuna dipendenza dura tra loro)
COST-01 ─┤
OPS-03 ──┤
BRAND-01 ┘

EVM-01 ──► STRAT-01   (soft: entrambi toccano public/perps.js — conviene fare EVM-01 prima
                        per non riscrivere due volte la stessa area)

SEC-08 ──► TG-01, STRAT-01   (soft: tutti toccano bot.js/aree adiacenti — SEC-08 per primo
                               evita di costruire su una race condition non ancora chiusa)

SPIKE-01 — indipendente, nessuna dipendenza di codice (è analisi)
```

### 3.3 Dipendenze esterne

| Dipendenza | Task | Natura |
|:---|:---|:---|
| Accesso VPS reale (SSH) | OPS-02, OPS-03 | Fuori dal perimetro degli agenti — eseguito da PO/Claude direttamente, come CHORE-01 in Sprint 2 |
| Servizio di uptime esterno (account) | OPS-03 | 🧑 Decisione umana minima (quale servizio) |
| Wallet reale per test end-to-end | EVM-01 | Serve MetaMask con fondi testnet per verificare il flusso dopo il ritiro del demo |

### 3.4 Risk register di sprint

| # | Rischio | Prob. | Impatto | Mitigazione |
|:--|:---|:---:|:---:|:---|
| R1 | EVM-01 rompe la connessione wallet reale di Perps mentre rimuove il demo | Media | **Alto** | Criteri di accettazione espliciti su cosa deve continuare a funzionare; test end-to-end prima di chiudere |
| R2 | SEC-07 fail-fast rompe un avvio in produzione che si affidava (inconsapevolmente) al fallback | Bassa | Alto | Verifica esplicita sul VPS reale già in Infisical, che non dovrebbe dipenderne |
| R3 | STRAT-01: import di JSON malformato crea bot con config parzialmente vuota | Media | Medio | Validazione schema obbligatoria prima di ogni scrittura, nei criteri di accettazione |
| R4 | SPIKE-01 scivola verso implementazione invece di restare analisi | Media | Basso | Criterio esplicito "nessun codice di produzione"; il PO verifica in review |
| R5 | OPS-02/OPS-03 restano bloccati per mancanza di tempo del PO (non delegabili agli agenti) | Media | Medio | Priorità P0/P1 dichiarata esplicitamente, da fare presto nello sprint non alla fine |
| R6 | SEC-08: il fix della race chiude anche il caso legittimo di adozione (bot riavviato con posizione live non tracciata) | Media | Alto | Criterio di accettazione e test dedicati al caso legittimo, non solo a quello duplicato |
| R7 | SEC-08: i 3 ordini orfani restano sul VPS live finché il task non è chiuso | Bassa (testnet) | Basso ora, alto se fosse mainnet | Non toccare gli ordini live finché il fix non è verificato — evitare cancellazioni manuali alla cieca |

### 3.5 Definition of Done

Per **ogni** task di sviluppo (non OPS-02/OPS-03, che sono operativi):

- [ ] `npm test` verde (suite esistente + eventuali nuove, nessuna regressione).
- [ ] `npm run lint` verde.
- [ ] Commit con messaggio che spiega il perché, non solo il cosa.
- [ ] Documentazione aggiornata se il comportamento osservabile cambia.

Per lo **sprint**:

- [ ] EVM-01 verificato con un flusso reale connetti→approva agent, non solo a occhio sul codice.
- [ ] OPS-02 e OPS-03 completati — un sistema live senza backup né monitoraggio non è uno stato
      accettabile da lasciare aperto oltre questo sprint.
- [ ] SPIKE-01 consegna un documento, non un prototipo abbandonato a metà.

---

## 4. Altri residui aperti, non ancora promossi a candidato

Segnalati durante lo Sprint 2 ma lasciati come nota, non ancora valutati per l'inclusione in questo
sprint — riportati qui per non perderne traccia, si decide in planning se promuoverli:

- `POST /api/agents/killswitch`: `req.body?.on !== false` attiva il kill-switch anche su body malformato o `{"on":"false"}` (stringa). Direzione fail-safe ma da rendere esplicita. (Maya, UI-01)
- Asimmetria di notifica: l'attivazione del kill-switch notifica su Telegram/log, la disattivazione no. (Maya, UI-01)
- `ws_reconnects_total` conta insieme drop reali e ri-sottoscrizioni volontarie da cambio rete — un contatore separato è stato suggerito da Bruno (WS-01, Sprint 2).
- `rotate-encryption-key.js` confronta solo l'id della chiave, non il materiale, per decidere se ri-cifrare — disallineamento silenzioso possibile. (Annie, TEST-01)
- Rating "Sforzo: Basso" per l'apertura del webhook a TrendSpider in `INDEX.md` §1.1, probabilmente sbagliato. (Maya, DOC-02)
- Duplicato AOLM e typo nel nome file in `INDEX.md` §4, residui pre-Sprint-1. (Maya, DOC-02)

---

*Planning chiuso il 9 agosto 2026 (§0.12). Prossimo passo: avvio dell'esecuzione — dispatch degli
agenti sui task assegnati in §2, con lo stesso meccanismo di autonomia (`docs/KB/BACKLOG/sprint3-status/`)
già usato nello Sprint 2.*
