---
name: feedback-verifica-dod-frontend
description: Routine di verifica della DoD frontend — node --check, check dei tag che ignora gli attributi, harness node:vm per gli script di public/; da Sprint 3 npm run lint copre anche public/
metadata:
  type: feedback
---

La DoD dice "`npm test` verde, `npm run lint` verde, HTML valido". Per i file *miei* servono
comunque due controlli che nessuno dei tre fa: il bilanciamento dei tag e un test vero sugli script
di browser.

**Why:** in UI-01 (8 agosto 2026) scoprii che `scripts/lint-syntax.js` aveva
`roots = ['src','test','scripts']`: tutto `public/*.js` era fuori dal lint, quindi un errore di
sintassi in `perps.js` passava la CI e rompeva l'interfaccia in silenzio. L'ho segnalato come
candidato di refinement invece di correggerlo di nascosto (vedi
[[feedback-segnalare-fuori-perimetro]]); è diventato **LINT-01 dello Sprint 3**, chiuso da Joshua, e
oggi `roots` include `'public'`. Il canale ha funzionato di nuovo — ma verifica il valore di `roots`
prima di fidarti: è una riga che qualcuno può cambiare.

**How to apply:** routine prima di dichiarare chiuso un task frontend:
1. `npm run lint` ora copre `public/` (verificato Sprint 3: 72 file). Se `roots` fosse tornato
   indietro, `node --check public/<file>.js` a mano su ogni file toccato.
2. Bilanciamento tag: un parser naive su `index.html`/`manual.html` riporta **3 mismatch falsi**
   (`</svg>`, `</head>`, `</html>`) perché il favicon inline è un data-URI che contiene un `<svg>`
   dentro un attributo. Prima di contare i tag rimuovi il contenuto degli attributi **e i commenti**
   (i commenti citano spesso markup vecchio di proposito): allora entrambi i file risultano
   bilanciati. Non inseguire quei 3 errori, non esistono.
3. Test su `public/*.js`: sono script di browser senza export. Il pattern che funziona è caricarli in
   `node:vm` con un DOM finto minimale e stub delle API del browser che servono — zero dipendenze
   aggiunte, nessun headless browser (in questo repo non c'è, e introdurre jsdom sarebbe una modifica
   di lockfile da far revisionare riga per riga). Esempi funzionanti, in ordine di completezza
   dell'harness: `test/killSwitchUi.test.js` (`getElementById` + `classList`),
   `test/networkBrandingUi.test.js` (aggiunge `document.title`),
   `test/strategyExportImportUi.test.js` (aggiunge `createElement`, `Blob`, `URL.createObjectURL`,
   `input.files` con `file.text()`), `test/walletPerpsUi.test.js` (aggiunge `window.ethereum` con
   `request()` per metodo, `dataset`, `addEventListener`/`click` per provare i listener veri).
   Coprono la logica della classe, **non** il rendering: le classi CSS e la corrispondenza degli id
   con l'HTML restano da verificare a mano (o con un'assert sul markup letto da file), e va detto nel
   report.
4. Un'assert `regex` sul markup di `index.html` è il modo economico di bloccare una regressione di
   *contenuto* (una stringa che afferma il falso, uno script legacy ricomparso). Attenzione a togliere
   prima i commenti HTML: i miei commenti citano di proposito le stringhe rimosse.
