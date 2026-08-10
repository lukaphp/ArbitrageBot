---
name: feedback-riconciliare-contratto-api
description: Costruire la UI contro il contratto atteso va bene, ma prima di chiudere si rilegge la route reale e si riconcilia — è lì che escono i bug; e gli scostamenti vanno nelle note di stato
metadata:
  type: feedback
---

Quando il backend da cui dipendo è in costruzione in parallelo: costruisco contro il contratto
concordato, con un fetch finto nei test, **e prima di scrivere le note di stato rileggo la route
reale e riconcilio**. La riconciliazione non è formalità: è dove sono usciti i problemi.

**Why:** Sprint 4, 10 agosto 2026, ADV-02/CUR-01. Tre scostamenti che una UI ingenua non avrebbe
retto, e un bug mio trovato dal test scritto sulla forma reale:

1. **I rifiuti previsti arrivano con HTTP 200 + `success:false`**, non con un errore HTTP. Vale per
   l'advisor (budget esaurito) *e* per il tasso di cambio, che risponde perfino
   `{success:true, data:{rate:null, stale:true}}` quando la fonte è giù. Una UI che guarda `res.ok`
   mostra un EUR calcolato su `null`. Il controllo va sui **dati**, non sullo stato HTTP.
2. **I rifiuti hanno un `code`** anche quando il contratto concordato non lo prometteva, e la
   distinzione è tutta lì: `agents_disabled`/`no_api_key`/`no_client`/`budget_exceeded` = degrado, si
   spegne il campo di invio; `turn_in_progress`/`message_too_long`/`session_not_found`/`turn_failed`
   = rifiuto passeggero, si dice il motivo e si resta utilizzabili. Con un `code` presente usalo in
   modo **esclusivo**: il mio fallback regex su "budget" nel testo era abbastanza largo da degradare
   su un errore che non c'entrava.
3. **Il backend può aver aggiunto una route apposta per la UI.** Bruno aveva scritto
   `GET /api/advisor/status` con `{available, reason, code, retentionDays}` proprio per non dover
   spendere un turno LLM solo per scoprire che l'advisor è spento. Se non rileggo il server, non la
   uso e faccio la cosa peggiore.

**Il bug:** con `/status` che diceva "Agenti AI disabilitati (AGENTS_ENABLED=false)" e `/budget` che
poi falliva, il secondo messaggio copriva il primo e l'utente leggeva "budget non leggibile". Regola
che ne è uscita: **il primo motivo di degrado dichiarato vince**, gli errori successivi sono
conseguenze e direbbero di meno.

**How to apply:**
- Scrivi la UI difensiva sul contratto atteso, con alias solo dove ha senso (`monthlyLimitUsd ??
  limitUsd`, `time ?? ts`) — non trasformarla in un parser di forme arbitrarie.
- Scegli i nomi di campo che **combaciano con una funzione DB già esistente** (per ANA-01:
  `trades`/`winRate`/`totalPnl` di `db.getBotStats`): è la forma che il collega estenderà.
- Attenzione alle **unità dei timestamp fra due fonti**: `risk_equity_history.ts` è in secondi
  (glielo passa `server.js`), `ml_history.ts` in millisecondi (`Date.now()`). Normalizza, o una curva
  finisce nel 1970.
- Poi rileggi `src/server.js` e i moduli nuovi, aggiorna il codice *e* i test alla forma vera, e
  scrivi ogni scostamento nelle `notes` dello status: è l'informazione più utile per la review. Vedi
  [[project-working-tree-condiviso]] e [[feedback-doc-riflette-codice]].
