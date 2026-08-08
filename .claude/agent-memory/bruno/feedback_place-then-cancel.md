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

**How to apply:** le implementazioni canoniche sono `_updateTrailing`/`_repriceTpSlAfterDca` in
`src/perps/bot.js` — replicale, non reinventarle. Se il ri-piazzamento fallisce a metà, i vecchi
trigger restano intatti (protezione parziale meglio di nessuna) e il fallimento va loggato **e**
notificato: vedi [[feedback-fallimenti-money-path-non-silenziosi]]. Un test onesto verifica sul book
che ci sia **un solo** trigger attivo dopo la sostituzione (nessun doppione, nessun buco): vedi
[[feedback-seam-di-test]].
