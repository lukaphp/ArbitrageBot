# Meccanismo di stato autonomo — Release 2 · Sprint 2

Stesso meccanismo di Sprint 1. Diverso in un punto: questo sprint ha **tre owner** (Bruno, Joshua,
Maya) più cinque storie dirette (PO o Claude, non delegabili ad agenti) — non un singolo owner come
Sprint 1.

## File

| File | Scritto da | Contenuto |
|:---|:---|:---|
| `sprint2-tasks.json` | Io/PO (statico) | Elenco canonico dei task — fonte: `docs/KB/BACKLOG/release2/sprint2.md` |
| `bruno.json` | bruno | LLM-VAL-01, DEBT-02, CRIT-05, LLM-02, LLM-04 |
| `joshua.json` | joshua | CI-01, LLM-PRICE-01 |
| `maya.json` | maya | DEBT-03, DEBT-04, DEBT-05, DEBT-06 |
| `annie.json` | annie | Note di review — da confermare in planning se revisore sull'intero sprint o solo sui money-path (CRIT-05, LLM-02) |
| `aggregate.json` | Claude in sessione di review (come Sprint 1) | Sintesi per la board visuale |

Le 5 storie dirette (CHORE-01, OPS-02, OPS-03r, ADV-OPS-01, OBS-OPS-01) non hanno un file `<agente>.json`
proprio — sono tracciate direttamente in `sprint2-tasks.json` con `owner: "po"` o `owner: "claude"`, e
il loro stato viene aggiornato lì, non in un file di agente.

## Schema di un file di stato agente

Identico a `sprint1-status/README.md`: `status` fino a `ready_for_review` (mai `done`, quella è
decisione del PO in review), `criteriaChecked` allineato ai criteri di accettazione di
`docs/KB/BACKLOG/release2/sprint2.md`, `notes` per blocchi/decisioni/candidati di refinement.

## Invarianti di questo sprint (da sprint2.md)

- **CRIT-05 non parte prima del secondo campione dalla demo** — vincolo esplicito, non negoziabile per
  pressione di tempo (vedi sprint2.md §0.14 e DoD §1).
- LLM-02: zero regressioni sui test esistenti dell'Analyst con provider Anthropic — l'astrazione non
  deve cambiare il comportamento osservabile, solo l'indirezione.
- ADV-OPS-01 e LLM-VAL-01 non partono senza la rispettiva decisione di spesa del PO — dipendenze
  esterne dichiarate in planning, non presunte pronte.
- DEBT-03: la card EXECUTION STATUS va alimentata con dati reali o rimossa — mai un numero finto o un
  "Queue health: Stable" fisso lasciato al suo posto.
