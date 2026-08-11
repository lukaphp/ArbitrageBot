# Meccanismo di stato autonomo — Sprint 2

Ogni membro del team scrive **solo il proprio file** in questa cartella. Nessun agente legge o
scrive il file di un altro (eccetto Roger, che li legge tutti per l'aggregato — mai per scriverli).
Questo evita qualunque race condition: non essendoci un file condiviso scritto da più processi, non
serve lock né coordinamento tra agenti.

## File

| File | Scritto da | Contenuto |
|:---|:---|:---|
| `sprint2-tasks.json` | Io/PO (statico, non da agenti) | Elenco canonico dei task, proprietario, story point — fonte: `sprint2.md`. Aggiornato dopo ogni planning. |
| `joshua.json` | joshua | Stato dei task che possiede: DEP-01, CI-REBUILD-01, CI-01, OPS-01 |
| `bruno.json` | bruno | Stato dei task che possiede: WS-01, TEST-01, TRAIL-01 |
| `maya.json` | maya | Stato dei task che possiede: DOC-02 (dal planning dell'8 agosto — prima non ne aveva) |
| `annie.json` | annie | Note di review (TEST-01, CI-01) + candidati di refinement |
| `aggregate.json` | roger | Sintesi di tutti i file sopra, letta da me per aggiornare la board visuale |

CHORE-01 non ha un file di stato dedicato: è esplicitamente non delegato a un agente (vedi
`sprint2-tasks.json`), resta in carico al PO.

## Schema di un file di stato agente

```json
{
  "agent": "bruno",
  "updatedAt": "2026-08-08T10:00:00Z",
  "tasks": {
    "WS-01": {
      "status": "not_started | in_progress | ready_for_review",
      "criteriaChecked": [false, false, false],
      "notes": "testo libero: cosa resta, blocchi, decisioni prese"
    }
  }
}
```

**Regole:**
- `status` può arrivare fino a `ready_for_review`, **mai** a `done`/`fatto` — quel passaggio è
  una decisione esplicita del PO, fatta in review (vedi `sprint1.md` per il precedente).
- `criteriaChecked` è un array di booleani nello stesso ordine dei criteri di accettazione elencati
  in `sprint2.md` per quel task — aggiornalo mano a mano, non solo a fine lavoro.
- `notes` è dove segnali blocchi, decisioni non ovvie, o candidati per il refinement dello sprint
  successivo — lo stesso spirito di quanto già fatto nello Sprint 1.
- Aggiorna il file **quando cambia qualcosa di reale** (non ad ogni singolo tool-call) — inizio
  lavoro, milestone interna, fine lavoro.

## Come arriva alla board visuale

Io leggo `aggregate.json` (prodotto da Roger) e aggiorno l'artifact pubblicato, com'è già successo
per lo Sprint 1 — la differenza è che ora lo stato "pronto per la review" è popolato in autonomia dal
team invece che da un mio giro di dispatch e raccolta report a fine sprint.
