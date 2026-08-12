---
name: feedback-verifica-dod-frontend
description: Routine di verifica della DoD frontend — node --check, check dei tag e degli id duplicati, harness node:vm (e il tranello di deepStrictEqual), integrità degli anchor di MANUAL.md/manual.html
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
5. Nel check dei tag conta anche gli **id duplicati**: due `id=` uguali rompono `getElementById` in
   silenzio, e `index.html` ne ha ormai oltre 220. Costa una riga nello stesso script.
6. `deepStrictEqual` su oggetti creati **dentro** il contesto `node:vm` fallisce sempre ("same
   structure but not reference-equal"): il contesto ha i suoi intrinsics, quindi il prototype non
   coincide. Riporta i dati nel realm del test con `Array.from(x, p => ({...}))` prima dell'assert.
7. Se tocchi la numerazione di `docs/MANUAL.md`, non farlo a mano: ha ~19 anchor `](#n-titolo)` più
   una dozzina di riferimenti `§N` nel testo (e un `§5` che punta a **DEPLOY.md** e non va toccato).
   Script per la rinumerazione + due check: ogni anchor deve risolvere a un titolo esistente (slug
   alla GitHub: minuscole, via la punteggiatura, **ogni** spazio diventa un trattino — `—` e `&`
   spariscono e lasciano un doppio trattino) e ogni `§N` deve corrispondere a una sezione esistente.
   Per `manual.html` il check equivalente è: ogni voce di nav ha la sua `<section class="doc-section">`
   e viceversa. **Aggiungi un terzo check, che è quello che vale davvero** (imparato in DEBT-05):
   confronta i **corpi** delle sezioni prima/dopo, normalizzando solo numerazione e riferimenti `§`.
   È l'unico modo di dimostrare "nessun contenuto perso o duplicato" invece di affermarlo — e produce
   una riga di evidenza da mettere nel report. Non ricordarti a mano le sottosezioni: `### 15.1`
   diventa `### 16.1` e nessun anchor lo segnala se sbagli.
8. **La ricchezza dell'harness `node:vm` va scelta in base a cosa il test deve provare, e a volte
   serve un file nuovo invece di aggiornare quello condiviso.** Gli stub minimali degli altri test non
   bastano per il focus da tastiera: un focus trap si può verificare solo se il finto DOM sa dire
   *chi ha il focus* (`document.activeElement`, aggiornato da `focus()`), *cosa c'è dentro un nodo in
   ordine di documento* (`querySelectorAll`) e *se un nodo è dentro un altro* (`contains`, per il
   click fuori). Con gli stub di `advisorDrawerUi.test.js` i casi sul trap passerebbero senza provare
   niente. In DEBT-06 ho scritto `test/advisorFocusTrapUi.test.js` con il suo harness più ricco invece
   di gonfiare quello esistente: file separato, nessun rischio di rompere 16 casi altrui.
   Nell'harness metti anche un **controllo finto "dietro" il pannello** e asserisci che il focus non
   ci finisca mai: senza quello stai verificando dove il focus va, non da cosa lo stai proteggendo.
9. **Fai dichiarare al test le precondizioni sullo stato dei controlli, non presumerle.** Due miei
   casi in DEBT-06 partivano da elementi che il render aveva già `disabled` (il menu delle sessioni
   senza conversazioni, tutto il composer a consulente spento): passavano/fallivano per il motivo
   sbagliato. Un `assert.equal(el.disabled, true, 'precondizione: …')` in testa al caso costa una riga
   e trasforma un test fragile in uno che spiega perché.
