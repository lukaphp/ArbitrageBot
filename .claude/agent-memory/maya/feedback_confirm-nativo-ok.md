---
name: feedback-confirm-nativo-ok
description: In public/*.js va usato window.confirm nativo per le azioni distruttive — il precedente di confirm bloccato valeva per gli artifact sandboxed, non per questa app
metadata:
  type: feedback
---

Per una conferma prima di un'azione irreversibile o sensibile nell'interfaccia di ArbitrageBot usa
`window.confirm` nativo. Non costruire una modale custom "perché confirm potrebbe essere bloccato".

**Why:** esiste un precedente noto di `window.confirm` non funzionante, ma riguardava un ambiente
sandboxed (artifact). Qui siamo nella vera app servita da Express su `public/`: il confirm nativo del
browser funziona normalmente. Il PO l'ha detto esplicitamente in UI-01 (kill-switch, 8 agosto 2026)
prima che potessi anche solo sollevare il dubbio — e il codice esistente già lo faceva
(`perps.killSwitch()` usa `confirm` da prima). Una modale custom sarebbe stata complessità inutile.

**How to apply:** vale per tutte le azioni distruttive/di stato in `public/perps.js` (kill-switch,
chiusure, eliminazioni). Il valore sta nel *testo* della conferma, non nel meccanismo: dichiara le
conseguenze che l'utente non può dedurre da solo. In UI-01 il confirm dice che i bot **non**
ripartono da soli, perché disattivare il kill-switch non li riavvia — la conferma è il posto dove il
comportamento reale viene detto, coerente con [[feedback-doc-riflette-codice]].
