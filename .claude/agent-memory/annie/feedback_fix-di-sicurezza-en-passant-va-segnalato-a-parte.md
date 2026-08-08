---
name: feedback-fix-di-sicurezza-en-passant-va-segnalato-a-parte
description: Un fix di sicurezza scoperto e applicato mentre si lavora su un task di copertura test va segnalato al PO come voce separata in review, non solo come criterio d'accettazione non soddisfatto tra tanti
metadata:
  type: feedback
---

In TEST-01 (Sprint 2) Bruno ha corretto un bug reale in `scripts/rotate-encryption-key.js` (query su
colonna inesistente, la rotazione delle chiavi agent non era mai stata eseguibile) mentre lavorava su
un task di sola copertura test. L'ha dichiarato esplicitamente marcando falso il criterio "nessuna
modifica al comportamento osservabile" invece di nasconderlo dentro il diff — comportamento corretto,
confermato dalla mia verifica indipendente ([[project-sandbox-blocca-nomi-variabili-segrete]] per come
l'ho verificata senza Edit/Write).

**Why:** il fix era necessario (senza di esso un altro criterio non era verificabile) e a basso
rischio (una riga, nome di colonna, coperto ora da test) — ma resta comunque una modifica a codice che
tocca la cifratura delle chiavi agent, decisa da chi stava scrivendo test, non da chi possiede quel
codice. Il criterio non soddisfatto da solo comunica "manca qualcosa", non comunica "qui c'è stata una
decisione di sicurezza presa fuori standard che merita occhi dedicati" — sono due cose diverse e la
seconda si perde se resta solo un checkbox falso in mezzo ad altri quattro veri.

**How to apply:** quando riscontri (in review o durante la tua stessa verifica) che un task non di
sicurezza ha prodotto un fix su codice security-sensitive (cifratura, auth, gestione chiavi, firma
transazioni), segnalalo al PO come voce **separata e esplicita** nel verdetto di review — non lasciare
che si confonda con la lista ordinaria dei criteri soddisfatti/non soddisfatti. Non significa bloccare
il merge: se il fix è piccolo, ben isolato e coperto da test (come qui), può restare nello stesso PR —
ma la decisione di accettarlo così va resa esplicita al PO, non presunta.
