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

**Corollario opposto e altrettanto insidioso: uno scarto di ZERO è un sintomo, non
una conferma.** Il 2026-09-15, indagando su stop loss che scattavano entro 10s
dall'ingresso, ho campionato 12 volte in 24s il prezzo di 3 coin da un endpoint
dell'app: identico all'ultimo decimale, escursione `0.00%`. Sembrava la prova che il
prezzo fosse fermo; era la prova che stavo misurando una **cache**. Quei valori non
corrispondevano a *nessuna* delle due reti (né al mid mainnet né a quello testnet,
entrambi letti in parallelo dagli endpoint `info` pubblici): erano solo vecchi.
Un prezzo di mercato vivo non è mai identico a 12 campioni consecutivi — se lo è,
la domanda giusta è «da dove viene questo numero?», non «perché il mercato è fermo?».
Discriminante decisivo: confrontare col **mid pubblico delle due reti nello stesso
istante**, e verificare quale prezzo usa davvero il codice sotto esame (per un bot è
`lastEval.price`, non l'endpoint che leggerebbe la UI — vedi
[[feedback-running-non-significa-operativo]] sulla differenza fra stato dichiarato e
stato osservato).
