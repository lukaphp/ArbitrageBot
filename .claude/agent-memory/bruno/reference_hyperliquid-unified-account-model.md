---
name: hyperliquid-unified-account-model
description: Semantica verificata dell'account unificato Hyperliquid (Spot come collaterale dei perp) e come interrogare gli endpoint info pubblici per provare dove sta davvero il denaro
metadata:
  type: reference
---

# Account unificato Hyperliquid: cosa significano davvero i campi

Verificato empiricamente il 2026-08-12 sull'account demo testnet `0x55dde414…73e72`
(indagine sul presunto doppio conteggio dell'equity). Questa semantica **non è
derivabile dal repository**: il codice la assume, non la documenta.

Con account unificato esiste **un solo pool di collaterale USDC**, non due:

- `spotClearinghouseState` → `balances[USDC].total` è il pool INTERO.
  `…hold` è la porzione già bloccata come margine dei perpetual.
  `total − hold` = collaterale davvero libero.
- `clearinghouseState` → `marginSummary.accountValue` **non è un pool indipendente**:
  è la vista mark-to-market della fetta di collaterale impegnata nei perp
  (≈ margine impegnato + PnL non realizzato + funding). Con account piatto vale `0`
  anche se in Spot ci sono centinaia di dollari.
- Identità osservate (esatte, non approssimate): `spot.hold == marginSummary.totalMarginUsed`
  e `accountValue == totalRawUsd + totalNtlPos`.
- `totalRawUsd` va **negativo** quando la posizione è finanziata dal collaterale Spot
  (visto: `-48.77` con una long da $97 di notional). Non è un errore.
- `usdClassTransfer` è **disabilitato** su questi account (`"Action disabled when
  unified account is active"`): non serve, lo Spot è già collaterale.

Corollario: `accountValue + spot.total` conta il margine impegnato **due volte**.
L'equity corretta è `accountValue + (spot.total − spot.hold)`, che ha la proprietà
giusta: è invariante all'apertura di una posizione. Vedi
[[equity-doppio-conteggio-spot]].

## Come provarlo senza autenticazione e senza toccare l'app

Gli endpoint `info` sono pubblici, in sola lettura, e non richiedono chiavi —
sono lo strumento giusto per verificare affermazioni sul denaro senza avvicinarsi
a un account operativo (nessuna autorizzazione a operare richiesta, ma resta
lettura: **mai** usare `/exchange`).

- `POST https://api.hyperliquid-testnet.xyz/info` (mainnet: `api.hyperliquid.xyz`)
- `{"type":"clearinghouseState","user":"0x…"}` → lato perp
- `{"type":"spotClearinghouseState","user":"0x…"}` → pool Spot, **con `hold`**
- `{"type":"userNonFundingLedgerUpdates","user":"0x…","startTime":0}` → **la prova
  decisiva su "il denaro si è mosso?"**: elenca depositi, `internalTransfer` e
  `accountClassTransfer` (Spot↔Perp). Zero eventi `accountClassTransfer` +
  un `accountValue` diverso da zero = il collaterale è unificato per forza,
  perché nessun trasferimento lo ha mai alimentato.

Usa `userNonFundingLedgerUpdates` prima di ipotizzare cause: distingue in un colpo
solo "contabilità sbagliata" da "il denaro si è davvero spostato".
