---
name: project-jordan-analista-di-rischio
description: Jordan è il nuovo analista di rischio del team Nautilus, revisore aggiuntivo dallo Sprint 1 di Release 2 — guarda la domanda a monte del bug tecnico
metadata:
  type: project
---

Dall'11 agosto 2026 il team Nautilus ha **Jordan, analista di rischio**, revisore aggiuntivo (accanto
ad Annie) su Release 2 · Sprint 1.

**Why:** il taglio delle sue segnalazioni è diverso dal mio e da quello di Annie. Sul lock di CRIT-03
— che risolve la race tecnica tra due bot sullo stesso mercato — ha chiesto perché quel secondo bot
potesse essere configurato senza che nessuno lo dicesse, portando l'incidente reale a supporto (due
bot "AI NEAR-PERP" quasi identici, `docs/KB/business-analysis-2026-08-11.md`). Da lì è nato
`CRIT-03-EXTRA`. Ragiona in termini di **esposizione e configurazione**, non di correttezza del
codice: "i limiti contano le posizioni, non le strategie che le generano".

**How to apply:** quando chiudo un fix di correttezza su un percorso che maneggia denaro, aggiungi al
report una riga sulla domanda a monte — chi/cosa ha reso possibile quello stato, e se il sistema lo
segnala. Se la risposta è "nessuno", è un candidato di refinement da nominare esplicitamente invece di
lasciarlo implicito: è la lacuna che Jordan troverebbe comunque in review. Vale anche al contrario:
i buchi adiacenti che decido di NON coprire (in Sprint 1: avviso all'avvio di un bot e su
`updateBot` che cambia coin) vanno dichiarati, non taciuti.
