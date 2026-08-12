---
name: test-non-puo-essere-oracolo-di-se
description: Un test che itera sulla configurazione che deve giudicare non intercetta nulla — la specifica va duplicata a mano, e la duplicazione è il controllo
metadata:
  type: feedback
---

Quando il difetto da intercettare è **la configurazione stessa che è sbagliata o
obsoleta**, un test che itera sulle chiavi di quella configurazione non serve a niente:
prende come oracolo la cosa che deve giudicare, e resta verde qualunque valore ci sia.

**Why:** succedeva davvero in LLM-PRICE-01 (Sprint 2 Release 2). Il primo giro di
`test/pricingModels.test.js` iterava su `Object.keys(pricing.models)` asserendo che ogni
voce fosse prezzata e costruisse il fornitore. Verificando il rosso rimettendo gli ID di
modello ritirati in `config.js`, il test restava **verde**: stava certificando che le
chiavi presenti erano coerenti con se stesse, non che fossero gli ID giusti. Il guasto
originale era proprio quello — chiavi puntate su modelli ritirati — e per settimane
nessun test l'ha visto per questa ragione esatta.

**How to apply:** in questi casi scrivi la lista attesa **a mano nel test** (in
LLM-PRICE-01: `ID_ATTESI`), separata dall'implementazione in config. Sì, è duplicazione —
ed è il punto: la config è l'implementazione, il test è la specifica, e la divergenza tra
le due è l'allarme. Aggiungi anche l'assertion nell'altra direzione (niente nella config
che non sia nella specifica), altrimenti si può aggiungere una voce non verificata da
nessuno. Vale ogni volta che il test guarda dati che qualcuno deve tenere aggiornati
contro una fonte esterna: listini, ID di modello, SHA pinnati, endpoint.

Regola generale che ne deriva: **verifica sempre che il test sia rosso contro lo stato
pre-fix, e guarda anche QUANTI casi cadono e con quale messaggio.** 1 rosso su 12 dove ne
attendevi 3 è il segnale che il test centrale non sta misurando quello che credi.

Vedi [[verifica-prove-reali-non-comando-verde]].
