---
name: project-config-scrittura-non-validata
description: "`validateStrategyConfig` esiste ed è cablata SOLO sull'import di un file di strategia — i percorsi che creano/modificano un bot (register_bot MCP, update_strategy_params, executionAgent) non guardano affatto le entryRules"
metadata:
  type: project
---

Nel repo esiste `strategySchema.validateStrategyConfig()`, che sa già riconoscere una regola di tipo
sconosciuto («ignorata a runtime, quindi una strategia diversa da quella dichiarata») e una config
senza regole d'ingresso. È cablata in **un solo posto**: `validateItem` → import di un file di
strategia. Tutti i percorsi che **scrivono** la config di un bot in produzione la saltano:

- `handleRegisterBot` (`src/mcp/tools.js`) valida leva, `maxPositionUsd`, parametri di sizing
  dinamico e blacklist, ma **non tocca `entryRules`/`exitRules`**;
- `update_strategy_params` e `botManager.applyConfigPatch` passano da `mergeStrategyConfig`, che
  fonde e basta;
- l'`executionAgent` (proposte `tune_params`) usa le stesse funzioni.

**Why:** è il motivo per cui la flotta OPS-FLEET-02 ha girato con sei config malformate senza che
niente protestasse (fix `BUG-RULESHAPE-01`, commit `e6b3842`, 2026-09-22): le regole erano state
scritte da un agente con `type` assente e `signal: 'open_long'`, e ogni strato le ha accettate
intatte fino al DB. Il fix rende il motore **tollerante** alla forma sbagliata e **rumoroso** su
quella inservibile, ma non impedisce che una config inservibile venga persistita: il buco a monte è
ancora aperto ed è una storia a sé, che non ho aperto per non allargare un P1.

Conseguenza correlata, sempre aperta: la config dei 6 bot **in DB resta non canonica**. La
normalizzazione vive in memoria (il costruttore di `PerpsBot` e `strategyEngine.evaluate`), di
proposito — `bots.config_json` non viene riscritto di nascosto, stessa disciplina dello storico di
`close_reason` e di `risk_equity_history`. Quindi chiunque legga `config_json`, o una futura
esportazione di strategia, vede ancora la forma vecchia.

**How to apply:** se mi si chiede di irrobustire la creazione/modifica dei bot da agente, il lavoro è
già mezzo fatto — la funzione pura c'è e ha i messaggi giusti, manca solo il cablaggio sui percorsi
di scrittura, più la decisione (del PO) se un errore di forma debba **rifiutare** la creazione o
crearla degradata e segnalata. Prima di proporlo, verifica se qualcuno l'ha già cablato: la
situazione descritta qui è fotografata al 2026-09-22. Vedi
[[feedback-ramo-default-neutro-e-diagnosi-cieca]] per perché il sintomo è invisibile, e
[[feedback-running-non-significa-operativo]] per il controllo da fare sulla flotta prima di
spingerle una config.
