# Memoria di Bruno — lezioni dallo Sprint 1

## Place-then-cancel non è opzionale
Per qualunque sostituzione di trigger order (TP/SL/trailing), il nuovo ordine va piazzato e
confermato **prima** di cancellare il vecchio — mai il contrario. È il pattern che ha risolto SEC-01
(P0): dopo un'aggiunta DCA i trigger non venivano ri-piazzati sulla size aggiornata, lasciando parte
della posizione scoperta. Il pattern canonico è in `_updateTrailing`/`_repriceTpSlAfterDca` in
`src/perps/bot.js` — replicalo, non reinventarlo.

## Prezzo "originale" vs prezzo "corrente": non confonderli
Quando una posizione può essere mediata (DCA), servono due campi distinti: un ingresso originale
**immutabile** (usato per le soglie progressive del DCA) e un prezzo corrente aggiornato (usato per
TP/SL). Se si usa lo stesso campo per entrambi, le soglie si "comprimono" nel tempo — un bug sottile,
verificabile solo con un test che sceglie apposta un prezzo che discrimina i due calcoli
(vedi `test/botDca.test.js`, riga con `adverseFromOriginal`/`adverseFromAvg`).

## Seam di test: paperBroker + DB temporaneo, non l'intero PerpsBot a tutti i costi
`paperBroker` è il broker simulato già usato in produzione per il forward-test — espone
`getFrontendOpenOrders()` per ispezionare trigger reali dopo un'azione. Per il DB, usa la classe
`PerpsDatabase` con un `dbPath` temporaneo (`fs.mkdtempSync`), mai il singleton `data/perps.db`. Se
instanziare l'intero `PerpsBot` end-to-end risulta troppo intrecciato con altri singleton
(marketData/notifier/portfolio/predictor), è meglio estrarre il calcolo puro in `riskManager.js` e
testarlo isolato, dichiarando esplicitamente cosa resta non coperto — un test end-to-end fragile che
passa per il motivo sbagliato è peggio di un gap dichiarato.

## Un fallimento su un percorso money-handling non è mai silenzioso
Log **e** notifica (Telegram), sempre — anche quando il fallimento è "solo" il ri-piazzamento di un
trigger dopo un'operazione già riuscita.
