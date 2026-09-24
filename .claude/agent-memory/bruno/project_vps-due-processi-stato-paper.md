---
name: vps-due-processi-stato-paper
description: Sul VPS girano DUE processi che importano gli stessi singleton (Express + MCP Stdio di Hermes) — si cancellano a vicenda lo stato paper; come operare senza perdere scritture
metadata:
  type: project
---

Sul VPS di produzione (`arbitragebot-vps`, `/opt/arbitragebot/app`, servizio `app-app-1`) NON c'è un
solo processo dell'app: oltre a `node src/server.js` (Express) gira **dentro lo stesso container** un
`node src/mcp/server.js` long-lived, tenuto vivo dal watchdog di Hermes
(`mcp_stdio_watchdog.py ... docker exec -i app-app-1 node src/mcp/server.js`). Entrambi importano gli
stessi singleton — `paperBroker`, `botManager`, `db`.

Conseguenze misurate il 2026-09-12, non ipotizzate:
- `paper_broker_state` è **un blob unico** in `settings`: `_save()` lo riscrive INTERO dallo stato in
  memoria e `_load()` gira una volta sola. La scrittura di un processo **cancella** quella dell'altro.
  Osservato: trigger tp/sl `oid 35/36 @103.67/99.142` riportati a `oid 24/25 @104.68/98.639` (i livelli
  di un bot cancellato 12 minuti prima) e `oidSeq` tornato da 37 a 35 → oid futuri che collidono con
  quelli citati in `trailing_json`.
- `bot_control('start')` via MCP avvia il bot **in quel processo**, e `notifyExpressReload()` lo avvia
  **anche** in Express: due loop di tick sulla stessa riga `positions`.

**AGGIORNAMENTO 16/09/2026 (issue #7, mio, `ready_for_review` — NON ancora deployato sul VPS: finché
non si rilascia, sul VPS vale tutto quanto sopra).** Il disegno è cambiato in due punti:
- **owner unico del tick loop**: `src/utils/processRole.js` (`declareProcessRole`/`ownsTickLoop`). Il
  processo MCP Stdio si dichiara `mcp_stdio`, `loadFromDb()` non avvia più i bot lì e i tool di ciclo
  di vita delegano a Express con `POST /internal/mcp/bot-control`. Default = «possiedo il loop», così
  chi non si dichiara si comporta come prima e Express non bussa a sé stesso;
- **`_save()` fa reload-and-merge** per (account, **coin**) — non per solo account: i conti paper sono
  per master address e più bot condividono lo stesso wallet. `oidSeq` è monotono anche al momento in
  cui l'oid viene **coniato** (`_nextOid`), non solo al salvataggio.
Resta scoperto: stessa coppia (account, coin) scritta da due processi = last-writer-wins, e
`place_order_paper` muta ancora il broker paper dentro il processo MCP.

**Why:** una modifica allo stato paper fatta da un processo esterno (script `docker exec`, SQL a mano)
o dal processo "sbagliato" viene sovrascritta al primo `_save()` dell'altro — e il `_save()` non avviene
a ogni tick ma solo su fill/piazzamento/cancellazione trigger, quindi l'illusione che "abbia tenuto"
può durare minuti.

**How to apply:** qualunque operazione sullo stato paper va eseguita **dentro il processo che la deve
vedere**, cioè via l'API HTTP dell'app (`POST /api/mcp/call` con `name`/`arguments` — il transport HTTP
dell'MCP gira in Express). Il gate `/api` vuole il cookie `sid`: si emette con il modulo dell'app stessa,
dentro il container, senza far uscire `SESSION_SECRET`
(`docker exec app-app-1 node -e 'import("/app/src/middleware/auth.js").then(m=>console.log(m.issueToken()))'`,
poi `curl -b "sid=$TOKEN" http://127.0.0.1:3000/...` dall'interno o `:8080` dall'host via Caddy).
Non chiudere una posizione paper con `/api/perps/positions/:coin/close` né col kill-switch
`closePositions`: usano `hyperliquidClient`, cioè il broker REALE. Il verso opposto via
`place_order_paper` chiude l'intera size (vedi [[feedback-place-then-cancel]] per i trigger, e
[[feedback_stato-posizione-immutabile-vs-corrente]] per il principio merge-non-overwrite che qui manca).
Dichiarare sempre che una bonifica dello stato paper è durevole **solo fino al prossimo `_save()`**
dell'altro processo, finché il blob non diventa per-account o non si rilegge in merge.
