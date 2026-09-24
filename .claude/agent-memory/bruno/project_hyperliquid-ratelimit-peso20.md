---
name: hyperliquid-ratelimit-peso20
description: Le chiamate SDK Hyperliquid di peso 20 (userFills, frontendOpenOrders, funding) muoiono di fame in silenzio nel token bucket condiviso — sintomo - promise pendente per sempre
metadata:
  type: project
---

Il rate limiter interno dell'SDK Hyperliquid è un token bucket **senza coda** (capacity 100, refill
10 token/s) condiviso da tutte le chiamate della **stessa istanza** `Hyperliquid`. Quasi tutte le
letture costano 2 token, ma `userFills`, `frontendOpenOrders`, `fundingHistory` e
`predictedFundings` ne costano **20**. Chi chiede 2 token li prende appena arriva; chi ne chiede 20
si addormenta e al risveglio trova il secchiello già svuotato → **starvation indefinita**. La
promise non si risolve e non si rigetta: nessun errore, nessun log, nessuna metrica.

**Why:** 17/09/2026, `GET /api/perps/fills` e `/api/perps/orders` appese per sempre in produzione
mentre `/api/perps/account` (peso 2) rispondeva in 634ms nello stesso istante. Contatore letto dal
vivo nel processo Express: **0.02 token su 100**, fisso. L'SDK crea inoltre la sua istanza axios
**senza `timeout`**, quindi niente nel percorso può accorgersene — e `withRetry` ritenta solo DOPO
un errore. Non è solo dashboard: `bot._ensureStopLoss` (garanzia SEC-08) e `getRealizedPnl` passano
di lì.

**How to apply:** se una chiamata Hyperliquid "non torna" e in un processo isolato funziona, la
prima ipotesi è questa — non la rete, non il socket. Discriminante in 30 secondi: una chiamata di
peso 2 e una di peso 20 in parallelo; se passa solo la prima è starvation. Il fix in repo:
`getHeavyReadSdk()` in `src/perps/hyperliquidClient.js` (istanza dedicata = secchiello dedicato) +
`withTimeout`/`timeoutMs` in `src/perps/retry.js`. Attenzione: la separazione raddoppia il budget
*client-side*, non quello vero di Hyperliquid.

**SEGUITO — il 24/09/2026 è successo davvero.** L'avvertimento «`_findStopOrders`/`_findTpOrders`
fanno due letture pesanti per tick per bot, che con bot live sfonda comunque il refill» si è
avverato appena il fix del sizing ha fatto aprire posizioni vere a 5-6 bot: 24 token/s richiesti
contro 10, timeout a catena, e la guardia SL che chiudeva le posizioni credendoli prove. Sistemato
con una sola lettura per tick condivisa dalle due guardie e la coalescenza delle richieste identiche
in volo per wallet — **non** alzando il secchiello. Resta aperto: `restRetries = 1` sulle letture
pesanti raddoppia la spesa di una lettura fallita (il tentativo abbandonato spende comunque i suoi
20 token), ed è il motore del burst; segnalato al PO, non cambiato.
Vedi [[feedback-non-so-non-e-non-ce]], [[feedback-budget-di-chiamate-e-aritmetica]],
[[fallimenti-money-path-non-silenziosi]] e [[diagnosi-processo-node-vivo]].
