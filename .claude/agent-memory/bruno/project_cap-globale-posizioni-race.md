---
name: cap-globale-posizioni-race
description: Cap globale maxConcurrentPositions superabile da due coin diverse (issue #34) — risolto con slot riservati per wallet in execQueue, NON con un lock di wallet; resta una finestra stretta dichiarata
metadata:
  type: project
---

`portfolio.canOpen()` fa rispettare `maxConcurrentPositions` (default **3**) su uno snapshot
dell'account letto a **inizio tick**, mentre `execQueue.acquireOpenLock` serializza per
**(masterAddress, COIN)**. Due bot su **coin diverse** dello stesso wallet potevano quindi superare
entrambi il cap **globale** senza vedersi: il lock non li incrocia e lo snapshot di ognuno è
anteriore all'apertura dell'altro.

**Why:** misurato il 17/09/2026 sulla flotta paper OPS-FLEET-02 (VPS): **4** posizioni aperte con
cap 3 (`portfolio_limits` mai salvato in DB → default). SOL ed ETH aperte a **686 ms** di distanza,
con BTC e BNB già aperte. Emerso solo allora perché le viste aggregate non mostravano le posizioni
paper (vedi [[feedback-vista-aggregata-di-due-fonti]]).

**RISOLTO il 19/09/2026** (issue #34, `CRIT-POSCAP-34`, `ready_for_review`): contatore sincrono di
**slot riservati per wallet** in `execQueue` (`reservedOpenSlots`/`reserveOpenSlot`/
`releaseOpenSlot`), che `bot.js` passa a `canOpen()` come parametro `reservedSlots` (default 0, così
`canOpen` resta pura per backtester e `riskAgent.evaluate`). La riserva si prende dopo il lock
CRIT-03 e si rilascia nello stesso `finally`.

**Il lock di wallet intero è stato VALUTATO E SCARTATO**, contro quel che diceva la versione
precedente di questa nota: il lock per (master, coin) è deliberato (punto 3 in testa a
`execQueue.js`) e serializzare tutte le aperture del wallet avrebbe messo ogni apertura dietro la
catena leva→ordine→trigger delle altre — un costo su *ogni* apertura per un vincolo che morde solo
all'ultimo slot. Un contatore costa zero e morde solo lì.

**How to apply:** due cose restano aperte e vanno ricordate. (1) **Finestra residua dichiarata:** un
bot che ha fetchato `account` prima di un'apertura altrui e valuta dopo il rilascio dello slot non
vede né la posizione né la riserva. Chiuderla richiede datare gli snapshot, col rischio opposto di
contare posizioni già chiuse; non fatto. (2) `agents/riskAgent.evaluate()` chiama `canOpen()` senza
`reservedSlots`, e l'**esposizione totale** ha la stessa forma di race sul nozionale: entrambi fuori
scope, segnalati in review. Le 4 posizioni già oltre il cap non sono state chiuse — il fix previene,
non ripara, e l'alert `positions-limit` resta vero finché il PO non decide.
