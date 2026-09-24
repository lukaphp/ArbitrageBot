---
name: feedback-vista-aggregata-di-due-fonti
description: Come si unisce la vista dell'exchange reale con quella del broker paper (o due fonti qualsiasi) senza inventare numeri — concatenare ed etichettare, mai fondere; i rapporti da un solo aggregato; i fatti del wallet restano reali
metadata:
  type: feedback
---

Quando una rotta deve mostrare **due fonti** della stessa grandezza (account reale Hyperliquid +
broker paper; in futuro anche bot live e bot paper sullo stesso indirizzo), valgono tre regole,
tutte e tre sulla stessa cosa: non affermare numeri che nessuno ha misurato.

1. **Le liste si CONCATENANO e si etichettano** (`source`/`isPaper`), non si fondono. Stessa coin su
   entrambe le fonti = due righe distinte: sommarle conta due volte una size che non esiste,
   tenerne una sola ne nasconde un'altra.
2. **I rapporti si calcolano su UN SOLO aggregato.** `deriveRiskAlerts` ragiona per rapporti
   (margine/equity, esposizione/cap, posizioni/cap): posizioni da una fonte ed equity dall'altra
   producono percentuali inventate. O si aggregano entrambe (`equity`, `totalMarginUsed`,
   `totalNtlPos`, `unrealizedPnl`) o non si aggrega niente.
3. **I fatti del WALLET restano reali**: `accountValue` (badge faucet), `spotUsdc` (trasferimento
   Spot→Perp), `withdrawable` (prelievo) descrivono denaro che si può davvero muovere. Sommarci
   equity simulata dice all'utente che ha fondi che non esistono.

E sempre: scomposizione leggibile (`sources.real` / `sources.paper`, **`null` = fonte assente**, non
"fonte a zero") più un `mode` (`real`/`paper`/`mixed`/`none`) che dica in una parola di cosa si sta
guardando il rischio. Se una fonte dichiara `0` un totale che non tiene (il paper broker non ha un
margin summary), quello zero è un **campo assente**: si ricava dalle posizioni, altrimenti il
pannello dice "margine 0%" con la flotta a leva 3x.

**Why:** 17/09/2026, `/api/perps/account` e `/api/perps/risk` leggevano solo l'account reale, con la
flotta interamente paper. Misurato sul VPS: tab Rischio con equity 974.54 piatta, 0 posizioni,
margine 0, **zero alert** — "nessun rischio" mentre 4 short a leva 3x erano a mercato, e il drawdown
veniva persistito su quella linea piatta. Il merge sta in `riskManager.mergeAccountViews` (puro), il
guscio di I/O in `server.js`.

**How to apply:** il calcolo puro va in `riskManager.js` accanto a `composeEquity`, e chi orchestra
si limita a interrogare le fonti. Quando cambi la definizione di una grandezza che viene
**persistita** in una serie storica (qui `risk_equity_history`), dichiara il **gradino** nel punto
della transizione e verifica in che verso va: uno scalino verso l'alto alza il picco e non può
produrre un falso drawdown, uno verso il basso sì. Vedi
[[feedback-contratto-api-leggi-il-consumer]] per la parte "quali campi non puoi ridefinire sotto i
piedi del consumer" e [[feedback-purezza-funzioni-che-sembrano-query]] per il modo giusto di
leggere lo stato paper.
