---
name: equity-doppio-conteggio-spot
description: Finding APERTO (2026-08-12) — equity = accountValue + spotUsdc conta due volte il margine impegnato; diagnosi confermata, fix non applicato, decisione al PO
metadata:
  type: project
---

`getAccount()` espone `equity = accountValue + spotUsdc` dove `spotUsdc` è il
`total` Spot: su account unificato il margine impegnato è dentro **entrambi** gli
addendi, quindi viene contato due volte. Sovrastima **esattamente** pari al margine
impegnato (`spot.hold`, == `totalMarginUsed`). Diagnosi chiusa con prove dagli
endpoint pubblici; **fix non applicato**, decisione su come/dove correggere al PO.
Semantica dei campi in [[hyperliquid-unified-account-model]].

**Why:** segnalato da Jordan dalla demo testnet :8091 (2026-08-11): apertura AAVE-PERP
con `spotUsdc` fermo e `equity` salita di ~$48. Il `+ spotUsdc` è deliberato (commit
`9e3a236`, "supporto account unificati") e risolveva un vero falso "Equity nullo":
la **premessa è giusta**, sbagliato solo l'addendo — serviva lo Spot *libero*, non il
`total`. Per questo è sopravvissuto a una review.

**How to apply:**

- Il bug è **invisibile a conto piatto** (`accountValue = 0` → somma corretta) e si
  manifesta solo con posizione aperta. Qualunque verifica futura di formule di equity
  va fatta *con posizione aperta*, altrimenti passa per il motivo sbagliato.
- L'invariante da testare non è un numero atteso ma una **proprietà**: aprire una
  posizione non deve cambiare l'equity (a meno delle fee). Un test che confronta
  soltanto un valore atteso non coglie questa classe di bug.
- Impatto oltre il sizing: `account.equity` è persistito in `risk_equity_history`
  (`server.js`) e alimenta drawdown e alert. Un'equity gonfiata dal margine produce
  un **drawdown fittizio** alla chiusura delle posizioni e **sottostima il `marginPct`**,
  cioè ritarda proprio l'allarme di sovra-leva. Toccando l'equity, considerare sempre
  questi consumatori a valle, non solo `sizePosition`.
- Il sovradimensionamento **compone** tra bot concorrenti (fattore `(1+f)^(n-1)`
  con `f` = frazione di sizing): è tanto peggiore quanto più bot aprono insieme.
