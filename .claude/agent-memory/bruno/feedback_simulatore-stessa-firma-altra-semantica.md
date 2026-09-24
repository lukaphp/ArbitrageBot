---
name: feedback-simulatore-stessa-firma-altra-semantica
description: paperBroker espone la firma di hyperliquidClient ma non la sua semantica — stesso parametro, significato diverso; verifica cosa ne fa ciascun lato prima di fidarti del forward-test
metadata:
  type: feedback
---

`paperBroker` è "l'interfaccia di `hyperliquidClient` usata da `PerpsBot`", ma **stessa firma non
significa stessa semantica**. Quando tocchi un parametro condiviso fra i due, guarda cosa ne fa
ciascun lato, non come si chiama.

**Why:** il caso costato 218 USD e una flotta ferma (CRIT #16): `placeMarketOrder({slippage})`. Sul
client reale è la **tolleranza** con cui si costruisce il limit price di un IoC aggressivo — il
peggio accettabile, con `avgPx` che poi torna dal book. Sul paperBroker era il prezzo **pagato**.
Stesso nome, stesso default apparente, significato opposto: il 2% che bot.js passa correttamente al
broker vero diventava un costo garantito del 2% su ogni apertura simulata. Nessun test lo vedeva
perché tutti mockavano il fill o il mid.

**How to apply:**
- Il paperBroker è il **broker simulato**, fratello di `hyperliquidClient`, non del layer di rischio:
  il suo modello di costo (fee taker, slippage di esecuzione) sta lì accanto a `TAKER_FEE_PCT`, e
  deve valere lo **stesso** del backtester (`DEFAULT_SLIPPAGE_PCT`), altrimenti forward-test e
  backtest non sono confrontabili — che è l'unica ragione per cui il paper mode esiste.
- Infedeltà **chiusa** (issue #17, 17/09/2026): `_fillClose` ignorava la size del trigger e chiudeva
  tutto. Ora accetta `meta.size`, riduce la posizione, e `_closableSize` la limita sempre al residuo —
  che è il modello del **reduce-only**, non una guardia di forma: fra un TP parziale e il primo
  aggiornamento del trailing lo SL sul book ha ancora la size piena, perché `_placeTpSl` lo piazza
  all'apertura e `_manageOpen` lo ridimensiona solo quando il trailing si muove davvero.
- Infedeltà **ancora aperte**, da tenere in conto leggendo un forward-test: `placeMarketOrder` sul ramo
  di chiusura (`reduceOnly`, o ordine di verso opposto) chiama `_fillClose` senza `size` e chiude
  quindi sempre tutta la posizione — ha un chiamante vero, `src/mcp/tools.js` `place_order_paper`, e il
  Position Uniqueness Gate permette di proposito l'ordine opposto come via d'uscita; `getRealizedPnl`
  ha una finestra `sinceTs - 1000` che può sommare la chiusura precedente; `_evaluateTriggers` riempie
  esattamente a `triggerPx` (nessun gap, nessuno slippage sullo stop) e si ferma al **primo** trigger
  colpito per passata, anche quando la chiusura è parziale.
- Un ordine **eseguito** va tolto dal book. Sulla chiusura totale lo fa la cancellazione dell'intera
  lista; sul parziale serve rimuovere esplicitamente il trigger scattato, altrimenti al tick dopo
  ri-scatta allo stesso prezzo e mangia un'altra fetta del residuo, a ripetizione. Il test che lo
  inchioda è un **secondo tick a prezzo invariato**.
- Prima di dichiarare "il paper si comporta come il reale" su un percorso, scrivi il caso che
  confronta i due, oppure dichiara il gap ([[feedback-seam-di-test]]).
- Quando il difetto è nel simulatore, il fix va nel simulatore: `bot.js` che passa 2% al broker è
  corretto, non si "aggiusta" il chiamante per far tornare i conti al finto.
