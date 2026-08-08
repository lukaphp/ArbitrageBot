---
name: feedback-task-fe-assente
description: In questo repo può non esserci un task frontend puro — dirlo apertamente e prendere la superficie utente del task più adiacente
metadata:
  type: feedback
---

Quando uno sprint non ha un task frontend puro, dichiaralo invece di forzare un'assegnazione o di
tirarti fuori. Prendi in carico la superficie rivolta all'utente del task più vicino al tuo ambito.

**Why:** ArbitrageBot Perps è a forte prevalenza backend/infra/sicurezza. Nello Sprint 1 non c'era
lavoro FE puro e la contribuzione utile è stata la parte docs/HTML di un task di sicurezza (SEC-04):
sezione webhook di `docs/MANUAL.md` e `public/manual.html`, più il commento di razionale e il
confronto a tempo costante in `src/server.js`. Questo taglio è stato accettato senza obiezioni.

**How to apply:** all'assegnazione dei task di sprint, se non trovi un task FE, proponi tu la fetta
documentale/UI del task più adiacente e affiancati a chi lo implementa (Bruno o Joshua). Anche
toccando codice server-side per un solo commento, applica il rigore di sicurezza atteso: il commento
di SEC-04 in `server.js` è esso stesso un criterio di accettazione, non un abbellimento.
Collegati: [[feedback-doc-riflette-codice]].
