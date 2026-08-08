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
correzione parziale. Esempio ancora aperto al 2026-08-08: `docs/KB/index/INDEX.md` riga 59 ha in
tabella "Il webhook esiste già → estenderlo", che contraddice il riquadro corretto più sotto nello
stesso file (§F.1) — la prosa è stata aggiornata, la riga di sintesi no. Segnalalo, non correggerlo.
Collegati: [[feedback-doc-riflette-codice]], [[project-sprint1-consegna-bundled]].
