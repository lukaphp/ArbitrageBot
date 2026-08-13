# Demo operativa isolata VPS — istanza :8091 (testnet Hyperliquid)

Memoria persistente tra sessioni di dispatch successive. Aggiungere sempre in coda con timestamp, non riscrivere le sezioni precedenti.

## Contesto fisso (non ricontrollare ogni volta)
- Istanza: `http://127.0.0.1:8091` via SSH `arbitragebot-vps`, container separato da produzione (:8080).
- Login: `POST /api/login` con password `SzUDHV84rdR`, cookie di sessione riutilizzabile (stesso meccanismo `src/middleware/auth.js`).
- Rete: Hyperliquid **testnet**, `ALLOW_MAINNET` non impostato.
- `masterAddress` (stesso wallet dei 4 bot reali, agent wallet già approvato su questa istanza): `0x55dde41417dd529e51b173916b7fafef86573e72`
- Agent address derivato: `0xd27299324bb713fe00767d06b3243a5d8f49bbf2`, `approved_at` valorizzato.
- Equity iniziale (prima di qualunque bot): **$977.56** (`spotUsdc`=977.564181, `accountValue`=0 — nessun margine perp ancora allocato).
- Notifiche Telegram non configurate su questa istanza — stato va letto da `/api/perps/risk`, non da Telegram.
- `AGENTS_ENABLED=false` — nessun Analyst/Advisor AI attivo, solo motore di trading.
- **Container Docker corretto per l'accesso DB: `demo-app-1`** (non `app-app-1`, che è produzione — stesso host, container diversi). Comando: `ssh arbitragebot-vps "sudo docker exec demo-app-1 node -e \"...\""`. Path DB: `/app/data/perps.db` dentro il container, `better-sqlite3`. Tabella bot: colonna config è `config_json`. Tabelle rilevanti: `positions` (bot_id, coin, side, size, entry_px, leverage, tp_px, sl_px, trailing_json, status, pnl, opened_at, closed_at, fee, close_reason), `trades` (solo fill di apertura, non di chiusura — verificato: ogni riga trades corrisponde 1:1 a un opened_at di positions, mai a un closed_at), `risk_equity_history` (network,address,ts,equity — **buffer corto, ~180 righe / ~3h, non l'intero storico dal boot**), `risk_drawdown_state` (peak/current/max_drawdown, persistito e non limitato alle stesse 3h del history), `audit` (azioni AI/manuali — vuoto in questa demo, coerente con `AGENTS_ENABLED=false`).
- **Il worktree isolato di questa agent è spesso indietro rispetto a `feat/perps-hardening`** (visto anche da Annie/Bruno/Joshua/Maya) — controllare `git log --oneline -5` e `git merge-base --is-ancestor HEAD feat/perps-hardening` a inizio sessione, `git merge --ff-only feat/perps-hardening` se serve, PRIMA di leggere memoria/codice/backlog (altrimenti questo stesso file può risultare vuoto o vecchio nel worktree pur esistendo aggiornato sul repo condiviso).

---

## Sessione 1 — 2026-08-11, ~22:40–22:50 UTC

### Cosa ho verificato prima di agire
- `GET /api/perps/agent/status` **richiede** `?address=` in query string — senza, risponde 400 `{"success":false,"error":"address richiesto"}`. Non è ovvio dalla sola chiamata senza parametri (nessun hint nel messaggio su quale parametro manca esattamente, ma il messaggio è comunque corretto e in italiano chiaro).
- `GET /api/perps/bots` → `[]` (0 bot, come atteso).
- `GET /api/perps/risk` → stato pulito, tutti zero, `alerts: []`, nessun `sourceErrors`.
- Letti in sola lettura 4 bot reali di produzione (tutti con `status: "stopped"` al momento della lettura — nota a margine, non è compito mio indagare perché in questa sessione, ma è uno scostamento rispetto a "4 bot reali attivi" che vale la pena segnalare se rilevante altrove) per capire lo schema `config_json` reale: `direction`, `candleInterval`, `logic`, `entryRules[]`, `exitRules[]`, `leverage`, `sizing{mode,value}`, `tp/sl/trailing{enabled,mode,value}`, `risk{maxDailyLossUsd,maxPositionUsd}`, `preset{strategy,risk}`, `paper`.
- Letto `botManager.createBot()` (`src/perps/botManager.js`): **nessuna validazione di forma della config** lato server. Accetta `config || {}` e lo persiste così com'è — un config vuoto o malformato crea comunque un bot che semplicemente non troverà mai un segnale (o fallirà più a valle, al tick). Nessun 400 ti guida verso lo schema corretto: l'ho ricostruito solo leggendo `strategyEngine.js` + un config reale di produzione.
- Letto `riskManager.checkLimits`/`sizePosition`: leva max globale 20x (`PERPS_MAX_LEVERAGE`), `maxPositionUsd` globale $5000, `maxDailyLossUsd` globale $1000 (default se il bot non li restringe). `portfolio.js`: `maxConsecutiveLosses=3`, `cooldownMinutes=60` (limiti globali, confermati anche da `/api/perps/risk.limits`).

### Bot creati

**1. `JORDAN-BTC-RSI-demo`** (id `c5ff3f81-bb12-4b72-bcbb-feb8509bc686`)
- Mercato: BTC-PERP (maxLeverage exchange 40x, molto liquido, l'asset macro meno idiosincratico del book).
- Motivazione: **replica diretta** della strategia RSI reversal già in produzione (bot "AI NEAR-PERP", preset `rsi_reversal`/`moderato`) — stessa logica di regola (RSI 14, <30 long / >70 short, 15m, logic `any`) ma su un mercato diverso da quelli già usati in produzione (NEAR/SOL), per un confronto diretto sul comportamento della stessa logica senza sovrapporsi ai dati storici già analizzati in `business-analysis-2026-08-11.md`.
- Config: leva 3x, sizing 5% equity (più conservativo del 10% di produzione — prima verifica operativa end-to-end, non validazione di strategia), TP 3% / SL 1.5% / trailing 1%, cap per-bot `maxPositionUsd=$300`, `maxDailyLossUsd=$50` (basso apposta: se qualcosa si comporta in modo inatteso, voglio che si fermi presto, non dopo aver bruciato $1000 di cap globale).

**2. `JORDAN-AAVE-MACD-demo`** (id `5724d887-370e-4969-9c1c-a521ad0687ed`)
- Mercato: AAVE-PERP (DeFi blue-chip, settore diverso da BTC — scelta deliberata per NON concentrare il rischio su due asset macro-correlati, coerente con la mia stessa lente di portafoglio multi-mercato).
- Motivazione: **strategia diversa** per ampliare l'osservazione (indicatore MACD invece di RSI), stesso schema di regola già visto in produzione sul bot "AI SOL-PERP" (preset MACD bullish/bearish), ma su un mercato distinto.
- Config: leva 2x, sizing 5% equity, TP 1.5% / SL 1% / trailing disattivato (come da config produzione originale), cap `maxPositionUsd=$250`, `maxDailyLossUsd=$50`.

Entrambi creati fermi (`status: stopped`, nessun `warning` di sovrapposizione mercato — ovvio, erano i primi due bot). Poi avviati via `POST /api/perps/bots/:id/start` → entrambi `status: running` senza errori.

### Esito primo tick (~15s dopo l'avvio, `botLoopInterval`=10s)

- **BTC-RSI**: `hold`, "Nessun segnale d'ingresso" — RSI(14) a 41.27, lontano da entrambe le soglie (30/70). Comportamento atteso: **non apre finché la soglia non viene attraversata**. Nessun errore, nessun tick fallito.
- **AAVE-MACD**: **ha aperto una posizione LONG reale al primissimo tick**, prima ancora che potessi osservare qualcosa. Size 1.1 AAVE @ entry 88.137 (~$96.9 notional, leva 2x, margine ~$48.4 ≈ 5% equity come atteso), con TP (Take Profit Market, oid `57734472446`, trigger 89.459) e SL (Stop Market, oid `57734472811`, trigger 87.256) piazzati **atomicamente sull'exchange** insieme all'apertura. Confermato via `/api/perps/orders` (risk snapshot): 2 ordini trigger reali, non simulati.

### Osservazione tecnica importante: MACD "cond" è uno stato, non un evento di incrocio

Letto `strategyEngine.js` riga ~110-116: `cond: 'bullish'` matcha semplicemente `histogram > 0`, `'bearish'` matcha `histogram < 0`. **Non è un rilevamento di attraversamento** (cross sopra/sotto zero), è una lettura dello stato corrente ad ogni tick. Con `logic: 'any'` e due regole opposte (long-se-bullish, short-se-bearish), **una delle due è quasi sempre vera** a meno che l'istogramma sia esattamente zero — quindi il bot apre quasi certamente alla primissima valutazione utile se il warm-up delle candele è già pronto (qui lo era: 301 candele disponibili subito, warm-up istantaneo).

Risultato pratico osservato: il bot non ha "aspettato un segnale", ha aperto perché il MACD era già in un regime bullish nel momento in cui il bot è stato avviato. Questo è un comportamento sostanzialmente diverso da "il MACD attraversa lo zero, apro" — è più vicino a "se il MACD è in un certo regime quando (ri)avvio il bot, apro subito". **Lo stesso identico shape di regola è usato nel bot di produzione "AI SOL-PERP" (id `f85a57a0`, preset MACD)**: se quel bot viene fermato e riavviato mentre il MACD è in un regime definito, si può aspettare lo stesso comportamento di apertura immediata — cosa che dalla sola lettura statica della config non era evidente (la config dice solo "bullish"/"bearish", non chiarisce che è uno stato persistente e non un evento).

**Non è un errore del sistema** — è una scelta di design legittima (trend-following "sei in un regime, seguilo"), ma è una sorpresa operativa reale rispetto a quello che ci si aspetterebbe leggendo "MACD crossover" come nome della strategia. Vale la pena che la PO ne sia consapevole quando decide se/come riavviare bot MACD esistenti.

**Aggiornamento sessione 2**: questa ipotesi è ora **confermata empiricamente 3 volte su 3** — ogni chiusura di posizione AAVE-MACD (TP o SL) è stata seguita da una riapertura entro ~3 secondi, per tutta la durata osservata. Non è più solo una lettura di codice, è un pattern osservato ripetutamente sui dati reali (vedi sessione 2).

**Aggiornamento sessione 3**: pattern ora **5 volte su 5** (vedi sessione 3) — resta un comportamento sistematico, non un caso isolato.

### Osservazione da verificare con ingegneria (NON un'azione mia, solo segnalazione dati)

Dopo l'apertura della posizione AAVE, ho confrontato `/api/perps/account` prima e dopo:

| | prima (nessuna posizione) | dopo apertura (t+15s) | dopo apertura (t+35s) |
|---|---|---|---|
| `accountValue` | 0 | 48.42 | 48.48 |
| `spotUsdc` | 977.564181 | 977.447954 | 977.505154 |
| `equity` (=accountValue+spotUsdc) | 977.564181 | 1025.868304 | 1025.982704 |
| `withdrawable` | 0 | 0 | 0.0099 |

`spotUsdc` è calato solo di ~$0.06-0.12 (coerente con fee/pnl realizzato, `pnl.realized=-0.0436`), **non** dei ~$48.4 di margine impegnato nella posizione. Il campo `equity` calcolato come `accountValue + spotUsdc` (in `hyperliquidClient.js getAccount()`) è salito di ~$48.4 rispetto al pre-apertura, cioè sembra **contare due volte** il margine: una volta dentro `accountValue` (il margine perp allocato) e una volta ancora dentro `spotUsdc` (che non si è ridotto a compensare). Ho aspettato 20s in più per escludere un semplice ritardo di sincronizzazione WS/API: il valore non si è assestato, resta stabile a ~1025.9.

Non ho gli elementi per dire con certezza se è un bug del codice o una caratteristica nota del modello di margine unificato di Hyperliquid testnet (dove magari `accountValue` da `clearinghouseState` include già il collaterale spot, rendendo la somma un doppio conteggio). **Segnalo il fatto grezzo, non la diagnosi**: se è un doppio conteggio reale, il sizing (`riskManager.sizePosition`, che usa esattamente questo `equity`) tenderebbe a **sovradimensionare progressivamente le posizioni future** man mano che più bot aprono posizioni contemporanee, perché l'equity apparente cresce ad ogni margine allocato invece di restare costante. Con le size attuali (~5% equity, cap per-bot $250-300) l'impatto immediato è piccolo, ma su un arco di più bot/più giorni potrebbe non esserlo. Anche `withdrawable` è sceso quasi a zero (~$0.01) per una posizione che impegna solo ~5% dell'equity nominale — anche questo è coerente con l'ipotesi di doppio conteggio (il sistema pensa di avere meno margine libero di quanto ne abbia davvero, oppure il margine cross-account è trattato in modo che non mi aspettavo). **Da verificare con Bruno/ingegneria contro la documentazione reale del modello di margine Hyperliquid**, non è nel mio mandato deciderlo né tantomeno correggerlo.

**Aggiornamento sessione 2 — CONFERMATO ED È STATO CORRETTO NEL CODICE (non ancora su questa demo)**: Bruno ha confermato l'ipotesi come bug reale, **CRIT-05** (`docs/KB/BACKLOG/release2/README.md`), e in data odierna (2026-08-12) lo ha **corretto** in `riskManager.composeEquity()` = `accountValue + (spot.total − spot.hold)` invece di `accountValue + spotUsdc` (memoria di Bruno: `project_equity-doppio-conteggio-spot.md`). **Il fix non è deployato su questa istanza demo** (immagine Docker `demo-app-1` costruita prima del fix) — quindi tutto quello che leggo da `/api/perps/risk.account.equity` e da `risk_equity_history`/`risk_drawdown_state` su questa istanza **ha ancora il doppio conteggio attivo** e va trattato come inattendibile per valori assoluti di equity/drawdown, finché la demo non viene aggiornata. Vedi sessione 2 per una conferma quantitativa concreta di come il bug si compone quando più bot hanno posizioni aperte insieme, e per la ricostruzione dell'equity "vera" a partire dai PnL di posizione (che restano attendibili, vedi sotto).

**Aggiornamento sessione 3 — FIX DEPLOYATO E VERIFICATO SULLA DEMO** (sera 12/08, vedi sessione 3): il doppio conteggio non è più presente nelle letture correnti. Trattare questa intera sotto-sezione come storico del bug, non come stato attuale.

### Frizioni operative annotate (esperienza da operatore, non da chi legge il codice)

1. **Nessuna UI grafica su questa istanza** (o comunque non usata in questo giro, tutto via API): creare un bot da zero via `POST /api/perps/bots` richiede aver letto tre file sorgente diversi (`server.js`, `botManager.js`, `strategyEngine.js`) più un esempio di config reale per sapere la forma esatta. Non c'è validazione né schema esposto dall'endpoint stesso — un tentativo con un campo sbagliato non darebbe un errore utile a creazione, solo un bot che non fa nulla o fallisce silenziosamente più avanti.
2. **`GET /api/perps/bots/:id/monitor` è ottimo**: messaggi diagnostici già in linguaggio naturale ("RSI(14) attuale 41.27, target < 30, deve scendere di 11.27 pt") — questo endpoint da solo racconta più chiaramente lo stato del bot di quanto farebbe leggere il codice. Buon contrasto rispetto al punto 1: la creazione è opaca, l'osservazione è invece molto chiara.
3. **`/api/perps/risk` è una buona fonte unica** per lo stato di rischio aggregato senza Telegram — confermato che alerts/summary/drawdown/pnl sono tutti lì, coerente con quanto descritto nel task.
4. Ordini bracket (TP+SL) piazzati **atomicamente** insieme all'apertura, confermati con oid reali sull'exchange — buon segnale di robustezza dell'esecuzione end-to-end su testnet.

### Stato a fine sessione 1 (~22:50 UTC 2026-08-11)
- 2 bot `running`, 0 `tickErrors`, 0 `lastError` su entrambi.
- BTC-RSI: nessuna posizione, in attesa di soglia RSI.
- AAVE-MACD: 1 posizione long aperta, TP/SL reali piazzati, PnL non realizzato -$0.015/-$0.07 (rumore di spread/fee iniziale, non un segnale di nulla).
- Nessun alert critico/warning in `/api/perps/risk.summary` (`status: "ok"`, 0 critical, 0 warning).

---

## Sessione 2 — 2026-08-12, ~19:40 UTC (check-in ~21h dopo l'avvio dei bot)

Nota temporale: il task di check-in parlava di "~12h dall'avvio"; i timestamp reali mostrano che sono trascorse **~21 ore** dall'avvio (sessione 1 22:41 UTC 11/08 → questa lettura 19:40 UTC 12/08). Segnalo lo scarto, non lo correggo — irrilevante per l'analisi, ma preferisco essere precisa sui tempi osservati piuttosto che assumere l'intervallo dichiarato nel prompt.

### Stato bot al momento della lettura

**`JORDAN-BTC-RSI-demo`**: `running`, 0 `lastError`, `tickErrors: 5` (vedi sotto — errori storici, non correnti). **1 posizione LONG aperta** (id 3): entry 63524, size 0.00242 BTC, aperta 2026-08-12 14:02:38 UTC, TP 65429.72 / SL 63001. Ancora aperta al momento della lettura, prezzo corrente ~63112.5, PnL non realizzato ≈ -$0.93/-0.97 (piccola oscillazione tra letture ravvicinate, rumore di prezzo). RSI(14) attuale 39.07, risalito rispetto alla soglia di ingresso. **0 trade chiusi finora** — un solo trade in ~21h, coerente con l'attesa: RSI reversal è selettiva, aspetta davvero l'attraversamento soglia (comportamento opposto a MACD, vedi sotto).

**`JORDAN-AAVE-MACD-demo`**: `running`, 0 `lastError`, `tickErrors: 5`. **1 posizione SHORT aperta** (id 5): entry 89.27, size 1.14 AAVE, aperta 2026-08-12 15:11:41 UTC, TP 87.93095 / SL 90.1627. PnL non realizzato ≈ +$0.68/+0.70. **3 trade chiusi nelle ultime 21h** (stats bot: trades=3, wins=1, winRate=33%, profitFactor=0.57, totalPnl=-$1.024435, totalFees=$0.268205) — molto più turnover del bot BTC, confermando l'osservazione di sessione 1 sul MACD "stato, non evento".

### Storico completo posizioni AAVE-MACD (da query diretta su `positions`, non solo dagli stats aggregati)

| # | side | entry | size | aperta (UTC) | chiusa (UTC) | durata | close_reason | pnl netto |
|---|------|-------|------|---------------|---------------|--------|--------------|-----------|
| 1 | long | 88.137 | 1.10 | 11/08 22:47:46 | 12/08 02:03:45 | 3h16m | **take profit eseguito** | **+$1.333** |
| 2 | long | 89.508 | 1.09 | 12/08 02:03:47 | 12/08 14:34:46 | 12h31m | **stop loss eseguito** | **-$1.115** |
| 4 | short | 88.554 | 1.16 | 12/08 14:34:48 | 12/08 15:11:38 | 36m50s | **chiusura manuale o esterna** ⚠️ | **-$1.243** |
| 5 | short | 89.27 | 1.14 | 12/08 15:11:41 | — (aperta) | 4h29m+ | — | +$0.68 (non realizzato) |

Verificato che la somma dei pnl delle posizioni chiuse (1.333−1.115−1.243 = -1.024) torna **esattamente** con `dailyPnl`/`stats.totalPnl` del bot (-1.024435) e che la somma dei `fee` (0.088+0.087+0.093=0.268) torna con `stats.totalFees` (0.268205). **Le statistiche a livello bot sono calcolate dai PnL di posizione reali, non dal campo `equity` (quello sì rotto da CRIT-05, vedi sotto) — sono attendibili anche su questa istanza non ancora aggiornata.**

**Pattern "riapertura immediata" confermato 3 volte su 3**: ogni chiusura è seguita da una nuova apertura entro 2-3 secondi (22:03:45→02:03:47, 14:34:46→14:34:48, 15:11:38→15:11:41). Non è più un'ipotesi da lettura di codice (sessione 1), è un comportamento osservato ripetutamente sui dati.

### Sorpresa operativa nuova: `close_reason: "chiusura manuale o esterna"` sulla posizione #4

Nessuna azione manuale mia né di terzi risulta nella tabella `audit` (vuota nella finestra, coerente con `AGENTS_ENABLED=false` — ma questa tabella potrebbe non registrare comunque chiamate dirette all'exchange, quindi "vuota" non è una prova definitiva di assenza di intervento esterno).

Ho letto la spiegazione del bucket in memoria di Bruno (`project_close-reason-non-distingue-tp-da-sl.md`, fix Sprint 4): dallo Sprint 4 il sistema **deduce** TP vs SL vs manuale confrontando l'`oid` del fill di chiusura con `slOid`/`tpOids` registrati per quella posizione (in `trailing_json`). `manual_or_external` non è "non so", è "ho trovato un fill di chiusura ma il suo oid non corrisponde a nessuno dei trigger che avevo piazzato per **questa** posizione" — diverso da `trigger_or_external` (nessun oid tracciabile).

Ho ricostruito il prezzo di uscita dalla posizione #4 dal pnl netto (formula verificata sulle altre righe): entry 88.554, pnl -1.243, fee 0.093, size 1.16 → uscita stimata ≈ **$89.545**, cioè **~0.12% sopra** il suo stesso `sl_px` (89.43954) registrato in `trailing_json` (slOid `57764170230`). Il prezzo è coerente con "lo SL è scattato" (stesso ordine di grandezza di slippage delle altre chiusure SL osservate: posizione #2 ha chiuso ~0.05% oltre il suo sl_px). **Quello che non torna è solo l'attribuzione dell'oid**, non la dinamica di prezzo.

**Segnalo il fatto grezzo, non la diagnosi** (stessa disciplina della segnalazione CRIT-05 in sessione 1): sembra un caso limite di riconciliazione oid-chiusura, non un evento di prezzo anomalo né una chiusura davvero manuale che io possa attribuire a qualcuno. Non ho controllato i log applicativi per una spiegazione più precisa (fuori mandato, verifica per Bruno) — ho verificato che la finestra di questa chiusura (14:34–15:11 UTC 12/08) **non coincide** con l'unica interruzione di rete osservata in questa sessione (vedi sotto, 02:44–02:45 UTC), quindi non è la stessa causa.

**Aggiornamento sessione 3**: nessuna nuova occorrenza — le 2 chiusure successive (#5 take profit, #6 stop loss) hanno entrambe `close_reason` corretto e coerente. Resta un caso isolato 1/5, non un pattern ricorrente.

### Errori di tick: 502 Bad Gateway, esterni, autorisolti

`tickErrors: 5` su entrambi i bot **non riflette lo stato attuale** — sono tutti storici, concentrati in una finestra di 47 secondi (2026-08-12 02:44:35–02:45:22 UTC), 13 righe di log `502 Bad Gateway` (nginx) provenienti dal gateway **testnet di Hyperliquid stesso**, non dal nostro stack. Nessun errore di alcun tipo da allora (~17h consecutive pulite al momento della lettura). Entrambi i bot si sono ripresi automaticamente senza intervento: buon segnale di resilienza del loop (`bot.js` non si è bloccato né ha perso lo stato per un'interruzione API esterna transitoria).

**Nota UX**: gli alert in `/api/perps/risk.alerts` per questi tick error restano "warning" attivi tuttora (`summary.status: "review"`, 2 warning) anche se l'evento è chiuso da 17 ore — il contatore `tickErrors` sembra essere lifetime/cumulativo, non una finestra recente. Non è un problema di rischio reale in questo momento, ma vale la pena saperlo per non leggere "review" come "problema in corso" quando si guarda il pannello senza contesto temporale.

**Aggiornamento sessione 3**: la domanda "si auto-risolve?" è rimasta **non risolvibile con questi dati** — il container demo è stato ricostruito/riavviato la sera del 12/08 per il deploy CRIT-05, il che ha azzerato anche lo stato in-memory degli alert insieme alle tabelle equity/drawdown. `tickErrors` in sessione 3 riparte da 0 su entrambi i bot e `summary.status` è di nuovo `"ok"` — ma questo è confuso col riavvio stesso, non è una prova che il contatore lifetime "si autorisolva" col tempo senza riavvio. Domanda di design ancora aperta, non testabile su questa istanza senza un nuovo episodio di tick error che non coincida con un riavvio.

### CRIT-05 in azione: conferma quantitativa del doppio conteggio composto

`/api/perps/risk.account` in questo momento: `accountValue=102.59`, `spotUsdc=976.17`, `equity (=accountValue+spotUsdc)=1078.76`, `totalMarginUsed=101.47`. `spotUsdc` è sceso solo di ~$1.4 dall'iniziale $977.56 (coerente con fee+pnl netto reali), **non** dei ~$101 di margine effettivamente allocato su BTC+AAVE insieme — il margine risulta ancora contato sia in `accountValue` sia (non decurtato) in `spotUsdc`, esattamente come segnalato in sessione 1, e ora **con due bot aperti contemporaneamente il doppio conteggio si somma** (~$101 invece dei ~$48 di un solo bot osservati in sessione 1) — conferma quantitativa dell'ipotesi di composizione già avanzata allora.

**Il drawdown riportato da `risk_drawdown_state` è a sua volta un artefatto dello stesso bug**, non una perdita reale: `peak_equity=1079.86`, `max_drawdown_usd=53.07` (4.91%). Il picco coincide temporalmente con il momento in cui **entrambi** i bot avevano posizioni aperte (massimo doppio conteggio); il calo di ~$53 corrisponde plausibilmente alla chiusura temporanea di una posizione (es. quando AAVE è rimasta piatta per 2-3 secondi tra una chiusura e la riapertura, o a un solo bot in posizione), che fa sparire metà del doppio conteggio, **non a un vero drawdown di capitale**. Coerente con quanto Bruno ha già documentato come conseguenza nota di CRIT-05 ("drawdown fittizio alla chiusura, perché `account.equity` è persistito in `risk_equity_history`").

**Equity "vera" ricostruita** (capitale iniziale + somma pnl di posizione reali, che sono attendibili come verificato sopra):
`977.564181 (iniziale) − 1.024435 (pnl netto AAVE chiuse) − ~0.93 (BTC non realizzato) + ~0.68 (AAVE non realizzato) ≈ $976.29`
→ variazione netta stimata in ~21h: **-$1.27, circa -0.13%**, sostanzialmente piatto — molto lontano dal +$101 (+10.3%) che il pannello di rischio mostrerebbe leggendo `equity` così com'è. Questa è una stima con margine d'errore piccolo (non ho il valore esatto di `spot.hold` per calcolare `composeEquity()` come farebbe il codice corretto), ma l'ordine di grandezza è netto e la direzione (quasi-flat, non un guadagno a due cifre) è quella su cui baso la lettura operativa.

**Nessun limite di rischio è stato messo sotto stress reale**: `maxConsecutiveLosses=3` non ancora raggiunto (AAVE ha 2 perdite consecutive attuali — #2 e #4 — dopo il win #1; una terza perdita di fila testerebbe per la prima volta il cooldown di 60 minuti, cosa che finora non è mai successa su questa demo). `maxPositionUsd`/`maxDailyLossUsd` per-bot ampiamente rispettati (BTC $152.8/$300 notional, AAVE $101.1/$250; PnL giornalieri ben sotto i $50 di cap). `maxConcurrentPositions=3` globale, 2 posizioni aperte in totale — margine ancora disponibile per verificare il limite se un terzo bot venisse aggiunto.

**Aggiornamento sessione 3 — verificato coerente ex post**: l'equity "vera" ricostruita qui a mano (~$976.29) e il valore letto direttamente dal pannello dopo il deploy del fix (~$977.48, vedi sessione 3) differiscono solo di ~$1.19 — entro il margine d'errore che avevo già dichiarato (mancanza del valore esatto di `spot.hold`). Buona conferma incrociata indipendente che sia la ricostruzione manuale sia il fix erano corretti.

### Stato a fine sessione 2 (~19:40 UTC 2026-08-12)
- 2 bot `running`, entrambi con posizione aperta, 0 errori nelle ultime ~17h (i `tickErrors:5` sono storici, da un'interruzione esterna di Hyperliquid testnet auto-risolta).
- AAVE-MACD: campione di 3 trade chiusi, 1 vinto/2 persi, PnL netto -$1.02 — **campione troppo piccolo per concludere qualunque cosa sulla strategia**, lo dico esplicitamente qui per non doverlo ripetere sotto pressione domani. Da segnalare (non diagnosticare): una chiusura su 3 classificata `manual_or_external` invece di `sl`, pur con prezzo di uscita coerente con lo SL — verifica per Bruno.
- BTC-RSI: 1 trade tuttora aperto, 0 chiusi — **zero base per qualunque conclusione**, nemmeno un'osservazione debole.
- CRIT-05 (doppio conteggio equity) confermato ancora attivo su questa istanza (fix non deployato), ora osservato **comporsi** con più bot in posizione simultanea (~$101 di sovrastima vs ~$48 con un bot solo in sessione 1). Drawdown riportato dal sistema (4.91%/$53.07) è un artefatto dello stesso bug, non una perdita reale. Equity vera stimata: sostanzialmente piatta (~-0.13%) contro il +10.3% mostrato dal pannello.

### Prossima sessione (check-in finale, domani sera) — cosa controllare
- Se la demo è stata aggiornata all'immagine con il fix CRIT-05 deployato — se sì, **tutti i numeri di equity/drawdown letti finora vanno ricalibrati** (probabile salto verso il basso di ~$100 nella serie storica, non è una perdita, vedi memoria di Bruno).
- Se AAVE-MACD raggiunge una terza perdita consecutiva: verificare se il cooldown di 60 minuti scatta davvero (mai testato finora su questa demo).
- Se BTC-RSI apre finalmente un secondo trade (o chiude il primo) — al momento resta a campione zero/uno, non tirare conclusioni.
- Chiarire con Bruno la causa della chiusura #4 classificata `manual_or_external` (oid di chiusura non corrispondente al proprio SL, ma prezzo coerente con SL).
- Verificare se il flag di alert "review" (tick error storici) si è auto-risolto o resta appeso indefinitamente — utile per capire se è un problema di progettazione dell'alert, non solo una curiosità di questa sessione.

---

## Sessione 3 — 2026-08-13, ~08:29 UTC (check-in ~24h dichiarate, ~33h48m reali dall'avvio bot; ~12h49m dalla sessione 2)

Worktree di dispatch trovato indietro di ~30 commit rispetto a `feat/perps-hardening` (memoria/backlog condivisi assenti nel checkout iniziale) — allineato con `git merge --ff-only feat/perps-hardening` prima di leggere qualunque cosa, coerente con la lezione già in memoria (vedi `environment_worktree-behind-shared-branch.md`) e ora anche annotata nel "Contesto fisso" qui sopra.

### CRIT-05: fix confermato deployato e corretto sui dati reali

Commit `2198c90` (12/08 22:49 UTC, PO): immagine ricostruita con il fix, `risk_equity_history`/`risk_drawdown_state` troncate sulla sola demo, container riavviato; un residuo di scrittura in corsa col riavvio (una riga con equity ancora gonfiata) trovato e rimosso in seduta.

Verificato di persona sui dati attuali, non solo sul commit: `/api/perps/risk.account` ora mostra `accountValue=100.38`, `spotAvailable=877.09` (=`spotUsdc`−`spotHold`=977.42−100.33), `equity=977.4757` — **combacia esattamente** con `accountValue + spotAvailable = 100.38+877.09=977.47`, non più con `accountValue+spotUsdc` (che darebbe ~1077.8). Il doppio conteggio non c'è più nella formula in uso. `risk_drawdown_state`: `peak_equity=980.10`, `current=977.47`, `max_drawdown_usd=3.96` (0.40%), `current_drawdown_usd=2.63` (0.27%) — numeri piccoli e sani, coerenti con un conto sostanzialmente piatto, non più l'artefatto da $53/4.91% di sessione 2. `risk_equity_history` riparte da 180 righe con `MIN=977.38`/`MAX=978.10` — range coerente, nessun salto residuo.

**Cross-check indipendente**: l'equity "vera" che avevo ricostruito a mano in sessione 2 (~$976.29, da capitale iniziale + PnL di posizione reali) e questa lettura diretta post-fix (~$977.48) differiscono di ~$1.19 — dentro il margine d'errore che avevo già dichiarato allora. Buona conferma che sia la ricostruzione manuale sia il fix deployato sono coerenti tra loro.

**Da qui in avanti, come da istruzione del dispatch, tratto le letture di equity/drawdown come attendibili** e non le sconto più.

### Stato bot al momento della lettura

**`JORDAN-BTC-RSI-demo`**: `running`, 0 `tickErrors`, 0 `lastError`. Stessa posizione LONG aperta dalla sessione 2 (id 3, entry 63524, size 0.00242 BTC, aperta 12/08 14:02:38 UTC — ora aperta da **~18h27m**), TP 65429.72 / SL 63111 (SL leggermente alzato da 63001 osservato in sessione 2, presumibilmente trailing — coerente con `trailing.enabled:true` nella config). PnL non realizzato ora +$0.28 (prezzo corrente 63637, sopra entry). **0 trade chiusi, ancora un solo trade in ~34h di vita del bot** — RSI reversal resta selettiva come atteso, **zero base per qualunque conclusione di performance**, nemmeno debole.

**`JORDAN-AAVE-MACD-demo`**: `running`, 0 `tickErrors`, 0 `lastError`. **3 nuovi trade chiusi** dalla sessione 2 (posizioni #5, #6, e la #4 già nota), più una **7ª posizione aperta ora** (long, entry 88.8, aperta 05:42:05 UTC oggi):

| # | side | entry | pnl netto | close_reason |
|---|------|-------|-----------|---------------|
| 5 | short | 89.27 | **+$1.481** | take profit eseguito |
| 6 | short | 87.84 | **-$1.119** | stop loss eseguito |
| 7 | long | 88.80 | (aperta, +$0.31 non realizzato) | — |

**Campione ora a 5 trade chiusi totali** (dall'inizio): 2 vinti (#1, #5) / 3 persi (#2, #4, #6), winRate 40%, profitFactor 0.81, PnL netto -$0.663, fee totali $0.447 (stats bot, verificato che tornano esattamente con la somma dei pnl/fee di posizione). **Ancora un campione troppo piccolo per concludere se la strategia ha un edge negativo persistente o sta solo dentro il rumore statistico atteso** — 5 osservazioni non bastano in nessuna delle due direzioni, lo dico esplicitamente come già in sessione 2.

**Pattern "riapertura immediata" ora confermato 5 volte su 5** (chiusura→riapertura entro 2-3s su tutte le transizioni osservate, incluse le due nuove di questa sessione: 21:30:39→21:30:42, 05:42:02→05:42:05). Resta un comportamento sistematico del design "stato MACD, non evento" descritto in sessione 1, non un caso isolato.

**Nessuna nuova occorrenza di `close_reason: manual_or_external`** — le chiusure #5 e #6 sono entrambe classificate correttamente (take profit / stop loss). Resta 1/5 nello storico completo, verifica per Bruno ancora aperta ma non un pattern che si ripete.

### Variazione di equity reale, ~34h di vita dei bot

Equity iniziale (sessione 1, pre-bot): $977.564181. Equity attuale (post-fix, attendibile): $977.4757. **Variazione netta: -$0.089, circa -0.009%, sostanzialmente piatta** su quasi un giorno e mezzo di trading live attraverso 7 eventi di posizione (5 chiusi + 2 aperti). Coerente con un sistema che al momento non sta né guadagnando né perdendo in modo significativo — la lettura di rischio (drawdown 0.40% max, ben sotto la soglia di warning 5%) conferma la stessa storia da un angolo diverso.

### Limiti di rischio: ancora nessuno messo sotto stress reale

`maxConsecutiveLosses=3`: la sequenza AAVE più recente è win(#5)→loss(#6), quindi 1 perdita consecutiva attuale, non 3 — il cooldown di 60 minuti **non è mai stato testato** su questa demo, invariato rispetto a sessione 2. `maxConcurrentPositions=3` globale: 2 posizioni aperte (BTC+AAVE), stesso margine inutilizzato di sessione 2. `maxPositionUsd`/`maxDailyLossUsd` per-bot ampiamente rispettati (BTC $154.0/$300 notional; AAVE $98.0/$250; `dailyPnl` AAVE -$1.12, ben sotto il cap $50).

### Osservazione nuova: reconnect WS frequenti, non legati al deploy, presenti anche in produzione

Log del container demo mostrano **220 warning `WS chiuso (testnet)` / riconnessione SDK** dal boot (12/08 20:47 UTC, riavvio per il deploy CRIT-05) a ora — frequenza crescente nel tempo: da 1/h nella prima ora a 25-30/h nelle ultime ore. **Segnalo il fatto grezzo, non la diagnosi**: ho controllato se fosse un effetto del rebuild/riavvio della demo confrontando con il container di **produzione** (`app-app-1`, in esecuzione continua da 36h, nessun riavvio recente) nella stessa finestra — **578 occorrenze equivalenti in produzione nello stesso periodo**, con lo stesso pattern di distribuzione oraria (crescita nelle ore notturne UTC, calo overnight). Questo esclude che sia un effetto del deploy/rebuild della demo: è un comportamento di fondo del SDK/gateway testnet e mainnet Hyperliquid, presente su entrambe le istanze, non introdotto da CRIT-05. **Nessun impatto osservato sui bot**: `tickErrors=0` su entrambi i bot demo al momento della lettura, i reconnect si assorbono internamente all'SDK senza propagarsi a errori di tick. Non richiede azione — lo segnalo solo perché è un dato nuovo rispetto alle sessioni precedenti, non perché sia un problema.

### Stato a fine sessione 3 (~08:29 UTC 2026-08-13)
- 2 bot `running`, 0 errori correnti su entrambi, CRIT-05 confermato corretto e le letture di rischio/equity ora attendibili.
- Equity reale: sostanzialmente piatta su ~34h (-$0.089, -0.009%), drawdown max 0.40%, ben sotto qualunque soglia di warning.
- AAVE-MACD: 5 trade chiusi (2W/3L, PF 0.81, PnL netto -$0.66) — **campione ancora troppo piccolo per un giudizio di strategia**, né a favore né contro. Nessun limite di rischio per-bot o globale mai stressato (mai 3 perdite consecutive, mai vicino ai cap di posizione/perdita giornaliera).
- BTC-RSI: 0 trade chiusi, 1 tuttora aperto — **campione zero**, nessuna base di giudizio.
- Nessuna sorpresa operativa nuova di rilievo per il rischio; l'unica novità (reconnect WS) è verificata come rumore di fondo pre-esistente e condiviso con la produzione, non un effetto collaterale del deploy.

### Prossima sessione (se richiesta, es. documento finale) — cosa portare
- Il campione resta piccolo su entrambi i bot (5 trade AAVE, 1 posizione BTC mai chiusa) — qualunque documento finale deve dichiarare esplicitamente questo limite, non concludere "strategia valida/da tagliare" sulla base di questi numeri.
- Nessun limite di rischio (cooldown, max posizioni concorrenti) è mai stato osservato scattare — non c'è evidenza diretta che tengano sotto stress reale, solo che non sono mai stati necessari finora.
- Il caso `manual_or_external` (posizione #4, sessione 2) resta un'anomalia isolata non riprodotta — menzionabile come nota a margine, non come rischio aperto.
