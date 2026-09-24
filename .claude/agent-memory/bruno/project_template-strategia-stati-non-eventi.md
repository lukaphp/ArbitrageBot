---
name: template-strategia-stati-non-eventi
description: Due dei 4 template BOT_STRATEGIES (macd_momentum, ema_trend) hanno segnale attivo il 100% delle barre — sono stati, non eventi, e come regole d'ingresso non selezionano nulla
metadata:
  type: project
---

I 4 template di `BOT_STRATEGIES` (`public/perps.js`) non sono la stessa classe di cosa, e la
differenza è decisiva perché `strategyEngine.evaluate` valuta le `entryRules` **solo quando il
bot è flat** e tutti e 4 i template hanno `exitRules: []`: la selettività della regola d'ingresso
è l'unica cosa che decide quando si entra.

- **`macd_momentum`** (`cond:'bullish'` = `histogram > 0`) e **`ema_trend`** (`compareToPrice`,
  `>` / `<`) sono **STATI**. Con `logic:'any'` + `direction:'both'` una delle due regole è vera
  *sempre*. Misurato su ~700 candele 5m reali dei 6 mercati principali: **segnale attivo il 100%
  delle barre**, su tutti e 6, con 35-67 cambi di lato per 50h.
- **`rsi_reversal`** (RSI<30/>70) e **`bollinger`** (fuori banda) sono **EVENTI**: attivi il 4-12%
  e il 10-13% delle barre. Sono gli unici due che funzionano come regole d'ingresso.

**Why:** il 2026-09-15, ricostruendo la flotta VPS, il brief suggeriva `macd_momentum` come fit
naturale per «catturare breakout di momentum». È il contrario: un bot così entra al primo tick
dopo il warmup nella direzione in cui l'indicatore punta in quell'istante, e rientra a ogni
chiusura — la regola non dice mai «no», quindi degrada a ingresso arbitrario con uscita affidata
solo a TP/SL/trailing. **Non è un difetto del 5m**: è strutturale al template e vale a qualunque
intervallo, il 5m lo rende solo più frequente. Il PO ha approvato di scartarli entrambi.

**How to apply:** se torna una richiesta di flotta o di strategia d'ingresso, usa `rsi_reversal` e
`bollinger`; dichiara però il costo, perché sono **entrambi mean-reversion** e la flotta risulta
decorrelata solo in parte. Per un momentum vero serve una regola a **transizione** (incrocio MACD,
incrocio prezzo/EMA, breakout di canale), che oggi non esiste: `_evalRule` riceve solo il valore
dell'indicatore alla barra corrente, quindi un evento di incrocio richiede la barra precedente o
uno stato per-bot — non è un `cond` in più. Limite adiacente: `logic:'all'` pretende che tutte le
regole condividano UN solo `signal`, quindi non si può esprimere una strategia bidirezionale con
filtro (es. ADX>25 su entrambi i lati). Storia proposta al PO, che la apre lui.

Nota operativa collegata: `config.paper` è ciò che decide il broker (`bot.js`:
`this.paper = !!this.config.paper`), **`network: 'testnet'` da solo non implica paper**; e il cap
che vincola davvero il sizing del loop autonomo è `config.risk.maxPositionUsd`, non
`config.maxPositionUsd` top-level, che è letto solo da `validateRiskCeiling` sul percorso MCP
manuale. I bot fantasma dell'hot-patch sbagliavano entrambe le cose
([[hotpatch-vps-20260914]], [[feedback-guardrail-copre-solo-chi-scrive-lo-stato]]).
