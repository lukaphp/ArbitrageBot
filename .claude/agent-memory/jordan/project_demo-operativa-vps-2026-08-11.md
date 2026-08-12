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
- DB produzione (SOLA LETTURA, per riferimento schema) via `ssh arbitragebot-vps "cd /opt/arbitragebot/app && sudo docker compose exec -T app node -e ..."` con `better-sqlite3` — **path corretto: `/app/data/perps.db`** (non `arbitragebot.db`, quello dà `SQLITE_CANTOPEN`). Tabella bot: colonna config è `config_json` (stringa JSON), non `config`.

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

### Prossima sessione — cosa controllare
- Se BTC-RSI ha aperto nel frattempo (a quale RSI, che direzione).
- Se AAVE-MACD ha chiuso (TP, SL, o ancora aperta) — e se ha aperto un secondo trade dopo la chiusura (utile per capire se la stessa dinamica "stato, non evento" del MACD produce aperture ravvicinate ripetute).
- Ricontrollare `equity`/`accountValue`/`spotUsdc` per capire se il pattern di doppio conteggio persiste, cresce, o era un artefatto isolato.
- `tickErrors` su entrambi i bot (dovrebbero restare 0).
- Se il PnL netto di sessione si allontana in modo significativo da zero (drawdown reale, non solo rumore di spread).
