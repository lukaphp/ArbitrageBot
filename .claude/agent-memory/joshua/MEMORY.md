# Memoria di Joshua — Infrastruttura, build, deploy

- [Prove reali, non "nessun errore"](feedback_prove-reali.md) — falsi positivi di `npm rebuild`/binding lazy, ricetta della sandbox "runner pulito", segreti inline bloccati.
- [Hardening mirato, mai rollback in blocco](feedback_hardening-mirato.md) — sbloccare un pacchetto per volta, commentato; ispezionare gli script prima di assumere che servano.
- [Binding nativo in CI: chiuso, con un residuo](project_ci-binding-nativo.md) — fix fatto l'8/8/2026; resta l'impatto sull'allowlist egress di CI-01.
- [Infisical non è il default di `npm start`](project_infisical-non-default.md) — richiesta del backlog respinta motivatamente nello Sprint 1.
- [Working tree condiviso tra agenti](project_working-tree-condiviso.md) — una suite rossa può essere lavoro in corso di un altro: isola prima di correggere.
