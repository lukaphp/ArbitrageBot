# Guida: Sviluppo di un Bot di Trading con Neural Network Transformer 

**Fonte originale:** [33,885+% Returns in 3 years on Cryptocurrency using Neural Network Transformer Model...](https://imbuedeskpicasso.medium.com/33-885-returns-in-3-years-on-cryptocurrency-using-neural-network-transformer-model-and-short-49d0fb7ab78b)
**Autore Originale:** Puranam Pradeep Picasso
**Scopo di questo documento:** Fonte di conoscenza per il progetto del bot di trading, specificamente focalizzata sull'evoluzione verso il deep learning e le reti neurali Transformer.

---

## 📋 Indice
1. [Evoluzione dell'Architettura: Da Algo a Deep Learning](#1-evoluzione-dellarchitettura-da-algo-a-deep-learning)
2. [Dataset e Feature Engineering](#2-dataset-e-feature-engineering)
3. [Gestione degli Sbilanciamenti (Resampling e Pesi)](#3-gestione-degli-sbilanciamenti-resampling-e-pesi)
4. [Architettura Transformer per Serie Storiche](#4-architettura-transformer-per-serie-storiche)
5. [Tecniche di Ensemble](#5-tecniche-di-ensemble)
6. [Risultati del Backtesting](#6-risultati-del-backtesting)
7. [Spunti per Miglioramenti nel Nostro Progetto](#7-spunti-per-miglioramenti-nel-nostro-progetto)

---

## 1. Evoluzione dell'Architettura: Da Algo a Deep Learning
Il progetto descritto nell'articolo segue un processo di evoluzione in 8 step che illustra perfettamente come scalare la complessità di un bot di trading:
- **Livello 1 (Algoritmico Base):** Strategie classiche basate su Freqtrade con indicatori standard (RSI, MACD, Bollinger Bands).
- **Livello 2 (Clustering):** Utilizzo del K-Nearest Neighbors (KNN) per isolare le criptovalute in base alla volatilità.
- **Livello 3 (Trend Analysis):** Hidden Markov Models (HMM) per identificare i "regimi" di mercato (bull, bear, choppy) per evitare di fare trading nei trend negativi o laterali.
- **Livello 4 (Machine Learning - Classificazione):** Modelli ad albero (XGBoost, LightGBM, CatBoost) per classificare i segnali in 0 (Neutral), 1 (Long) e 2 (Short).
- **Livello 5 (Deep Learning & Transformers):** Utilizzo di architetture Neurali avanzate (TCN, LSTM e Transformer) integrate tramite metodi Ensemble per catturare relazioni temporali a lungo termine nei dati.

## 2. Dataset e Feature Engineering
Il test principale del Transformer è stato eseguito su:
- **Asset:** Ethereum (ETH/USDT) e Bitcoin (BTC/USDT).
- **Timeframe:** Candele a 15 minuti (15m).
- **Dimensione Dati:** Più di 97.000 righe e oltre **190 features** calcolate tramite `talib` (TA-Lib) e altre librerie (volumi, momentum, trend, e volatilità).

## 3. Gestione degli Sbilanciamenti (Resampling e Pesi)
Nel trading, i segnali validi per entrare a mercato (Long/Short) sono una piccolissima percentuale rispetto ai momenti in cui il mercato è neutro. 
- Il problema è affrontato trasformando il target in **3 classi**: 0 (Hold/Neutral), 1 (Buy/Long), 2 (Sell/Short).
- **Tecniche utilizzate:** Algoritmi di sovracampionamento (Oversampling) come **ADASYN** (Adaptive Synthetic Sampling) unito al calcolo dei *class_weights* in Keras, per evitare che la rete neurale impari semplicemente a predire sempre "0" (Neutral).

## 4. Architettura Transformer per Serie Storiche
A differenza delle LSTM classiche che elaborano i dati sequenzialmente, i Transformer (basati sul meccanismo di *Self-Attention*) processano l'intera sequenza temporale contemporaneamente.
- Nel bot vengono usati per la **Time Series Classification**, identificando pattern multidimensionali complessi nelle oltre 190 feature, per decidere con precisione chirurgica il momento esatto in cui aprire la posizione.

## 5. Tecniche di Ensemble
L'articolo evidenzia l'importanza cruciale dell'**Ensemble Learning**:
- Invece di affidarsi a un singolo modello, la strategia combina predizioni da TCN (Temporal Convolutional Networks), LSTM (Long Short-Term Memory) e Transformer.
- L'output finale di voto (Voting Classifier o approcci ibridi scikit-learn/Keras) migliora la robustezza, riducendo i falsi positivi.
- Recall, precision, accuracy e F1 score per tutte e tre le classi hanno superato l'80%.

## 6. Risultati del Backtesting
L'uso dei modelli Transformer accoppiati agli approcci precedenti (come CatBoost ed Ensemble) ha prodotto risultati fuori scala:
- Più del **11.270%** su ETH e **4.750%** su BTC (in circa 1000 giorni).
- Percentuali complessive che superano il **33.000%** quando ottimizzate e testate sul lungo periodo, surclassando pesantemente la strategia "Buy & Hold".

---

## 7. Spunti per Miglioramenti nel Nostro Progetto (Knowledge Base)
L'evoluzione descritta in questa architettura ci offre una Roadmap eccellente per aggiornare il nostro bot:

1. **Strategia a 3 Classi:** Modificare la classificazione del nostro bot prevedendo la struttura a tre etichette `[0, 1, 2]` per `[Neutral, Long, Short]`.
2. **Implementare HMM (Hidden Markov Models):** Prima di attivare i nostri algoritmi di trade, utilizzare HMM per fare *Regime Detection*. Se l'HMM dice che il mercato è incerto o bear, il bot disattiva l'engine Long per quella crypto.
3. **Migliorare il Risk/Reward via Resampling:** Quando si addestrano i modelli AI (anche un semplice Random Forest o XGBoost che già potremmo avere), dobbiamo integrare metodi come `ADASYN` (da `imblearn`) per bilanciare le classi target.
4. **Dal ML al Deep Learning:** Se l'attuale stack del progetto usa alberi decisionali, il prossimo step architetturale deve essere l'introduzione di layer Attention/Transformer o un ibrido LSTM/Transformer per i dati M15, usando Keras/TensorFlow.
5. **Feature Engineering Massiccio:** Passare dai soliti RSI/MACD a dataset con oltre 100+ feature cross-timeframe. I modelli deep learning "mangiano" grandi quantità di feature e riescono a scartare il rumore molto meglio dei modelli tradizionali.
