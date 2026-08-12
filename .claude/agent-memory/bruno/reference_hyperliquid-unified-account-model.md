---
name: hyperliquid-unified-account-model
description: Semantica verificata dell'account unificato Hyperliquid (Spot come collaterale dei perp), come interrogare gli endpoint info pubblici, e le differenze fra spotClearinghouseState e webData2
metadata:
  type: reference
---

# Account unificato Hyperliquid: cosa significano davvero i campi

Verificato empiricamente il 2026-08-12 sull'account demo testnet `0x55dde414…73e72`,
prima con una posizione (indagine) poi con **due posizioni concorrenti** long+short
(fix CRIT-05). Questa semantica **non è derivabile dal repository**: il codice la
assume, non la documenta.

Con account unificato esiste **un solo pool di collaterale USDC**, non due:

- `spotClearinghouseState` → `balances[USDC].total` è il pool INTERO.
  `…hold` è la porzione già bloccata come margine dei perpetual.
  `total − hold` = collaterale davvero libero.
- `clearinghouseState` → `marginSummary.accountValue` **non è un pool indipendente**:
  è la vista mark-to-market della fetta di collaterale impegnata nei perp
  (≈ margine impegnato + PnL non realizzato + funding). Con account piatto vale `0`
  anche se in Spot ci sono centinaia di dollari.
- `spot.hold == marginSummary.totalMarginUsed`: verificato **esatto** anche con due
  posizioni aperte insieme, una long e una short (6 campioni appaiati, scarto 0).
  Ma va misurato come descritto sotto, o sembra falso.
- `totalMarginUsed == somma dei marginUsed` delle posizioni, e ogni `marginUsed ==
  positionValue / leverage` — cioè **derivato dal mark corrente**, non dall'entrata.
- `totalRawUsd` va **negativo** quando la posizione è finanziata dal collaterale
  Spot (visto: `-48.77` con una long da $97 di notional). Non è un errore.
- `usdClassTransfer` è **disabilitato** su questi account (`"Action disabled when
  unified account is active"`): non serve, lo Spot è già collaterale.

⚠️ **Correzione a una nota precedente**: avevo registrato `accountValue ==
totalRawUsd + totalNtlPos`. È **falso** in generale — vale solo con una singola
posizione long. La forma giusta usa il valore **firmato** delle posizioni:
`accountValue == totalRawUsd + Σ(±positionValue)` (long positivo, short negativo).
Con una long da 153.17 e una short da 102.91: `51.85 + (153.17 − 102.91) = 102.10`.
`totalNtlPos` è la somma dei notional in **valore assoluto**, quindi non è l'addendo
giusto.

Corollario: `accountValue + spot.total` conta il margine impegnato **due volte**.
L'equity corretta è `accountValue + (spot.total − spot.hold)`, che ha la proprietà
giusta: è invariante all'apertura di una posizione. Vedi
[[equity-doppio-conteggio-spot]].

## Attenzione: `webData2` NON ha la stessa semantica

`webData2` (la chiamata che usa il frontend) restituisce stato perp e spot in
un'unica risposta, comodo per un confronto **atomico** — ma il suo `spotState`
riporta il saldo **già al netto** del bloccato: `total` = disponibile e `hold` = 0.
Sullo stesso istante: `spotClearinghouseState` dava total 976.87 / hold 102.52,
`webData2` dava total 874.80 / hold 0. Sottrarre `hold` due volte non succede solo
per fortuna (è 0), ma **non dare per scontato che `total` significhi la stessa cosa
nei due endpoint**: qui il codice usa `spotClearinghouseState`.

## Come provarlo senza autenticazione e senza toccare l'app

Gli endpoint `info` sono pubblici, in sola lettura, e non richiedono chiavi — sono
lo strumento giusto per verificare affermazioni sul denaro senza avvicinarsi a un
account operativo (resta lettura: **mai** usare `/exchange`).

- `POST https://api.hyperliquid-testnet.xyz/info` (mainnet: `api.hyperliquid.xyz`)
- `{"type":"clearinghouseState","user":"0x…"}` → lato perp
- `{"type":"spotClearinghouseState","user":"0x…"}` → pool Spot, **con `hold`**
- `{"type":"userNonFundingLedgerUpdates","user":"0x…","startTime":0}` → **la prova
  decisiva su "il denaro si è mosso?"**: elenca depositi, `internalTransfer` e
  `accountClassTransfer` (Spot↔Perp). Zero eventi `accountClassTransfer` +
  un `accountValue` diverso da zero = il collaterale è unificato per forza.

Usa `userNonFundingLedgerUpdates` prima di ipotizzare cause: distingue in un colpo
solo "contabilità sbagliata" da "il denaro si è davvero spostato". Per confrontare
grandezze fra i due endpoint vedi [[misura-grandezze-mark-dipendenti]].
