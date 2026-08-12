# Spike Story: Valutazione dell'Integrazione di MetaTrader nell'Infrastruttura del Bot

**Status:** Ready for Backlog (Architecture Spike & R&D) — non ancora pianificato in un'epica/sprint,
registrato qui su richiesta diretta del PO (12 agosto 2026).

**Target Audience:** Core Engineering Team & System Architects

**Scope:** Analisi di fattibilità, vincoli architetturali e benefici derivanti dall'adozione di
MetaTrader (MT4/MT5) come layer di esecuzione o supporto per il sistema di trading automatizzato,
valutando il trade-off rispetto alle attuali integrazioni dirette via API con gli exchange.

---

## Nota di contesto (Claude, 12 agosto 2026)

Ticket registrato come ricevuto dal PO, contenuto non riscritto. Tre agganci reali al progetto
attuale, utili per delimitare lo spike quando verrà preso in carico:

- **Oggi non esiste alcuna integrazione MetaTrader nel codice** — l'unica execution venue è
  Hyperliquid (perpetui), via API REST/WebSocket dirette (`src/perps/hyperliquidClient.js`,
  `marketData.js`). Non è un broker CFD/forex con un gateway MetaTrader: è un DEX di perpetui a
  custodia autonoma (wallet firmato via EIP-712, mai custodito da terzi). Il ponte descritto nel
  ticket ("Python → Bridge → MetaTrader → Broker") implicherebbe quindi **una terza venue di
  esecuzione distinta da Hyperliquid**, non un layer sopra di essa — un broker CFD crypto separato,
  con margine, custodia e struttura di costo (spread/overnight) diverse dai funding rate dei
  perpetui. Il Task 1 dello spike (compatibilità di mercato) dovrebbe partire esplicitamente da
  questa distinzione, non darla per implicita.
- **Precedente diretto e recente nel progetto, in direzione opposta:** Sprint 3 (Release 1, EVM-01)
  ha **ritirato** la demo EVM legacy proprio per ridurre superficie ed eliminare un secondo stack di
  esecuzione parallelo mai arrivato a maturità (`docs/KB/BACKLOG/release1/sprint3.md`). Un'eventuale
  integrazione MetaTrader riporterebbe il progetto verso una struttura multi-venue — la Minaccia di
  "Lock-in Tecnologico" già individuata nel ticket va quindi letta insieme al costo di manutenzione
  già sperimentato una volta con l'onboarding EVM, non solo in astratto.
- **Tensione architetturale non ancora nominata nel ticket:** l'intero sistema di rischio attuale
  (`portfolio.js`, `riskManager.js`, i limiti di Sprint 1) è disegnato per un conto a margine
  unificato self-custodied su un singolo indirizzo. Un conto MetaTrader è custodito dal broker, con
  un modello di margine proprio: qualunque prototipo (Task 2) erediterebbe due sistemi di gestione
  del rischio paralleli, non uno esteso — da rendere esplicito nel documento di chiusura (Task 3)
  come costo strutturale, non solo operativo.

Nessuna verifica ulteriore fatta oltre questi tre agganci — l'analisi di fattibilità vera (quali
broker offrono CFD crypto via MetaTrader, quali asset del bot sarebbero coperti, stima di sforzo per
il bridge) resta da fare quando questa storia verrà presa in carico.

---

## 1. Obiettivo dello Spike

Valutare se l'introduzione di **MetaTrader** all'interno dell'attuale stack tecnologico possa offrire
vantaggi concreti in termini di esecuzione degli ordini, stabilità della piattaforma e accesso ai
mercati.

L'attività **non prevede lo sviluppo o la scrittura di codice di produzione in questa fase**, ma la
produzione di una diagnosi tecnica finalizzata a rispondere al quesito fondamentale: *conviene
integrare MetaTrader o mantenere l'architettura nativa basata su API dirette e WebSocket?*

---

## 2. Analisi SWOT dell'Integrazione di MetaTrader

### Punti di Forza (Strengths)

- **Ecosistema di Esecuzione Consolidato:** MetaTrader (specie MT5) offre un motore di gestione degli
  ordini estremamente robusto, collaudato da anni sui mercati finanziari tradizionali e forex.
- **Strumenti di Backtest e Analisi Grafica Nativi:** disponibilità di librerie native e ambienti di
  testing (Strategy Tester) altamente performanti per la validazione preliminare delle strategie.
- **Standardizzazione delle Connessioni:** molti broker tradizionali e multi-asset offrono un gateway
  unificato tramite MetaTrader, semplificando la gestione di molteplici canali di accesso.

### Punti di Debolezza (Weaknesses)

- **Limiti del Linguaggio e dei Bridge:** le logiche di IA e i modelli sviluppati in Python
  richiedono bridge complessi (es. socket o librerie di terze parti come il pacchetto Python
  `MetaTrader5`) per comunicare con l'ambiente MetaTrader, introducendo potenziali colli di bottiglia
  di latenza.
- **Vincoli sui Mercati Crypto Spot/DeFi:** MetaTrader nasce storicamente per Forex e CFD (perpetui/
  derivati); la sua adozione nativa su mercati crypto spot o DEX decentralizzati è limitata o
  vincolata ai singoli broker che offrono CFD crypto.
- **Controllo Incompleto dell'Infrastruttura:** dipendenza da un software proprietario di terze parti
  (MetaQuotes) e dai gateway del broker, riducendo la flessibilità architetturale rispetto a un
  connettore API proprietario.

### Opportunità (Opportunities)

- **Maggiore Resilienza su Asset Supportati:** se il perimetro di investimento include derivati o
  asset coperti dai broker MetaTrader, si possono sfruttare meccanismi di failover e gestione del
  margine già pronti all'uso.
- **Riduzione dello Sviluppo Custom:** delega a MetaTrader di alcune funzioni di basso livello (es.
  gestione grafica degli ordini, tracciamento base del rischio di conto).

### Minacce (Threats)

- **Latenza Aggiuntiva:** l'aggiunta di un ulteriore strato di comunicazione (Python/LLM → Bridge →
  MetaTrader → Broker) potrebbe compromettere i requisiti di reattività richiesti dai bot di
  investimento dinamici.
- **Lock-in Tecnologico:** vincolarsi a un'architettura dipendente da MetaTrader limita la
  portabilità del codice verso exchange nativi crypto o infrastrutture cloud distribuite.

---

## 3. Impatto sul Profilo di Rendimento-Rischio e Sostenibilità

- **Costi Operativi e Invisibili:** l'adozione di MetaTrader comporta la valutazione dei costi di
  licenza indiretti o degli spread/commissioni applicati dai broker che supportano la piattaforma,
  che potrebbero erodere i margini di profitto del bot.
- **Stabilità vs Complessità:** se da un lato MT offre stabilità di esecuzione, dall'altro la
  complessità di manutenzione di un'architettura ibrida (Python + Bridge + MetaTrader) potrebbe
  aumentare il rischio di downtime operativo.

---

## 4. Roadmap e Task per il Backlog dello Spike

1. **Task 1 (Analisi di Compatibilità di Mercato):** verificare se gli asset di interesse del bot
   sono pienamente supportati dai broker MetaTrader di riferimento (con particolare attenzione a
   differenze tra Spot e CFD/Perps).
2. **Task 2 (Prototipazione del Bridge Tecnologico):** testare la latenza e la stabilità della
   libreria di connessione Python-MetaTrader (`MetaTrader5`) per valutare la fattibilità dello
   scambio di dati in tempo reale e l'invio automatizzato degli ordini guidati dall'IA.
3. **Task 3 (Valutazione di Architettura Comparata):** redigere un documento di chiusura dello spike
   che metta a confronto i costi, i rischi di latenza e i benefici di MetaTrader rispetto al
   mantenimento dell'attuale stack basato su API dirette.

---

*Ticket ricevuto dal PO il 12 agosto 2026, registrato come spike candidate — non ancora assegnato a
una release/epica. Da riprendere in un refinement dedicato quando il PO deciderà di darne priorità.*
