---
name: feedback-budget-di-chiamate-e-aritmetica
description: Un limite di rate si verifica facendo l'aritmetica domanda/offerta, non guardando i log — e la risposta quasi mai è alzare il budget
metadata:
  type: feedback
---

Quando i timeout sembrano un problema di capacità, **misura il secchiello e fai la divisione** prima
di cercare colpe esterne. Refill diviso peso della chiamata = chiamate al secondo sostenibili; poi
conta quante ne servono davvero (bot × chiamate per tick ÷ intervallo). Se la domanda supera
l'offerta, il guasto è aritmetica, non sfortuna, e non serve un istogramma dei log per saperlo.

**Why:** 24/09/2026. Secchiello dell'SDK Hyperliquid **ispezionato su un'istanza viva** (non dedotto
dai docs): `{capacity: 100, refillRate: 10}`, `getFrontendOpenOrders`/`getUserFills` = 20 token → 0,5
letture/s sostenibili. Domanda reale: 6 bot × 2 letture / 10s = **24 token/s contro 10**. Bastavano 3
bot con posizione aperta per sfondare — ed è esattamente la soglia attraversata quando il fix del
sizing ha fatto smettere alla flotta di stare in `hold`.

**How to apply:**
- **Alzare il budget è quasi sempre la risposta sbagliata.** Il limitatore client-side approssima
  quello vero del fornitore: qui i due secchielli (normale + pesante) sommavano già i ~20 token/s del
  limite REST reale per IP, alzarlo avrebbe solo trasformato timeout locali in 429 veri. Si riduce
  la domanda.
- **Cerca le chiamate che sono per WALLET e non per mercato** (`getFrontendOpenOrders(master)`,
  `getUserFills(master)`): N bot dello stesso account chiedono N volte la stessa identica risposta.
  Unire le richieste **in volo** (non una cache a TTL) le collassa a una, senza introdurre staleness
  — cosa che su un percorso che decide se una posizione è protetta conta più dell'efficienza. Ed è
  tanto più efficace quanto più il sistema soffre: si comporta da stabilizzatore.
- **Cerca l'amplificazione da retry.** Un tentativo andato in timeout *continua a girare e spende
  comunque i suoi token* (`withTimeout` non può annullarlo): con un retry, una lettura fallita ne
  costa il doppio, proprio quando il secchiello è vuoto. È il feedback positivo che trasforma un
  degrado in un **burst**, e spiega la forma del grafico meglio di qualunque ipotesi esterna.
- **Discriminante interno vs fornitore, in un colpo:** se falliscono *solo* le chiamate di peso alto
  che condividono un secchiello, mentre quelle di peso 2 fatte nello stesso tick non compaiono fra i
  timeout, è nostro. Un rallentamento del fornitore colpirebbe anche quelle.
- Cerca anche il **ciclo che si auto-alimenta**: qui timeout → chiusura → `getRealizedPnl` →
  `getUserFills` (altri 20 token) → riapertura. Una diagnosi di capacità non è finita finché non hai
  guardato cosa fa il *rimedio* al carico.
Collegati: [[project-hyperliquid-ratelimit-peso20]], [[feedback-non-so-non-e-non-ce]].
