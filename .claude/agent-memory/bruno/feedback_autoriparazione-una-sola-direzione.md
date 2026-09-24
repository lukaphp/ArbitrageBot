---
name: feedback-autoriparazione-una-sola-direzione
description: Un meccanismo che ripara da solo lo stato dei bot agisce in UNA direzione — riavvia ciò che l'operatore vuole acceso, non spegne né riaccende ciò che ha deciso di fermare
metadata:
  type: feedback
---

Qualunque meccanismo di **auto-riparazione** (riavvio, chiusura, riallineamento) deve avere una
direzione dichiarata e una sola, e quella direzione non scavalca mai una decisione esplicita
dell'operatore.

**Why:** deciso col PO in `SYNC-RESTART-01` (reconciliation watcher, 2026-09-24). Il caso limite non
è teorico: un bot `stopped` a DB **con una posizione aperta** è esattamente la situazione di chi ha
fermato il bot apposta per gestire l'uscita a mano. Un watcher "intelligente" che notasse la
posizione scoperta e riaccendesse il bot piazzerebbe trigger che nessuno ha chiesto su denaro vero,
e lo farebbe a un operatore che sta guardando un'altra schermata. Il DB è la fonte di verità
sull'**intento**, la memoria lo è sul **fatto**: si ripara solo la divergenza fatto≠intento, mai
l'intento.

**How to apply:**
- Filtra sull'intento all'inizio del giro (`rows.filter(r => r.status === 'running')`), non dentro i
  rami: una sola riga da mutare per verificare che i test di sicurezza diventino rossi.
- Scrivi il test che dimostra la **non azione** (nessuna chiamata a `start()`, nessun tick, nessun
  cambio di riga) e verificalo per mutazione allargando il filtro. Un test che non fa niente passa
  anche quando il codice non esiste: senza la mutazione non prova nulla.
- Il verso opposto ha già un proprietario (`reconciler.js` chiude in DB le posizioni orfane di bot
  fermi): se serve, si estende quello, non si aggiunge una seconda direzione al watcher.
- Se la riparazione fallisce, non ripiegare su una sequenza che **scrive** lo stato intermedio:
  `stop()` + `start()` per rimettere in moto un'istanza bloccata passa da `status='stopped'` sul DB,
  e uno start fallito lì ribalta l'intento in silenzio — con l'aggravante che il watcher, da quel
  momento, quel bot non lo guarda più.

Collegati: [[feedback-running-non-significa-operativo]] (come si distingue il fatto dall'etichetta),
[[feedback-fallimenti-money-path-non-silenziosi]] (una notifica per episodio, il tentativo invece si
ripete), [[feedback-purezza-funzioni-che-sembrano-query]].
