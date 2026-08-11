# 📚 Indice Ragionato della Knowledge Base — ArbitrageBot

> **Cosa contiene questo file:** classificazione tematica di tutti i documenti in `docs/KB/`, con
> valutazione del **potenziale** (quanto vale l'idea in sé) e dell'**attinenza** (quanto è applicabile
> *a questo* progetto, così com'è oggi), più gli **spunti operativi** già mappati sui file sorgente.
>
> **Ultimo aggiornamento:** 2026-08-08 · **Documenti indicizzati:** 14 · **Branch di riferimento:** `feat/perps-hardening`

---

## 0. Contesto: cos'è oggi ArbitrageBot

Prima di valutare l'attinenza dei documenti serve fissare *cosa* stiamo valutando. Nonostante il nome
storico (`arbitrage-bot-testnet`), il cuore attuale del progetto è un **bot di perpetual futures su
Hyperliquid con supervisione AI**:

| Layer | Implementazione attuale | File |
|:---|:---|:---|
| Market data | WebSocket `allMids` + fallback polling REST, cache candele | [marketData.js](../../../src/perps/marketData.js), [hyperliquidClient.js](../../../src/perps/hyperliquidClient.js) |
| Indicatori | RSI, EMA, SMA, MACD, Bollinger, ATR, ADX (`technicalindicators`) | [indicators.js](../../../src/perps/indicators.js) |
| Strategia | Rule engine dichiarativo: regole `indicator` / `price` / `funding` / `external` (webhook), logica `any`/`all` | [strategyEngine.js](../../../src/perps/strategyEngine.js) |
| ML | Regressione logistica "fatta a mano" (FreqAI-lite), 9 feature, gate `mlGate` con accuracy-vs-baseline | [predictor.js](../../../src/perps/predictor.js) |
| Backtest | Replay su candele storiche, riusa strategyEngine + riskManager, no look-ahead | [backtester.js](../../../src/perps/backtester.js) |
| Ottimizzazione | Hyperopt con validazione **walk-forward** in-sample / out-of-sample | [optimizer.js](../../../src/perps/optimizer.js) |
| Rischio | Sizing, TP/SL/trailing, limiti per-bot + limiti globali di portafoglio + gate deterministico unico | [riskManager.js](../../../src/perps/riskManager.js), [portfolio.js](../../../src/perps/portfolio.js), [riskAgent.js](../../../src/agents/riskAgent.js) |
| AI advisory | Agent Claude read-only che produce **proposte** in coda di approvazione, mai esecuzione diretta | [agents/analyst/](../../../src/agents/analyst/) |
| Esecuzione | Coda serializzata per master address + nonce monotono persistito; agent wallet (no popup MetaMask) | [execQueue.js](../../../src/perps/execQueue.js), [agentWallet.js](../../../src/perps/agentWallet.js) |
| Osservabilità | Metriche Prometheus, notifiche Telegram, kill-switch | [metrics.js](../../../src/perps/metrics.js), [notifier.js](../../../src/perps/notifier.js) |
| Sicurezza | Cifratura segreti a riposo con key versioning/rotation, CSP, auth, vincoli mainnet | [secretBox.js](../../../src/perps/secretBox.js), [SECURITY_CHECKLIST.md](../../../SECURITY_CHECKLIST.md) |

**Conseguenza pratica per la lettura dell'indice:** una parte consistente dei "consigli" contenuti nei
documenti KB è **già implementata** nel progetto — a volte in forma più rigorosa di quanto suggerito.
Dove è così, lo segnalo esplicitamente: serve a evitare di riscrivere ciò che esiste già.

---

## 1. Mappa tematica

| # | Tema | Documenti | Peso per il progetto |
|:--|:---|:---|:---|
| **A** | **Architettura & Infrastruttura di esecuzione** | Architettura Modulare/AsyncIO · AOLM (×2) | 🔴 Alto |
| **B** | **Strategie quantitative & Modelli** | DCA vs Grid · Transformer · Sciforce Prediction | 🔴 Alto |
| **C** | **AI / LLM nel loop di trading** | DegenBot (Dart) · LLM Crypto Bot (FinBERT) | 🟠 Medio-Alto |
| **D** | **Sicurezza & Supply chain** | Malicious Polymarket Bot | 🔴 Alto (critico) |
| **E** | **Integrazione broker/exchange** | Alpaca Bot | 🟡 Medio-Basso |
| **F** | **Benchmark competitivo (feature)** | Coinrule · StockHero · TrendSpider | 🟠 Medio |
| **G** | **Prodotto, pricing & CRO** | Trade Ideas · Stock Hero | ⚪️ Nullo sul codice / utile solo se il progetto diventa prodotto |

### 1.1 Matrice di sintesi (ordinata per priorità d'azione)

| Documento | Tema | Potenziale | Attinenza | Sforzo | Verdetto |
|:---|:---:|:---:|:---:|:---:|:---|
| [Malicious Polymarket Bot](../Malicious-Polymarket-Bot-Hides-in.md) | D | ★★★★★ | ★★★★★ | Basso | **Agire subito** — checklist difensiva |
| [Adaptive Order Lifecycle (AOLM)](../Adaptive%20Order%20Lifecycle%20Management%20in%20Mercati%20Event-Driven.md) | A | ★★★★★ | ★★★★★ | Alto | **Gap architetturale reale** |
| [DCA vs Grid](../Comparing-Strategies-DCA-vs.-Grid.md) | B | ★★★★★ | ★★★★☆ | Medio | **Famiglie di strategie mancanti** |
| [Architettura Modulare & AsyncIO](../rchitettura%20Modulare%20e%20AsyncIO%20per%20Bot%20di%20Trading.md) | A | ★★★★☆ | ★★★★☆ | Medio | Adottare le **metriche**, non il refactor |
| [DegenBot (Dart)](../Sviluppo%20di%20un%20Crypto%20Trading%20Bot%20in%20Dart%20(DegenBot).md) | C | ★★★★☆ | ★★★★☆ | Basso-Medio | Valida la scelta attuale + auto-tuning |
| [Sciforce Trade Prediction](../guida_sciforce_trader_prediction.md) | B | ★★★★☆ | ★★★★☆ | Medio | **3 classi + confidenza** sul predictor |
| [TrendSpider](../TrendSpider_TradingBot_Analysis.md) | F | ★★★★☆ | ★★★☆☆ | Basso | Webhook **interno per scelta** (SEC-04) → estenderlo solo su decisione esplicita |
| [LLM Crypto Bot (FinBERT)](../guida_llm_crypto_bot.md) | C | ★★★☆☆ | ★★★☆☆ | Medio | Lezioni negative + sizing su equity |
| [Transformer Crypto Bot](../guida_transformer_crypto_bot.md) | B | ★★★☆☆ | ★★☆☆☆ | Molto alto | **Cherry-pick** (HMM, 3 classi), non il Transformer |
| [Coinrule](../Coinrule.md) | F | ★★☆☆☆ | ★★★☆☆ | Basso | Benchmark UX del rule builder |
| [StockHero](../Stock%20Hero.md) | F/G | ★★★☆☆ | ★★☆☆☆ | — | Idea Marketplace strategie |
| [Alpaca Bot](../guida_alpaca_bot.md) | E | ★★☆☆☆ | ★★☆☆☆ | — | Quasi tutto già fatto meglio |
| [Trade Ideas](../Trade%20Ideas.md) | G | ★★☆☆☆ | ★☆☆☆☆ | — | Solo se si va a mercato |
| [guida_polymarket_aolm_bot](../guida_polymarket_aolm_bot.md) | A | — | — | — | ⚠️ **Duplicato** — vedi §4 |

> **Legenda.** *Potenziale* = valore intrinseco dell'idea. *Attinenza* = quanto è applicabile ad
> ArbitrageBot oggi (Hyperliquid perps, Node.js, single-process). Un doc può avere potenziale alto e
> attinenza bassa: è il caso del Transformer.

---

## 2. Schede documento

### 🅐 Tema A — Architettura & Infrastruttura di esecuzione

---

#### A.1 · [Adaptive Order Lifecycle Management in Mercati Event-Driven](../Adaptive%20Order%20Lifecycle%20Management%20in%20Mercati%20Event-Driven.md)

**Potenziale ★★★★★ · Attinenza ★★★★★ · Sforzo Alto**

**Sintesi.** Il concetto centrale è trattare l'ordine come **entità viva** anziché come "fire &
forget": ciclo continuo `Create → Adjust → Cancel → Re-enter` legato all'evoluzione del segnale.
Nasce sui prediction market (Polymarket), ma è un pattern di *control systems* trasferibile ovunque.
Aggiunge: separazione netta Signal Engine / Execution Engine, position sizing *liquidity-aware*,
throttling e failover.

**Perché è il documento architetturalmente più rilevante della KB.**
Oggi [bot.js](../../../src/perps/bot.js) è una macchina a stati a due stati — `idle` → `in_position` →
`idle` — con esecuzione a **market order**. Non esiste lo stato intermedio "ordine in vita, non ancora
fillato". Tutta la fascia `Adjust` / `Cancel` / `Re-enter` dell'AOLM è **assente per costruzione**:
non è un bug, è una scelta implicita che il market order rende invisibile. Il costo lo si paga in
slippage e in fee taker.

**Spunti operativi mappati sul codice**

1. **Stato `pending_entry` nella macchina a stati** ([bot.js](../../../src/perps/bot.js)) — introdurre
   ordini limit post-only con un loop di re-quote: se il mid si muove oltre N tick, cancella e
   ri-piazza; se il segnale d'ingresso decade prima del fill, cancella e torna `idle`. È l'unico modo
   per passare da fee taker a fee maker su Hyperliquid.
2. **Invalidazione del segnale pre-fill** ([strategyEngine.js](../../../src/perps/strategyEngine.js)) —
   il motore oggi risponde solo alla domanda "apro adesso?". Serve un secondo verdetto: "il segnale che
   ha generato questo ordine è **ancora valido**?". Senza, l'`Adjust`/`Cancel` non ha su cosa decidere.
3. **Sizing liquidity-aware** ([riskManager.js](../../../src/perps/riskManager.js) `sizePosition`) — il
   sizing attuale è `percent`/`fixed` su equity: **non guarda il book**. Aggiungere un haircut sulla
   size quando la profondità entro X bps è sottile è il singolo intervento con il miglior rapporto
   impatto/sforzo di tutta questa scheda, ed è indipendente dal resto dell'AOLM.
4. **Il throttling/failover è già coperto** da [execQueue.js](../../../src/perps/execQueue.js) (coda
   serializzata + nonce monotono persistito) e [retry.js](../../../src/perps/retry.js). Su questo punto
   il progetto è **avanti** rispetto al documento.

**Da non prendere alla lettera.** Il documento spinge su microservizi + Kubernetes + SSO. Per un
single-user bot Node.js in-process è **over-engineering netto**: la separazione logica esiste già
(moduli distinti, gate di rischio unico) e la serializzazione degli ordini è più semplice da garantire
in un processo solo. Il valore dell'AOLM qui è il **ciclo di vita dell'ordine**, non il deployment.

---

#### A.2 · [Architettura Modulare e AsyncIO per Bot di Trading](../rchitettura%20Modulare%20e%20AsyncIO%20per%20Bot%20di%20Trading.md)

**Potenziale ★★★★☆ · Attinenza ★★★★☆ · Sforzo Medio**

> ⚠️ Il nome del file ha un **typo**: manca la `A` iniziale (`rchitettura`). Vedi §4.

**Sintesi.** Tesi forte e corretta: *l'illusione del modello predittivo*. Il 90% dello sforzo va sul
modello, ma in produzione le performance dipendono dalla **latenza dell'intera pipeline**
(`Dati → Eventi → Feature → Modello → Strategia → Rischio → Esecuzione`). Propone I/O asincrono,
caching Redis, approccio event-driven e — la parte più utile — **target numerici di performance**.

**Attinenza.** Node.js è già asincrono per natura: la raccomandazione "convertire tutto ad `asyncio`"
è un no-op qui. Il caching esiste già in forma leggera (`CANDLE_TTL_MS` in
[marketData.js](../../../src/perps/marketData.js)) e l'approccio event-driven è **parzialmente**
adottato: WS `allMids` per i prezzi, ma i tick dei bot restano **a polling su timer**.

**Spunti operativi**

1. **SLO misurabili in [metrics.js](../../../src/perps/metrics.js)** — è lo spunto più concreto e a
   basso costo. Oggi il file espone 4 contatori (`api_errors_total`, `tick_errors_total`,
   `orders_placed_total`, `ws_reconnects_total`) ma **nessun istogramma di latenza**. Aggiungere:
   latenza API Hyperliquid, durata del tick, età dell'ultimo messaggio WS, tasso di ordini falliti.
   I target del documento (API < 100 ms, strategia < 50 ms, ordini falliti < 1%) sono una baseline
   ragionevole da cui partire.
2. **Da polling a event-driven sui tick** — far scattare la valutazione della strategia alla
   **chiusura della candela** o su soglia di prezzo, invece che su timer fisso. Riduce lavoro inutile
   e, soprattutto, elimina il jitter tra chiusura candela e valutazione del segnale — che oggi è una
   fonte silenziosa di divergenza tra backtest e live.
3. **Redis: rimandare.** Con SQLite (`better-sqlite3`, sincrono e in-process) e un solo processo, Redis
   aggiunge una dipendenza operativa senza risolvere un collo di bottiglia dimostrato. Da rivalutare
   solo se si separano davvero i processi.

---

### 🅑 Tema B — Strategie quantitative & Modelli

---

#### B.1 · [Comparing Strategies: DCA vs. Grid](../Comparing-Strategies-DCA-vs.-Grid.md)

**Potenziale ★★★★★ · Attinenza ★★★★☆ · Sforzo Medio** — *il documento più corposo della KB (~88 KB, ~2540 righe)*

**Sintesi.** Trattato completo su due famiglie di strategie con implementazione di riferimento in Go:
meccanica DCA (base order + safety orders + deviazione prezzo + take profit), meccanica Grid
(livelli aritmetici/geometrici, range), analisi comparativa con backtest 2025, **combo bot ibridi**
(DCA con *minigrid* al posto dell'uscita secca), risk management di portafoglio con matrice di
correlazione, e capitoli finali su AI, sentiment, arbitraggio cross-chain e quadro regolatorio.

**Il punto chiave.** I dati riportati (180 giorni, ott 2024 – apr 2025) mostrano i **grid bot che
trasformano downtrend in profitto**: BTC +9,6% vs −16% buy&hold, ETH +10,4% vs −53%, SOL +21,88% vs
−49%. Anche scontando l'ottimismo di un articolo Medium, la tesi strutturale regge: **DCA e Grid
coprono regimi di mercato che una strategia trend-following a regole non copre**.

**Perché è attinente.** [strategyEngine.js](../../../src/perps/strategyEngine.js) supporta oggi
`indicator`, `price`, `funding`, `external` — tutte regole **a segnale singolo, posizione singola**.
Il **DCA di base esiste già** ([bot.js](../../../src/perps/bot.js) `_maybeDca`: `steps`,
`stepPercent` progressivo, `sizeMultiplier`, esposto nella UI del bot). Manca invece del tutto il
**grid**, e mancano i raffinamenti del DCA descritti nel documento.

**Spunti operativi**

1. **Grid come nuovo tipo di strategia** — il candidato numero uno. Un mercato perp con funding e
   range definito è terreno naturale per il grid. Richiede però un pezzo che oggi non c'è:
   la **gestione di ordini multipli aperti contemporaneamente per bot** (oggi 1 bot = 1 posizione).
   Prerequisito condiviso con l'AOLM (§A.1) — vale la pena progettarli insieme.
2. **Raffinare il DCA esistente** ⚠️ — il documento descrive un DCA più strutturato: *base order*
   distinto dai *safety order*, take profit **ricalcolato sul prezzo medio** dopo ogni aggiunta, e un
   tetto esplicito al capitale impegnabile dalla scala. Il confronto ha fatto emergere un difetto
   concreto nell'implementazione attuale, da verificare come primo intervento:

   TP e SL sono piazzati come trigger order all'apertura con `size: this.position.size` e prezzi
   calcolati sull'`entryPx` iniziale ([bot.js](../../../src/perps/bot.js) ~righe 238, 334-343).
   `_maybeDca` incrementa `this.position.size` ma **non ricalcola i prezzi né ri-piazza i trigger con
   la size aggiornata**. Dopo un'aggiunta la posizione è più grande dei trigger che dovrebbero
   chiuderla: **lo stop copre solo la size originale**, il resto resta scoperto. Il trailing stop
   maschera in parte il problema (ri-piazza l'SL con la size corrente), ma il TP no — e senza
   trailing non lo maschera nulla. È la combinazione DCA + leva descritta al §B.1 come rischiosa,
   qui però per un motivo implementativo, non strategico.
3. **Regime detection come selettore** — il pattern `determineOptimalMode(volatility, trend)` del
   combo bot è direttamente riusabile, e **le fondamenta ci sono già**: ADX è un indicatore
   utilizzabile nelle regole ([strategyEngine.js](../../../src/perps/strategyEngine.js)) e ATR guida
   già stop e trailing adattivi ([riskManager.js](../../../src/perps/riskManager.js), modalità `atr`).
   Quello che manca non è il segnale di regime, è **usarlo come selettore di strategia** invece che
   come semplice filtro d'ingresso: cambiare modalità operativa (grid in laterale, DCA in bear) anziché
   limitarsi a non entrare.
4. **Metriche di backtest** — il `PerformanceMetrics` del documento include `TotalFees` e
   `VolatilityImpact`. Verificare che [backtester.js](../../../src/perps/backtester.js) modelli le
   **fee** in modo esplicito: su strategie ad alta frequenza di trade come il grid, le fee sono la
   differenza tra edge reale ed edge illusorio, e un backtest senza fee è peggio che inutile.
5. **Allocazione multi-strategia con correlazione** — il `DiversificationManager` estende
   [portfolio.js](../../../src/perps/portfolio.js), che oggi limita posizioni/esposizione/cooldown ma
   **ignora la correlazione**: 3 posizioni long su BTC, ETH e SOL contano come 3 rischi indipendenti
   quando in pratica sono quasi lo stesso rischio. È una falla di risk management concreta e
   correggibile con poco.

**Cautela.** I backtest citati vengono da un articolo divulgativo, con periodo scelto a posteriori e
senza dettaglio sul modello di costi. Da usare come **ipotesi da verificare** con il nostro
[optimizer.js](../../../src/perps/optimizer.js) in walk-forward — che per questo è lo strumento
giusto — non come risultato acquisito.

---

#### B.2 · [Modello Predittivo per il Comportamento dei Trader (Sciforce)](../guida_sciforce_trader_prediction.md)

**Potenziale ★★★★☆ · Attinenza ★★★★☆ · Sforzo Medio**

**Sintesi.** Sposta l'obiettivo dalla predizione del prezzo alla predizione del **comportamento**
(propri o degli attori avversari). Confronto LSTM vs XGBoost — con XGBoost preferito per costo
computazionale — e tre conclusioni metodologiche forti:
- il **tipo di modello conta meno** della qualità delle feature, della lunghezza del contesto e della finestra di aggregazione;
- classificazione a **3 stati: Buy / Sell / Idle**, con score di confidenza;
- la difficoltà vera **non è Buy vs Sell, è distinguere l'Idle** — cioè sapere quando *non* operare.

**Attinenza — molto alta e specifica.** [predictor.js](../../../src/perps/predictor.js) è oggi una
regressione logistica **binaria** (sale / non sale) su 9 feature, con warmup 35 candele. Il file è già
notevolmente onesto — dichiara accuratezza realistica ~50-56% e confronta sempre con la baseline della
classe maggioritaria, che è esattamente la disciplina che manca alla maggior parte dei progetti
simili. Ma un classificatore binario **non può esprimere "stai fermo"**: è costretto a schierarsi a
ogni candela. Il documento centra il limite strutturale.

**Spunti operativi**

1. **Passare a 3 classi `[Idle, Long, Short]`** — la modifica più mirata suggerita da tutta la KB per
   questo progetto. Il gate `mlGate` diventa "apri solo se `confidence(direzione) > soglia` **e**
   `confidence(Idle) < soglia`", che è un filtro del rumore molto più selettivo dell'attuale.
2. **Tuning della finestra di aggregazione e del context length** — il documento insiste che la
   finestra debba corrispondere alla frequenza operativa del bot. Da parametrizzare ed esplorare con
   [optimizer.js](../../../src/perps/optimizer.js), che è già walk-forward e quindi adatto a non
   overfittare la scelta.
3. **Feature di portafoglio** — il documento nota che aggiungere posizione corrente e P&L aperto alle
   feature migliora l'accuratezza in modo significativo. Oggi le 9 feature sono **puramente tecniche**
   (`rsi`, `emaFast`, `emaSlow`, `macdHist`, `bbPctB`, `ret1/3/5`, `vol10`): il modello non sa se è già
   in posizione. Estensione a costo basso.

**Da ignorare.** La sezione 6.2/6.3 (Java + Spring Boot, Kubernetes, SSO) è generica e fuori scala per
questo progetto — vedi la stessa nota in §A.1.

---

#### B.3 · [Bot di Trading con Neural Network Transformer](../guida_transformer_crypto_bot.md)

**Potenziale ★★★☆☆ · Attinenza ★★☆☆☆ · Sforzo Molto alto**

**Sintesi.** Roadmap evolutiva in 5 livelli: regole classiche → clustering KNN → **HMM per regime
detection** → alberi (XGBoost/LightGBM/CatBoost) → deep learning (TCN/LSTM/Transformer) in ensemble.
Dataset: 97.000 righe di candele 15m, **oltre 190 feature** da TA-Lib. Gestione dello sbilanciamento
delle classi con ADASYN + class weights.

**Perché l'attinenza è bassa nonostante il tema sia caldo.** I rendimenti dichiarati — **+33.885% in
3 anni**, +11.270% su ETH — sono di un ordine di grandezza che, in assenza di walk-forward pubblicato
e di modello di costi esplicito, è il profilo tipico dell'**overfitting**. Va detto chiaramente:
l'articolo è una fonte di *idee*, non di risultati. Inoltre lo stack richiesto (Keras/TensorFlow,
Python, 190+ feature, GPU per il training) è **incompatibile** con la scelta deliberata del progetto
di un predictor leggero, in-process, senza dipendenze pesanti e spiegabile — scelta che è documentata
in testa a [predictor.js](../../../src/perps/predictor.js) e che considero corretta per un sistema che
deve girare 24/7 su un singolo host.

**Spunti operativi — solo cherry-picking**

1. **HMM per regime detection** ⭐ — l'idea più preziosa e riutilizzabile del documento, indipendente
   dal deep learning: disattivare il motore long quando il regime è bear/choppy. **Un'approssimazione
   a soglie di ADX/ATR cattura gran parte del beneficio senza introdurre un HMM** — ed è in buona parte
   già in casa (filtro di regime ADX e stop ATR, commit `d279cc6`). Il passo successivo è il regime
   come *selettore di strategia*, non solo come filtro: vedi §B.1 punto 3.
2. **Classificazione a 3 classi** — stessa raccomandazione di §B.2, qui rafforzata da una seconda fonte
   indipendente. Segnale forte: due documenti diversi convergono sullo stesso limite.
3. **Bilanciamento delle classi** — i segnali validi sono una frazione minima delle candele. Anche
   restando su regressione logistica, pesare le classi evita il collasso sulla classe maggioritaria.
   Rilevante perché [mlTrainer.js](../../../src/agents/mlTrainer.js) già monitora l'edge sopra la
   baseline (`EDGE_MIN = 0.02`): il bilanciamento è ciò che rende quell'edge raggiungibile.
4. **Feature engineering incrementale** — passare da 9 a ~30-40 feature cross-timeframe è realistico e
   utile; passare a 190 con una regressione logistica non lo è (si finisce a overfittare il rumore).

---

### 🅒 Tema C — AI / LLM nel loop di trading

---

#### C.1 · [Sviluppo di un Crypto Trading Bot in Dart (DegenBot)](../Sviluppo%20di%20un%20Crypto%20Trading%20Bot%20in%20Dart%20(DegenBot).md)

**Potenziale ★★★★☆ · Attinenza ★★★★☆ · Sforzo Basso-Medio**

**Sintesi.** Filosofia in tre parole: **"Le regole decidono, l'AI spiega."** Il rule engine
deterministico è il decisore ultimo; l'LLM è retrocesso a livello di spiegazione (riassunti per
Telegram) e non altera mai la scelta operativa. In più: pipeline dati a 5 livelli, rule engine a 4
gate (honeypot, safety scan, liquidity lock, market cap range), modulo `StrategyDiscovery` che ogni 4
ore ricalibra i parametri target a ritroso sui token che hanno performato meglio, e **fallback
graceful** se l'LLM cade.

**Attinenza — è la validazione esterna dell'architettura attuale.** Il progetto ha già esattamente
questa separazione, e in forma più rigorosa: [riskAgent.js](../../../src/agents/riskAgent.js) è il
gate deterministico unico dichiarato non aggirabile dall'AI, e l'analyst Claude produce **proposte in
coda di approvazione** anziché eseguire. Il documento non insegna nulla di nuovo su questo asse — **lo
conferma**, ed è un motivo valido per non cedere alla tentazione di dare più autonomia all'AI.

**Spunti operativi**

1. **`StrategyDiscovery` / auto-tuning retroattivo** ⭐ — il vero contributo nuovo. Un job periodico che
   analizza a ritroso *cosa ha funzionato nelle ultime N ore* e riaggiusta i parametri target. Il
   progetto ha già i due pezzi necessari: [optimizer.js](../../../src/perps/optimizer.js) (ricerca
   walk-forward) e il runtime degli agent ([runtime.js](../../../src/agents/runtime.js), con
   [mlTrainer.js](../../../src/agents/mlTrainer.js) come esempio di agent schedulato). Manca solo di
   **collegarli**: un `strategy-tuner` agent che gira ogni N ore e propone nuovi parametri *attraverso
   la coda di proposte* — mantenendo così l'umano nel loop.
2. **Fallback graceful dell'AI** — verificare che un fallimento dell'API Claude non blocchi né degradi
   il loop di trading a regole. Data l'architettura advisory-only dovrebbe già essere così, ma è un
   test di resilienza che vale la pena scrivere esplicitamente.
3. **Trailing ancorato** — l'idea di ancorare l'uscita al *post-buy all-time low* invece di un take
   profit percentuale fisso è una variante di trailing da testare in
   [riskManager.js](../../../src/perps/riskManager.js). Attenzione: nasce per le altcoin a bassa cap
   con movimenti parabolici; su perp BTC/ETH il profilo di rendimento è diverso e va **validato in
   backtest prima**, non assunto.
4. **I 4 gate anti-scam non si applicano** — honeypot check, liquidity lock e market cap range servono
   per token DEX arbitrari. Su Hyperliquid i mercati perp sono curati e c'è già una whitelist in
   [riskAgent.js](../../../src/agents/riskAgent.js). Nessuna azione.

---

#### C.2 · [Bot di Trading LLM + Sentiment Analysis (FinBERT)](../guida_llm_crypto_bot.md)

**Potenziale ★★★☆☆ · Attinenza ★★★☆☆ · Sforzo Medio**

**Sintesi.** Cronaca sperimentale onesta di **quattro fallimenti prima di un successo**, che è ciò che
la rende utile:

| Fase | Approccio | Risultato |
|:---|:---|:---|
| 1 | Bot casuale (baseline) | −8,98% |
| 2 | LLM generalista → sentiment → trend following | **−65,36%** |
| 3 | LLM che raccomanda direttamente Buy/Sell | **−450% drawdown** |
| 4 | FinBERT + Alpaca News API, long/short | ancora in perdita |
| 5 | **FinBERT + Contrarian + Long-Only** | **+20,04% annuo** |

**Le tre lezioni che contano.** (a) Chiedere a un LLM generalista un segnale diretto Buy/Sell è
catastrofico — la fase 3 è il caso peggiore in assoluto. (b) Il problema non era solo il modello, era
l'**approccio direzionale**: seguire il sentiment positivo significa comprare il top. (c) Il bug di
position sizing su posizioni short — usare `get_cash` invece di `get_portfolio_value` — produce size
enormi e bilanci negativi.

**Attinenza.** La lezione (a) è **già interiorizzata** nell'architettura (vedi §C.1). La lezione (c) è
un controllo da fare adesso. La (b) è un'ipotesi di strategia da testare.

**Spunti operativi**

1. **Verificare la base di calcolo del sizing** ⭐ — in
   [riskManager.js](../../../src/perps/riskManager.js) `sizePosition(config, equity, price, ...)`
   riceve `equity`: va confermato che i chiamanti passino **account value totale** e non il margine
   libero. Su perp con leva, sbagliare questa base è esattamente il bug descritto nel documento, e si
   manifesta solo sotto stress — cioè nel momento peggiore. Controllo a costo quasi zero, downside
   molto alto.
2. **Strategia contrarian come regola** — "compra quando il sentiment è fortemente negativo" è
   testabile in backtest. Il funding rate di Hyperliquid è un **proxy di sentiment nativo, numerico e
   già disponibile** come tipo di regola `funding` nello strategy engine: funding molto negativo =
   short affollati = setup mean-reversion long. Non serve alcun feed di news per iniziare — questa è
   una strategia implementabile *oggi* con i mattoni esistenti.
3. **Sentiment via news: non ora.** Aggiungere FinBERT significa introdurre uno stack Python. Il
   funding rate (punto 2) copre gran parte del segnale a costo zero. Da rivalutare solo se il
   contrarian su funding mostra edge.
4. **Attenzione allo short automatizzato** — il documento raccomanda di partire long-only. Su perp con
   leva il rischio di liquidazione è strutturalmente più alto che su spot; il progetto ha già limiti,
   trailing e kill-switch, ma vale come promemoria per la configurazione dei cap di leva di default.

---

### 🅓 Tema D — Sicurezza & Supply chain

---

#### D.1 · [Malicious Polymarket Bot Hides in Hijacked GitHub Org](../Malicious-Polymarket-Bot-Hides-in.md)

**Potenziale ★★★★★ · Attinenza ★★★★★ · Sforzo Basso — 🚨 PRIORITÀ MASSIMA**

**Sintesi.** Report di threat intelligence StepSecurity (feb 2026). Un'organizzazione GitHub
**verificata e legittima** (`dev-protocol`, progetto DeFi giapponese, 568 follower, attiva dal 2019)
viene compromessa e usata per distribuire bot di trading Polymarket malevoli. Il repo ha README
curato, centinaia di stelle, e **il bot funziona davvero** — si connette alle vere API Polymarket.
Nascoste tra le dipendenze npm: due pacchetti typosquattati.

**Catena d'attacco**

```
package.json ─┬─ ts-bign@1.2.8     (finge big.js)      → levex-refa@1.0.0   [file stealer]
              └─ big-nunber@5.0.2  (typo bignumber.js) → lint-builder@1.0.1 [backdoor installer]
```

Doppio innesco: `postinstall` durante `npm install` **e** import nel codice sorgente
(`from_str()`). Payload: esfiltrazione di `.env`, `*.env`, `id.json`, `config.toml` verso C2 su
Vercel deliberatamente chiamati `cloudflareguard` / `cloudflareinsights` per non insospettire chi
guarda i log di rete; fingerprinting IP; poi `sudo chown -R ~/.ssh`, `sudo ufw enable`,
`sudo ufw allow 22/tcp` → **backdoor SSH**.

**Perché è massimamente attinente a questo progetto.** Il profilo di rischio combacia punto per punto:
progetto **Node.js/npm**, **crypto**, con **chiavi wallet** e un file **`.env`** — che è
letteralmente il target primario del file stealer. Il repo ha `.env` (4,6 KB) e `.env.example` in
root. Il progetto ha già fatto passi seri nella direzione giusta (cifratura a riposo in
[secretBox.js](../../../src/perps/secretBox.js), key versioning e rotazione, `.gitignore`,
[SECURITY_CHECKLIST.md](../../../SECURITY_CHECKLIST.md), agent wallet con permessi limitati), ma
**tutto questo protegge i segreti a riposo e in uso — non protegge dalla catena di fornitura npm**.
Un `npm install` di un pacchetto compromesso legge il `.env` in chiaro, dopo la decifratura, come
qualsiasi processo locale.

**Azioni concrete — checklist**

- [ ] **Verificare l'esposizione**: `npm ls levex-refa lint-builder ts-bign big-nunber` e ricerca in `node_modules/`.
- [ ] **`npm ci` invece di `npm install`** in CI e deploy (`.github/`, [Dockerfile](../../../Dockerfile)) — installazione riproducibile dal lockfile.
- [ ] **`ignore-scripts=true`** in `.npmrc`, con abilitazione esplicita per i pacchetti che lo richiedono davvero (`better-sqlite3` compila nativo — va verificato caso per caso).
- [ ] **`npm audit signatures`** + audit in CI come step bloccante.
- [ ] **Lockfile diff obbligatorio in review**: ogni PR che tocca `package-lock.json` va letta riga per riga. È il punto di ingresso di questa classe di attacco.
- [ ] **Segreti fuori dal filesystem**: il progetto ha già gli script `start:infisical` / `dev:infisical` — **portare Infisical da opzionale a default** rimuove il file `.env` dal disco, cioè esattamente ciò che il malware cerca.
- [ ] **Harden-Runner** (`step-security/harden-runner` con `egress-policy: block`) nelle GitHub Actions: rileva connessioni di rete non previste durante `npm install`.
- [ ] **Separazione dei wallet**: l'agent wallet Hyperliquid ha già permessi limitati (no prelievi) — è la mitigazione strutturalmente più forte già in casa. Documentarla come requisito, non come opzione.
- [ ] **Verifica delle dipendenze nuove**: download count, data di pubblicazione, presenza di `postinstall`, distanza di edit dal nome di un pacchetto noto (`nunber` vs `number`).

**Nota trasversale.** Questo documento fa da contrappeso a tutti gli altri: le schede §A–§C propongono
di *aggiungere* dipendenze e integrazioni (Redis, TensorFlow, FinBERT, feed di news). Ogni nuova
dipendenza è nuova superficie d'attacco su un sistema che maneggia chiavi private. Il criterio da
applicare è quello già usato in [predictor.js](../../../src/perps/predictor.js) — implementazione
leggera senza dipendenze pesanti — e va reso esplicito come **principio di progetto**.

---

### 🅔 Tema E — Integrazione broker/exchange

---

#### E.1 · [Bot di Trading con Alpaca e Python](../guida_alpaca_bot.md)

**Potenziale ★★☆☆☆ · Attinenza ★★☆☆☆ · Sforzo —**

**Sintesi.** Tutorial introduttivo: setup ambiente Python, API key Alpaca, strategia su SMA/RSI/BB,
`submit_order`, ordini bracket, position sizing, WebSocket vs REST, logging, separazione ambienti
paper/live via `.env`.

**Attinenza — bassa perché il progetto è già oltre.** Punto per punto: architettura modulare ✅
(strategy/execution/risk sono moduli separati); WebSocket vs REST ✅ (WS con fallback REST
automatico, più sofisticato del suggerimento); ambienti separati ✅ (testnet/mainnet + paper mode con
[paperBroker.js](../../../src/perps/paperBroker.js)); logging ✅. Alpaca stesso non è rilevante:
broker azionario USA, mentre il progetto è su perp DEX.

**Unico spunto residuo**

- **Ordini bracket nativi (OCO/OTO)** — il documento raccomanda giustamente di delegare TP/SL
  all'exchange invece di gestirli nel loop locale, così sopravvivono a crash e lag del bot. Da
  verificare in [hyperliquidClient.js](../../../src/perps/hyperliquidClient.js): se il TP/SL è
  applicato via **trigger order lato Hyperliquid** siamo a posto; se invece è monitorato solo nel tick
  di [bot.js](../../../src/perps/bot.js), un crash del processo lascia posizioni **scoperte**. È il
  singolo controllo più importante di questa scheda e giustifica da solo la sua presenza in KB.

---

### 🅕 Tema F — Benchmark competitivo (feature)

---

#### F.1 · [TrendSpider](../TrendSpider_TradingBot_Analysis.md)

**Potenziale ★★★★☆ · Attinenza ★★★☆☆ · Sforzo Basso**

**Sintesi.** Piattaforma di analisi tecnica automatizzata: trendline e Fibonacci automatici, heatmap
di supporti/resistenze, riconoscimento pattern candlestick, AI Strategy Lab no-code, backtesting
multi-symbol/multi-timeframe su 50 anni di dati, **spread sintetici** per pair trading, e — il punto
d'interesse — **webhook JSON** che spara segnali al proprio bot, con esecuzione cloud 24/7.

**Il modello proposto è interessante:** TrendSpider fa da "cervello" analitico, il bot proprietario si
occupa **solo** di risk management ed esecuzione. È una divisione del lavoro sensata.

**Attinenza — il gancio esiste, ma è deliberatamente interno.** Il progetto ha `POST /api/perps/webhook`
([server.js:1128](../../../src/server.js#L1128)) e il tipo di regola `external` in
[strategyEngine.js](../../../src/perps/strategyEngine.js), con scadenza dei segnali a 5 minuti.

> ℹ️ **Aggiornamento (Sprint 1, SEC-04).** L'endpoint è dietro `requireAuth` + rate limit + secret a
> confronto costante — **non raggiungibile da TrendSpider/TradingView così com'è**, per scelta
> esplicita (opzione B, vedi [sprint1.md](../BACKLOG/release1/sprint1.md)), non per svista. Aprirlo davvero
> (HMAC, whitelist del path, anti-replay) resta un'opzione futura, non un debito di sicurezza attuale.

**Spunti operativi**

1. **Aprire il webhook a fonti esterne** — oggi è raggiungibile solo da sessioni autenticate del
   pannello stesso. Per collegarci davvero TrendSpider/TradingView servirebbe: whitelist esplicita
   del path fuori dal gate cookie, HMAC-SHA256 sul corpo, timestamp anti-replay, rate limiting
   dedicato — è la "opzione A" già scartata per lo Sprint 1 perché nessuna integrazione esterna era
   in esercizio. Da riprendere quando (e se) serve davvero: un webhook che scatena ordini reali è
   **superficie d'attacco** — vale la §D.1.
2. **Analisi tecnica automatizzata come feature** — trendline automatiche e cluster di S/R sono
   implementabili in [indicators.js](../../../src/perps/indicators.js) (pivot detection + clustering
   dei livelli). Nuovi tipi di regola: "prezzo rompe la trendline", "prezzo entro X% da un cluster S/R".
3. **Spread sintetici / pair trading** — chiude il cerchio con il nome del progetto: costruire un
   asset sintetico da due perp correlati e tradare la divergenza è un **arbitraggio statistico** vero,
   sensato su Hyperliquid dove si può stare long e short simultaneamente su mercati diversi. Idea
   ambiziosa ma coerente con l'identità del progetto.

---

#### F.2 · [Coinrule](../Coinrule.md)

**Potenziale ★★☆☆☆ · Attinenza ★★★☆☆ · Sforzo Basso**

**Sintesi.** Scheda prodotto sintetica. Piattaforma cloud no-code con logica **If-This-Then-That**,
150+ template di strategie pronte, backtesting integrato, connessione via API senza permessi di
prelievo, supporto multi-exchange.

**Attinenza.** Valore quasi esclusivamente come **benchmark UX del rule builder**. Il rule engine di
[strategyEngine.js](../../../src/perps/strategyEngine.js) è già più espressivo di un IFTTT lineare
(regole tipizzate, combinazione `any`/`all`, gate ML) ma è definito via JSON: Coinrule mostra come si
presenta la stessa potenza a un utente non tecnico.

**Spunti operativi**

1. **Libreria di template di strategie** ⭐ — l'idea più riusabile: preset pronti (RSI mean reversion,
   EMA crossover, funding carry, breakout ATR) che l'utente clona e modifica. Riduce drasticamente
   l'attrito di partenza e si sposa con la strategy history già presente
   ([server.js:1153](../../../src/server.js#L1153)) e con le proposte `new_strategy_candidate`
   dell'analyst.
2. **Il "no withdrawal permission" è già superato** — l'agent wallet Hyperliquid firma solo ordini,
   non prelievi: garanzia strutturale più forte di un permesso API revocabile. Da valorizzare
   esplicitamente nella UI, perché è un punto di fiducia che l'utente non deduce da solo.

---

#### F.3 · [StockHero](../Stock%20Hero.md)

**Potenziale ★★★☆☆ · Attinenza ★★☆☆☆ · Sforzo —** — *doc a metà tra F e G*

**Sintesi.** Analisi di landing page e modello di business SaaS no-code: segmentazione per persona
(beginner / esperto / executive / day trader), **Marketplace di strategie** (gli esperti pubblicano,
i principianti "affittano"), paper trading, pricing a tre livelli basato sul **numero di bot attivi**,
e un blocco di *risk reversal* — no fund custody, ISO 27001, rimborso 7 giorni.

**Attinenza tecnica bassa, ma due idee sopravvivono**

1. **Marketplace / condivisione di strategie** — se il progetto diventasse multi-utente, è il
   moltiplicatore di valore più forte del documento. Oggi fuori scope, ma la strategy history già
   esistente ne è il precursore naturale.
2. **Pricing basato sul numero di bot attivi** — [botManager.js](../../../src/perps/botManager.js)
   gestisce già N bot concorrenti: la metrica di scalabilità esiste, mancherebbe solo il modello
   commerciale.

---

### 🅖 Tema G — Prodotto, pricing & CRO

---

#### G.1 · [Trade Ideas — Summer Sale Landing Page](../Trade%20Ideas.md)

**Potenziale ★★☆☆☆ · Attinenza ★☆☆☆☆ · Sforzo —**

**Sintesi.** Dissezione di una landing page promozionale: promo bar, hero con gioco di parole
finanziario (*"Go Long On Our Summer Sale!"*), value proposition a tre pilastri, pricing table con
**price anchoring** (prezzo barrato accanto allo scontato), guida in 3 step, social proof con trade
profittevoli recenti, countdown timer.

**Attinenza — la più bassa della KB, e va detto senza giri di parole.** Zero contenuto tecnico: è un
documento di marketing/CRO in una KB altrimenti ingegneristica. **Non contiene spunti applicabili al
codice.** Ha senso conservarlo solo nell'ipotesi di commercializzare il bot; in quel caso le due
regole trasferibili sono: motivare sempre lo sconto (uno sconto senza ragione svaluta il prodotto) e
usare il price anchoring.

> 💡 **Suggerimento di organizzazione:** `Trade Ideas.md` e `Stock Hero.md` sono documenti di
> *business*, non di *ingegneria*. Se la KB cresce, meritano una cartella separata — vedi §4.

---

## 3. Backlog derivato dalla KB — prioritizzato

Ordinato per **rapporto valore/sforzo**, non per tema. Ogni voce cita il documento d'origine.

### 🔴 Priorità 1 — Sicurezza e correttezza (fare subito, sforzo basso)

| # | Azione | File coinvolti | Fonte |
|:--|:---|:---|:---|
| 0 | **TP/SL non ri-piazzati dopo un'aggiunta DCA**: dopo lo step la posizione supera la size dei trigger → stop parzialmente scoperto | [bot.js](../../../src/perps/bot.js) `_maybeDca` | §B.1 |
| 1 | Audit supply chain npm: `npm ci`, `ignore-scripts`, audit in CI, lockfile diff in review | [package.json](../../../package.json), `.github/`, [Dockerfile](../../../Dockerfile) | §D.1 |
| 2 | Infisical da opzionale a **default** → niente `.env` sul disco | [package.json](../../../package.json), [DEPLOY.md](../../DEPLOY.md) | §D.1 |
| 3 | ✅ ~~Verificare che TP/SL siano trigger order lato exchange~~ — **verificato: lo sono** (`placeTriggerOrder`), sopravvivono a un crash. Resta aperto il caso DCA (riga 0) | [bot.js](../../../src/perps/bot.js) | §E.1 |
| 4 | **Verificare la base di calcolo del sizing** (account value totale, non margine libero) | [riskManager.js](../../../src/perps/riskManager.js) | §C.2 |
| 5 | ✅ ~~Auth/HMAC + rate limit sul webhook che può scatenare ordini~~ — **chiuso in SEC-04**: la rotta è dietro `requireAuth`, rate limit globale su `/api` e secret a confronto costante. L'HMAC servirebbe solo aprendo l'endpoint a fonti esterne (opzione A, scartata) — non è un debito attuale | [server.js:1128](../../../src/server.js#L1128) | §F.1 + §D.1 |

> Le voci 3 e 4 sono **verifiche**, non necessariamente modifiche: possono chiudersi in pochi minuti
> con esito "già a posto". Vanno comunque fatte, perché entrambe hanno un downside asimmetrico —
> falliscono in silenzio finché non falliscono nel momento peggiore.

### 🟠 Priorità 2 — Edge e qualità del segnale (sforzo medio, impatto alto)

| # | Azione | File coinvolti | Fonte |
|:--|:---|:---|:---|
| 6 | Predictor a **3 classi** `[Idle, Long, Short]` con soglia di confidenza | [predictor.js](../../../src/perps/predictor.js), [bot.js](../../../src/perps/bot.js) | §B.2 + §B.3 |
| 7 | **Regime come selettore di strategia** (non solo filtro d'ingresso: ADX/ATR ci sono già) | [strategyEngine.js](../../../src/perps/strategyEngine.js), [bot.js](../../../src/perps/bot.js) | §B.3 + §B.1 |
| 8 | **Sizing liquidity-aware**: haircut sulla size su book sottile | [riskManager.js](../../../src/perps/riskManager.js) | §A.1 |
| 9 | Correlazione tra posizioni nei limiti di portafoglio | [portfolio.js](../../../src/perps/portfolio.js) | §B.1 |
| 10 | Verificare/modellare le **fee** nel backtester | [backtester.js](../../../src/perps/backtester.js) | §B.1 |
| 11 | Feature di portafoglio nel predictor (posizione aperta, P&L) | [predictor.js](../../../src/perps/predictor.js) | §B.2 |
| 12 | Strategia **contrarian su funding rate** (proxy di sentiment, già disponibile) | [strategyEngine.js](../../../src/perps/strategyEngine.js) | §C.2 |

### 🟡 Priorità 3 — Architettura (sforzo alto, va progettato)

| # | Azione | File coinvolti | Fonte |
|:--|:---|:---|:---|
| 13 | **AOLM**: stato `pending_entry`, ordini limit con re-quote, cancel su decadimento segnale | [bot.js](../../../src/perps/bot.js), [strategyEngine.js](../../../src/perps/strategyEngine.js) | §A.1 |
| 14 | **Strategia Grid** (il DCA esiste già; il grid richiede ordini multipli per bot — prerequisito condiviso con #13) | nuovo modulo + [strategyEngine.js](../../../src/perps/strategyEngine.js) | §B.1 |
| 15 | Agent **`strategy-tuner`**: auto-tuning periodico che propone parametri via coda proposte | [runtime.js](../../../src/agents/runtime.js) + [optimizer.js](../../../src/perps/optimizer.js) | §C.1 |
| 16 | **SLO di latenza** in metrics (istogrammi, non solo contatori) | [metrics.js](../../../src/perps/metrics.js) | §A.2 |
| 17 | Tick **event-driven** su chiusura candela invece che su timer | [bot.js](../../../src/perps/bot.js), [marketData.js](../../../src/perps/marketData.js) | §A.2 |

### ⚪️ Priorità 4 — Prodotto / UX (opzionale)

| # | Azione | Fonte |
|:--|:---|:---|
| 18 | Libreria di **template di strategie** pronti all'uso | §F.2 |
| 19 | Trendline automatiche e cluster S/R come tipi di regola | §F.1 |
| 20 | **Spread sintetici / pair trading** — arbitraggio statistico, coerente col nome del progetto | §F.1 |
| 21 | Marketplace/condivisione strategie (solo se multi-utente) | §F.3 |

---

## 4. Note di manutenzione della KB

Tre problemi rilevati durante l'indicizzazione:

1. **🔁 Duplicato.** [`Adaptive Order Lifecycle Management in Mercati Event-Driven.md`](../Adaptive%20Order%20Lifecycle%20Management%20in%20Mercati%20Event-Driven.md)
   e [`guida_polymarket_aolm_bot.md`](../guida_polymarket_aolm_bot.md) derivano **dalla stessa fonte**
   (daily.dev, `jssagsylc`) e coprono lo stesso contenuto. Differenze minori: il secondo include uno
   snippet Python delle classi `Order`/`AOLMEngine` e una sezione dedicata alla gestione del rischio.
   **Consiglio:** fondere in un unico file, tenendo lo snippet Python. In questo indice sono trattati
   come una scheda sola (§A.1).

2. **✏️ Typo nel nome file.** `rchitettura Modulare e AsyncIO per Bot di Trading.md` → manca la `A`
   iniziale. Rinominare in `Architettura Modulare e AsyncIO per Bot di Trading.md` (aggiornando il
   link in §A.2 di questo file).

3. **🗂️ Convenzioni di naming e struttura.** Convivono tre stili: `guida_*.md` (snake_case),
   `Titolo Con Spazi.md`, `Titolo-Con-Trattini.md`. Gli spazi nei nomi richiedono `%20` in ogni link.
   **Consiglio:** standardizzare su `kebab-case`, e separare i documenti per tema — in particolare
   isolare i due documenti di business (`Trade Ideas.md`, `Stock Hero.md`) dal resto, che è
   ingegneristico.

---

## 5. Come mantenere questo indice

Aggiungendo un documento in `docs/KB/`:

1. Inserirlo nella **mappa tematica** (§1) e nella **matrice di sintesi** (§1.1) con potenziale, attinenza e sforzo.
2. Scrivere la **scheda** (§2) sotto il tema corretto, includendo sempre: *Sintesi* → *Attinenza al progetto* → *Spunti operativi mappati sui file* → *Cosa ignorare*.
3. Se produce azioni concrete, aggiungerle al **backlog** (§3) nella fascia di priorità giusta.
4. Aggiornare la data in testa.

**Criterio di valutazione dell'attinenza.** Chiedersi, in ordine: *(a)* è già implementato nel
progetto? *(b)* è compatibile con lo stack (Node.js, single-process, SQLite, no dipendenze pesanti)?
*(c)* introduce nuova superficie d'attacco su un sistema che maneggia chiavi private (§D.1)?
*(d)* è verificabile in backtest walk-forward prima di andare live?

Un documento che fallisce (b) o (c) può comunque valere per cherry-picking di singole idee — è il caso
del Transformer (§B.3) — ma non come roadmap da seguire.
