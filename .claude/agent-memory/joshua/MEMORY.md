# Memoria di Joshua — Infrastruttura, build, deploy

- [Prove reali, non "nessun errore"](feedback_prove-reali.md) — i falsi positivi di `npm rebuild` e del binding lazy di better-sqlite3; come verifico davvero.
- [Hardening mirato, mai rollback in blocco](feedback_hardening-mirato.md) — sbloccare un pacchetto per volta, commentato; ispezionare gli script prima di assumere che servano.
- [Gap aperto: binding nativo in CI](project_ci-binding-nativo.md) — `npm ci` sotto `ignore-scripts` senza rebuild: verde in locale, rosso su runner pulito.
- [Infisical non è il default di `npm start`](project_infisical-non-default.md) — richiesta del backlog respinta motivatamente nello Sprint 1.
