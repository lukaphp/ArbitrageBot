# Guida: Sviluppo di un Bot di Trading Cripto basato su LLM e Sentiment Analysis

**Fonte originale:** [I tried coding a LLM Crypto Trading Bot (to retire early $$$) - YouTube](https://www.youtube.com/watch?v=cYqNBY7i0hI)
**Scopo di questo documento:** Fonte di conoscenza per il progetto del bot di trading. Analisi di diverse iterazioni di strategie basate su AI/LLM per identificare le insidie comuni e la strategia finale profittevole.

---

## 📋 Indice
1. [Stack Tecnologico e Setup Iniziale](#1-stack-tecnologico-e-setup-iniziale)
2. [Anatomia del Bot (Lumibot)](#2-anatomia-del-bot-lumibot)
3. [Evoluzione delle Strategie e Fallimenti](#3-evoluzione-delle-strategie-e-fallimenti)
4. [La Strategia Vincente: Contrarian Long-Only](#4-la-strategia-vincente-contrarian-long-only)
5. [Gestione del Rischio e Position Sizing](#5-gestione-del-rischio-e-position-sizing)
6. [Spunti per Miglioramenti nel Nostro Progetto](#6-spunti-per-miglioramenti-nel-nostro-progetto)

---

## 1. Stack Tecnologico e Setup Iniziale
Il bot è stato costruito testando diverse librerie e approcci per il backtesting e l'esecuzione:
- **Framework di Trading:** `lumibot.strategies.strategy` (semplifica la gestione del ciclo di vita del trade).
- **Backtesting:** Modulo CCXT integrato in Lumibot (dati storici da exchange come Kraken).
- **Modelli AI Testati:** Open Hermes / Qwen 2.5 14B (tramite Ollama) per LLM generalista, e **FinBERT** per un'analisi del sentiment specializzata in ambito finanziario.
- **Fonti Dati News:** Inizialmente Serper API (ricerca web generica), poi sostituita con **Alpaca News API** per maggiore stabilità.

## 2. Anatomia del Bot (Lumibot)
La classe principale del bot (`MLTrader`) eredita dalla strategia di Lumibot e si divide in tre metodi fondamentali:
1. **`initialize`**: Imposta i parametri base, come il capitale a rischio (`cash_at_risk`), la moneta da scambiare (es. Bitcoin, Solana, Ripple), la frequenza (es. `sleep_time = 1 day`) e l'exchange (mercati crypto 24/7).
2. **`position_sizing`**: Calcola la quantità di asset da comprare basandosi sul capitale disponibile, la percentuale di rischio e l'ultimo prezzo noto.
3. **`on_trading_iteration`**: Il cuore della logica di trading, eseguito ad ogni tick/candela. Valuta le condizioni (es. sentiment) e piazza ordini (`buy`, `sell`, `hold`).

## 3. Evoluzione delle Strategie e Fallimenti
Il video documenta un processo iterativo molto utile per capire cosa *non* fare:

- **Fase 1: Rando Bot (Scelte Casuali):** Un bot basato puramente su probabilità casuali (Hold, Buy, Sell) genera perdite consistenti (-8.98%). Utile solo come base architetturale.
- **Fase 2: LLM Sentiment Base:** L'utilizzo di un LLM generico (Ollama) per leggere le news e restituire un sentiment (Positivo/Negativo) come segnale trend-following (Compra se positivo, Vendi/Shorta se negativo). *Risultato:* Disastroso (-65.36%). Il bot apriva posizioni short sbilanciate.
- **Fase 3: Direct Agent Recommendations:** Invece di chiedere il sentiment, si chiede all'LLM di suggerire direttamente "Compra" o "Vendi". *Risultato:* Peggiore in assoluto (-450% di draw down).
- **Fase 4: FinBERT (Sentiment Finanziario):** Abbandono degli LLM generalisti in favore di FinBERT (modello NLP specializzato). Introduzione di Alpaca News API (3 giorni storici). *Risultato:* Ancora in perdita, rivelando che il problema non era solo il modello, ma l'approccio long/short basato sul seguire il sentiment.

## 4. La Strategia Vincente: Contrarian Long-Only
La svolta è arrivata cambiando radicalmente la logica di esecuzione basata sui segnali di FinBERT:
1. **Stop allo Shorting:** Passaggio a una strategia **Long-Only** (acquisti e vendite per chiudere, niente vendite allo scoperto).
2. **Approccio Contrarian (Buy the fear):** Invece di comprare con le buone notizie (trend-following), il bot è stato istruito a **COMPRARE quando il sentiment è fortemente NEGATIVO**.
3. **Ottimizzazione Aggressiva:**
   - Riduzione della soglia di probabilità del segnale da 0.999 a 0.99 (per ottenere più ingressi a mercato).
   - Aumento del capitale a rischio (`cash_at_risk`) fino al 50%.
*Risultato:* Rendimento annuale del **+20.04%** (Ritorno totale del 32%).

## 5. Gestione del Rischio e Position Sizing
Diversi errori di Risk Management sono emersi e corretti durante lo sviluppo:
- **Errore di Position Sizing con gli Short:** Usare il capitale liquido (`get_cash`) per calcolare la size mentre si hanno posizioni short aperte porta a size enormi e bilanci negativi. Soluzione: usare il valore totale del portafoglio (`get_portfolio_value`).
- **Uscite programmate:** Nella strategia Long-Only finale, sono stati introdotti parametri di sicurezza fissi al momento dell'ordine:
  - **Take Profit:** 1.5% sopra il prezzo di acquisto.
  - **Stop Loss:** 70% (piuttosto largo, configurato probabilmente per evitare chiusure su volatilità standard crypto).

---

## 6. Spunti per Miglioramenti nel Nostro Progetto (Knowledge Base)
Dal fallimento e successo di questo esperimento, possiamo estrarre le seguenti linee guida per il nostro bot:

1. **Evitare LLM Generalisti per Segnali Diretti:** Usare modelli NLP specializzati (come FinBERT) per estrarre il sentiment, ed evitare di chiedere a modelli come ChatGPT/Claude suggerimenti diretti di "Buy/Sell".
2. **Testare Strategie Contrarian:** Nel mercato crypto, comprare sull'euforia delle news (sentiment positivo) spesso significa comprare il "top" (Buy the rumor, sell the news). Testare strategie di mean-reversion basate sull'acquisto durante i picchi di sentiment negativo prolungato.
3. **Fonti Dati Affidabili:** Sostituire scraper generici o API di ricerca web (come Serper) con API dedicate (Alpaca News API) per ottenere dati storici puliti e strutturati.
4. **Attenzione allo Shorting Automatizzato:** Le posizioni short nelle crypto possono liquidare rapidamente un portafoglio automatizzato. Partire con strategie Long-Only e implementare lo shorting solo con coperture rigorose.
5. **Calcolo della Size:** Calcolare sempre l'allocazione del capitale basandosi sulla *Total Equity/Portfolio Value* e non solo sul *Cash* disponibile, specialmente se il bot scala in ingressi multipli.
