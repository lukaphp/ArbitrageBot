---
name: hotpatch-vps-20260914
description: L'hot-patch che il 14/09/2026 ha messo il VPS in crash-loop 3h40m — sentiment fabbricato con Math.random e rotazione bot via SQL grezzo; respinto, non integrato
metadata:
  type: project
---

Il 2026-09-14 un hot-patch scritto dentro il container del VPS (via `docker exec`, mai
passato da git) ha causato 3h40m di crash-loop. Backup del codice su `arbitragebot-vps` in
`/opt/arbitragebot/hotpatch-backup-20260914-100320/`. Revisionato e **raccomandato di non
integrare** — nessun file del repo è stato modificato.

Cosa conteneva, in sintesi:
- `multiFeedEngine.js` / `marketFeedModule.js`: un "sentiment multi-feed" con tre
  presunte fonti (perp predictions, onchain momentum, orderbook imbalance) che in realtà
  non fanno nessuna chiamata di rete: i valori escono da `Math.sin(hash + Date.now())`,
  `Math.cos(...)` e `Math.random()`. Numeri inventati con l'aspetto di segnali di mercato.
- `botPerformanceRotator.js`: timer al minuto che ferma via SQL grezzo i bot `running` con
  0 trade da >15 min e ne crea di nuovi con coin pescata a caso da una pool hardcoded,
  `status='running'`, leva 2, 500 USD — scavalcando `botManager.createBot`, `riskManager`
  e i limiti di `portfolio`.

**Why:** è il precedente concreto del perché il codice non entra in produzione fuori da git.
I bug non erano uno (lo shebang) ma una catena: import sopra lo shebang, `dbInstance` e `io`
non definiti, e SQL scritto contro uno schema che non esiste (`bots.config` invece di
`config_json`, `trades.pnl` inesistente, `network`/`master_address` NOT NULL omessi).

**How to apply:** se in `data/perps.db` o sul VPS compaiono bot chiamati `"<COIN> Multi-Feed
Sentiment Bot"` con `actor_label='Hermes'`, vengono da qui e non da una feature approvata.
Se la rotazione automatica dei bot per inattività torna come richiesta, va rifatta da zero
attraverso `botManager` e `riskManager`, non recuperando questo codice.

**Il codice è stato tolto, i bot no.** Verificato il 2026-09-15: i file dell'hot-patch non sono
più nel container, ma i 6 bot che aveva creato sono ancora lì, tutti `running` su testnet
(5 `"<COIN> Multi-Feed Sentiment Bot"` + `"SOL Sentiment TestNet Bot"`). Nessuno di loro ha
`entryRules`, quindi nessuno ha mai aperto una posizione né mai lo farà, e i flag
`useMultiFeedSentiment`/`usePredictionSentiment` nelle loro config non sono letti da nessuna riga
del repo. Un rollback del codice non ripulisce lo stato che quel codice ha scritto: quando questa
flotta ricompare in una richiesta operativa, il punto di partenza è decidere se ricrearla o
fermarla, non ritoccarne i parametri ([[feedback-running-non-significa-operativo]]).
Vedi [[feedback-invarianti-nel-db-non-nel-chiamante]] e [[tree-condiviso-mai-git-stash]].
