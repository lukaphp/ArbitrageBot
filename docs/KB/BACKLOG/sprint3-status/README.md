# Meccanismo di stato autonomo — Sprint 3

Ogni membro del team scrive **solo il proprio file** in questa cartella. Nessun agente legge o
scrive il file di un altro (eccetto Roger, che li legge tutti per l'aggregato — mai per scriverli).
Questo evita qualunque race condition: non essendoci un file condiviso scritto da più processi, non
serve lock né coordinamento tra agenti. Stesso meccanismo già usato nello Sprint 2
(`docs/KB/BACKLOG/sprint2-status/`), qui solo con i task di questo sprint.

## File

| File | Scritto da | Contenuto |
|:---|:---|:---|
| `sprint3-tasks.json` | Io/PO (statico, non da agenti) | Elenco canonico dei task, proprietario, story point — fonte: `sprint3.md`. Aggiornato dopo ogni planning. |
| `joshua.json` | joshua | Stato dei task che possiede: SEC-07, LINT-01, SPIKE-01 (+ parte server di EVM-01) |
| `bruno.json` | bruno | Stato dei task che possiede: TG-01, COST-01 (+ parte backend di STRAT-01) |
| `maya.json` | maya | Stato dei task che possiede: BRAND-01 (+ parte UI di EVM-01 e STRAT-01) |
| `annie.json` | annie | Note di review (SEC-07, EVM-01, STRAT-01) + candidati di refinement |
| `aggregate.json` | roger | Sintesi di tutti i file sopra, letta da me per aggiornare la board visuale |

**Task con doppio proprietario (EVM-01, STRAT-01):** ciascun proprietario aggiorna la propria parte
nel proprio file — non esiste un file condiviso per un task a due, per non reintrodurre la race
condition che questo meccanismo evita. Roger concilia le due metà in `aggregate.json`.

OPS-02 e OPS-03 non hanno un file di stato dedicato: sono esplicitamente non delegati a un agente
(accesso VPS reale fuori dal loro perimetro, come CHORE-01 in Sprint 2) — restano in carico al PO,
eseguiti insieme a Claude nel thread principale.

## Schema di un file di stato agente

```json
{
  "agent": "bruno",
  "updatedAt": "2026-08-09T10:00:00Z",
  "tasks": {
    "TG-01": {
      "status": "not_started | in_progress | ready_for_review",
      "criteriaChecked": [false, false, false],
      "notes": "testo libero: cosa resta, blocchi, decisioni prese"
    }
  }
}
```

**Regole:**
- `status` può arrivare fino a `ready_for_review`, **mai** a `done`/`fatto` — quel passaggio è
  una decisione esplicita del PO, fatta in review.
- `criteriaChecked` è un array di booleani nello stesso ordine dei criteri di accettazione elencati
  in `sprint3.md` per quel task — aggiornalo mano a mano, non solo a fine lavoro.
- `notes` è dove segnali blocchi, decisioni non ovvie, o candidati per il refinement dello sprint
  successivo.
- Aggiorna il file **quando cambia qualcosa di reale** (non ad ogni singolo tool-call) — inizio
  lavoro, milestone interna, fine lavoro.

## Come arriva alla board visuale

Io leggo `aggregate.json` (prodotto da Roger) e aggiorno l'artifact pubblicato, come già per gli
Sprint 1-2.
