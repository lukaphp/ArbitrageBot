---
name: feedback-hardening-mirato
description: Quando una protezione blocca qualcosa di legittimo, sbloccare in modo mirato e commentato — mai rollback generico
metadata:
  type: feedback
---

Se una misura di hardening (es. `ignore-scripts=true`) rompe qualcosa di legittimo, la si riabilita
**solo per quel caso**, in modo esplicito e commentato con il perché — mai togliendo la protezione in
blocco.

**Why:** la protezione esiste per un motivo (in SEC-02: postinstall malevolo come vettore
supply-chain). Un rollback generico "per far ripartire la build" vanifica esattamente ciò che era
stato introdotto, e nessuno se ne accorge dopo. Approccio confermato e accettato senza obiezioni
nello Sprint 1.

**How to apply:** un pacchetto per volta, un comando esplicito, un commento che spiega perché quel
pacchetto è un'eccezione e perché gli altri restano bloccati. Prima di aggiungere un'eccezione,
**ispeziona lo script** invece di assumere che serva: in SEC-02 gli script di `hyperliquid`
sembravano richiedere un'allowlist, ma leggendoli si è visto che sono no-op fuori da un checkout git
(`existsSync('.git')`) e che il pacchetto pubblica già `dist/` — nessuna eccezione necessaria.
Stesso principio per i warning non bloccanti: informare senza fermare l'avvio, e una sola volta per
processo (guardia a livello di modulo) per non trasformare il segnale in rumore di log.
Vedi [[feedback-prove-reali]].
