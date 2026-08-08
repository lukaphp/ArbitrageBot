---
name: feedback-stato-posizione-immutabile-vs-corrente
description: Prezzo d'ingresso originale (immutabile, per le soglie DCA) e prezzo corrente (per TP/SL) sono due campi distinti — e lo stato che vive in trailing_json va in merge, mai in overwrite
metadata:
  type: feedback
---

Quando una posizione può essere mediata (DCA) servono **due** campi distinti: un ingresso originale
**immutabile** (riferimento per le soglie progressive del DCA) e un prezzo corrente aggiornato (per
TP/SL). Usare lo stesso campo per entrambi fa "comprimere" le soglie nel tempo.

**Why:** bug sottile, invisibile a runtime. Verificabile solo con un test che sceglie apposta un
prezzo che discrimina i due calcoli (vedi `adverseFromOriginal`/`adverseFromAvg` in
`test/botDca.test.js`). Un secondo giro dello stesso problema è emerso in TRAIL-01: quello stato vive
dentro il blob `trailing_json`, e tre punti di `bot.js` lo sovrascrivevano col solo `{ slOid }` —
corretto in memoria, distrutto **dopo un riavvio**, con il risultato che il bot poteva eseguire più
step di DCA di quanti configurati (capitale non previsto impegnato su una posizione già in perdita).

**How to apply:** ogni scrittura su un campo che è un *blob di stato condiviso* va fatta in **merge**
col contenuto persistito (preservando anche le chiavi che non conosci), con lo stato in memoria come
fonte di verità. In `bot.js` c'è un solo punto autorizzato a serializzarlo, `_trailingJson()`: se
aggiungi una scrittura, passa da lì. La classe di bug non si manifesta finché non si simula un
riavvio, quindi il test deve **istanziare un nuovo `PerpsBot` sullo stesso DB** — non basta asserire
lo stato in memoria. E l'assert che conta non è il campo, è la conseguenza: nessun DCA extra dopo il
riavvio. Collegati: [[feedback-seam-di-test]].
