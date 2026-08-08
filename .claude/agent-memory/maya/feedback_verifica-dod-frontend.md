---
name: feedback-verifica-dod-frontend
description: npm run lint NON copre public/ — per la DoD frontend servono node --check sui file browser, un check dei tag che ignori gli attributi, e un harness node:vm per perps.js
metadata:
  type: feedback
---

La DoD dice "`npm test` verde, `npm run lint` verde, HTML valido". Per i file *miei* questi tre
controlli non bastano da soli: `scripts/lint-syntax.js` ha `roots = ['src','test','scripts']`, quindi
`public/*.js` non viene mai passato a `node --check`. Un lint verde non dice nulla su `perps.js`.

**Why:** scoperto in UI-01 (8 agosto 2026). Tutto il mio perimetro JS è fuori dal lint del progetto:
un errore di sintassi in `perps.js` passerebbe la CI e romperebbe l'interfaccia in silenzio.
Segnalato come candidato di refinement (aggiungere `'public'` ai roots è una riga), non corretto di
nascosto — vedi [[feedback-segnalare-fuori-perimetro]].

**How to apply:** routine di verifica prima di dichiarare chiuso un task frontend:
1. `node --check public/<file>.js` a mano su ogni file browser toccato (perps.js passa).
2. Bilanciamento tag: un parser naive su `index.html`/`manual.html` riporta **3 mismatch falsi**
   (`</svg>`, `</head>`, `</html>`) perché il favicon inline è un data-URI che contiene un `<svg>`
   dentro un attributo. Prima di contare i tag, rimuovi il contenuto degli attributi: allora entrambi
   i file risultano bilanciati. Non inseguire quei 3 errori, non esistono.
3. Test su `public/*.js`: `perps.js` è uno script di browser senza export. Il pattern che funziona è
   caricarlo in `node:vm` con un DOM finto minimale (`getElementById` + `classList`) e stub di
   `fetch`/`confirm`/`app.showToast` — zero dipendenze aggiunte, nessun headless browser (in questo
   repo non c'è, e introdurre jsdom sarebbe una modifica di lockfile da far revisionare riga per
   riga). Esempio funzionante: `test/killSwitchUi.test.js`. Copre la logica della classe, **non** il
   rendering: le classi CSS restano da verificare a mano, e va detto nel report.
