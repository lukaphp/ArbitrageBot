---
name: feedback-evidenza-gia-persistita
description: Prima di aggiungere strumentazione, cerca l'osservabile che il sistema già scrive in DB — e diffida di un numero che coincide con un default di configurazione
metadata:
  type: feedback
---

Quando serve confrontare due grandezze per confermare una causa radice, **cerca prima se il sistema
le sta già confrontando e persistendo da qualche parte**. Aggiungere un log è il piano B, non il
piano A.

**Why:** su CRIT #16 la issue chiedeva di loggare il mid dentro `_evaluateTriggers` prima di
qualunque fix — cioè un deploy, la riaccensione di una flotta rotta e l'attesa di nuovi casi. Ma
`trades.slippage_pct` (WARN-03) scriveva già `computeSlippage(order.avgPx, snapshot.price)`, cioè
esattamente il confronto fra prezzo eseguito e prezzo vivo della decisione, su tutti e 18 i casi
reali già accaduti. Evidenza più forte del log futuro, e a costo zero. Vale anche per
`positions.trailing_json`, `mcp_audit`, `risk_equity_history`: molte domande diagnostiche hanno già
una colonna che le risponde.

**Il segnale che chiude la diagnosi:** un valore misurato che coincide con un **default di
configurazione** non è una coincidenza, è la firma della sorgente. `slippage_pct` = 0.019974–0.020018
su 18 aperture non era "staleness variabile": era il letterale `config.slippage ?? 0.02` di `bot.js`
arrivato dove non doveva. Se un numero fosse davvero il sintomo casuale che credi, **varierebbe**;
una costante a 4 cifre viene da una costante nel codice — cercala con grep prima di costruire teorie.

**How to apply:**
- Prima di scrivere strumentazione nuova: `.schema` delle tabelle coinvolte e una query sulle righe
  dell'incidente. Sul VPS si legge senza rischio con
  `sudo sqlite3 'file:/var/lib/docker/volumes/app_perps-data/_data/perps.db?mode=ro' -header -column "…"`.
  I log Docker NON sono una fonte affidabile per un incidente passato: un `compose up --build`
  ricrea il container e li azzera (è successo, il 15/09 alle 18:54 sono spariti quelli dell'incidente).
- Se devii da un passo esplicitamente chiesto nel task (qui: "logga PRIMA di qualunque fix"),
  **dichiara la deviazione e perché l'osservabile scelto è più forte**, non ometterla.
- Poi riproduci i numeri ESATTI di produzione in un test: se dal mid implicito esce `entry_px` 75913 e
  `sl_px` 77051.695, cioè le righe vere, la causa non è più un'ipotesi. È la stessa disciplina del
  rosso-prima-del-fix ([[feedback-seam-di-test]]) portata sui dati reali.
- Elimina le ipotesi alternative **misurandole** invece di lasciarle cadere: reti diverse, cache
  dell'SDK, trailing. Una a una, con il numero accanto — vedi
  [[project-stop-istantaneo-prezzo-esecuzione]] e [[feedback-misura-grandezze-mark-dipendenti]].
