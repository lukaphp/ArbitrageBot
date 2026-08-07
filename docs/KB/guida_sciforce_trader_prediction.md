# Guida: Modello Predittivo per il Comportamento dei Trader

**Fonte originale:** [Building a trade prediction model for a trader bot](https://medium.com/sciforce/building-a-trade-prediction-model-for-a-trader-bot-f70725a5f046)
**Autore Originale:** Sciforce
**Scopo di questo documento:** Fonte di conoscenza per il progetto del bot di trading. Analisi di un approccio orientato non solo al prezzo dell'asset, ma alla predizione del *comportamento* del trader (o dei bot avversari) sul mercato.

---

## 📋 Indice
1. [Obiettivo: Modellare il Comportamento sul Mercato](#1-obiettivo-modellare-il-comportamento-sul-mercato)
2. [Scelta dei Modelli: LSTM vs XGBoost](#2-scelta-dei-modelli-lstm-vs-xgboost)
3. [Dati di Input e Feature Selection](#3-dati-di-input-e-feature-selection)
4. [L'Importanza dell'Aggregazione e del Contesto Temporale](#4-limportanza-dellaggregazione-e-del-contesto-temporale)
5. [Classificazione a 3 Stati: Il Problema dell'Idle](#5-classificazione-a-3-stati-il-problema-dellidle)
6. [Spunti per l'Architettura e l'Integrazione nel Progetto](#6-spunti-per-larchitettura-e-lintegrazione-nel-progetto)

---

## 1. Obiettivo: Modellare il Comportamento sul Mercato
Invece di limitarsi a prevedere la direzione del prezzo, la strategia illustrata mira a riconoscere e simulare i pattern di specifici trader o algoritmi concorrenti. Questo comporta:
- Riconoscere le tipologie di attori (hedger, arbitraggisti, speculatori).
- Costruire profili basati sullo storico delle attività.
- Identificare l'esatto momento (IN/OUT) o il livello di prezzo in cui interverranno sul mercato.

## 2. Scelta dei Modelli: LSTM vs XGBoost
Per il task di predizione transazionale sono state impiegate e confrontate due famiglie di modelli:
- **LSTM (Long Short-Term Memory):** Tratta nativamente i dati come sequenze temporali. È estremamente flessibile per estensioni future, ma computazionalmente più oneroso.
- **XGBoost (Extreme Gradient Boosting):** Offre tassi di elaborazione dati molto più rapidi. È risultato preferibile negli esperimenti per risparmiare tempo computazionale, arrivando a supportare i dati "tick-by-tick" grezzi.

*Nota:* I risultati hanno dimostrato che il tipo di modello incide meno rispetto alla qualità delle feature, alla lunghezza del contesto e alla finestra di aggregazione.

## 3. Dati di Input e Feature Selection
Il backtesting analizza lo storico dei prezzi incrociato con le azioni passate. I parametri fondamentali sono:
- **Feature di base:** Prezzo, volumi, profitti/posizioni attuali, indicatori tecnici e probabilità di specifici pattern grafici.
- L'uso esclusivo del prezzo genera modelli già robusti, ma l'aggiunta di indicatori e dati di portafoglio incrementa l'accuratezza in modo significativo.

## 4. L'Importanza dell'Aggregazione e del Contesto Temporale
L'esposizione al "rumore" di mercato rende difficile per i modelli estrarre un segnale pulito.
- **Aggregazione:** I dati di mercato vengono impacchettati in finestre temporali (es. 1h, 30m, 15m, 1m). Il periodo ottimale deve coincidere con la frequenza tipica di trading dell'attore modellato.
- **Raw Ticks:** I tick crudi di mercato sono utili solo per bot ad altissima frequenza. Per trader che operano in media 1 volta l'ora, il prezzo di chiusura aggregato è più che sufficiente.
- **Context Length:** Avere un contesto troppo breve fa crollare l'accuratezza; averlo troppo ampio spreca risorse senza migliorare le performance. 

## 5. Classificazione a 3 Stati: Il Problema dell'Idle
Il modello affronta un problema di classificazione multiclasse per il prossimo intervallo temporale: **Buy, Sell, oppure Idle (Nessuna transazione)**.
- Fornisce sia l'azione predetta sia uno *score di confidenza* (es. 80% Buy, 19% Idle, 1% Sell).
- La vera difficoltà per l'IA non è decidere tra Buy e Sell, ma distinguere i momenti "Idle" (le pause tra le operazioni) dai momenti in cui bisogna effettivamente inviare un ordine.

---

## 6. Spunti per l'Architettura e l'Integrazione nel Progetto
L'adozione di un motore basato su questi concetti richiede un framework robusto:

1. **Gestione del Modello Multi-Stato:** Adattare la logica del nostro bot per accettare vettori di confidenza invece di segnali binari. Eseguire l'ordine solo se la confidenza per "Buy/Sell" supera una soglia definita, filtrando efficacemente il rumore (Idle).
2. **Architettura Backend Enterprise:** Disaccoppiare la logica di intelligenza artificiale dal sistema di routing degli ordini. La pipeline di acquisizione dati (tick e aggregazioni M15/H1) e l'interfaccia verso l'exchange possono essere sviluppati come microservizi in **Java e Spring Boot**, incapsulati e scalati fluidamente su **Kubernetes**. Questo permette al modulo Python (dedicato esclusivamente all'inferenza XGBoost o LSTM) di scalare in maniera indipendente dal motore esecutivo.
3. **Pannello di Controllo Sicuro:** Per la visualizzazione delle performance e del tuning dei modelli, l'infrastruttura di gestione richiede accessi controllati. L'implementazione di logiche di autenticazione centralizzate tramite **Single Sign-On (SSO)** assicura una gestione degli accessi professionale per gli endpoint amministrativi.
