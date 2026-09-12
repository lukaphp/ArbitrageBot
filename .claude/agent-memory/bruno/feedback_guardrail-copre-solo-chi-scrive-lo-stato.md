---
name: feedback-guardrail-copre-solo-chi-scrive-lo-stato
description: Un cancello che decide leggendo uno stato (riga DB, cache, campo in memoria) protegge SOLO i percorsi che quello stato lo scrivono — va verificato empiricamente chi lo scrive, prima di dichiarare chiuso un bug
metadata:
  type: feedback
---

Prima di dichiarare risolto un bug con un guardrail che **legge** uno stato per decidere,
identifica chi **scrive** quello stato — e verificalo eseguendo, non leggendo.

**Why:** in MCP-UNIQ-01 (ingressi Short duplicati su segnale persistente) il cancello di
unicità posizione legge la riga `open` in `positions`. Sembrava completo: il predicato è lo
stesso di `insertPositionIfNoneOpen`, i test passavano, il rosso-prima-del-fix era verificato.
Ma quella riga la scrive **solo** `bot.js` (`_openPosition` / adozione in `_reconcile`):
il percorso MCP `handlePlaceOrderPaper` inserisce un `trade` e muove il paper broker, e
**nessuna riga `positions`**. Risultato misurato con uno script: tre ordini SHORT identici su
un bot FERMO passano tutti e tre anche col fix, posizione paper accumulata a size 3 con 0
righe in DB. Il cancello chiude il caso del bot *running* (il suo tick adotta la posizione e
da lì scatta, con una finestra residua di un tick) e non quello del bot fermo pilotato solo
dall'agente. Due suite verdi non lo avrebbero mai detto — al contrario, due subtest esistenti
piazzavano due ingressi identici *di proposito* per testare altri cancelli, e restavano verdi.

**How to apply:**
- Fai un `grep` dei **writer** dello stato letto, non solo dei reader. Se i writer sono meno
  dei percorsi che il cancello deve coprire, il cancello è parziale per costruzione.
- Verificalo con uno script usa-e-getta su DB temporaneo che riproduce la sequenza reale
  (N richieste ripetute, cooldown resettato tra l'una e l'altra) e stampa **sia** l'esito
  **sia** lo stato risultante nelle due sedi (DB e broker). È la differenza tra "il fix
  funziona" e "il fix ha la forma giusta".
- Nel report e nel JSDoc del cancello scrivi il **perimetro** in modo esplicito: quali
  posizioni copre (tracciate) e quali no (esistenti solo sull'exchange/paper). Un cancello
  con un limite dichiarato è utilizzabile; uno creduto totale è una falsa sicurezza.
- Non allargare il perimetro da solo se richiede di rilavorare test altrui o di spostare il
  punto fail-fast: presenta le opzioni al PO. Vale anche il contrario — non spuntare il
  criterio come soddisfatto se copre metà dei casi.

Sul cancello in sé: nessuna notifica sul blocco *atteso* (con un segnale persistente scatta a
ogni candela: sarebbe spam), notifica urgente solo quando lo stato è **non verificabile** —
e in quel caso fail-closed, perché eseguire senza sapere cosa è già aperto raddoppia
l'esposizione, mentre le posizioni aperte restano protette dai trigger sull'exchange.

**Esito, e la forma approvata dal PO:** il gap è stato chiuso con **due livelli, non con la
sostituzione del primo**. Livello 1 sulla sorgente che costa zero (riga in DB, sincrona, prima
di qualunque fetch: fail-fast); livello 2 sulla sorgente **autorevole** (posizioni
dell'account), come funzione pura che riceve le posizioni già lette dal chiamante per un altro
cancello — nessun I/O aggiunto. Scartata l'alternativa di far scrivere la riga `positions` al
percorso dell'agente: avrebbe creato righe senza TP/SL e intersecato reconciler/adozione.
Tre dettagli che si riveleranno utili la prossima volta:
- **Predicato e messaggio d'errore condivisi** fra i livelli (qui `isSameSideEntry` + un
  costruttore di messaggio): stessa causa ⇒ stesso errore e stessa chiave d'audit, così
  l'agente non può trattarli diversamente. Cambia solo un riferimento in coda che dice *quale*
  sorgente ha risposto — ed è quello su cui i test distinguono i due livelli.
- **Normalizza il nome del mercato** (`SOL` vs `SOL-PERP`): le due sorgenti non usano la stessa
  forma, e un confronto letterale rende il cancello inerte sul percorso reale restando verde
  sui test paper.
- **Bot e indirizzo paper dedicati per ogni livello nei test**: sullo stato condiviso della
  suite un rifiuto è attribuibile a entrambi e il verde non dice quale funziona. Verifica il
  rosso **neutralizzando un livello alla volta**: se neutralizzandone uno restano verdi tutti i
  test, quel livello non è coperto da nessuno.
- Aggiungere un livello **rompe i test altrui che duplicavano di proposito** (qui due ingressi
  identici per esercitare altri cancelli): riscrivili sul loro bersaglio reale e aggiungi una
  contro-prova, non allentare l'asserzione.

Collegati: [[feedback-invarianti-nel-db-non-nel-chiamante]], [[feedback-purezza-funzioni-che-sembrano-query]],
[[feedback-seam-di-test]], [[feedback-fallimenti-money-path-non-silenziosi]].
