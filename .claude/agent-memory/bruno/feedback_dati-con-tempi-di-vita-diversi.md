---
name: feedback-dati-con-tempi-di-vita-diversi
description: Quando una cache tiene insieme metadati lenti e un valore veloce (un prezzo), il valore veloce va sovrapposto in lettura dal feed già vivo — non rinfrescato con un timer che rifà la stessa fetch
metadata:
  type: feedback
---

Se una struttura in cache mescola **metadati che cambiano raramente** e un **valore che invecchia in
secondi**, non rinfrescare tutta la struttura: lascia i metadati dove sono e **sovrapponi il valore
veloce in lettura**, prendendolo dalla sorgente che è già tenuta fresca.

**Why:** in `marketData.markets` (issue #14) `coin/name/maxLeverage/szDecimals` e `mid` erano scritti
dalla stessa fetch `client.getMarkets()`, chiamata due volte in tutta la vita del processo. Il
`mid` restava quindi quello del boot per ore — `/api/perps/markets` ha servito valori che non
corrispondevano a **nessuna** rete, solo vecchi. La issue proponeva un `refreshMarkets()` periodico:
scartata dal PO e a ragione nel merito — avrebbe creato una **seconda sorgente di prezzo** che duplica
traffico verso Hyperliquid per riottenere quello che il WebSocket già consegna a ~4s e gratis, e il
prezzo servito sarebbe comunque stato vecchio fino a un intero periodo di refresh. Una grandezza di
mercato deve avere **una sola** fonte di verità.

**How to apply:**
- Prima di aggiungere un timer di refresh, chiedi: *esiste già un feed vivo per questo dato?* Se sì,
  il fix è nel **getter**, non in un nuovo poll.
- La sovrapposizione ritorna **copie** (`{...m, val: live(...) ?? m.val}`): un getter che riscrive la
  cache rimette due scrittori sullo stesso campo — [[feedback-purezza-funzioni-che-sembrano-query]].
- Tieni il fallback al valore statico (`?? m.val`): un dato nuovo che il feed non conosce ancora deve
  restare vecchio, non diventare `null`.
- Il percorso di refresh completo **non si rimuove**, si ridefinisce: serve ancora per i metadati e
  per il caso "la fetch all'avvio è fallita e la cache è vuota" (in `start()` è un `warn`, non un throw).
- Poi passa in rassegna **ogni** consumatore: quelli che leggono solo i metadati non erano
  interessati, ma un `m.val ?? liveLookup()` è insidioso — il valore stantio è non-null e **vince**
  sul fallback che sembrava proteggerti (era il caso di `analyst/tools.js`, che serviva all'AI prezzi
  del boot). [[feedback-contratto-api-leggi-il-consumer]]
