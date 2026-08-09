---
name: feedback-invarianti-nel-db-non-nel-chiamante
description: Un'invariante di unicità (una sola posizione aperta per bot+coin) va imposta dentro un metodo sincrono del DB, non con check-then-write nel chiamante — pattern del fix SEC-08
metadata:
  type: feedback
---

Quando serve garantire "al massimo una riga X", il controllo e la scrittura vanno **dentro
un singolo metodo di `database.js`**, non spezzati nel chiamante.

**Why:** `better-sqlite3` è sincrono. SELECT + INSERT nello stesso metodo non hanno `await`
in mezzo, quindi nessun altro tick — e nessuna altra istanza dello stesso oggetto — può
infilarsi tra i due. La stessa coppia scritta nel chiamante con un `await` in mezzo riapre
la finestra che si voleva chiudere. È il pattern con cui SEC-08 (P0) ha chiuso la
duplicazione di `positions`: `db.insertPositionIfNoneOpen()` restituisce
`{ id, created, row }`, e chi trova `created:false` **riprende la riga esistente** invece
di inserirne una seconda.

**How to apply:** vale per qualunque "crea se non esiste" sul money path. Due corollari
imparati nello stesso fix:
- Se lo stato in memoria può essere temporaneamente vuoto mentre l'oggetto reale esiste
  già sull'exchange, serve **anche** un flag di "operazione in volo" (`_opening`) alzato
  per tutta la finestra e azzerato in `finally` — copre il sotto-caso in cui la riga in DB
  non è ancora stata scritta, dove il controllo sul DB non può aiutare.
- Una riga DB può esistere senza che l'oggetto in memoria la conosca (istanza sostituita a
  caldo): l'idratazione riga→memoria deve stare in **un solo posto** condiviso con il
  costruttore (`_hydratePosition`), altrimenti dopo un riavvio il bot gestisce una
  posizione con campi diversi da quelli con cui l'ha adottata.
- **Non** aggiungere un UNIQUE index parziale per irrigidire l'invariante se in produzione
  esistono già righe che lo violano: la creazione dell'indice fallirebbe all'avvio e
  l'applicazione non partirebbe. Prima la bonifica dei dati, poi eventualmente l'indice.

Collegati: [[feedback-place-then-cancel]], [[feedback-stato-posizione-immutabile-vs-corrente]].
