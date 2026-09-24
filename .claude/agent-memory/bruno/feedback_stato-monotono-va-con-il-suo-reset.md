---
name: feedback-stato-monotono-va-con-il-suo-reset
description: Uno stato persistito "monotono per disegno" (max che non scende mai) ha bisogno di un modo esplicito per correggerlo; e un massimo stantio non resta fermo — se il picco è parte dello stato, il numero CRESCE
metadata:
  type: feedback
---

Quando un valore persistito è **monotono per disegno** (un massimo che non deve scendere), la logica di
merge è quasi sempre giusta: serve a non perdere un massimo vero quando esce dalla finestra di dati
esposta. Il difetto non è la monotonia, è che **manca il contrappeso**: nessun modo di correggere il
valore quando si scopre che i dati su cui è stato calcolato erano sbagliati.

**Why:** `risk_drawdown_state` + `mergeDrawdownState` (residuo di CRIT-05, chiuso il 17/09/2026). Dopo
un fix che aveva corretto lo storico equity, il drawdown massimo calcolato *prima* della correzione
restava il massimo per sempre. E misurandolo è venuto fuori che la segnalazione sottostimava: il
valore non resta incollato, **cresce**. Il merge tiene anche il `peak` massimo fra curva e persistito,
poi calcola `current = peak − equitàCorrente`: un picco fantasma combinato con un'equity ormai
corretta *fabbrica* un drawdown "in corso" più grande del valore vecchio, e lo promuove a nuovo
massimo. Curva vera 0.5%, valore persistito 30%, valore riportato 49.75% — e riscritto a ogni tick.

**How to apply:**
- Prima di accettare «basta una correzione dati una tantum», **verifica dove vive davvero il numero**.
  Se il valore mostrato viene da `max(calcolatoOra, persistito)`, ripulire la tabella sorgente è un
  **no-op**: il primo giro rilegge il persistito e lo riscrive identico. Metà correzione non si
  distingue da nessuna correzione, ma sembra fatta.
- Misura il **secondo ordine di conseguenza**, non solo il numero sbagliato: qui un drawdown fantasma
  faceva scattare `drawdown-critical` e portava la board a `blocked` per sempre. Un critico permanente
  è peggio di un numero sbagliato — insegna a ignorare i critici. Ed è lo stesso valore che finisce
  nel contesto del consulente AI (`get_risk_snapshot`, `get_equity_history`).
- La correzione va **ricalcolata e riscritta**, non solo cancellata: la riga viene riseminata
  dall'upsert al primo tick successivo, quindi tanto vale scriverci dentro il valore vero.
- Il ricalcolo **rifiuta** invece di scrivere zeri quando la curva non è utilizzabile: azzerare un
  massimo che non si sa ricostruire è una bugia diversa, non una correzione. Attenzione al filtro dei
  campioni — `Number(null)` vale **0** ed è finito, quindi una curva di soli `null` passa il controllo
  ovvio (stessa trappola già documentata in `deriveExecutionStatus`).
- Scrivi nel codice il caso in cui lo strumento **non** va usato: se lo storico è stato *potato* dalla
  ritenzione anziché corretto, il persistito è l'unica memoria di un drawdown vero e ricalcolare lo
  cancella. Vedi [[feedback-dati-con-tempi-di-vita-diversi]].
- Preferisci uno script CLI con **dry-run di default** all'SQL grezzo sul container
  ([[project-hotpatch-vps-20260914]]): è ripetibile, testabile a processo figlio
  ([[feedback-seam-di-test]]) e non si esegue per sbaglio.
