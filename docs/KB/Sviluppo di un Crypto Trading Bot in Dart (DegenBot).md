# Guida: Sviluppo di un Crypto Trading Bot in Dart (DegenBot)

**Fonte originale:** [Building a Dart Crypto Trading Bot: Rules Decide, AI Explains](https://medium.com/@diweesomchi/building-a-dart-crypto-trading-bot-rules-decide-ai-explains-a8df95001f45)
**Autore Originale:** Diwe Esomchi
**Scopo di questo documento:** Fonte di conoscenza per il progetto del bot di trading. Analisi di un'architettura che separa le decisioni deterministiche dalle spiegazioni generate dall'Intelligenza Artificiale.

---

## 📋 Indice
1. [La Filosofia Architetturale: Regole vs LLM](#1-la-filosofia-architetturale-regole-vs-llm)
2. [La Pipeline di Intelligence a 5 Livelli](#2-la-pipeline-di-intelligence-a-5-livelli)
3. [Motore a Regole (4-Gate Rule Engine)](#3-motore-a-regole-4-gate-rule-engine)
4. [Gestione Dinamica delle Strategie e Vendita](#4-gestione-dinamica-delle-strategie-e-vendita)
5. [Integrazione LLM per le Spiegazioni](#5-integrazione-llm-per-le-spiegazioni)
6. [Spunti per Miglioramenti nel Nostro Progetto](#6-spunti-per-miglioramenti-nel-nostro-progetto)

---

## 1. La Filosofia Architetturale: Regole vs LLM
Il concetto centrale di **DegenBot** (bot scritto interamente in Dart) è la sostituzione di un modello decisionale "LLM-first" con un motore a regole deterministico. 
*   **Le Regole Decidono:** Le decisioni di trading non sono mai influenzate dalle previsioni dei modelli linguistici, ma si basano esclusivamente su logica condizionale rigorosa.
*   **L'AI Spiega:** Gli LLM vengono retrocessi a un puro "livello di spiegazione". Ricevono il verdetto dal motore a regole e lo traducono in un riassunto in linguaggio naturale (es. per le notifiche su Telegram) senza però alterare mai la scelta operativa del bot.

## 2. La Pipeline di Intelligence a 5 Livelli
Per operare efficacemente nel mercato crypto, il bot utilizza un'infrastruttura di raccolta dati a cinque livelli che aggrega informazioni in tempo reale:
*   **DexScreener** per i flussi di dati principali e volumi.
*   **GoPlus** e **RugCheck** per analisi di sicurezza degli smart contract.
*   **ChainGPT** per analisi addizionali.
*   **Analisi forense on-chain** per un monitoraggio a livello blockchain.

## 3. Motore a Regole (4-Gate Rule Engine)
Tutti i dati raccolti passano attraverso un imbuto decisionale composto da quattro filtri logici rigorosi:
1.  **Honeypot Check:** Verifica che il token non sia una truffa progettata per bloccare le vendite dopo l'acquisto.
2.  **Safety Scan:** Rileva anomalie e vulnerabilità nello smart contract.
3.  **Liquidity Lock:** Controlla che la liquidità sia bloccata.
4.  **Market Cap Range:** Il token deve rientrare in precisi limiti di capitalizzazione di mercato per essere tradabile.

## 4. Gestione Dinamica delle Strategie e Vendita
Il bot implementa un approccio dinamico per mitigare i rapidi sbalzi della criptovaluta:
*   **Modulo StrategyDiscovery:** Ogni 4 ore questo modulo ricalibra la finestra ottimale della capitalizzazione di mercato (Market Cap) calcolando a ritroso i parametri di lancio dei token che hanno registrato i migliori "pump".
*   **Strategia di Vendita:** Invece di dipendere da un fisso "Take Profit", la strategia di vendita àncora l'operatività al minimo storico post-acquisto (*post-buy all-time low*).

## 5. Integrazione LLM per le Spiegazioni
Anche se non determinano le operazioni, i modelli IA svolgono un ruolo chiave per la visibilità dell'utente:
*   Il livello LLM utilizza `dartantic_ai`, che permette di variare i provider a runtime (sfruttando in base alle necessità Claude, Gemini o GPT).
*   È integrato un robusto meccanismo di "fallback": se le API dell'LLM falliscono, il sistema usa direttamente il messaggio grezzo (raw reason string) generato dal motore a regole per giustificare la trade, senza bloccarsi.

---

## 6. Spunti per Miglioramenti nel Nostro Progetto (Knowledge Base)
Analizzando l'architettura di DegenBot, ecco alcune direttive fondamentali da applicare alla nostra pipeline:

1.  **Isolamento Deterministico del Trading:** Come abbiamo visto, far generare segnali diretti di Buy/Sell agli LLM porta a grandi inefficienze o fallimenti. Un *Rule Engine* matematico e solido deve essere il decisore ultimo, relegando l'IA a ruoli ausiliari (reporting, sentiment analysis su dati esterni).
2.  **Auto-Tuning Retroattivo:** Introdurre un processo temporizzato (simile allo *StrategyDiscovery*) che analizza a ritroso le crypto che hanno appena performato bene, aggiustando autonomamente i filtri target del bot (es. volatilità o volumi minimi ricercati nelle ultime N ore).
3.  **Vendite Ancorate (Dynamic Trailing):** Superare il concetto limitato del Take Profit fisso in percentuale, sperimentando ancoraggi al *post-buy all-time low* per sfruttare asimmetricamente i movimenti rialzisti parabolici tipici delle altcoin.
4.  **Fallback Graceful per l'AI:** Tutti i layer integrati di Machine Learning o LLM (inclusi FinBERT e analisi sentiment via web) devono possedere fallback sicuri nel caso in cui i loro endpoint cadano, assicurandosi che il loop centrale di trade continui a operare grazie alla logica algoritmica grezza.