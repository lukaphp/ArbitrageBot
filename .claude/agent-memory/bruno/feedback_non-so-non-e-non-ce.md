---
name: feedback-non-so-non-e-non-ce
description: Su un guardiano, il fallimento della VERIFICA non va confuso con l'esito negativo della verifica — un try/catch attorno all'intera funzione li rende indistinguibili
metadata:
  type: feedback
---

Un guardiano che controlla una protezione ha **due esiti negativi diversi** e deve trattarli
diversamente: «non sono riuscito a verificare» (assenza di conoscenza) e «ho verificato che non c'è»
(conoscenza di un'assenza). Solo il secondo autorizza un'azione distruttiva. Il modo in cui i due si
fondono in silenzio è sempre lo stesso: **un try/catch attorno all'intera funzione**, con l'azione
correttiva nel `catch`.

**Why:** 24/09/2026, `_ensureStopLoss`. Il `catch` che avvolgeva tutto chiamava `_closeNow`: un
timeout di rete nel *rileggere* uno stop loss già piazzato e confermato liquidava la posizione. 23
chiusure su 24 in 23 minuti, alcune sotto i 60 secondi dall'apertura. Il codice era *difensivo* e
proprio per questo pericoloso — «in caso di errore irriducibile è più prudente chiudere» è vero solo
se l'errore riguarda la protezione, non la sua lettura.

**How to apply:**
- Isola la **fase di acquisizione della conoscenza** in un suo try/catch che `return`a. Tutto ciò che
  viene dopo può assumere di sapere. È la struttura, non il commento, a impedire la confusione.
- Chiediti *cosa protegge la posizione mentre sono cieco*. Quasi sempre la risposta è: l'ordine già
  vivo sull'exchange — lo stesso che la protegge a bot fermo. Se è così, la cecità non giustifica di
  chiudere, mai, per quanto duri.
- Quando la chiusura è giusta, pretendi **prove ripetute e consecutive**: assenza confermata da una
  lettura *riuscita* più N ripristini falliti di fila. Tieni i due contatori **separati** (cecità vs
  guasto reale) perché contano cose diverse; azzerali entrambi su un successo.
- Corollario sul conteggio: se due consumatori condividono la stessa lettura, ricevono lo **stesso
  oggetto Error** e conteranno due volte un guasto solo. Dedup sull'identità dell'errore, o log e
  metrica diranno il doppio del vero.
- Rumore sì, silenzio no: log a ogni tentativo, metrica, e **una** notifica per episodio più quella
  di rientro ([[feedback-fallimenti-money-path-non-silenziosi]]).
Vedi [[project-hyperliquid-ratelimit-peso20]] per la causa della pressione che generava i timeout.
