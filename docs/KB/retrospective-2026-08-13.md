# Prima Retrospective di Team Nautilus (12-13 agosto 2026)

**Versione illustrata (stessa retrospettiva):** [artifact pubblicato](https://claude.ai/code/artifact/bfb74b8e-bcd8-4c35-af2e-16731f0dfc73) — collegato anche dalla [board di Release 2](https://claude.ai/code/artifact/ebb6390c-8caa-4025-b30d-ec31c630ffdc).

Prima retrospective mai fatta da questo team, richiesta esplicita del PO dopo la chiusura di Sprint 2
di Release 2. Formato Glad/Sad/Mad, sei riflessioni raccolte senza coordinamento tra loro — Bruno,
Joshua, Maya, Annie, Jordan (il membro più recente, unito l'11 agosto) e il PO stesso in qualità di
Scrum Master — poi sintetizzate da Roger.

## Filo comune trovato, non pianificato da nessuno

Cinque riflessioni su sei riportano indipendentemente lo stesso problema: worktree isolati che
partono indietro rispetto al branch condiviso (commit mancanti, memoria persa). Si salda direttamente
al rilievo del PO sul controllo dei branch.

## Conclusioni e responsabili (sintesi di Roger)

| Conclusione | Tipo | Responsabile |
|:--|:--|:--|
| Sincronizzare il worktree prima di ogni dispatch; merge-back formale a fine release su `master` | Azione | Claude — orchestratore, su mandato del PO |
| Triage esplicito di ogni rischio riconosciuto-ma-senza-proprietario (harden-runner fail-open, ADV-OPS-01, badge Max Drawdown, gap codice→istanza live) | Decisione | PO, item per item |
| Test di contratto tra i dati che l'Analyst produce e quelli che il renderer di Maya si aspetta | Azione | Bruno + Maya |
| Direzione del ruolo di Roger (ripristinare il trigger esplicito, o aggiornare formalmente ruolo/memoria) | Decisione | PO |
| Template per storie/review con una sezione su "cosa cambia e perché conta" funzionalmente, non solo checklist tecniche | Mitigazione + azione | Claude — orchestratore, approvazione PO |
| Valutazione costo/beneficio di uno strumento agile dedicato (Jira/Taiga) | Decisione | PO — se procedere alla valutazione |

Dettaglio completo, con le sei riflessioni integrali, nell'artifact pubblicato.
