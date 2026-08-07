# Istruzioni di Hardening e Sicurezza (Priorità 1) — ArbitrageBot Perps

Questo documento contiene le specifiche tecniche e le istruzioni operative per implementare le modifiche di **Priorità 1 (Sicurezza e Correttezza)** sul branch `feat/perps-hardening`. 

Caro Claude, conosci già molto bene la codebase di **ArbitrageBot Perps**. Il tuo compito è implementare con il massimo rigore ingegneristico i seguenti 5 compiti di hardening. Per ogni compito sono descritti i file coinvolti, la razionale di sicurezza e le linee guida per lo sviluppo.

---

## Task 1: Audit & Hardening della Supply Chain npm (Mitigazione Malware)
*   **Razionale:** Prevenire attacchi alla supply chain come quello reale avvenuto ai danni del Polymarket Bot (febbraio 2026), in cui pacchetti typosquattati eseguivano script `postinstall` malevoli per esfiltrare file `.env` ed abilitare backdoor SSH locali.
*   **File coinvolti:** `package.json`, `package-lock.json`, `.github/` (workflow CI), `Dockerfile`, nuovo file `.npmrc`.
*   **Istruzioni operative:**
    1.  **Verifica dell'esposizione:** Esegui una scansione di sicurezza automatica o manuale nel progetto per escludere la presenza di pacchetti sospetti noti (es. `levex-refa`, `lint-builder`, `ts-bign`, `big-nunber`).
    2.  **Configurazione `.npmrc`:** Crea o modifica il file `.npmrc` nella root del progetto abilitando `ignore-scripts=true`. 
        *   *Attenzione:* Verifica se ci sono pacchetti fondamentali che richiedono compilazione nativa all'installazione (es. `better-sqlite3`). Se sì, configura l'installazione in modo da consentire selettivamente solo i moduli necessari o compilarli in modo sicuro ed esplicito, bloccando tutti gli altri script postinstall non autorizzati.
    3.  **Transizione a `npm ci`:** Modifica tutti i workflow di integrazione continua (GitHub Actions in `.github/workflows/`) e il `Dockerfile` di produzione per utilizzare rigorosamente `npm ci` invece di `npm install`, garantendo un'installazione deterministica e immutabile basata esclusivamente sul file `package-lock.json`.
    4.  **Audit dei pacchetti:** Aggiungi `npm audit signatures` e un controllo bloccante `npm audit` nei pipeline CI.
    5.  **Linee guida per PR future:** Documenta nel file di sviluppo l'obbligo di ispezionare riga per riga qualsiasi diff che coinvolga `package-lock.json` prima di fare il merge, controllando minuziosamente la reputazione, la data di pubblicazione e l'eventuale presenza di script postinstall nelle nuove dipendenze.

---

## Task 2: Passaggio a Infisical come default per la Gestione dei Segreti
*   **Razionale:** Il file `.env` memorizzato in chiaro sul disco rigido è il bersaglio primario dei malware infostealer. L'uso di un gestore di segreti esterno come **Infisical** permette di iniettare le chiavi direttamente in memoria all'avvio, azzerando il footprint sul filesystem.
*   **File coinvolti:** `package.json`, `DEPLOY.md`, script di avvio.
*   **Istruzioni operative:**
    1.  **Impostazione di Default:** Attualmente nel progetto sono presenti gli script opzionali `start:infisical` e `dev:infisical`. Modifica gli script `start` e `dev` principali in `package.json` affinché utilizzino Infisical come metodo predefinito di recupero delle variabili d'ambiente.
    2.  **Fallback di sicurezza:** Se l'applicazione viene avviata senza Infisical in produzione (ad esempio se un utente prova a forzare l'avvio con un file `.env` locale non cifrato), assicurati che l'app stampi un warning molto visibile nei log, scoraggiando questa pratica per gli ambienti di produzione reali.
    3.  **Documentazione:** Aggiorna `DEPLOY.md` inserendo Infisical come requisito standard per la messa in produzione, spiegando chiaramente come configurarlo e associare le chiavi.

---

## Task 3: Verifica dei Trigger Order per Take Profit (TP) e Stop Loss (SL)
*   **Razionale:** Se il Take Profit e lo Stop Loss sono gestiti solo all'interno del loop in memoria del server (es. nel tick del bot), un crash del server, un disservizio di rete o un riavvio improvviso lascerebbero la posizione aperta totalmente priva di protezione. Hyperliquid permette di registrare questi ordini direttamente sul loro exchange.
*   **File coinvolti:** `src/perps/hyperliquidClient.js`, `src/perps/bot.js`, `src/perps/riskManager.js`.
*   **Istruzioni operative:**
    1.  **Analisi del codice attuale:** Ispeziona approfonditamente la logica di invio degli ordini in `hyperliquidClient.js`. 
    2.  **Registrazione lato Exchange:** Verifica e assicurati che ogni volta che l'utente (o un bot) apre una posizione specificando TP/SL, questi vengano registrati **lato Hyperliquid come trigger order nativi** (e non gestiti esclusivamente dal monitoraggio locale).
    3.  **Gestione del Trailing Stop:** Nel caso di stop dinamici o trailing stop, assicurati che la logica di aggiornamento preveda la cancellazione sicura del vecchio trigger order sul DEX prima (o contestualmente) alla conferma del nuovo trigger order, evitando ordini duplicati o orfani.
    4.  **Test di resilienza:** Simula un arresto anomalo del server per verificare che gli stop inseriti rimangano attivi sul book di Hyperliquid e che proteggano efficacemente la posizione in caso di movimenti avversi del prezzo durante la manutenzione del bot.

---

## Task 4: Verifica della Base di Calcolo per il Position Sizing
*   **Razionale:** Un bug classico nell'integrazione di bot con leva è l'utilizzo del "margine libero" o del "saldo disponibile" (es. `get_cash`) invece del valore totale del portafoglio (`get_portfolio_value`) come base per il calcolo percentuale della dimensione della posizione. Sotto stress o in caso di drawdowns, questo errore causa size sproporzionate e liquidazioni rapide.
*   **File coinvolti:** `src/perps/riskManager.js`.
*   **Istruzioni operative:**
    1.  **Analisi di `sizePosition`:** Trova la definizione della funzione `sizePosition(config, equity, price, ...)` all'interno di `riskManager.js`.
    2.  **Verifica dei Chiamanti:** Rintraccia tutti i punti in cui `sizePosition` viene invocata (es. nel loop del bot a regole, nell'invio di ordini manuali o nell'approvazione delle proposte dell'Analyst AI).
    3.  **Garantire la correttezza del parametro `equity`:** Assicurati matematicamente che l'input fornito come `equity` corrisponda sempre all'**Equity complessiva del conto** (Account Value totale = capitale depositato + PnL non realizzato), e mai al solo margine libero o disponibile.
    4.  **Aggiunta di controlli difensivi:** Inserisci una validazione runtime robusta all'interno di `sizePosition` che sollevi un errore esplicito o rifiuti l'esecuzione se il parametro di equity fornito è nullo, negativo o palesemente incoerente con i dati dell'account.

---

## Task 5: Protezione degli Endpoint Webhook (Autenticazione e Rate Limiting)
*   **Razionale:** L'uso di webhook esterni (es. da TradingView o TrendSpider) per innescare operazioni reali rappresenta una superficie d'attacco critica se l'endpoint è esposto pubblicamente senza adeguate barriere.
*   **File coinvolti:** `src/server.js` (indicativamente attorno alla rotta webhook, linea ~1096).
*   **Istruzioni operative:**
    1.  **Implementazione HMAC:** Proteggi l'endpoint di ricezione dei webhook implementando una validazione rigorosa della firma HMAC nell'header delle richieste. Le chiavi di firma devono essere salvate cifrate nel database o lette in modo sicuro tramite Infisical.
    2.  **Rate Limiting:** Aggiungi un middleware di rate limiting specifico per questa rotta per mitigare attacchi di tipo Denial of Service (DoS) o tentativi di spamming di ordini.
    3.  **Scadenza del Segnale (TTL):** Assicurati che nel controller che elabora il segnale sia implementata e verificata la scadenza massima del payload (il segnale non deve essere eseguito se è trascorso un tempo superiore a 5 minuti dal momento della sua generazione esterna, per evitare esecuzioni tardive dovute a latenze o attacchi di tipo replay).

---

## Protocollo di Sviluppo per Claude
Quando avvii l'implementazione:
1.  **Ispeziona prima di modificare:** Usa comandi read-only per verificare lo stato attuale delle funzioni descritte prima di apportare modifiche.
2.  **Preserva la modularità:** Non alterare la netta separazione tra il motore decisionale (strategy/rules) e i controlli deterministici di rischio (`riskManager.js`, `portfolio.js`).
3.  **Testa a fondo:** Se possibile, esegui i test di integrità dell'applicazione e verifica che non ci siano regressioni sulla gestione dei nonce persistiti o sulla coda di esecuzione (`execQueue.js`).

---

## Esito — Sprint 1 (7 agosto 2026, team Nautilus)

Questo backlog è stato **verificato contro il codice reale** prima dell'implementazione, non eseguito
alla lettera. L'analisi dettagliata, la riprioritizzazione e il piano di esecuzione vivono in
[`docs/KB/BACKLOG/sprint1.md`](sprint1.md) — qui solo l'esito, task per task, perché chi rilegge
questo file non deve doverlo dedurre.

- **Task 1 (supply chain npm)** → confermato reale. Implementato come **SEC-02** (`.npmrc`,
  rebuild mirato di `better-sqlite3`, ispezione dello script di `hyperliquid`) e **SEC-03**
  (`npm audit`, `npm audit signatures`, `harden-runner` pinnato a SHA, `CONTRIBUTING.md`). ✅ Fatto,
  in review.
- **Task 2 (Infisical di default su `npm start`)** → **non implementato come scritto**: la proposta
  avrebbe rotto lo sviluppo locale e duplicato una logica già corretta in
  `scripts/docker-entrypoint.sh`/`scripts/restart.sh`. Accolta solo la parte utile — il warning —
  come **SEC-06**. ✅ Fatto, in review.
- **Task 3 (TP/SL solo nel loop locale)** → **chiuso: la premessa era falsa.** I trigger sono già
  nativi su Hyperliquid in ogni percorso (ordini manuali, bot, trailing con sequenza
  place-then-cancel). La verifica ha però fatto emergere un buco reale e più specifico: dopo
  un'aggiunta DCA i trigger non venivano ri-piazzati sulla size aggiornata. Diventato **SEC-01**
  (P0) — l'unico task di questo sprint con capitale realmente a rischio. ✅ Fix implementato, test
  end-to-end verde, in review. **Resta da fare:** verifica su testnet Hyperliquid con un ciclo DCA
  reale (fuori dal perimetro di un agente automatico).
- **Task 4 (base di calcolo del sizing)** → **chiuso: il bug non esisteva.** `sizePosition` usa già
  l'equity totale del conto, non il margine libero. Aggiunto solo il guard difensivo mancante
  (**SEC-05**) per input non validi (`NaN`/`undefined`/negativi). ✅ Fatto, in review.
- **Task 5 (webhook esposto pubblicamente)** → **chiuso: la premessa era invertita.** L'endpoint è
  già dietro autenticazione, rate limit e secret opzionale — il problema reale era l'incoerenza tra
  questo e la documentazione, che lo presentava come pronto per TradingView/TrendSpider. Implementata
  **SEC-04**, opzione B (raccomandata): documentazione corretta, commento esplicativo nel codice,
  confronto del secret a tempo costante. Nessuna nuova superficie d'attacco aperta. ✅ Fatto, in
  review.

**Squadra:** Joshua (Team Leader), Bruno (Backend Senior), Maya (Frontend Senior), Annie (QA &
Analyst) — coordinati in parallelo su file disgiunti, nessuna sovrapposizione. 66/66 test verdi,
lint verde, sull'insieme combinato delle modifiche dopo un `npm ci` pulito. Nessun commit, nessun
push: le modifiche restano nel working tree per la review.
