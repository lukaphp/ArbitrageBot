---
name: feedback-stesso-parametro-due-percorsi
description: Un limite di rischio scritto in due percorsi legittimi (radice vs blocco annidato) da due sorgenti diverse — come si riconosce, e perché si applica il più restrittivo invece di eleggerne uno
metadata:
  type: feedback
---

Quando un parametro che limita il rischio "non fa effetto", la prima domanda non è *se* il controllo
esista ma **da quale percorso legge il valore**, e **chi scrive la config** da quel percorso.

**Why:** BUG-SIZECAP-01 (2026-09-23). `riskManager.sizePosition` applicava il cap `maxPositionUsd`
correttamente su entrambi i rami di sizing, ma lo leggeva **solo** da `config.risk.maxPositionUsd`.
La flotta gestita da Hermes ha il tetto alla **radice** (`config.maxPositionUsd`) — forma altrettanto
legittima: è quella documentata e validata da `register_bot`/`update_strategy_params`, quella che i
guardrail MCP leggono, e quella copiata in `bots.max_allocation_usd`. La UI (`public/perps.js`) scrive
invece la forma annidata. Con `?? Infinity` il tetto per-bot spariva e restava il cap **globale** di
`config.js` (5.000$): quattro bot con tetto dichiarato 500$ hanno proposto aperture fino a 4.999$.
Stessa famiglia di BUG-RULESHAPE-01 (`signal: open_long` vs `long`): due vocabolari a un livello di
distanza, e il motore ne conosce uno solo.

**How to apply:**
- **La firma diagnostica**: se più bot con config diverse convergono sullo *stesso* numero a meno
  dell'arrotondamento, quel numero è un default globale, non un calcolo. Tre dei quattro notional
  erano 5.000$ meno il troncamento a `szDecimals` — cioè il cap globale al centesimo. Non era «una
  size esplosa», era «un tetto diverso da quello che credevo».
- **Non eleggere una sola fonte** quando entrambe sono scritte da sorgenti vive: eleggere l'annidata
  lasciava il bug su tutta la flotta ad agente, eleggere la radice toglieva il tetto ai bot creati
  dalla UI. Si applica il **più restrittivo** (un limite di rischio non si allarga mai per una
  divergenza di formato) e si **nomina** il disaccordo.
- **Un valore inservibile non è "nessun limite"**: `notional > 'abc'` è falso, quindi una stringa nel
  campo del cap lo cancellava in silenzio. Validare e degradare sul cap globale, con un warn.
- **Cerca il gemello annidato**: `update_strategy_params` fonde un livello in profondità, quindi un
  agente che passa `{ sizing: { maxPositionUsd } }` crea un **percorso nuovo e inerte** invece di
  aggiornare quello canonico. Quei campi non si indovinano, si elencano all'avvio del bot
  (`riskManager.auditRiskConfig` → `PerpsBot._reportConfigIssues`).
- **Il blocco inerte può non essere inerte affatto**: `config.sizing` era anche il blocco del sizing
  statico, e senza `value` produceva `NaN`. Vedi [[feedback-nan-attraversa-ogni-guardia]].

Collegati: [[project-config-scrittura-non-validata]], [[feedback-fallimenti-money-path-non-silenziosi]].
