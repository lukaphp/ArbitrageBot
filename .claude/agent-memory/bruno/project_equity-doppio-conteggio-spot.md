---
name: equity-doppio-conteggio-spot
description: CRIT-05 — equity = accountValue + spotUsdc contava due volte il margine; RISOLTO in Release 2 · Sprint 2 con composeEquity(); resta aperto solo lo storico gonfiato in risk_equity_history
metadata:
  type: project
---

`getAccount()` esponeva `equity = accountValue + spotUsdc` usando il `total` del
pool Spot: su account unificato il margine impegnato è dentro **entrambi** gli
addendi, quindi contato due volte, con sovrastima pari esattamente a `spot.hold`.
**Corretto in Release 2 · Sprint 2 (CRIT-05)**: `riskManager.composeEquity()`
calcola `accountValue + (spot.total − spot.hold)`, e `getAccount()` espone i campi
nuovi `spotAvailable`/`spotHold` lasciando `spotUsdc` invariato (pool intero).
Semantica dei campi in [[hyperliquid-unified-account-model]].

**Why:** trovato da Jordan sulla demo testnet :8091 (2026-08-11). Il `+ spotUsdc`
era deliberato (commit `9e3a236`, "supporto account unificati") e risolveva un
vero falso "Equity nullo": la **premessa era giusta**, sbagliato solo l'addendo —
serviva lo Spot *libero*, non il `total`. Per questo è sopravvissuto a una review.

**How to apply:**

- Il bug era **invisibile a conto piatto** (`accountValue = 0` → somma corretta) e
  si manifestava solo con posizione aperta. Vale come regola generale: qualunque
  verifica di formule di equity va fatta *con posizione aperta*, altrimenti passa
  per il motivo sbagliato. Confermato sperimentalmente durante il fix — rimettendo
  il bug, i test a conto piatto restano **verdi**.
- L'invariante da testare non è un numero atteso ma una **proprietà**: aprire una
  posizione non cambia l'equity (a meno di fee e PnL). Tre fixture nei test: conto
  piatto, posizione già aperta, e i dati reali misurati sulla demo.
- La formula è robusta **perché non dipende** dall'identità `spot.hold ==
  totalMarginUsed`: calcola lo Spot davvero libero, quindi qualunque cosa `hold`
  includa (es. ordini di *apertura* pendenti, che bloccano collaterale senza essere
  ancora margine di posizione) la somma non conta niente due volte. L'identità
  serviva a misurare la magnitudine del difetto, non a fondare il fix.
- Impatto a valle, tutto coperto da test: `marginPct` **sottostimato** (allarme di
  sovra-leva in ritardo — trovato un caso in cui il warning al 60% non scattava
  affatto), sizing che **compone** tra bot concorrenti, e **drawdown fittizio**
  alla chiusura, perché `account.equity` è persistito in `risk_equity_history`.
- **Resta aperto**: le righe storiche già scritte su :8091 sono gonfiate, quindi al
  deploy la serie scende di ~$102 di colpo senza che sia una perdita. Non
  riscritte (stessa disciplina di [[close-reason-non-distingue-tp-da-sl]]):
  decisione al PO. Su mainnet non si pone, lì il difetto è latente.
