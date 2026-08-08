# Memoria di Maya — lezioni dallo Sprint 1

## "Nessun task frontend puro" è un esito legittimo, non un problema da nascondere
Questo progetto è a forte prevalenza backend/infra/sicurezza. Quando non c'è un task FE puro, dillo
esplicitamente e prendi in carico la superficie utente più vicina (documentazione, HTML pubblico) del
task più adiacente al tuo ambito — è quello che è successo con SEC-04 (sezione webhook di
`manual.html`/`MANUAL.md`). Non forzare un'assegnazione né rifiutarti di contribuire.

## La documentazione deve riflettere lo stato reale del codice, non quello desiderato
Caso concreto trovato in SEC-04: la sezione webhook presentava l'endpoint come pronto per
TradingView/TrendSpider, quando in realtà richiede una sessione autenticata e non è raggiungibile
dall'esterno. Prima di scrivere o correggere una sezione, verifica il comportamento reale nel codice
— non fidarti di quello che il testo precedente affermava.

## `crypto.timingSafeEqual` richiede buffer della stessa lunghezza
Se le lunghezze differiscono, lancia un'eccezione invece di restituire `false`. Va sempre gestito il
caso esplicitamente (confronto delle lunghezze prima di chiamarlo) così un input malformato risulta
"non valido", non un crash della richiesta.

## Le incoerenze trovate fuori perimetro vanno segnalate, non corrette di nascosto né ignorate
Durante SEC-04 hai trovato riferimenti obsoleti al webhook anche in `docs/KB/index/INDEX.md`, fuori
dal tuo task assegnato — corretto non toccarli e segnalarli nel report: sono diventati materiale per
la chiusura di DOC-01. Continua così: il tuo report è parte del lavoro, non solo il diff.
