# Spike Ticket: Modulo di Ragionamento Interno ed Esperienziale ("Sistema Neofita-Maestro")

**Status:** Ready for Backlog (Architecture Spike & R&D) — non ancora pianificato in un'epica/sprint,
registrato qui come candidato futuro su richiesta diretta del PO (12 agosto 2026).

**Target Audience:** Core Engineering Team & System Architects

**Scope:** Progettazione e prototipazione di un sistema di memoria esperienziale interno per il
trading bot, finalizzato a ridurre la dipendenza dai costi dei token LLM esterni e a capitalizzare il
know-how storico delle strategie.

---

## Nota di contesto (Claude, 12 agosto 2026)

Ticket registrato come ricevuto dal PO, contenuto non riscritto. Tre punti di aggancio reali al
codice attuale, utili quando si arriverà a pianificare lo spike vero e proprio:

- **Il sistema è già in parte stateful, non puramente stateless.** `db.getBotStats`/`getBotPerformance`
  (`src/db/database.js`) e lo storico `positions`/`trades` esistono da tempo; il backtester
  (`src/perps/backtester.js`) e il predittore ML (`src/perps/predictor.js`, storico esposto ma senza
  consumer UI — vedi refinement candidate di Sprint 4) raccolgono già segnale storico non ancora
  sfruttato come "memoria" per l'Analyst. Una parte del Task 1 (design architetturale) potrebbe partire
  da qui invece che da zero.
- **`src/agents/analyst/proposals.js`/`riskAgent.js` sono l'unico punto in cui una "decisione" viene
  presa oggi** — qualunque motore interno di euristiche validate dovrebbe alimentare quello stesso
  punto di ingresso (una proposta con `rationale` verificabile), non un canale parallelo: stesso
  principio "le regole decidono, l'AI spiega" già applicato al resto del sistema (vedi
  `.claude/agents/jordan.md`).
- **Il rischio di "falso apprendimento" (SWOT, Weaknesses)** ha già un precedente diretto nel progetto:
  `docs/KB/business-analysis-2026-08-11.md` §3 documenta un campione di 7 trade, esplicitamente
  troppo piccolo per concludere alcunché sulla redditività di una strategia. Qualunque guardrail di
  validazione (Task 2) dovrebbe applicare lo stesso standard — mai promuovere un pattern a "regola
  interna" senza una soglia di significatività statistica dichiarata esplicitamente.

Nessuna verifica ulteriore fatta oltre questi tre agganci — lo spike vero (analisi di fattibilità,
scelta tra RAG/vettoriale e knowledge base strutturata, stima di sforzo) resta da fare quando questa
storia verrà presa in carico.

---

## 1. Obiettivo dello Spike

Analizzare la fattibilità e definire l'architettura per evolvere l'attuale sistema (basato su
interrogazioni *stateless* e ripetute a LLM esterni come Claude) verso un **sistema di
auto-apprendimento interno**. L'obiettivo è fare in modo che la piattaforma accumuli esperienza dai
successi e dai fallimenti passati — agendo come un assistente "neofita" che impara dai "maestri" —
per diventare progressivamente autonoma, ridurre i costi operativi delle API e blindare il know-how
proprietario.

---

## 2. Analisi SWOT dell'Iniziativa

### Punti di Forza (Strengths)

- **Abbattimento drastico dei costi operativi:** riduzione del consumo di token a pagamento per task
  ripetitivi o già affrontati in passato.
- **Consistenza e persistenza del know-how:** conservazione strutturata del *perché* una determinata
  strategia o configurazione sia stata promossa o scartata in base a specifiche condizioni di mercato.
- **Indipendenza dai vendor:** minore esposizione a variazioni di prezzo, cambi di policy o downtime
  dei provider di LLM esterni.

### Punti di Debolezza (Weaknesses)

- **Rischio di "falso apprendimento" (Overfitting):** se il sistema memorizza e replica rigidamente
  strategie passate senza valutare il contesto macroeconomico o di volatilità, rischia di applicare
  regole obsolete a regimi di mercato differenti.
- **Complessità architetturale iniziale:** richiede lo sviluppo di una pipeline di archiviazione e
  indicizzazione dei dati (es. database vettoriali o knowledge base strutturate) assente in un setup
  puramente stateless.

### Opportunità (Opportunities)

- **Creazione di un IP proprietario:** il vero valore competitivo nel trading algoritmico risiede nei
  dati storici e nelle euristiche di apprendimento proprietarie, non nell'accesso all'LLM generico del
  momento.
- **Evoluzione ibrida efficiente:** usare i modelli esterni (i "maestri") solo per la generazione di
  idee innovative o refactoring complessi, delegando la routine al motore interno.

### Minacce (Threats)

- **Propagazione di bug o allucinazioni:** se il sistema "neofita" impara da codice o strategie
  generate in precedenza che contenevano micro-errori occulti, rischia di cristallizzare e amplificare
  i difetti strutturali.

---

## 3. Profilo di Impatto Economico e ROI

- **Riduzione del Cost of Ownership (TCO):** l'abbassamento del volume di chiamate API a modelli di
  frontiera (come le versioni *Thinking* o *Pro*) riduce i costi fissi di sviluppo e manutenzione
  iterativa.
- **Mitigazione dei costi di latenza:** sostituire passaggi di ragionamento complessi con euristiche
  interne o modelli locali riduce i tempi di elaborazione nei cicli decisionali.

---

## 4. Roadmap e Task per il Backlog

1. **Task 1 (Design Architetturale):** definizione delle specifiche per la memorizzazione strutturata
   delle interazioni passate (es. implementazione di un database vettoriale RAG o di una wiki locale
   collegata ai log di esecuzione dei bot).
2. **Task 2 (Definizione dei Guardrail di Validazione):** progettazione di un "esame di abilitazione"
   oggettivo (basato su backtest o paper trading rigoroso) che funga da filtro per impedire al sistema
   di apprendere da strategie fallimentari o allucinate.
3. **Task 3 (Prototipazione del Workflow ibrido):** separazione dei ruoli tra LLM esterno (chiamato
   *solo* per scenari complessi e ideazione) e motore interno (gestione autonoma dei parametri noti e
   dei pattern validati).

---

*Ticket ricevuto dal PO il 12 agosto 2026, registrato come spike candidate — non ancora assegnato a
una release/epica. Da riprendere in un refinement dedicato quando il PO deciderà di darne priorità.*
