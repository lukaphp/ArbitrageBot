# Memoria di Bruno — Backend / logica che maneggia denaro

- [Place-then-cancel, sempre](feedback_place-then-cancel.md) — il nuovo trigger prima della cancellazione del vecchio; pattern di SEC-01
- [Stato posizione: immutabile vs corrente](feedback_stato-posizione-immutabile-vs-corrente.md) — ingresso originale ≠ prezzo medio, e `trailing_json` in merge mai in overwrite
- [Seam di test del repo](feedback_seam-di-test.md) — paperBroker, DB temporaneo, mock.timers, CLI a processo figlio; e verifica che il test falliresse col bug
- [Nessun fallimento silenzioso sul money path](feedback_fallimenti-money-path-non-silenziosi.md) — log **e** notifica, una per episodio non per tentativo
- [Invarianti nel DB, non nel chiamante](feedback_invarianti-nel-db-non-nel-chiamante.md) — "crea se non esiste" dentro un metodo sincrono; il pattern di SEC-08
- [Contratto API: leggi il consumer](feedback_contratto-api-leggi-il-consumer.md) — due suite verdi e la UI rotta; segni firmati e chiavi aggiuntive invece di forme cambiate
- [Purezza delle funzioni che sembrano query](feedback_purezza-funzioni-che-sembrano-query.md) — `canOpen` che scriveva stato: il finding più importante di Release 2 · Sprint 1
- [Working tree condiviso: mai git stash](project_tree-condiviso-mai-git-stash.md) — il rosso-prima-del-fix si ottiene test-first o con un worktree separato, non stashando il lavoro dei colleghi
- [TP vs SL si legge dall'oid del fill](project_close-reason-non-distingue-tp-da-sl.md) — fatto dal fix Sprint 4 in poi; lo storico precedente resta ambiguo e non si riclassifica
- [La spesa dell'Analyst va in proposte scadute](project_analyst-spesa-va-in-proposte-scadute.md) — 127 su 137 mai decise: è il destinatario, non il modello
- [Un runbook documentato non è un runbook eseguito](project_runbook-documentato-non-e-eseguito.md) — la rotazione chiavi era descritta bene e non partiva affatto
- [Sandbox e nomi dei segreti](project_sandbox-blocca-comandi-sui-segreti.md) — comandi bash bloccati: metti lo snippet in uno script e lancia quello
- [Jordan, analista di rischio](project_jordan-analista-di-rischio.md) — revisore aggiuntivo da Sprint 1 di Release 2: guarda la domanda a monte del bug tecnico
- [Account unificato Hyperliquid](reference_hyperliquid-unified-account-model.md) — `hold`/`accountValue`/`totalRawUsd`: cosa significano, e gli endpoint info pubblici per provarlo
- [Equity: doppio conteggio dello Spot](project_equity-doppio-conteggio-spot.md) — finding aperto: invisibile a conto piatto, e tocca drawdown/alert oltre al sizing
