---
name: feedback-parametro-nuovo-e-richiesta-in-volo
description: Quando un controllo della UI comincia a viaggiare in query string, la guardia "richiesta già in volo" smette di essere innocua e va resa consapevole del parametro — più il modo di provare col test che un bottone inerte adesso ricarica davvero
metadata:
  type: feedback
---

Collegare un controllo dell'interfaccia (preset, filtro, selettore) a un **parametro nuovo del
server** non è solo "aggiungere `&x=` alla query". Due cose vanno riviste, e la seconda è quella che
nessun brief mi ha mai chiesto.

**1. La guardia di deduplica diventa un difetto.** `refreshRiskSnapshot()` aveva
`if (this.riskRefreshInFlight) return;` e `loadPerformance()` `if (this.perfLoading) return;` —
corrette finché ogni chiamata chiedeva la stessa cosa. Dal momento in cui la richiesta porta con sé
la scelta dell'utente, quella in volo è partita con la scelta **precedente**: il click viene
scartato e la risposta vecchia ridisegna la finestra sbagliata *sotto un bottone acceso su
un'altra*. Il pannello dice una cosa e ne mostra un'altra — e con un polling a 15s più gli eventi
socket la collisione è la condizione **normale**, non il caso limite. Rimedio minimo: due campi per
lato, `…RangeInFlight` (cosa ha chiesto la richiesta in corso) e `…RangeDirty` (l'utente ne ha
chiesta un'altra); nel `finally` si rifà la chiamata solo se il valore è cambiato, così il traffico
da polling resta deduplicato come prima. Coprire **entrambi** i rami con un test.

**2. Il filtro locale che c'era prima non si butta: diventa il primo di due passaggi.** Restringe
subito (riscontro immediato al click, la rete non fa aspettare) ma non può **allargare**, perché i
dati più vecchi il browser non li ha mai ricevuti. Quella asimmetria è di solito la causa del bug
originale, quindi è il caso di test che vale: *da 1G a Tutto la curva torna intera*.

**Why:** BUG-EQUITYRANGE-01, 24 settembre 2026. I preset 1G/7G/30G/90G/1A/Tutto dei grafici equity
non avevano mai avuto effetto visibile: il filtro client-side era corretto, ma girava su dati che il
backend troncava per numero di righe. Bruno ha aggiunto `?range=`, a me mancava solo chiederlo — e
il difetto nuovo che ho trovato strada facendo è tutto nel punto 1.

**How to apply (il test che dimostra qualcosa):** il finto server deve **riprodurre l'asimmetria**,
non semplificarla — *senza* il parametro risponde con le ultime poche righe (il comportamento che
generava il bug), *con* il parametro con la finestra vera. Un fetch finto che restituisce sempre
tutto lo storico passa anche sul codice di prima. Poi la verifica rosso-prima-del-fix su snapshot di
HEAD (tecnica in [[project-working-tree-condiviso]]): su 17 casi, 14 rossi e i 3 verdi erano
esattamente quelli che non dovevano cambiare. Due dettagli dell'harness `node:vm` che mi sono
costati un giro: in `public/perps.js` **`connected` e `address` sono getter** (su `isConnected` e
`walletAddress`) e assegnarli lancia `TypeError`; e per mettersi *nell'attimo fra il click e la
risposta* serve un `fetch` che trattiene le promise finché il test non le sblocca — con un solo
`release()` la richiesta di recupero parte ma la sua risposta resta in coda, ne servono due.
Vedi [[feedback-riconciliare-contratto-api]] e [[feedback-verifica-dod-frontend]].
