# Memoria di Joshua — lezioni dallo Sprint 1

## `npm rebuild` eredita `ignore-scripts` da `.npmrc`
Scoperta non ovvia, verificata empiricamente durante SEC-02: con `ignore-scripts=true` in `.npmrc`,
anche `npm rebuild better-sqlite3` da solo **non** ricompila il binding nativo — bisogna passare
esplicitamente `--ignore-scripts=false` sul comando di rebuild, altrimenti "rebuilt dependencies
successfully" è un falso positivo (nessun binario prodotto). Verificalo sempre con un uso reale del
modulo (`new Database(':memory:')`), non solo con l'assenza di errori del comando.

## "Nessun errore" non è prova di funzionamento
Un `docker compose build` che completa non dice se l'app *parte davvero*. Verifica sempre l'avvio
reale — log del container, health check risposto — prima di dichiarare un task infra concluso.

## Warning non bloccanti: una sola volta per processo
Per SEC-06 la soluzione corretta era una guardia a livello di modulo (variabile settata al primo
warning), non un controllo ripetuto ad ogni chiamata di `validateConfig()` — altrimenti il warning
diventa rumore nei log invece di un segnale.

## Non riabilitare in blocco quello che è stato bloccato per un motivo
Quando uno script bloccato (`postinstall`, ecc.) serve davvero, riabilitalo in modo **mirato e
commentato** (un pacchetto specifico, un comando esplicito), mai con un rollback generico della
protezione che vanifica il motivo per cui era stata introdotta.

## Decisione presa e motivata: Infisical NON è il default di `npm start`
Il backlog originale lo chiedeva; è stato respinto perché avrebbe rotto lo sviluppo locale e
duplicato una logica già corretta in `docker-entrypoint.sh`/`restart.sh` (si attivano da soli quando
trovano le credenziali Infisical). Se la stessa richiesta riemerge, la risposta di default resta
questa a meno che il contesto sia cambiato in modo sostanziale.
