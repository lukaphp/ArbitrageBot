---
name: feedback-ritiro-legacy-superficie-condivisa
description: Prima di rimuovere un file legacy dal frontend, censire cosa di condiviso ci vive dentro — il task lo descrive come "elimina", ma il rischio è portarsi via funzioni vive
metadata:
  type: feedback
---

Quando un task dice "rimuovi `<file>` e ogni riferimento", non partire dalla rimozione: parti da
`grep` di *cosa altro* quel file esporta e chi lo consuma. Poi decidi dove va a vivere la parte
condivisa **prima** di cancellare qualsiasi cosa.

**Why:** in EVM-01 (Sprint 3) il backlog descriveva `public/app.js` come "la demo di arbitraggio
EVM". Dentro c'erano anche il gate di autenticazione con l'overlay di login, il socket, i toast e
`showModal`/`closeModal` — quest'ultimo usato da `onclick` inline anche su `botModal`, che è Perps al
100%. Cancellare il file e basta avrebbe rotto login e modali di una vista che con la demo non
c'entrava nulla: esattamente il tipo di danno collaterale che il task voleva *chiudere*, non aprire.
La soluzione accettata è stata un modulo shell nuovo e minimo per la parte condivisa, e la logica di
dominio (il wallet) spostata dentro il suo unico consumatore.

**How to apply:** vale per ogni ritiro di file in `public/`. Sequenza che ha funzionato:
1. `grep` del globale che il file espone (`app.`, `window.<nome>`) in **tutti** i `public/*.js` *e*
   negli `onclick`/`onchange` inline dell'HTML — gli inline sfuggono a qualunque analisi statica.
2. Distinguere le tre categorie: demo da ritirare / dominio da spostare al consumatore / shell
   condivisa da reinsediare.
3. Cancellare solo dopo che le prime due hanno una nuova casa e un test che le copre.
4. Un test che asserisce l'*assenza* del vecchio globale (`/(^|[^.\w])app\s*\??\./` sul sorgente,
   commenti esclusi) impedisce che rientri per copia-incolla. Attenzione ai falsi positivi da URL
   (`app.hyperliquid.xyz`).

Corollario sulla superficie utente: se togli l'unico punto d'ingresso visibile di un flusso, cerca
tutti i modi in cui l'utente ci arrivava, **viewport strette incluse**. In EVM-01 la media query a
680px nascondeva anche il pill del wallet: rimuovendo la card avrei riprodotto su mobile lo stesso
vicolo cieco già corretto sul desktop. Collegati: [[feedback-doc-riflette-codice]],
[[feedback-segnalare-fuori-perimetro]].
