# ArbitrageBot Perps — Analisi di valore e capitale minimo

**Data:** 11 agosto 2026 · **Base:** 4 sprint completati, audit indipendente verificato riga per
riga (`docs/AUDIT_REPORT.md`), dati reali estratti dal database di produzione sul VPS (query in sola
lettura). **Rete:** Hyperliquid testnet — nessun capitale reale movimentato ad oggi.

Versione illustrata (stessa analisi): [artifact pubblicato](https://claude.ai/code/artifact/facdc0b8-aeb2-402e-9d15-9c7b51a469b6).

---

## 0. Il verdetto in due righe

**"Vale questo software" e "questa strategia farà guadagnare denaro" non sono la stessa domanda**, e
hanno evidenza di qualità molto diversa. La prima ha una risposta sicura: l'ingegneria è solida,
verificabile, dimostrata su 4 sprint e un audit esterno. La seconda no: la redditività della
strategia è ignota, e l'unica evidenza reale che esiste oggi è negativa (§3). Confondere le due
domande è l'errore più comune — e più costoso — in questo tipo di progetto.

## 1. Telaio vs motore

Il **telaio** — gestione del rischio, riconciliazione dallo stato reale dell'exchange, stop-loss
garantito, kill-switch, IA vincolata a proporre/spiegare mai a decidere — è verificabile e verificato.
Il **motore** — le strategie: RSI, EMA, MACD, Bollinger — sono indicatori tecnici pubblici, senza una
fonte di informazione o esecuzione differenziante. Un telaio eccellente con un motore non ancora
testato non è "mezza buona macchina": è una base seria il cui risultato in pista resta da dimostrare.

## 2. Punti di forza (verificabili, non promessi)

- **Difesa a strati** — sei livelli indipendenti tra una decisione e il capitale, confermati riga per
  riga da un audit indipendente l'11 agosto.
- **L'IA non decide, spiega** — verificato con 22+19 casi avversariali, incluso lo scenario in cui è
  il modello stesso a tentare uno strumento vietato. La KB di questo stesso progetto documenta un
  caso reale di −450% di drawdown da un LLM lasciato generare segnali diretti — la scelta
  architettuale qui è l'opposto.
- **Backtest onesto** — costi di transazione modellati, verdetto anti-overfitting con split fuori
  campione.
- **Reattività dimostrata** — due incidenti reali in produzione (posizione duplicata da una race
  condition, notifiche impazzite dopo perdite consecutive) diagnosticati e risolti in ore, con
  evidenza reale.
- **Nessuna esposizione superflua** — server mai raggiungibile pubblicamente, segreti mai in chiaro,
  chiavi cifrate a riposo.

## 3. Punti deboli (senza addolcirli)

**Zero track record con capitale reale.** Mai operato su mainnet. Backtest e testnet non predicono in
modo affidabile il comportamento con soldi veri.

**L'unico dato reale esistente** (estratto dal DB di produzione, 11 agosto):

| Metrica | Valore |
|:---|--:|
| Periodo coperto | < 1 giorno (19 ore) |
| Posizioni chiuse | 7 |
| Vinte / Perse | 0 / 7 (100%) |
| Risultato netto (testnet) | −$43,47 |
| Commissioni | $1,97 |

Tutte e 7 le perdite sono short su NEAR-PERP, tutte chiuse dallo stop-loss (il telaio ha funzionato —
nessuna perdita fuori controllo). Il campione è troppo piccolo per concludere che la strategia non
funzioni, ma anche troppo piccolo per il contrario: **zero evidenza positiva esiste oggi**. Nota
aggiuntiva: due bot diversi hanno shortato lo stesso mercato quasi nello stesso minuto con parametri
quasi identici — conseguenza nota e accettata dell'architettura attuale, non un guasto, ma un
promemoria da tenere d'occhio quando cresce il numero di strategie generate.

**4 bug critici, trovati e non ancora corretti** — dall'audit indipendente dell'11 agosto, verificati
personalmente sul codice reale (dettaglio in `docs/KB/BACKLOG/release2.md` §1-2): size di posizione
non allineata al fill reale, cooldown di portafoglio che sparisce a un riavvio, race di apertura tra
bot sullo stesso mercato. Operare su mainnet nello stato attuale aggiunge rischio operativo *sopra*
il rischio di mercato.

**Strategie senza vantaggio differenziante.** Indicatori pubblici e noti, senza una fonte di
informazione o esecuzione differenziante rispetto a chi opera con infrastruttura e dati migliori. Il
backtest onesto non è una prova che funzioneranno fuori campione.

**Singolo punto di guasto operativo** — un VPS, un operatore, backup mai provato davvero.

**Rischio di piattaforma** — Hyperliquid è un exchange relativamente giovane; il capitale passa da un
agent wallet con chiave cifrata sul server, un livello di fiducia tecnica in più di un intermediario
regolamentato.

## 4. Il capitale minimo — tre domande diverse dentro una

**a) Perché il sistema funzioni tecnicamente:** poco — qualche centinaio di dollari di margine, dati
leva 3× osservata e size minime di mercato dell'ordine di poche decine di dollari. Non è la domanda
che conta.

**b) Per una conclusione statisticamente difendibile:** qui conta il **numero di operazioni**, non i
dollari. Sette trade non bastano; servirebbero centinaia, attraverso condizioni di mercato diverse.
Si ottiene a costo quasi zero su testnet, con il tempo — nessuna cifra di capitale reale accelera
questo processo.

**c) Quanto rischiare quando (e se) si passa a soldi veri** — l'unica domanda genuinamente personale:

| Fase | Capitale | Condizione |
|:---|:--|:---|
| Oggi | $0 | Testnet, finché lo storico non è abbastanza lungo e i 4 critici non sono chiusi |
| Prima verifica mainnet | Solo capitale discrezionale (perdibile per intero, senza destinazione) | Expectancy positiva sostenuta su testnet, non un tratto fortunato |
| Scala | — | Solo con un secondo blocco di evidenza reale (mainnet), mai in anticipo sui dati |

Il vincolo più importante non è un numero: è la **sequenza**. Capitale reale prima di uno storico che
lo giustifichi inverte l'ordine raccomandato.

## 5. Raccomandazione

Il valore reale oggi non è "un sistema con rendimento dimostrato" — non lo è. È **una piattaforma
pronta a validare in sicurezza se una strategia ha un vantaggio**, con i freni già installati prima
di chiedersi se il motore va forte. Tre condizioni, in ordine, prima di considerare capitale reale:
chiudere i 4 critici dell'audit (Epic A, `release2.md`); accumulare uno storico testnet abbastanza
lungo da dire qualcosa di statisticamente onesto; verificare almeno una volta che il backup funzioni
davvero (OPS-02). Nessuna delle tre costa capitale — tutte e tre costano tempo.

---

*Documento di analisi, non una raccomandazione di investimento personalizzata. Le decisioni su
capitale reale restano del proprietario del progetto.*
