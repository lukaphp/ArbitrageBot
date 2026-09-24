# Memoria di Maya — Frontend & Documentazione

- [Doc = stato reale del codice](feedback_doc-riflette-codice.md) — verifica nel sorgente prima di scrivere; caso SEC-04 webhook
- [Nessun task FE puro è un esito legittimo](feedback_task-fe-assente.md) — dirlo e prendere la superficie utente del task adiacente
- [Segnalare le incoerenze fuori perimetro](feedback_segnalare-fuori-perimetro.md) — nel report, non di nascosto; ordina i candidati e dì qual è il peggiore
- ["Ignoto" non è zero né verde](feedback_stato-ignoto-non-e-zero.md) — tre stati, non due; `Number(null)` è 0; badge senza `id` che nessuno scrive mai
- [Sprint 1 consegnato in un commit bundled](project_sprint1-consegna-bundled.md) — `git diff` vuoto non vuol dire lavoro assente
- [`window.confirm` nativo va bene](feedback_confirm-nativo-ok.md) — il precedente di confirm bloccato era un artifact sandboxed, non questa app
- [Come verificare davvero la DoD frontend](feedback_verifica-dod-frontend.md) — check tag, harness `node:vm`, assert sul markup, e un test di sicurezza va provato rosso prima del fix
- [Ritirare un file legacy senza portarsi via il vivo](feedback_ritiro-legacy-superficie-condivisa.md) — censire la superficie condivisa prima di cancellare; caso `app.js`/EVM-01
- [Riconciliare il contratto API prima di chiudere](feedback_riconciliare-contratto-api.md) — rifiuti con HTTP 200, `code` esclusivo, il primo degrado vince; e un evento Socket.IO può avere due payload
- [Come lavoro in parallelo con Bruno e Joshua](project_working-tree-condiviso.md) — worktree isolato o checkout condiviso: si alternano, controlla all'avvio; snapshot `git archive` per provare che un rosso non è mio
- [Quando due file devono concordare, dichiara la fonte di verità](feedback_fonte-di-verita-tra-due-file.md) — vince quello dove l'ordine porta significato per l'utente; scrivi la regola nel file
- [Un tipo nuovo in un renderer generico](feedback_tipo-nuovo-in-render-generico.md) — «non si rompe» non basta: payload decidibile, esiti opposti distinti prima del click, null-by-design, escaping
- [Un dato che non decide non va reso come se decidesse](feedback_osservatore-non-decide.md) — tab, palette, tempo verbale; e l'elenco vuoto con due cause si dichiara doppio
- [Osservatore Jev (JEV-OBS-01)](project_jev-osservatore.md) — spento in produzione: lista vuota è normale; `jevStatus()` non è su nessuna rotta, l'ho chiesta
- [Rendere uno stato di rischio che il backend non espone](feedback_stato-di-rischio-derivato.md) — `startsWith` e non `includes` (la coda è testo utente); due numeri accostati portano ciascuno la sua finestra
- [Un parametro nuovo in query string rompe la guardia "richiesta in volo"](feedback_parametro-nuovo-e-richiesta-in-volo.md) — il click scartato ridisegna la finestra sbagliata; il filtro locale restringe ma non allarga
