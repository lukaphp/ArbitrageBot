---
name: feedback-contratto-api-leggi-il-consumer
description: Quando implemento un contratto API su cui un altro agente sta già costruendo la UI, leggo il suo codice consumer prima di finalizzare le forme — e piego l'API alla forma documentata, non il contrario
metadata:
  type: feedback
---

Se sto implementando un contratto API concordato e qualcuno costruisce la UI **in parallelo**, prima
di considerare il backend finito vado a leggere il suo codice consumer (`public/*.js`) e verifico
campo per campo. Dove la mia forma è più ricca di quella documentata, **aggiungo una chiave nuova e
lascio quella documentata così com'è**, invece di cambiarla.

**Why:** in Sprint 4 (ANA-01) avevo esposto `closeReasons` come `{bucket: {trades,wins,losses,pnl}}`
e `mlHistory` come serie annidate, mentre la storia documentava `closeReasons:{tp,sl,manual,…}` e
Maya aveva già scritto il renderer su quella forma: il suo `Number(count)` su un oggetto dava `NaN` e
il breakdown mostrava "nessun trade" con i trade presenti. Due suite di test verdi, ognuna sul
proprio lato, e la UI reale rotta — nessun test lo vedeva perché lei usava le sue fixture. Trovato
solo leggendo `public/perps.js`. Stesso giro su `avgLoss`: io positivo ("perdita media"), lei
formattava col segno ⇒ una perdita renderizzata come guadagno.

**How to apply:** al momento di chiudere una storia con contratto condiviso, `grep` dell'endpoint nel
codice client e controllo di ogni campo che legge (nomi, tipo, **segno**, annidamento). Regola sui
segni: qualunque importo PnL esposto va **firmato** come `pnl`/`totalPnl` del resto del progetto —
mai "valore assoluto più il nome che spiega il segno"; se serve l'assoluto, è una chiave a parte
(`avgLossAbs`). Regola sulla ricchezza: contratto documentato invariato + chiave aggiuntiva
(`closeReasonDetail`). E scrivo nelle note di stato la forma **esatta** che ho implementato, con i
casi limite (ruoli possibili, `null` attesi, codici d'errore), perché è lì che l'altro va a leggere.
