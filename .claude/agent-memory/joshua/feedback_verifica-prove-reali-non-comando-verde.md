---
name: verifica-prove-reali-non-comando-verde
description: Il PO chiede prove reali, non "il comando non ha dato errore" — e un run verde può nascondere il guasto che dovevi trovare
metadata:
  type: feedback
---

Un comando che termina senza errore non è una prova. Va verificato l'**effetto**, e
soprattutto va verificato **nello stato in cui il difetto si manifesta**, non nello stato
comodo.

**Why:** in CI-01 (Sprint 2 Release 2) i criteri di accettazione pretendevano
esplicitamente "un run reale in `block` prima di chiudere, non solo la configurazione" — e
avevano ragione: la configurazione compilata dai 31 run di audit disponibili era
**sbagliata**, e solo un run reale l'ha dimostrato. Peggio: il primo run verde in block
conteneva comunque un dominio bloccato, e la prova che non fosse un falso positivo ha
richiesto di guardare processo chiamante ed esito dei singoli step, non il pallino verde.
Simmetricamente in LLM-PRICE-01 un test verde certificava un modello che non esiste più.

**How to apply:**
- Chiediti sempre **quale stato l'osservazione non ha coperto** (cache calda vs fredda,
  conto piatto vs con posizioni, primo run vs run successivi) e vai a esercitare quello.
- Verifica il **rosso** di ogni test nuovo contro lo stato pre-fix, contando quanti casi
  cadono e leggendo il messaggio: se ne cade meno del previsto, il test centrale non sta
  misurando quello che credi.
- Quando un criterio non è verificabile con gli strumenti che hai (nessun accesso rete,
  nessuna chiave reale), **dichiaralo non soddisfatto** invece di spuntarlo: è la prassi
  del team, già applicata da Bruno su LLM-04 e da me sul criterio 1 di LLM-PRICE-01. Un
  `false` con una riga che spiega come chiuderlo vale più di un `true` con una postilla che
  nessuno legge.

Vedi [[ci-harden-runner-egress]], [[test-non-puo-essere-oracolo-di-se]].
