---
name: project-analyst-spesa-va-in-proposte-scadute
description: La spesa dell'Analyst si perde in proposte che scadono senza decisione (127 su 137), non nel modello — misurato in COST-01, Sprint 3
metadata:
  type: project
---

Il costo dell'Analyst AI non è un problema di modello: è un problema di **destinatario**.
Misura reale (COST-01, 10 agosto 2026, su `data/perps.db`): 68 run, $8,00 spesi, media
$0,12/run — e **127 delle 137 proposte prodotte sono scadute senza decisione umana**
(1 approvata, 5 rifiutate). Composizione di una run tipica: ~66% scrittura in cache
(1,25×), ~32% token di output, input non cachato trascurabile.

**Why:** cadenza 30 min e TTL delle proposte 30 min si annullano a vicenda — ogni batch
viene rimpiazzato appena scade. Inoltre la cache è *ephemeral* (5 min), quindi **tra due
run non fa mai centro**: il prefisso system+tools viene riscritto a prezzo pieno ogni
volta, e il risparmio del prompt caching esiste solo dentro la singola run.

**How to apply:** prima di proporre di cambiare modello o di limare i prompt, guarda
quante proposte vengono davvero decise. La leva implementata è un gate di cadenza
adattiva (`AGENT_SKIP_IF_PENDING`): salta la run periodica se c'è già un arretrato non
consumato (−33% misurato). Per stimare risparmi su dati storici serve un **replay**, non
una somma: saltare una run cambia lo stato delle successive, e ignorarlo gonfiava la
stima da −33% a un irreale −59%. I numeri per run stanno in `audit` (`run.completed`);
`proposals.cost_usd` è la quota per singola proposta, non il costo della run.
Collegati: [[feedback-seam-di-test]].
