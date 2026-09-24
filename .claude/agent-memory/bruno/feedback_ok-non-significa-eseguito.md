---
name: ok-non-significa-eseguito
description: Un esito `ok: true` non autorizza il messaggio "eseguita" — il testo mostrato all'utente va ramificato sull'esito reale, su OGNI superficie (web e Telegram)
metadata:
  type: feedback
---

Quando una funzione torna `{ ok: true }` per più esiti diversi — eseguito davvero, archiviato senza
effetti, accodato — il messaggio all'utente deve ramificare su **quale** dei tre è stato, non sul
solo `ok`. E la correzione va fatta su **tutte** le superfici che riportano quell'esito, non solo su
quella da cui è arrivata la segnalazione.

**Why:** `proposals.approve()` torna ok anche per una proposta diagnostica (`tune_params` senza
patch), che non modifica nulla. Sia la coda web sia `/approva` su Telegram dicevano "approvata ed
eseguita": chi legge aspetta un effetto che non arriverà e poi dà la colpa al bot. È la stessa
famiglia di errore di un `catch` vuoto sul money path ([[fallimenti-money-path-non-silenziosi]]): il
sistema non mente sullo stato, mente il testo che lo racconta. Maya ha corretto il web il
2026-09-15; il gemello Telegram era rimasto e l'ha segnalato in review.

**How to apply:** davanti a un fix di questo tipo, cerca subito i gemelli — la stessa decisione è
quasi sempre implementata due volte (`public/*.js` per il browser, `src/perps/telegramControl.js`
per la chat) e le due copie non possono importarsi a vicenda, quindi divergono in silenzio. Nel
messaggio riporta il cambiamento **misurato** dal server (`da → a`), non quello richiesto: se il
merge ha prodotto altro, si vede. E fai arrivare dal server il testo del caso "nessun effetto", che
dipende dal tipo. Test: esercita il percorso vero fino al risultato, perché il punto è la FORMA di
ciò che la funzione ritorna e un doppio la congelerebbe ([[seam-di-test]]).
