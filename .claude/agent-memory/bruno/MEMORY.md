# Memoria di Bruno — Backend / logica che maneggia denaro

- [Place-then-cancel, sempre](feedback_place-then-cancel.md) — il nuovo trigger prima della cancellazione del vecchio; pattern di SEC-01
- [Stato posizione: immutabile vs corrente](feedback_stato-posizione-immutabile-vs-corrente.md) — ingresso originale ≠ prezzo medio, e `trailing_json` in merge mai in overwrite
- [Seam di test del repo](feedback_seam-di-test.md) — paperBroker, DB temporaneo, mock.timers, CLI a processo figlio; e verifica che il test falliresse col bug
- [Nessun fallimento silenzioso sul money path](feedback_fallimenti-money-path-non-silenziosi.md) — log **e** notifica, una per episodio non per tentativo
- [Invarianti nel DB, non nel chiamante](feedback_invarianti-nel-db-non-nel-chiamante.md) — "crea se non esiste" dentro un metodo sincrono; il pattern di SEC-08
- [Contratto API: leggi il consumer](feedback_contratto-api-leggi-il-consumer.md) — due suite verdi e la UI rotta; segni firmati e chiavi aggiuntive invece di forme cambiate
- [Working tree condiviso: mai git stash](project_tree-condiviso-mai-git-stash.md) — il rosso-prima-del-fix si ottiene test-first, non stashando il lavoro dei colleghi
- [TP vs SL si legge dall'oid del fill](project_close-reason-non-distingue-tp-da-sl.md) — fatto dal fix Sprint 4 in poi; lo storico precedente resta ambiguo e non si riclassifica
- [La spesa dell'Analyst va in proposte scadute](project_analyst-spesa-va-in-proposte-scadute.md) — 127 su 137 mai decise: è il destinatario, non il modello
- [Un runbook documentato non è un runbook eseguito](project_runbook-documentato-non-e-eseguito.md) — la rotazione chiavi era descritta bene e non partiva affatto
- [Sandbox e nomi dei segreti](project_sandbox-blocca-comandi-sui-segreti.md) — comandi bash bloccati: metti lo snippet in uno script e lancia quello
