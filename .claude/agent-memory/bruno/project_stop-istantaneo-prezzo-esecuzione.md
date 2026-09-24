---
name: stop-istantaneo-prezzo-esecuzione
description: Risolto (issue #16, 16/09) — ogni posizione paper nasceva 2% oltre il mid perché il fill simulato pagava la TOLLERANZA di slippage; con SL all'1.5% moriva al primo tick. Ipotesi "prezzo d'apertura stantio" SMENTITA
metadata:
  type: project
---

Il 2026-09-15 i 6 bot paper della flotta VPS (OPS-FLEET-02, testnet, `rsi_reversal` e `bollinger`)
hanno fatto **18 trade e 18 perdite**, ~218 USD su 10.000 di equity paper: apertura → SL entro un
giro di `botLoopInterval` (10s) → riapertura → stesso esito, fino al circuit breaker. Chiuso il
2026-09-16 (GitHub issue #16, CRIT).

**Causa radice confermata:** `paperBroker.placeMarketOrder` usava come prezzo di FILL la **tolleranza**
di slippage del chiamante (`px = mid * (1 ± slippage)`, con `bot.config.slippage ?? 0.02` → **2%**).
Su `hyperliquidClient` quella formula costruisce il **limit price** di un IoC aggressivo — Hyperliquid
non ha veri market order — cioè il prezzo peggiore ACCETTABILE, non il costo atteso: il fill vero
arriva dal book. Nel paper diventava il prezzo pagato, quindi ogni posizione nasceva 2% oltre il mid,
con lo SL all'1.5%: **già oltre il proprio stop nell'istante in cui nasce**, in entrambe le direzioni,
a mercato fermo. Fix: il fill paga `DEFAULT_SLIPPAGE` (0.05%, lo stesso valore del backtester),
`min(tolleranza, costo)` perché un IoC non si riempie mai peggio del proprio limit.

**Le due ipotesi plausibili erano entrambe sbagliate, e questo è il punto da ricordare:** la issue
accusava `_evaluateTriggers` di leggere un mid falsato; io avevo concluso che fosse `entry_px` a
essere **stantio** (tre short BTC a 75913 identici a 10s di distanza). Nessuna delle due: il mid era
vivo su ENTRAMBI i percorsi, ed era il prezzo di esecuzione a essere spostato di una costante. I tre
`entry_px` identici erano solo la quantizzazione di `roundPx` a 5 cifre significative (passo ~1 USD su
BTC) su un mid quasi fermo — un valore che si ripete non prova una sorgente congelata. Escluse con
misura anche: mismatch di rete (i mid testnet/mainnet distano <0.5% su BTC/BNB/ETH/SOL/AVAX, 9% solo
su NEAR — non producono un difetto uniforme all'1.5%), cache dentro l'SDK Hyperliquid (`getAllMids`
fa una POST a ogni chiamata, letto in `node_modules/hyperliquid/src/rest/info/general.ts`), trailing
che sposta lo SL (`computeTrailing` ratchetta solo in direzione favorevole). **La staleness di
`GET /api/perps/markets` (issue #14) è un difetto vero ma INDIPENDENTE da questo.**

**How to apply:** le 21 posizioni e l'equity paper (~9782) restano in archivio, lo storico non si
riscrive — ma la finestra di forward-test prima del 16/09 va considerata nulla, non è performance di
strategia. Prima di leggere risultati di forward-test, sappi che il paperBroker ha ancora due
infedeltà dichiarate e non corrette: **il partial TP chiude la posizione INTERA** (`_fillClose`
ignora `t.size` del trigger, e la flotta ha `partialTp` al 50%), e `getRealizedPnl` usa una finestra
`sinceTs - 1000` che su una riapertura entro un secondo somma anche il fill di chiusura della
posizione precedente (riga 46 di `positions`: pnl −22.95 invece di −11.6). Vedi
[[feedback-evidenza-gia-persistita]] per il metodo con cui è stata chiusa l'indagine,
[[template-strategia-stati-non-eventi]] per la flotta e [[vps-due-processi-stato-paper]] per come
operare sul VPS.
