---
name: feedback-place-then-cancel
description: Ogni sostituzione di trigger order (TP/SL/trailing) piazza il nuovo PRIMA di cancellare il vecchio — pattern che ha risolto SEC-01
metadata:
  type: feedback
---

Per qualunque sostituzione di trigger order (TP/SL/trailing), il nuovo ordine va piazzato e
confermato — e lo stato in memoria/DB aggiornato — **prima** di cancellare il vecchio. Mai il
contrario.

**Why:** è il pattern che ha risolto SEC-01 (P0): dopo un'aggiunta DCA i trigger non venivano
ri-piazzati sulla size aggiornata, lasciando parte della posizione scoperta. Cancellare prima di
piazzare apre una finestra — anche di un solo istante — in cui la posizione è nuda: su un perpetuo con
leva quella finestra è denaro.

**How to apply:** le implementazioni canoniche sono il blocco trailing dentro `_manageOpen` e
`_replaceTpSl` in `src/perps/bot.js` — replicale, non reinventarle. (`_replaceTpSl` è
l'ex `_repriceTpSlAfterDca`, generalizzato in SEC-08 perché serve anche all'adozione di una
posizione non tracciata; `_updateTrailing` come metodo separato non esiste più. La skill
`arbitragebot-conventions` cita ancora i nomi vecchi.) Se l'oid del vecchio trigger non è
noto — perché non l'abbiamo piazzato noi — va **cercato sul book**, non dato per assente:
è così che nasce un ordine orfano. Se il ri-piazzamento fallisce a metà, i vecchi
trigger restano intatti (protezione parziale meglio di nessuna) e il fallimento va loggato **e**
notificato: vedi [[feedback-fallimenti-money-path-non-silenziosi]]. Un test onesto verifica sul book
che ci sia **un solo** trigger attivo dopo la sostituzione (nessun doppione, nessun buco): vedi
[[feedback-seam-di-test]].
