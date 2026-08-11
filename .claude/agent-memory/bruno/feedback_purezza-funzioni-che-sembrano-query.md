---
name: feedback-purezza-funzioni-che-sembrano-query
description: Cercare effetti collaterali nelle funzioni il cui nome promette una verifica è l'ispezione che ha dato più valore in Release 2 Sprint 1 — approccio confermato dal PO e da due revisori
metadata:
  type: feedback
---

Quando lavoro su questo codice, vale la pena **cercare attivamente le funzioni che sembrano una
domanda e invece scrivono stato** (`canOpen`, `check*`, `find*`, `get*`), non solo correggere il bug
assegnato.

**Why:** in Release 2 · Sprint 1 il fix di QUAL-01 item 2 — `portfolio.canOpen()` che attivava un
cooldown di un'ora come effetto collaterale — è stato giudicato dal PO **il finding più importante
dello sprint**, confermato indipendentemente da Annie e da Jordan. Il motivo non era l'impurità in
sé: era il secondo chiamante, `agents/riskAgent.evaluate()`, il gate delle proposte dell'Analyst.
*Valutare* una proposta poteva mettere in pausa un bot per un'ora. Il danno non stava nella funzione
sporca ma nel consumer che nessuno aveva collegato ([[feedback-contratto-api-leggi-il-consumer]]).

**How to apply:** dopo aver capito il bug di una storia, `grep` di tutti i chiamanti della funzione
che sto toccando e chiediti cosa succede a chi la usa "solo per chiedere" — diagnostica, UI, gate
advisory, test. Se scrive, separa in due (lettura pura + azione esplicita), sposta la scrittura nel
punto dove il fatto è *confermato* (es. `recordLoss` alla chiusura in perdita, non alla verifica), e
dillo nel report: è il tipo di scoperta che il PO vuole vedere. Corollario validato: **gli extra
piccoli e in tema nati da questo tipo di analisi vengono approvati** (in Sprint 1 ne sono usciti due,
`CRIT-03-EXTRA` e `CRIT-02-EXTRA`, entrambi accettati in review) — proporli è giusto, ma proporli,
non farli di iniziativa dentro la storia in corso.
