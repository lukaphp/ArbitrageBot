---
name: feedback-stato-ignoto-non-e-zero
description: Regola di design ricorrente della cockpit — prima del primo dato reale si dichiara "ignoto" ('—', grigio, "in attesa"), mai un valore, uno zero o un verde di default
metadata:
  type: feedback
---

In questa cockpit **un numero plausibile ma finto è peggio di un dato assente**, perché è
indistinguibile da uno vero su un pannello di trading. Prima che arrivi il primo dato reale si
dichiara *ignoto*, e "ignoto" non è nessuna di queste cose:

| Sembra innocuo | In realtà afferma |
|:---|:---|
| badge a `0` | "nessuna condizione da verificare" — cioè proprio ciò che non sappiamo |
| pallino verde di default | "il servizio è a posto" |
| pallino rosso di default | "il servizio è giù" (falso quanto il verde) |
| "Nessuna posizione aperta" al primo render | "ho guardato il conto" |
| `aria-label="Margin used 32 percent"` | un numero inventato letto ad alta voce da uno screen reader |
| una voce di legenda per una serie che non esiste | il grafico disegna due serie |

**Why:** è la stessa regola già applicata alla curva equity (non sintetizza più una serie finta
quando lo storico manca) e ai tile a `—`, ed è quella che il PO ha promosso a fix di sprint quando
ha visto i dati del mockup ancora nel markup (`ES/NQ/CL/GC`, `28ms`, `3/3 ONLINE`). Vale sia per il
markup statico sia per i **percorsi di fallimento**: un `catch` che non tocca il pannello lascia a
schermo l'ultima cosa che c'era, e al primo caricamento quella cosa è il placeholder.

**How to apply:**
1. Distingui sempre tre stati, non due: *non lo so ancora* / *ho guardato e non c'è niente* /
   *ecco il dato*. In pratica: un parametro tipo `hasData` nel renderer, e uno stato CSS `unknown`
   (grigio) accanto a `ok`/`warning`/`offline`.
2. Ogni `catch` che sostituisce dei dati deve **scrivere** lo stato "non disponibile" con il motivo
   (escapato: viene dal server), non limitarsi a loggare.
3. Fai affermare lo stato onesto anche dal **codice**, non solo dal markup: se il renderer lo
   riscrive a ogni primo giro, nessuno può reintrodurre valori fissi nell'HTML senza che un test lo
   veda.
4. Nei test sul markup, oltre alle stringhe specifiche usa un **invariante**: es. "nel pannello
   Dashboard non esiste nessun importo in dollari scritto a mano"
   (`/[+-]?\$\s?[\d.,]+/`). Regge anche contro placeholder nuovi che oggi non conosco.
5. **`Number(null)` vale 0 e `Number.isFinite(0)` è `true`.** Quindi il controllo che viene naturale
   scrivere — `Number.isFinite(Number(x)) ? Number(x) : null` — trasforma proprio l'assenza di dato
   nello zero che stai cercando di evitare. Escludi `null`/`undefined`/`''` **prima** di convertire.
   Non è teoria: in DEBT-03 (Sprint 2 R2) il mio primo `deriveExecutionStatus` aveva esattamente
   quella riga, e il caso "le proposte non leggibili non diventano zero" è andato rosso e l'ha preso.
   Corollario di metodo: quando implemento i tre stati, il caso da scrivere **per primo** è "null non
   deve diventare 0" — è quello che intercetta la coercizione, mentre i casi sul valore misurato
   passerebbero comunque.
6. Un `[]` che arriva da un `catch` è la stessa trappola in forma di array: `fills = []` non
   distingue "nessuna operazione" da "non ho potuto leggere lo storico". Se il ramo di errore produce
   un contenitore vuoto, serve un **flag separato** (`fillsAvailable`) accanto al dato, e va inizializzato
   a `false` — non a `true` con l'idea di abbassarlo nel catch, perché il percorso in cui non si legge
   affatto (nessun indirizzo, chiamata mai fatta) non passa da nessun catch.
7. Attenzione ai valori fissi **senza `id`**: sono i peggiori perché nessun renderer potrà mai
   correggerli e nessun test che cerchi id orfani li trova. In Sprint 2 R2 ho trovato un
   `<span class="cockpit-positive">OK</span>` nella card Max drawdown che resta verde anche mentre la
   riga sotto, quella scritta dal codice, dice "Review now": la stessa card afferma due cose opposte.
   Cerca i badge di stato **senza id** oltre a quelli con id mai scritto.

Collegati: [[feedback-doc-riflette-codice]] (stessa disciplina, applicata alla documentazione),
[[feedback-verifica-dod-frontend]].
