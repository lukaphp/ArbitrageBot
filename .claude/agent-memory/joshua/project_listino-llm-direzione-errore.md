---
name: listino-llm-direzione-errore
description: Regola del progetto per i prezzi LLM incerti — sovrastimare, mai sottostimare, perché pricing.models è un gate di attivazione e non una tabella
metadata:
  type: project
---

`agents.pricing` in `src/config/config.js` non è una tabella informativa: è un **gate**.
`providers/index.js` rifiuta di costruire un fornitore per un modello senza tariffa
(`ProviderError` codice `missing_pricing`), perché senza tariffa il costo risulta 0 e il
budget mensile a soglia dura di ADV-03 non frenerebbe mai.

**Why:** conseguenza pratica scoperta in LLM-PRICE-01 (12 agosto 2026) — quando gli alias
DeepSeek su cui il listino era keyato sono stati ritirati, l'effetto non è stato "prezzi
vecchi" ma **l'intero percorso multi-provider fermo**, in silenzio, finché qualcuno non ha
provato a usarlo. Un ID di modello sbagliato in quel listino è un guasto funzionale.

**How to apply:** due regole stabilite e scritte nei commenti del file.

1. **Su un valore incerto, sbaglia per eccesso.** Se sovrastima, il budget frena presto e
   si nota; se sottostima, non frena mai e non c'è pavimento. Applicata al tier per
   sottostringa (`opus`/`sonnet`/`haiku`), che è una congettura per costruzione: porta il
   prezzo **più alto ancora acquistabile** nella famiglia. Applicata anche all'unica
   tariffa arrivata come intervallo invece che come valore puntuale (v4-flash via
   OpenRouter): estremo alto dell'intervallo, dichiarato tale nel commento.
2. **Tier vs voce esatta.** Il tier segue il **modello pinnato di default**
   (`analystModel`, `advisorModel`), non la famiglia più recente — cambiarlo per un
   modello nuovo sottostimerebbe quello che gira davvero. I modelli che si discostano dal
   tier vanno in `pricing.models` come **ID esatti**. Attenzione al match per prefisso:
   una chiave "di famiglia" (es. `deepseek-v4`) si mangia ogni variante più specifica.

Ogni tariffa è sovrascrivibile da ENV, ma il pattern `parseFloat(env) || default` rende
impossibile impostare **zero** (rilevante per le varianti `:free` di OpenRouter): è un
difetto noto e non corretto, vedi le note di refinement in `sprint2-status/joshua.json`.

Vedi [[test-non-puo-essere-oracolo-di-se]].
