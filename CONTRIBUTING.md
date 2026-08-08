# Contribuire ad ArbitrageBot

Grazie per l'interesse a contribuire. Questo documento raccoglie le regole minime
da rispettare prima di aprire una Pull Request, in particolare quelle legate alla
sicurezza della supply chain delle dipendenze.

## 🔒 Regola obbligatoria: modifiche a `package-lock.json`

`package-lock.json` è il vero punto d'ingresso degli attacchi supply-chain: un
pacchetto typosquattato o compromesso entra quasi sempre come dipendenza
**transitiva** e non compare mai in `package.json`. Per questo, **ogni PR che
modifica `package-lock.json` richiede ispezione riga per riga** di ogni
dipendenza aggiunta o cambiata, prima dell'approvazione. Per ciascuna nuova
riga di lockfile, chi effettua la review deve controllare:

- **Download count** del pacchetto su npm (un numero anomalmente basso per una
  dipendenza "di base" è un segnale d'allarme).
- **Data di pubblicazione**: pacchetti pubblicati da pochissimi giorni, o con
  una versione "major" rilasciata a ridosso della PR, vanno verificati con
  attenzione doppia.
- **Presenza di script `postinstall` / `preinstall` / `install`** nel
  `package.json` del pacchetto (visibile su npmjs.com o scaricando il tarball):
  uno script di install è il vettore più comune per eseguire codice arbitrario
  durante `npm ci`, prima ancora che l'applicazione parta.
- **Somiglianza sospetta del nome con un pacchetto noto** (typosquatting), es.
  `big-nunber` invece di `bignumber.js`, `crossenv` invece di `cross-env`,
  `ethersjs` invece di `ethers`. In caso di dubbio, confrontare il nome
  carattere per carattere con quello del pacchetto legittimo.
- **Chi mantiene il pacchetto** e da quanto tempo: un cambio improvviso di
  maintainer o un pacchetto storico "adottato" di recente da un nuovo autore
  sono pattern noti di compromissione (vedi i casi `event-stream`,
  `ua-parser-js`, `tj-actions/changed-files`).

Se anche uno solo di questi controlli solleva un dubbio, la dipendenza va
motivata esplicitamente nella descrizione della PR (perché serve, chi la usa,
alternative valutate) prima di poter essere approvata.

La CI esegue automaticamente `npm audit --audit-level=high` (bloccante su
vulnerabilità note di severità alta/critica con fix disponibile) e
`npm audit signatures` (verifica delle firme del registry npm). Questi
controlli sono un complemento alla review umana, non un sostituto: `npm audit`
non rileva il typosquatting né i pacchetti dannosi non ancora segnalati.

## 🔧 Setup di un clone pulito

Dopo `npm ci` (o `npm install`) esegui **sempre**:

```bash
npm run rebuild:native
```

`.npmrc` imposta `ignore-scripts=true`, quindi l'install non compila il binario nativo di
`better-sqlite3`. Salta questo passaggio e i test che aprono davvero SQLite
(`test/botDca.test.js`, `test/riskPersistence.test.js`) falliscono con
`Could not locate the bindings file`. Su una macchina che ha installato le dipendenze *prima*
di SEC-02 il problema non si vede, perché il `.node` è rimasto sul disco: è esattamente il caso
"verde da noi, rosso su un runner pulito". La CI esegue lo stesso step (vedi
`.github/workflows/ci.yml`).

Lo script sblocca gli script di install per **quel solo pacchetto**
(`npm rebuild better-sqlite3 --ignore-scripts=false`): non allentare `.npmrc` per farlo
funzionare. E non usare `npm rebuild better-sqlite3` senza il flag — `npm rebuild` eredita
`ignore-scripts` da `.npmrc` e stampa "rebuilt dependencies successfully" senza produrre alcun
binario.

## ✅ Prima di aprire una PR

- `npm run lint` deve essere verde (lint di sintassi leggero su `src/`,
  `test/`, `scripts/`).
- `npm test` deve essere verde (`node --test`, suite in `test/*.test.js`).
- Se la PR tocca `package-lock.json`, esegui in locale anche
  `npm audit --audit-level=high` e `npm audit signatures` e riporta l'esito
  nella descrizione della PR.
- Non committare mai segreti reali (chiavi private, seed phrase, API key).
  Per i test che toccano la cifratura usa variabili d'ambiente di sviluppo
  (vedi `AGENT_ENCRYPTION_KEY` nel workflow CI), mai valori reali.

## 📝 Stile dei commit

Il repository segue una convenzione ispirata a Conventional Commits:

```
<tipo>(<scope>): <descrizione>
```

- `tipo`: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`.
- `scope`: opzionale, spesso `perps` per le modifiche al modulo di trading
  perpetuals (es. `feat(perps): ...`).
- La descrizione può essere in italiano o inglese: nel repo convivono
  entrambi, ma l'italiano è prevalente nei messaggi legati a logica di
  dominio/trading. Mantieni coerenza con i commit vicini a quello che stai
  scrivendo.

## 💬 Commenti nel codice

I commenti nel codice sono prevalentemente in **italiano** (vedi
`scripts/lint-syntax.js`, `.github/workflows/ci.yml`, i moduli sotto `src/`).
Continua a commentare in italiano nel nuovo codice per coerenza con il resto
della base di codice, a meno che il file in cui stai lavorando sia già
commentato in inglese.

## 🔁 Flusso Pull Request

1. Fork del repository.
2. Crea un feature branch (`git checkout -b feature/NomeFeature`).
3. Commit delle modifiche seguendo lo stile sopra.
4. Push del branch.
5. Apri la Pull Request: assicurati che la CI (`npm run lint`, `npm test`,
   `npm audit --audit-level=high`, `npm audit signatures`) sia verde.
