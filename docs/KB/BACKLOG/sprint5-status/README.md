# Meccanismo di stato autonomo — Sprint 5 (Release 2 · Sprint 1)

Stesso meccanismo degli Sprint 2-4. Diverso in un punto: questo sprint ha **un solo owner**
(Bruno) su tutte le 10 storie — decisione esplicita di planning, non un'omissione — quindi non
esistono `joshua.json`/`maya.json` per questo sprint.

## File

| File | Scritto da | Contenuto |
|:---|:---|:---|
| `sprint5-tasks.json` | Io/PO (statico) | Elenco canonico dei task — fonte: `sprint5.md` |
| `bruno.json` | bruno | Stato di tutte e 10 le storie (CRIT-01/02/03, WARN-01…06, QUAL-01) |
| `annie.json` | annie | Note di review — revisore designata per l'intero sprint, non un sottoinsieme |
| `aggregate.json` | roger (o Claude in sessione di review, come Sprint 3/4) | Sintesi per la board visuale |

## Schema di un file di stato agente

Identico a `sprint4-status/README.md`: `status` fino a `ready_for_review` (mai `done`, quella è
decisione del PO in review), `criteriaChecked` allineato ai criteri di accettazione di `sprint5.md`,
`notes` per blocchi/decisioni/candidati di refinement.

## Invarianti di questo sprint (da sprint5.md §1)

- Nessuna storia introduce una feature nuova — solo correttezza/resilienza.
- CRIT-01: il caso di fill nullo non deve mai scrivere una posizione "fantasma".
- CRIT-03: il lock riusa `execQueue`, non introduce una seconda struttura di serializzazione.
- WARN-05: non tocca il backoff/la logica di retry già esistente, solo lo stato esplicito.
