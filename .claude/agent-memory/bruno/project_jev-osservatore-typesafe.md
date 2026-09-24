---
name: jev-osservatore-typesafe
description: TypeSafe Jev in ArbitrageBot (JEV-OBS-01) — osservatore asincrono mai guardrail, contratto API, e il prezzo NON verificato che resta l'unica cosa aperta
metadata:
  type: project
---

Da settembre 2026 esiste in ArbitrageBot un **osservatore asincrono** (`src/agents/jev.js`) che
interroga TypeSafe Jev — un "System One model": stato testuale + domande tipizzate
(`noul` → probabilità calibrata, `choice`, `score`) → giudizi. **Non è un LLM conversazionale** e
non sta in `agents/providers/`.

**Why:** il PO voleva un supervisore visibile in dashboard senza introdurre un secondo decisore sul
percorso dei soldi. Il vincolo, approvato in chat (non è una issue GitHub), è che il giudizio di Jev
non possa **mai** bloccare, ritardare o influenzare un'apertura/chiusura: i guardrail restano
`riskManager.js` e `portfolio.js`, deterministici e verificabili.

**How to apply:**
- L'innesco è in `bot._runTick`, **dopo** il blocco di esecuzione e solo se `decision.action !== 'hold'`.
  Chi tocca quel punto deve sapere che «dopo» non è casuale: è l'unico posto in cui l'esito di Jev non
  può materialmente precedere l'ordine, e permette allo stato di raccontare com'è *andata*. Un `await`
  lì davanti riapre esattamente il difetto che il disegno vieta (c'è un test che in quel caso non
  termina affatto).
- Nessuna domanda **direttiva** ("devo aprire?"): una risposta che sembra un ordine operativo invita a
  collegarla al trading. C'è un test che verifica l'assenza.
- **L'innesco è sul SEGNALE, non sull'esito — ed è l'amplificatore di spesa** (misurato il 23/09/2026:
  88 chiamate, 1,13$ su un budget mensile di 3$, in ~10 minuti). Un segnale persistente (RSI sotto
  soglia per molte candele) con un'apertura che non va a buon fine per *qualunque* motivo — Budget
  Ceiling, portafoglio, lock, cooldown — produce una chiamata a pagamento **a ogni tick**, cioè ogni
  10s per bot. Osservare anche il caso bloccato è voluto ("lo stato racconta com'è andata"), quindi il
  rimedio non è sopprimere ma **deduplicare per episodio**, come già si fa per le notifiche di
  cooldown. Non ancora fatto: se si indaga un consumo anomalo di Jev, guarda prima quanti bot stanno
  ritentando un'apertura che non passa.
- **Un canale a pagamento che non è un LLM non va in `pricing.models`.** Il guardiano di Joshua
  (`pricingModels.test.js`) boccia l'aggiunta, e ha ragione: quella tabella è la *specifica* dei modelli
  costruibili da `getProvider`. La via corretta è una tariffa di **famiglia** (`pricing.jev` + pattern in
  `resolvePricing`), come i tier opus/haiku/sonnet — la matematica del costo resta una sola in `usage.js`.
- **RESTA APERTO (decisione del PO):** il *contratto* dell'API è stato validato con chiamate reali, il
  **prezzo no**. Le tariffe in `config.js` sono una sovrastima deliberata (10/30 per milione) e il budget
  mensile di default (3$) è l'unica cosa che davvero limita la spesa finché non arriva una fattura vera.
  Prima di dire «quanto ci costa Jev», guarda se quel numero è stato sostituito.
- `JEV_API_KEY` **non è** nei segreti di produzione: il comportamento normale oggi è osservatore spento,
  una riga all'avvio che dice perché, e bot identici a prima.

Collegati: [[feedback-seam-di-test]], [[feedback-fallimenti-money-path-non-silenziosi]].
