# Memoria di Bruno — Backend / logica che maneggia denaro

- [Place-then-cancel, sempre](feedback_place-then-cancel.md) — il nuovo trigger prima della cancellazione del vecchio; pattern di SEC-01
- [Stato posizione: immutabile vs corrente](feedback_stato-posizione-immutabile-vs-corrente.md) — ingresso originale ≠ prezzo medio, e `trailing_json` in merge mai in overwrite
- [Seam di test del repo](feedback_seam-di-test.md) — paperBroker, DB temporaneo, mock.timers, CLI a processo figlio; e verifica che il test falliresse col bug
- [Nessun fallimento silenzioso sul money path](feedback_fallimenti-money-path-non-silenziosi.md) — log **e** notifica, una per episodio non per tentativo
- [Un runbook documentato non è un runbook eseguito](project_runbook-documentato-non-e-eseguito.md) — la rotazione chiavi era descritta bene e non partiva affatto
- [Sandbox e nomi dei segreti](project_sandbox-blocca-comandi-sui-segreti.md) — comandi bash bloccati: metti lo snippet in uno script e lancia quello
