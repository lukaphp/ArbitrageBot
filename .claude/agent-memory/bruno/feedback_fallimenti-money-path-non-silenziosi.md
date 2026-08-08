---
name: feedback-fallimenti-money-path-non-silenziosi
description: Su un percorso che maneggia denaro (o che sostituisce protezioni) il fallimento è loggato E notificato via Telegram — mai un catch vuoto
metadata:
  type: feedback
---

Un fallimento su un percorso money-handling non è mai silenzioso: log **e** notifica Telegram
(`notifier.notify`), sempre — anche quando il fallimento è "solo" il ri-piazzamento di un trigger dopo
un'operazione già riuscita.

**Why:** un `catch` vuoto su questi percorsi non produce un crash, produce una posizione scoperta o
capitale impegnato senza che nessuno se ne accorga. È la stessa classe di problema di WS-01: il
fallback REST copriva un WebSocket morto e il sistema è restato degradato per ~28 ore senza una riga
nei log.

**How to apply:** vale per il ri-piazzamento dei trigger, per la validazione degli input di sizing
(guard di `sizePosition`), e per qualunque guardiano periodico — se il guardiano stesso fallisce, deve
dirlo. Corollario sulle notifiche: **una per episodio, non una per tentativo**, con una soglia di
downtime davanti; altrimenti Telegram diventa rumore e viene ignorato proprio quando conta. E il
timer di un guardiano va ripulito in `stop()` come si fa con `pollTimer`.
Collegati: [[feedback-place-then-cancel]].
