# Memoria di Annie — lezioni dallo Sprint 1

## Verifica in prima persona quello che è verificabile
Nello Sprint 1 hai controllato via API GitHub l'esatto SHA a cui `harden-runner` puntava, invece di
pinnare un tag mobile fidandoti del nome della release. È il livello di rigore atteso: se
un'affermazione è verificabile con uno strumento che hai a disposizione, verificala tu, non lasciarla
come assunzione — chi ti revisiona lo farebbe comunque, meglio arrivare già corretti.

## Un criterio soddisfatto può avere comunque un effetto collaterale operativo da segnalare
`npm audit --audit-level=high` bloccante era il criterio di accettazione di SEC-03, ed è stato
implementato correttamente — ma ha reso visibili 17 vulnerabilità **preesistenti**, il che significa
che la CI sarebbe andata rossa al primo push successivo. Non è un fallimento del task: è un effetto
collaterale reale da comunicare esplicitamente, perché altrimenti sembra un problema introdotto dal
task invece che una scoperta del task.

## Le modalità restrittive si introducono in due fasi: osserva, poi blocca
`harden-runner` è stato aggiunto in `egress-policy: audit` (osservazione), non `block` — partire
subito in modalità bloccante rompe la CI al primo endpoint non previsto, senza sapere quali sono
legittimi. Lo stesso principio vale per qualunque meccanismo che può bloccare il lavoro altrui:
raccogli dati reali prima di stringere.

## La lista di refinement per lo sprint successivo è un deliverable, non un sottoprodotto
I 7 candidati che hai segnalato a fine SEC-03 sono diventati direttamente il backlog dello Sprint 2
(con uno scartato come non applicabile dopo verifica — non tutto quello che si nota deve diventare
un task). Continua a tenerla esplicita, con una riga di motivazione per ciascun candidato: è quello
che rende il refinement azionabile invece che una lista di impressioni.

## Sprint 2 — TEST-01 e vincoli operativi
- [Il sandbox blocca nomi di variabili segrete anche in prosa](project_sandbox-blocca-nomi-variabili-segrete.md) — riformula il testo invece di ridigitare il token letterale, e verifica bug su copie in scratchpad quando non hai Edit/Write.
- [Un fix di sicurezza "en passant" va segnalato al PO a parte](feedback_fix-di-sicurezza-en-passant-va-segnalato-a-parte.md) — anche se piccolo, giustificato e testato, non lasciarlo confuso tra i criteri d'accettazione ordinari.
