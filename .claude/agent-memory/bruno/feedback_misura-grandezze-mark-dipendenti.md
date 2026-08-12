---
name: misura-grandezze-mark-dipendenti
description: Prima di dichiarare violata un'invariante fra due grandezze derivate dal mark price, rimisurala con richieste in parallelo — in sequenza la deriva del prezzo la fa sembrare falsa
metadata:
  type: feedback
---

Un'invariante fra due grandezze **derivate dal mark price** non si verifica con due
chiamate sequenziali: prima di dichiararla violata, rimisurala emettendo le
richieste **in parallelo** e su **più campioni**, e guarda se lo scarto oscilla
(rumore) o resta fisso (struttura).

**Why:** in CRIT-05 il gate della storia era "verifica che `spot.hold ==
totalMarginUsed` regga con due posizioni aperte; **se non regge, fermati**". Due
`curl` sequenziali davano uno scarto di `0.009054` — invariante violata, quindi
stop e documenta la discrepanza. Era falso: `marginUsed` è `positionValue /
leverage`, cioè funzione del **mark corrente**, quindi le due risposte
appartenevano a due istanti diversi e non erano confrontabili al centesimo. Con le
richieste emesse in parallelo lo scarto è `0.00000000` esatto su 6 campioni, mentre
i valori assoluti derivano fra un campione e l'altro (102.5523 → 102.5327 →
102.5356 → 102.5283): la deriva era tutta lì. Fermarsi avrebbe bloccato una storia
P0 corretta; procedere senza rimisurare avrebbe fondato un fix su un'identità mai
davvero verificata.

**How to apply:**

- Vale per qualsiasi confronto fra valori che dipendono dal prezzo: margine,
  `positionValue`, PnL non realizzato, equity, `withdrawable`. Non vale per
  quantità discrete (size, `szi`, oid), che non derivano dal mark.
- Ordine di grandezza come discriminante: uno scarto **relativo** dell'ordine di
  `1e-4` su valori a 6 decimali è deriva; un offset **stabile** su più campioni
  paralleli è struttura. Un artefatto di arrotondamento sarebbe ~`1e-6`.
- Se esiste un endpoint che restituisce le due grandezze in **una sola risposta**,
  usalo per il confronto atomico — ma verifica prima che i campi abbiano la stessa
  semantica dell'endpoint specifico (su Hyperliquid `webData2` **non** ce l'ha, vedi
  [[hyperliquid-unified-account-model]]).
- Meglio ancora: preferisci un fix la cui correttezza **non dipenda**
  dall'invariante. In CRIT-05 la formula calcola lo Spot libero come `total − hold`
  ed è giusta qualunque cosa `hold` includa; l'invariante serviva solo a misurare
  la magnitudine del difetto. Vedi [[equity-doppio-conteggio-spot]].
