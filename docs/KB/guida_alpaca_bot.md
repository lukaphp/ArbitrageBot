# Guida: Sviluppo di un Bot di Trading per Criptovalute con Alpaca e Python

**Fonte originale:** [Building an Automate Your Crypto Trading Bot using Alpaca Trading in Python](https://blog.gopenai.com/building-a-automate-your-crypto-trading-bot-using-alpaca-trading-in-python-a9a5fa095eea)
**Autore Originale:** Sahaj Godhani
**Scopo di questo documento:** Fonte di conoscenza per il progetto del bot di trading. Utilizzabile per migliorare, correggere o suggerire cambiamenti all'architettura e alle strategie del bot.

---

## 📋 Indice
1. [Configurazione dell'Ambiente di Sviluppo](#1-configurazione-dellambiente-di-sviluppo)
2. [Account Alpaca e Chiavi API](#2-account-alpaca-e-chiavi-api)
3. [Installazione delle Librerie](#3-installazione-delle-librerie)
4. [Connessione all'API di Alpaca](#4-connessione-allapi-di-alpaca)
5. [Sviluppo della Strategia di Trading](#5-sviluppo-della-strategia-di-trading)
6. [Logica di Esecuzione dei Trade](#6-logica-di-esecuzione-dei-trade)
7. [Gestione del Rischio e del Portafoglio](#7-gestione-del-rischio-e-del-portafoglio)
8. [Esecuzione del Bot](#8-esecuzione-del-bot)
9. [Monitoraggio e Analisi](#9-monitoraggio-e-analisi)
10. [Spunti per Miglioramenti nel Nostro Progetto](#10-spunti-per-miglioramenti-nel-nostro-progetto)

---

## 1. Configurazione dell'Ambiente di Sviluppo
Per iniziare, è necessario preparare l'ambiente di sviluppo. 
- **Linguaggio:** Python (assicurarsi di avere una versione aggiornata, es. 3.9+).
- **IDE:** Si consiglia PyCharm, Visual Studio Code (VS Code) o simili per la gestione agevole degli script e del debugging.
- **Isolamento:** È raccomandato l'uso di un virtual environment (`venv` o `conda`) per gestire le dipendenze in modo pulito.

## 2. Account Alpaca e Chiavi API
Alpaca Markets è un broker commission-free con un'ottima API progettata per gli sviluppatori, ideale per il trading algoritmico.
- Crea un account gratuito su [Alpaca Markets](https://alpaca.markets).
- Genera le **API Keys** (Key ID e Secret Key) dalla dashboard, preferibilmente per un conto **Paper Trading** (simulazione) prima di passare in produzione.

## 3. Installazione delle Librerie
Le librerie principali necessarie per l'analisi dei dati, l'interazione con l'API e la visualizzazione sono:
- `alpaca-trade-api` (SDK ufficiale)
- `pandas` (manipolazione dati)
- `numpy` (calcoli numerici)
- `matplotlib` (visualizzazione dati)

```bash
pip install alpaca-trade-api pandas numpy matplotlib
```
*Nota: Alpaca offre anche un nuovo SDK (`alpaca-py`), valutare l'aggiornamento se si usa la vecchia versione nel progetto.*

## 4. Connessione all'API di Alpaca
Lo script deve stabilire una connessione sicura con i server di Alpaca per recuperare dati di mercato in tempo reale ed eseguire ordini.

```python
import alpaca_trade_api as tradeapi

BASE_URL = "https://paper-api.alpaca.markets" # Usa l'URL paper per i test
KEY_ID = "LA_TUA_CHIAVE_QUI"
SECRET_KEY = "LA_TUA_CHIAVE_SEGRETA_QUI"

api = tradeapi.REST(KEY_ID, SECRET_KEY, BASE_URL, api_version='v2')
```

## 5. Sviluppo della Strategia di Trading
La strategia si basa sulla definizione di indicatori, regole e condizioni per l'acquisto e la vendita di criptovalute.
- **Analisi Tecnica:** Utilizzare medie mobili (SMA/EMA), Relative Strength Index (RSI), o Bande di Bollinger per identificare segnali di ingresso/uscita.
- *Suggerimento per il progetto:* Separare la logica della strategia dal resto del codice per consentire backtesting e sostituzione agevole delle strategie.

## 6. Logica di Esecuzione dei Trade
Traduci la tua strategia in codice. Sfrutta le funzioni dell'API di Alpaca per piazzare ordini.
Esempio concettuale di invio ordine:
```python
api.submit_order(
    symbol='BTCUSD',
    qty=0.01,
    side='buy',
    type='market',
    time_in_force='gtc'
)
```
- Implementare controlli per evitare ordini multipli non desiderati o invii in caso di saldo insufficiente.

## 7. Gestione del Rischio e del Portafoglio
Il Risk Management è cruciale:
- **Stop-loss e Take-profit:** Alpaca supporta ordini bracket. Usa questi strumenti per mitigare le perdite.
- **Position Sizing:** Non investire l'intero capitale in un solo trade. Calcola dinamicamente la size della posizione in base alla volatilità.
- **Diversificazione:** Opera su più coppie di criptovalute per spalmare il rischio.

## 8. Esecuzione del Bot
Il bot deve essere eseguito in un loop continuo o tramite un gestore di eventi (WebSocket) per reagire ai dati in tempo reale (tick).
- Assicurarsi di gestire correttamente le eccezioni (`try/except`) per evitare crash del bot dovuti a disconnessioni di rete temporanee.

## 9. Monitoraggio e Analisi
- **Logging:** Implementare un sistema di logging solido (libreria `logging` di Python) per tracciare esecuzioni, errori e stato del portafoglio.
- **Dashboarding/Visualizzazione:** Salvare i log e l'equity curve su file o database e analizzarli (usando `pandas` e `matplotlib`) per raffinare la strategia post-esecuzione.

---

## 10. Spunti per Miglioramenti nel Nostro Progetto (Knowledge Base)
Basandoci sui concetti di questo articolo, ecco alcune linee guida da applicare al nostro bot:

1. **Migrazione SDK:** Controllare se il progetto utilizza `alpaca-trade-api` (deprecato per alcune nuove feature) o il più recente `alpaca-py`. Passare al nuovo se possibile.
2. **Architettura Modulare:** Assicurarsi che le *Strategie* (Sezione 5), l'*Execution* (Sezione 6) e il *Risk Management* (Sezione 7) siano classi o moduli separati.
3. **Gestione del Rischio via API:** Implementare gli ordini Bracket (OCO/OTO) direttamente nativi in Alpaca al posto di gestire Stop Loss e Take Profit in locale sul loop del bot, per ridurre il rischio legato a lag o crash del sistema.
4. **WebSocket vs REST:** Per il punto 4 e 8, valutare l'integrazione di stream WebSocket per ricevere dati di mercato veri (push) invece di fare polling frequente (REST API), in modo da essere più veloci nella reazione e limitare gli alert rate limit di Alpaca.
5. **Ambienti Separati:** Implementare configurazioni `.env` per separare rigorosamente le chiavi Paper (test) dalle chiavi Live (reali).
