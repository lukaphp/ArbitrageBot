---
name: feedback-segnalare-fuori-perimetro
description: Le incoerenze trovate fuori dal perimetro del task vanno segnalate nel report, non corrette in silenzio né ignorate — approccio validato nello Sprint 1
metadata:
  type: feedback
---

Quando durante un task trovi incoerenze in file fuori dal tuo perimetro, non toccarle: elencale nel
report di consegna come candidati per il refinement successivo.

**Why:** approccio confermato nello Sprint 1. Durante SEC-04 ho trovato affermazioni obsolete sul
webhook in `docs/KB/index/INDEX.md` ("il gancio esiste già… la strada è aperta"), file non mio. Le ho
segnalate invece di correggerle, e sono state raccolte e sistemate da chi lavorava su DOC-01 nello
stesso sprint. Il report è quindi parte del deliverable, non un extra: è il canale che ha fatto
arrivare la correzione alla persona giusta senza diff a sorpresa nei file di altri.

**How to apply:** vale sia per le incoerenze doc-vs-codice sia per i residui che restano dopo una
correzione parziale. Il canale funziona ed è stato chiuso il cerchio: il residuo di `INDEX.md:59` che
avevo segnalato in SEC-04 è diventato la story DOC-02 dello Sprint 2, assegnata a me — segnalare
invece di correggere in silenzio ha prodotto un task tracciato, non una perdita di informazione.

**Il canale ha funzionato una terza volta, e più in fretta (Sprint 4, 10 agosto 2026).** Avevo
elencato cinque `refinementCandidates` nel mio status, descrivendone uno come "il residuo peggiore
che ho incontrato" (i dati finti del mockup nel markup di `index.html`). In review il PO ha promosso
**quello** a extra dello stesso sprint invece di rimandarlo. Due cose che ne ho imparato:
- **Ordina i candidati e dì qual è il peggiore, con il motivo.** Una lista piatta di cinque voci si
  legge come cinque "poi vediamo"; una voce con un giudizio esplicito e la conseguenza per l'utente
  ("vede numeri plausibili e falsi") si può decidere subito.
- Quando un candidato viene promosso, gli **altri restano fuori scope**: il coordinatore me lo ha
  detto esplicitamente. Non allargare. Se durante il fix trovi che una parte adiacente ha lo stesso
  difetto (lì: `LIVE` e `Queue health: Stable` fissi nella card EXECUTION STATUS, dichiarata fuori
  scope), **arricchisci la voce di refinement** invece di toccarla, così chi la prende vede tutti i
  pezzi insieme. Quello che invece è *inseparabile* dal fix — il conteggio `[4]` nella stessa card
  del corpo che stai correggendo — va incluso, e va detto nel report che l'hai incluso e perché.

**Corollario imparato in DOC-02:** un residuo di documentazione non è mai una riga sola. La riga di
sintesi era stata scritta insieme ad altri riferimenti allo stesso oggetto (un item di backlog, un
marcatore di priorità, dei link a numero di riga) che l'aggiornamento parziale non aveva toccato.
Quando correggi un residuo, cerca *tutte* le menzioni dell'oggetto nel file (`grep`), non solo quella
citata nel task: distingui ciò che rientra nel criterio d'accettazione da ciò che va solo segnalato.
Collegati: [[feedback-doc-riflette-codice]], [[project-sprint1-consegna-bundled]].
