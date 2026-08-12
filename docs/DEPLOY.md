# Deploy in produzione — VPS + Docker (mainnet, single-user)

Guida per far girare ArbitrageBot **24/7** in sicurezza su un piccolo VPS, con
denaro reale su Hyperliquid mainnet, accessibile **solo a te**.

> ⚠️ Il server custodisce una **chiave agent** capace di **piazzare ordini reali**
> (non può prelevare). Tratta i segreti e il volume `perps-data` come critici.

**Indice**

| § | Argomento |
|:--|:---|
| [0](#0-perché-non-serverless-vercel) | Perché non serverless |
| [1](#1-provisioning-del-vps) | Provisioning del VPS |
| [2](#2-segreti-inventario-e-modello-di-minaccia) | **Segreti: inventario e modello di minaccia** |
| [3](#3-esposizione-due-opzioni) | Esposizione |
| [4](#4-avvio) | Avvio |
| [5](#5-backup-e-restore-verificato) | Backup e restore verificato |
| [6](#6-monitoraggio-e-allerte) | Monitoraggio e allerte |
| [7](#7-checklist-go-live-mainnet) | Checklist GO-LIVE |
| [8](#8-kill-switch) | Kill-switch |
| [9](#9-segreti-gestiti-con-infisical-self-hosted-vps) | Infisical self-hosted |
| [10](#10-rotazione-della-chiave-di-cifratura--runbook) | **Rotazione della chiave — runbook** |
| [11](#11-sicurezza-della-catena-di-fornitura-npm) | **Supply chain npm** |
| [12](#12-risposta-a-un-sospetto-incidente) | **Risposta a un incidente** |

---

## 0. Perché NON serverless (Vercel)

I bot girano in un loop persistente (`setInterval`) e scrivono su SQLite
(`better-sqlite3`, nativo). Il serverless è stateless, effimero e a tempo: **non
può** tenere i bot attivi né conservare il database. Serve un **processo
persistente** → VPS o container. Il vecchio `vercel.json` non va usato per l'app live.

---

## 1. Provisioning del VPS

- Provider consigliato: **Hetzner CX22** (~4€/mese) o DigitalOcean (1 vCPU/2GB bastano).
- SO: **Debian 13** (consigliata, supporto più lungo) · Debian 12 · Ubuntu 22.04. Il repository
  apt ufficiale di Docker supporta tutti e tre i codename (`trixie`, `bookworm`, `bullseye`); lo
  script d'installazione sotto li gestisce automaticamente. Nota per Debian 13: preferisce il
  formato `deb822` (`.sources`) per i repository apt — lo script ufficiale `get.docker.com` lo
  usa già correttamente, serve attenzione solo se configuri il repository a mano.
- Accesso **solo a chiave SSH** (niente password). Crea un utente non-root:

```bash
adduser deploy && usermod -aG sudo deploy
# copia la tua chiave pubblica in /home/deploy/.ssh/authorized_keys
```

- Firewall + hardening:

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
apt install -y fail2ban unattended-upgrades
```

- Installa Docker + Compose plugin:

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

---

## 2. Segreti: inventario e modello di minaccia

### 2.1 Cosa protegge cosa

| Variabile | Livello | Cosa protegge | Se trapela |
|:---|:---|:---|:---|
| `AGENT_ENCRYPTION_KEY` | 🔴 critico | Cifra a riposo le chiavi agent e il token Telegram nel DB | Chi ha **anche** il DB o un backup ottiene le chiavi agent → può **piazzare ordini** |
| `SESSION_SECRET` | 🔴 critico | Firma i token di sessione del pannello | Si forgiano sessioni valide → accesso completo al pannello |
| `APP_PASSWORD_HASH` | 🔴 critico | Hash della password del pannello (scrypt) | È un hash, non la password: il rischio è l'attacco offline se debole |
| `ANTHROPIC_API_KEY` | 🟠 importante | Chiave dell'Analyst AI | Abuso a tuo carico (costo economico), non accesso ai fondi |
| `TELEGRAM_BOT_TOKEN` | 🟡 opzionale | Notifiche e comandi da chat | Chi lo ha può comandare i bot via Telegram (`/chiuditutto`, `/ferma`) |
| `METRICS_TOKEN` | 🟡 opzionale | Protegge `/metrics` | Senza, `/metrics` è **pubblico** (vedi §2.5) |

Le tre variabili **critiche** sono obbligatorie in `NODE_ENV=production`: se
mancano o sono troppo corte, `validateConfig()` **rifiuta l'avvio** con
`process.exit(1)`. È un fail-fast voluto — meglio un server che non parte di uno
che opera senza le protezioni attese.

> ⚠️ **Fallback di sviluppo — solo fuori produzione.** Senza `AGENT_ENCRYPTION_KEY`,
> `secretBox` usa una chiave di sviluppo **hardcoded nel sorgente**. Serve a far
> girare i test e lo sviluppo locale senza configurazione, ma significa che
> qualsiasi dato cifrato in quello stato è cifrato con una chiave pubblica. Non
> usare mai un DB nato così come base per la produzione.
>
> Con `NODE_ENV=production` quel fallback **non esiste più** (SEC-07): `secretBox`
> solleva un errore invece di cifrare con la chiave di sviluppo. Il controllo è
> volutamente duplicato rispetto a `validateConfig()` perché copre anche i percorsi
> che non passano dall'avvio del server — `scripts/rotate-encryption-key.js`
> lanciato a mano nel container e la lettura/scrittura del token Telegram in
> `notifier.js`.

### 2.2 Dove vivono i segreti

Tre livelli, con proprietà di sicurezza diverse:

| Livello | Contenuto | Protezione |
|:---|:---|:---|
| **Ambiente del processo** | `AGENT_ENCRYPTION_KEY`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`… | In chiaro nella memoria del processo. Da `.env` (file su disco) oppure iniettati da Infisical (§9) |
| **Database SQLite** | `agent_wallets.encrypted_key`, `settings.telegram_config.tokenEnc` | **AES-256-GCM** con chiave versionata (§2.3) |
| **Backup** | Copia del DB | Eredita la cifratura del DB: un backup rubato è inutile **senza** la chiave (§5) |

Tutto il resto del DB — bot, posizioni, trade, `risk_equity_history`,
`risk_drawdown_state`, `ml_history`, proposte, audit — è **in chiaro**: non
contiene segreti, ma è comunque storico operativo tuo.

### 2.3 Cifratura a riposo con chiave versionata

Formato del ciphertext prodotto da [`src/perps/secretBox.js`](../src/perps/secretBox.js):

```
v<id>:base64( iv[12] | authTag[16] | ciphertext )
```

Il prefisso `v<id>` marca **quale chiave** ha prodotto il valore. È ciò che rende
la chiave **ruotabile**: le vecchie restano disponibili in sola decifratura mentre
le nuove scritture usano già quella corrente. I valori scritti prima
dell'introduzione del versioning non hanno prefisso e restano leggibili (vengono
provate tutte le chiavi note; il tag GCM fa fallire in modo netto quelle sbagliate).

Tre variabili governano il portachiavi:

```bash
AGENT_ENCRYPTION_KEY=...        # segreto corrente — cifra e decifra
AGENT_ENCRYPTION_KEY_ID=1       # id del segreto corrente (default 1)
AGENT_ENCRYPTION_KEYS_OLD=      # precedenti, SOLO decifratura: "1:vecchio;2:piuVecchio"
```

> ℹ️ **Correzione rispetto alle versioni precedenti di questa guida.** Prima si
> leggeva *"non cambiare `AGENT_ENCRYPTION_KEY` dopo aver salvato chiavi agent"*.
> Con il versioning **non è più vero**: la chiave si ruota, e la procedura è nel
> runbook al §10.

### 2.4 Generazione e file di configurazione

```bash
git clone <repo> /home/deploy/arbitragebot && cd /home/deploy/arbitragebot
cp .env.example .env && chmod 600 .env
```

```bash
node scripts/hash-password.js 'una-password-lunga-e-robusta'   # -> APP_PASSWORD_HASH=...
openssl rand -hex 32                                            # -> SESSION_SECRET=...
openssl rand -hex 32                                            # -> AGENT_ENCRYPTION_KEY=...
openssl rand -hex 32                                            # -> METRICS_TOKEN=... (se esponi /metrics)
```

Usa **sempre** `openssl rand`: la derivazione della chiave è uno SHA-256 diretto
del segreto, adeguato per un valore ad alta entropia ma **non** per una passphrase
scelta a mano (nessun KDF lento, nessun salt).

Contenuto minimo di `.env`:

```bash
NODE_ENV=production
APP_PASSWORD_HASH=scrypt$...
SESSION_SECRET=...                 # ≥16 char imposti, ≥32 consigliati
APP_ORIGIN=https://trading.tuodominio.it
BIND_HOST=127.0.0.1                # dietro reverse proxy; in Docker lo forza il compose

# --- Cifratura a riposo ---
AGENT_ENCRYPTION_KEY=...           # ≥32 caratteri, obbligatoria in produzione
AGENT_ENCRYPTION_KEY_ID=1
AGENT_ENCRYPTION_KEYS_OLD=         # vuoto quando non c'è una rotazione in corso

# --- Rete e cap di rischio ---
HYPERLIQUID_NETWORK=testnet        # parti da testnet, poi mainnet
ALLOW_MAINNET=false
PERPS_MAX_POSITION_USD=500         # cap prudenti
PERPS_MAX_DAILY_LOSS_USD=100
PERPS_MAX_LEVERAGE=10
PERPS_DEFAULT_LEVERAGE=3

# --- Opzionali ---
METRICS_TOKEN=                     # se vuoto, /metrics è pubblico (§2.5)

# Watchdog del WebSocket Hyperliquid: valori di default ragionevoli, si toccano
# solo per diagnosi. Il watchdog ri-sottoscrive il feed se cade (§6).
PERPS_WS_WATCHDOG_MS=30000            # ogni quanto verificare che il WS sia vivo
PERPS_WS_RECONNECT_BACKOFF_MS=15000   # attesa minima tra due tentativi (anti reconnect storm)
PERPS_WS_DOWN_NOTIFY_MS=300000        # downtime oltre il quale arriva una notifica Telegram
PERPS_WS_DEGRADED_MS=                 # downtime oltre il quale lo stato del feed diventa
                                      # `degraded` (vuoto = uguale a PERPS_WS_DOWN_NOTIFY_MS,
                                      # così l'ingresso in degraded coincide con l'unica
                                      # notifica che parte già, §6)

PERPS_EXECQUEUE_DEPTH_WARN=10          # profondità della coda ordini di un wallet oltre la
                                       # quale scatta un warning nei log (un ordine urgente
                                       # può restare in attesa dietro le altre azioni dello
                                       # stesso wallet). Solo osservabilità: nessuna
                                       # prioritizzazione. Metrica: perps_execqueue_depth

AGENTS_ENABLED=false               # Analyst AI: advisory, non esegue mai
ANTHROPIC_API_KEY=
AGENT_MAX_CALLS_PER_HOUR=8         # tetto di spesa dell'Analyst
AGENT_CADENCE_MIN=30               # ogni quanto gira l'Analyst
AGENT_SKIP_IF_PENDING=1            # salta la run periodica se ci sono già N proposte
                                   # non decise (0 = disattivato). Misurato: −33% di
                                   # spesa sullo storico, vedi MANUAL.md §12

```

> ⚠️ **`APP_PASSWORD_HASH` non va messa in un file letto da `env_file:` di Docker
> Compose.** Compose **interpola** i `$VAR` dentro i valori di un `env_file`, e un
> hash scrypt ha la forma `scrypt$salt$hash`: le parti che iniziano con una lettera
> vengono lette come nomi di variabile, non esistono, e sparisce quel pezzo. Il risultato è
> un login che rifiuta la password **giusta** con "Password errata", senza alcun
> errore nei log. Verificato con Compose v2.29.7 il 2026-08-10; `docker run
> --env-file` invece non tocca il valore.
> Il percorso documentato qui è al sicuro: `.env` viene letto da `dotenv` **dentro
> il processo**, che non interpola. Se proprio devi passare l'hash via `env_file`,
> raddoppia i dollari (`scrypt$$salt$$hash`), oppure — meglio — usa Infisical (§9).

> **Modulo Arbitraggio EVM — ritirato dal server web** (EVM-01, Sprint 3). Era una *demo
> educativa* a prezzi simulati (non arbitraggio reale) che si accendeva con
> `DEMO_EVM_ENABLED=true`. Quella variabile non esiste più e impostarla non ha effetto: il
> server non registra le sue route (`/api/status`, `/api/prices`, `/api/opportunities`…) né
> avvia i suoi servizi in nessuna condizione. Il prodotto in produzione è **solo Perps**.
> La demo resta eseguibile a mano con `npm run cli`, che non fa parte del deploy.

### 2.5 Verifica prima di avviare

```bash
npm run secrets:check                       # legge il file locale
infisical run -- node scripts/check-secrets.js   # legge da Infisical (§9)
```

Stampa nome, stato e **lunghezza** di ogni variabile — **mai un valore**. Esce con
codice ≠ 0 se manca un segreto critico in produzione, quindi è usabile in CI o in
uno script di deploy.

### 2.6 Regole operative

- **`.env` a `600`** e mai committato (già in `.gitignore`, insieme a
  `deploy/infisical/infisical.env` e a `data/`).
- **Mai un segreto negli argomenti da riga di comando**: finiscono in `ps` e nella
  history della shell. `hash-password.js` è l'eccezione consapevole — usa una
  password che poi non riutilizzi altrove, oppure prefissa il comando con uno
  spazio se la tua shell è configurata per non registrarlo.
- **Attenzione a `docker inspect`.** Con `env_file: .env` nel compose, i segreti
  sono visibili in `docker inspect` e a chiunque possa parlare col socket Docker.
  Chi è nel gruppo `docker` è di fatto root. È una delle ragioni per passare a
  Infisical (§9).
- **`/metrics` è fuori dal gate di autenticazione** (per consentire lo scraping).
  Senza `METRICS_TOKEN` è raggiungibile da chiunque arrivi al server: non espone
  segreti, ma rivela attività dei bot ed errori. Con Tailscale (§3 opzione A) il
  problema non si pone; con dominio pubblico **imposta il token**.
- **Log**: `logger` filtra i campi sensibili, ma non fidarti mai ciecamente — se
  incolli log in un issue o in una chat, rileggili.

---

## 3. Esposizione: due opzioni

### Opzione A — consigliata per single-user: **Tailscale** (niente porte pubbliche)
Solo i tuoi dispositivi raggiungono il pannello; superficie d'attacco minima.
Nessun dominio pubblico, nessun certificato da gestire a mano: HTTPS reale,
rinnovo automatico, il tutto dentro la tailnet.

```bash
curl -fsSL https://tailscale.com/install.sh | sh && tailscale up --ssh
```

**1. Abilita i certificati HTTPS per la tailnet** (una tantum, dal pannello,
non dalla CLI): [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns)
→ sezione "HTTPS Certificates" → attiva.

**2. `docker-compose.yml`** pubblica Caddy solo su `127.0.0.1:8080` — mai
raggiungibile da fuori l'host, nemmeno dalla tailnet direttamente. `Caddyfile`
usa già il blocco `:8080` (in fondo al file) per questo.

**3. `tailscale serve`** è il vero ingresso pubblico sulla tailnet: termina
HTTPS con un certificato Let's Encrypt reale per il nome MagicDNS dell'host
(rinnovo automatico, nessun cron da gestire) e inoltra in HTTP puro a Caddy
su localhost:

```bash
sudo tailscale serve --bg 8080
tailscale serve status     # conferma cosa è pubblicato
```

Il pannello è raggiungibile su `https://<hostname>.<tuo-tailnet>.ts.net` —
trovi l'hostname esatto con `tailscale status`. La configurazione di `serve`
persiste da sola tra i riavvii (stato di `tailscaled`, non serve rieseguirla).

> ⚠️ **`COOKIE_SECURE=false` serviva solo prima di `tailscale serve`.** Con
> HTTP puro diretto (senza questo passaggio) l'app marca il cookie di sessione
> `Secure` per default, e il browser lo scarta su HTTP — il login sembra
> fallire con password corretta. Con `tailscale serve` il browser vede HTTPS
> vero end-to-end, quindi il default va bene: se avevi impostato
> `COOKIE_SECURE=false` in precedenza puoi rimuoverlo (non è dannoso lasciarlo,
> ma non serve più).

### Opzione B — HTTPS pubblico con dominio
1. Punta un record DNS `A` del tuo dominio all'IP del VPS.
2. In `Caddyfile` sostituisci `trading.tuodominio.it` col tuo dominio.
3. Caddy ottiene e rinnova il certificato Let's Encrypt da solo.

In entrambi i casi la password app resta come secondo livello. Con l'opzione B
imposta anche `METRICS_TOKEN` (§2.5).

**Intestazioni e CSP.** L'app usa `helmet` con una CSP restrittiva:
`defaultSrc 'self'`, `objectSrc 'none'`, `frameAncestors 'none'` (niente
embedding in iframe), `formAction 'self'`. Se aggiungi risorse esterne al
frontend devi aggiornare le direttive in [`src/server.js`](../src/server.js),
altrimenti il browser le blocca — è il comportamento voluto.

---

## 4. Avvio

```bash
docker compose up -d --build
docker compose logs -f app          # verifica il banner di avvio e l'auth ATTIVA
```

`restart: unless-stopped` riavvia i container dopo crash o reboot; i bot che erano
`running` ripartono da soli (`botManager.loadFromDb`).

L'immagine gira come **utente non-root** (`node`), installa le dipendenze con
`npm ci --omit=dev` (§11) ed espone un `HEALTHCHECK` su `/health`. L'app **non è
pubblicata sull'host**: solo Caddy espone 80/443, l'app resta sulla rete Docker interna.

**Senza Docker** (sviluppo o VPS bare-metal) usa lo script di riavvio, che fa stop
graceful, riavvio in background e verifica di `/health`:

```bash
npm run restart      # riavvia
npm run stop         # ferma
./scripts/restart.sh status
```

Lo script inietta automaticamente i segreti da Infisical se trova `.infisical.json`
e la CLI installata; `USE_INFISICAL=0` lo disattiva.

---

## 5. Backup e restore verificato

**Verificato realmente sul VPS il 12 agosto 2026** (OPS-02, Sprint 2 Release 2 — mai eseguito prima
d'ora): backup creato, restore verificato su copia separata, `integrity_check = ok`, tutte le tabelle
attese presenti (`bots positions trades settings agent_wallets proposals audit`), 4 bot/9 posizioni
lette senza errori.

**Nota:** questo VPS non ha `cron`/`crontab` installato (immagine Debian minimale) — il timer
notturno usa **systemd**, non cron. Se il tuo host ne è dotato, l'equivalente cron resta valido (vedi
sotto), ma sul VPS reale di questo progetto è un timer systemd:

```bash
# /etc/systemd/system/arbitragebot-backup.service
[Service]
Type=oneshot
User=debian
WorkingDirectory=/opt/arbitragebot/app
Environment=DB_PATH=/var/lib/docker/volumes/app_perps-data/_data/perps.db
Environment=BACKUP_DIR=/opt/arbitragebot/backups
ExecStart=/opt/arbitragebot/app/scripts/backup.sh

# /etc/systemd/system/arbitragebot-backup.timer
[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
```

Attivato con `systemctl daemon-reload && systemctl enable --now arbitragebot-backup.timer` — verifica
lo stato con `systemctl list-timers arbitragebot-backup.timer`. Il nome reale del volume Docker su
questo VPS è `app_perps-data` (dal progetto compose `app`), non `arbitragebot_perps-data` — verificalo
sempre con `docker volume inspect` invece di assumerlo, i nomi cambiano col nome del progetto compose.

Equivalente cron, se il tuo host ce l'ha (`crontab -e`, utente deploy):

```bash
17 3 * * *  DB_PATH=/var/lib/docker/volumes/<progetto>_perps-data/_data/perps.db \
            BACKUP_DIR=/opt/arbitragebot/backups /opt/arbitragebot/app/scripts/backup.sh
```

`backup.sh` usa l'API `.backup` di sqlite3 (consistente anche col WAL attivo),
comprime e ruota i file (`RETENTION=14` di default).

**Verifica il restore — un backup non verificato è un backup che non esiste:**

```bash
BACKUP_DIR=/opt/arbitragebot/backups ./scripts/restore-verify.sh
```

Ripristina l'ultimo backup su un DB temporaneo, ne controlla l'integrità e la
presenza delle tabelle attese. **Non tocca il DB di produzione** ed esce con codice
≠ 0 in caso di problemi.

Poi sincronizza `/opt/arbitragebot/backups` **fuori dal VPS** (es. `rclone` verso object
storage, o `restic`) — **non ancora fatto**: il backup oggi vive solo sullo stesso host del DB che
protegge, un singolo guasto disco perderebbe entrambi. Candidato di refinement per il prossimo sprint.

> 🔐 **Il punto di sicurezza che conta.** Le chiavi agent nel backup sono cifrate:
> un backup rubato **senza** `AGENT_ENCRYPTION_KEY` è inservibile. Questa proprietà
> vale **solo se chiave e backup stanno in posti diversi**. Se archivi il `.env`
> accanto ai dump, o se Infisical gira sullo stesso host che ospita i backup, la
> proprietà svanisce e torni ad avere un singolo punto di compromissione (vedi
> anche l'avviso al §9). Conserva la chiave in un password manager, non nel
> bucket dei backup.

---

## 6. Monitoraggio e allerte

- **Uptime**: punta UptimeRobot / healthchecks.io su `https://.../health`.
- **Telegram**: configura token + chat id nell'app → ricevi avvisi su entrate/uscite,
  errori e kill-switch, e puoi comandare i bot da chat (`/status`, `/chiuditutto`).
  Il token viene salvato **cifrato** sul DB (`tokenEnc`), non in chiaro.
- **Metriche Prometheus** su `/metrics`, protette da `METRICS_TOKEN` se impostato:

  ```bash
  curl -H "Authorization: Bearer $METRICS_TOKEN" https://.../metrics
  ```

  Questo è il controllo a mano. Per il cruscotto vero (raccolta, grafici e alert,
  spenti per default) vedi **§6.1**.

- **Feed di mercato (WebSocket)**: `perps_ws_connected` deve stare a `1`. Se resta
  a `0` il bot non è fermo — lavora sul fallback REST, con prezzi validi ma meno
  freschi. Un watchdog verifica la connessione ogni `PERPS_WS_WATCHDOG_MS` e la
  ristabilisce da sé; ogni ripristino riuscito incrementa
  `perps_ws_reconnects_total`. Se il downtime supera `PERPS_WS_DOWN_NOTIFY_MS`
  (default 5 min) arriva **una** notifica Telegram per episodio, più una di
  ripristino. Un `perps_ws_reconnects_total` che cresce di continuo indica una
  connessione instabile, non un guasto momentaneo: da guardare insieme ai log
  `Hyperliquid WS …` in `logs/app.log`.

  Lo **stato del feed** è esplicito e a tre valori (`perps_ws_state{state=…}` a 1
  sullo stato corrente, e `system.marketData.wsState` in `/api/perps/risk`):
  `healthy` connesso, `retrying` caduto e in riconnessione, `degraded` giù da oltre
  `PERPS_WS_DEGRADED_MS` — cioè un guasto persistente, non uno sfarfallio. Serve a
  distinguere due situazioni che `perps_ws_connected 0` mostrava identiche.
  `perps_ws_connected` **non è cambiata**: query, alert e pannelli scritti prima
  continuano a valere.

- **Coda ordini per wallet**: `perps_execqueue_depth` è la profondità della coda del
  wallet più carico (azioni firmate in attesa o in corso). Con più bot sullo stesso
  master, un valore che resta alto significa che un ordine urgente (una chiusura)
  può aspettare dietro le aperture. Oltre `PERPS_EXECQUEUE_DEPTH_WARN` (default 10)
  compare un warning nei log con l'indirizzo del wallet coinvolto, e
  `perps_execqueue_depth_warnings_total` si incrementa. Nessuna prioritizzazione
  automatica: per ora è solo visibilità.

- **Notifiche Telegram**: quelle urgenti (protezione della posizione, limiti di
  rischio, anomalie di esecuzione) vengono ritentate su rate-limit/5xx/errori di
  rete; `perps_telegram_errors_total` conta quelle perse anche dopo i retry. Una
  notifica persa non interrompe mai la gestione di una posizione.

- Log: `docker compose logs` (Docker) o `logs/app.log` (script di riavvio).

### 6.1 Cruscotto Prometheus + Grafana (profilo `monitoring`)

**Verificato realmente sul VPS il 12 agosto 2026** (OBS-OPS-01, Sprint 2 Release 2 — prima solo
provato in locale): profilo attivato con il `METRICS_TOKEN` reale già configurato in produzione (letto
dall'ambiente del processo, mai passato in chiaro su una riga di comando visibile), target Prometheus
`up`, dashboard e datasource confermati provisionati via API, password admin cambiata dal default.
Esposto in tailnet su `https://vps-ec91eb11.tail3a3dde.ts.net:8444` — **non 8443**: quella porta è
già occupata dall'istanza demo isolata (vedi nota sotto). Su un VPS senza altre istanze parallele,
8443 resta la scelta naturale come nell'esempio sotto.

> **Nota se altre istanze condividono l'host**: `tailscale serve` assegna le porte HTTPS per
> hostname:porta, non per servizio — se hai già altro in ascolto su 8443 (es. una demo isolata come
> quella di Sprint 1-2), scegli una porta libera (`8444`, `8445`, …) invece di riusare l'esempio sotto
> alla lettera. Verifica sempre con `tailscale serve status` prima di assegnarne una nuova.

`/metrics` espone 18 famiglie di metriche, ma da sole sono solo testo: il profilo
`monitoring` aggiunge chi le raccoglie (Prometheus) e chi le disegna (Grafana),
con dashboard e regole di alert **provisionate da file nel repository**.

**È spento per default.** Chi non lo attiva non ha alcun cambiamento: un
`docker compose up -d` continua a portare su esattamente `app` + `caddy`.

```bash
docker compose --profile monitoring up -d      # accende anche prometheus + grafana
docker compose --profile monitoring ps         # 4 servizi
docker compose --profile monitoring down       # li spegne (i volumi restano)
docker compose up -d                           # senza profilo: solo app + caddy
```

**Niente porte pubbliche nuove.** Come Caddy, entrambi pubblicano solo su
loopback: Grafana su `127.0.0.1:3001`, Prometheus su `127.0.0.1:9090`. Tra loro
si parlano per nome sulla rete Docker interna, e Prometheus interroga
`app:3000/metrics` direttamente, senza passare da Caddy.

**Accesso dalla tailnet** — stesso schema del pannello (§3, opzione A), con
`tailscale serve` sull'host che termina HTTPS reale e inoltra al loopback:

```bash
sudo tailscale serve --bg --https=8443 127.0.0.1:3001
tailscale serve status
```

Grafana diventa `https://<hostname>.<tuo-tailnet>.ts.net:8443`. Conviene allineare
anche l'URL che Grafana usa nei propri link:

```bash
GRAFANA_ROOT_URL=https://<hostname>.<tuo-tailnet>.ts.net:8443 \
  docker compose --profile monitoring up -d grafana
```

**Credenziali iniziali: `admin` / `admin`, da cambiare al primo accesso** —
Grafana chiede il cambio da sé al primo login proprio perché la password è quella
di default. Per impostarne una prima di partire (in quel caso Grafana *non* chiede
il cambio, la password è già tua):

```bash
GRAFANA_ADMIN_PASSWORD='...' docker compose --profile monitoring up -d grafana
```

**Cosa si vede.** Un'unica dashboard, *ArbitrageBot Perps — operativo*, nella
cartella `ArbitrageBot`: raccolta metriche attiva, WebSocket, posizioni aperte,
bot in esecuzione, uptime, PnL giornaliero per bot, età dell'ultimo tick per bot,
errori nell'ultimo intervallo, alert attivi. È **provisionata da file**
(`deploy/monitoring/grafana/dashboards/arbitragebot-perps.json`): un salvataggio
dal browser viene rifiutato con *"Cannot save provisioned dashboard"*. Si modifica
il JSON nel repository e si riavvia il container; per esperimenti usa
"Save as copy", che crea una dashboard separata.

**Alert.** Cinque regole in `deploy/monitoring/alerts.yml`, valutate da Prometheus
e visibili in Grafana (*Alerting → Alert rules*, sezione della datasource, in sola
lettura) oltre che nel pannello "Alert attivi":

| Regola | Condizione |
|:---|:---|
| `ArbitrageBotTargetDown` | metriche non raccolte da 2 min |
| `PerpsWebSocketDown` | `perps_ws_connected == 0` da 2 min |
| `PerpsBotTickStale` | bot **in esecuzione** che non ticca da >180s |
| `PerpsApiErrorsSpike` | >10 errori API in 10 min, persistenti da 5 |
| `PerpsTickErrorsSpike` | >5 errori di tick in 10 min, persistenti da 5 |

> ⚠️ **Nessun inoltro esterno**: senza Alertmanager, un alert "firing" non manda
> niente a nessuno — si vede solo aprendo Grafana. Non resta scoperto il caso
> urgente, perché WS giù e bot fermo sono già notificati su Telegram dall'app
> (§6). L'inoltro è un raffinamento previsto, non incluso.

**Se i pannelli sono vuoti, guarda prima "Raccolta metriche".** Se è `DOWN`, il
problema è la raccolta, non il bot. La causa più comune è `METRICS_TOKEN`
impostato per l'app ma non disponibile a Prometheus: lo scrape prende 401.
Prometheus legge il token dal proprio ambiente e lo scrive in un file di
credenziali all'avvio, quindi al momento del `docker compose` la variabile deve
essere visibile — con i segreti in Infisical:

```bash
infisical run -- docker compose --profile monitoring up -d
curl -s localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"'   # atteso: up
```

**Ritenzione e spazio.** 30 giorni o 1 GB, quello che scade prima
(`--storage.tsdb.retention.*` nel compose), su volumi dedicati
`prometheus-data` e `grafana-data`: i dati sopravvivono a `down`/`up` e agli
aggiornamenti d'immagine. Per buttare via lo storico delle metriche senza
toccare il DB dei bot: `docker volume rm arbitragebot_prometheus-data` (a
container spento).

---

## 7. Checklist GO-LIVE mainnet

**Segreti**

1. ✅ `npm run secrets:check` verde con `NODE_ENV=production`.
2. ✅ `.env` a `600` (o segreti già solo in Infisical, §9), `AGENT_ENCRYPTION_KEY`
   copiata in un password manager **fuori dal VPS**.
3. ✅ `AGENT_ENCRYPTION_KEY_ID` impostato e `AGENT_ENCRYPTION_KEYS_OLD` vuoto
   (nessuna rotazione a metà).
4. ✅ **Prova di rotazione fatta almeno una volta su testnet** (§10): è la
   differenza tra avere una risposta all'incidente e non averla.

**Dati**

5. ✅ Backup automatico attivo **e** `restore-verify.sh` eseguito con esito ok.
6. ✅ Backup sincronizzati off-box, in un posto diverso da dove tieni la chiave.

**Accesso**

7. ✅ Auth attiva (login richiesto), pannello non raggiungibile in chiaro dall'esterno.
8. ✅ `METRICS_TOKEN` impostato se il dominio è pubblico.

**Esercizio**

9. ✅ **Dry-run su testnet** sul VPS: approva agent, 1 ordine manuale, 1 ciclo bot,
   kill-switch, `docker compose restart` → i bot ripartono, allerta Telegram arriva.
10. ✅ Passa a mainnet: `HYPERLIQUID_NETWORK=mainnet` **e** `ALLOW_MAINNET=true`,
    con **cap minimi**. All'avvio compare l'avviso rosso `MAINNET ATTIVO`; il
    pannello richiede una connessione wallet valida per le operazioni mainnet.
    Riavvia e rifai le verifiche con importi piccoli.
11. ✅ Finanzia solo il capitale che puoi permetterti di perdere. L'agent **non può
    prelevare**: tieni i fondi non operativi fuori dal conto di trading. È la
    mitigazione strutturalmente più forte del sistema — vale più di ogni altra voce
    di questa lista.

---

## 8. Kill-switch

Per fermare tutto immediatamente:

```bash
# ferma tutti i bot (richiede sessione autenticata via cookie)
curl -X POST https://.../api/perps/killswitch -H 'Content-Type: application/json' \
     -b cookie.txt -d '{"closePositions": true}'
```

Oppure da Telegram: `/chiuditutto` (chiude le posizioni) e `/ferma <bot>`.

---

## 9. Segreti gestiti con Infisical self-hosted (VPS)

Sostituisce il file di configurazione in chiaro sul server con un secret manager
che ospiti tu. **In locale non serve**: lo sviluppo continua a leggere il file
locale, senza dipendere da questa istanza.

L'integrazione è opt-in: si attiva solo quando trova `.infisical.json` (locale) o
`INFISICAL_TOKEN` (container). Senza, tutto funziona come prima.

> Se parti in produzione senza `INFISICAL_TOKEN`, l'app stampa un banner di
> avviso (non bloccante) all'avvio — vedi `validateConfig` in `src/config/config.js`.

### Perché

- Sul VPS non resta alcun segreto in chiaro su disco, né visibile in `docker inspect`.
- Da N segreti sparsi si passa a **1 solo** da proteggere (il token di macchina),
  revocabile e a scadenza — a differenza di una chiave di cifratura.
- Rotazione centralizzata senza redeploy, e traccia di chi legge cosa.

> ⚠️ **Attenzione alla co-locazione.** Se Infisical gira sullo *stesso* VPS
> dell'app e dei backup, chi compromette quella macchina ottiene di nuovo sia il
> database sia la chiave che lo decifra: il beneficio "backup rubato = inutile"
> svanisce. Per ottenerlo davvero, ospita Infisical su una macchina separata
> (basta un VPS minimo raggiunto via Tailscale). Sullo stesso host resta comunque
> un guadagno — rotazione, audit, nessun file in chiaro — ma non quello.

### 9.1 Avvio dell'istanza

```bash
cd deploy/infisical
../../scripts/infisical-bootstrap.sh     # genera infisical.env (0600), una tantum
docker compose up -d
docker compose logs -f backend           # attendi "Server started"
```

Lo script genera `ENCRYPTION_KEY`, `AUTH_SECRET` e la password di PostgreSQL
senza stamparne i valori, ed è idempotente. Il tag dell'immagine è **fissato**
(non `latest`): gli aggiornamenti sono una decisione esplicita, non un effetto
collaterale di un `docker compose pull`.

> ⚠️ `ENCRYPTION_KEY` cifra i segreti **dentro** Infisical. Se la perdi, quei
> segreti non sono recuperabili. Copiala in un password manager **prima** di
> caricare qualcosa di importante.

L'interfaccia è pubblicata solo su `127.0.0.1:8080`, quindi non è esposta su
Internet. Per raggiungerla dal tuo portatile usa Tailscale (§3 opzione A) e
cambia la pubblicazione della porta in `deploy/infisical/docker-compose.yml`:

```yaml
    ports:
      - "100.x.y.z:8080:8080"     # IP del tailnet
```

Aggiorna di conseguenza `SITE_URL` in `infisical.env`.

### 9.2 Configurazione iniziale

1. Apri l'interfaccia e crea l'account amministratore.
2. Crea un progetto e l'ambiente `prod`.
3. Carica i valori: dashboard → Secrets → Import (accetta un file di
   configurazione) oppure `infisical secrets set NOME=valore`.
4. Crea una **machine identity** con accesso in **sola lettura** a `prod` e
   generane il token.

Dal tuo portatile la CLI punta all'istanza così:

```bash
infisical login --domain http://infisical.<tuo-tailnet>.ts.net:8080
```

### 9.3 Collegamento dell'app

L'app raggiunge Infisical **per nome di container** sulla rete condivisa: dentro
un container `localhost` è il container stesso, non l'host.

In `docker-compose.yml` dell'app:

```yaml
services:
  app:
    build: .
    # env_file: ...                 ← non serve più
    environment:
      - NODE_ENV=production
      - BIND_HOST=0.0.0.0
      - INFISICAL_TOKEN=${INFISICAL_TOKEN}          # unico segreto di bootstrap
      - INFISICAL_DOMAIN=http://infisical-backend:8080
      - INFISICAL_ENV=prod
    networks: [web, infisical]

networks:
  web:
  infisical:
    external: true                  # creata da deploy/infisical/docker-compose.yml
```

`INFISICAL_TOKEN` va tenuto fuori dal repository: un `EnvironmentFile` di systemd
con permessi `0600`, oppure Docker secrets.

L'entrypoint del container ([`scripts/docker-entrypoint.sh`](../scripts/docker-entrypoint.sh))
riconosce il token e avvia il server sotto `infisical run --silent`. Se il token
c'è ma la CLI manca nell'immagine, **fallisce esplicitamente** invece di ripiegare
in silenzio su una configurazione senza segreti.

### 9.4 Verifica

```bash
docker compose run --rm app node scripts/check-secrets.js
```

Stampa nome, stato e lunghezza di ogni variabile, **mai un valore**. Quando è
verde puoi eliminare il file di configurazione dal VPS.

### 9.5 Ordine di avvio

L'app è **fail-closed**: se Infisical non risponde, non parte. Non serve però
orchestrare l'ordine: con `restart: unless-stopped` il container riprova finché
Infisical non è pronto, quindi dopo un reboot il sistema converge da solo.

Il rovescio della medaglia è che un disservizio di Infisical è un disservizio del
bot. È il prezzo di non avere segreti in chiaro sul disco: preferibile a un'app
che parte in stato degradato e opera senza le protezioni attese.

---

## 10. Rotazione della chiave di cifratura — runbook

Da eseguire **periodicamente** (es. ogni 6-12 mesi) e **immediatamente** in caso di
sospetta esposizione della chiave o del backup (§12).

Cosa viene ri-cifrato:

- `agent_wallets.encrypted_key` — chiavi agent Hyperliquid
- `settings.telegram_config.tokenEnc` — token del bot Telegram

### Procedura

**1. Backup, prima di tutto.**

```bash
./scripts/backup.sh && ./scripts/restore-verify.sh
```

**2. Aggiorna il portachiavi.** Sposta il segreto attuale tra le vecchie chiavi,
metti il nuovo come corrente, incrementa l'id:

```diff
- AGENT_ENCRYPTION_KEY=vecchioSegreto
- AGENT_ENCRYPTION_KEY_ID=1
- AGENT_ENCRYPTION_KEYS_OLD=
+ AGENT_ENCRYPTION_KEY=nuovoSegreto        # openssl rand -hex 32
+ AGENT_ENCRYPTION_KEY_ID=2
+ AGENT_ENCRYPTION_KEYS_OLD=1:vecchioSegreto
```

L'id nella lista `KEYS_OLD` **deve** corrispondere a quello con cui i dati sono
stati cifrati, altrimenti la decifratura fallisce.

**3. Verifica a vuoto** — non scrive nulla, mostra solo cosa farebbe:

```bash
npm run secrets:rotate
```

**4. Applica:**

```bash
npm run secrets:rotate -- --apply     # via npm: nota il `--` che passa il flag
# oppure: node scripts/rotate-encryption-key.js --apply
```

**5. Riavvia** (`docker compose restart app` o `npm run restart`) e verifica che i
bot operino e che la notifica Telegram funzioni.

**6. Dopo qualche giorno** di esercizio senza errori, svuota
`AGENT_ENCRYPTION_KEYS_OLD` e riavvia.

### Comportamento in caso di errore

Lo script è **conservativo per costruzione**: se un valore non è decifrabile
(chiave mancante nel portachiavi), lo **lascia intatto**, lo elenca in coda e esce
con codice 1. Non sovrascrive mai un segreto che non è riuscito a leggere —
sovrascriverlo significherebbe perderlo definitivamente.

Se compaiono errori: aggiungi la chiave mancante ad `AGENT_ENCRYPTION_KEYS_OLD`
col suo id e rilancia. Non forzare, non cancellare le righe.

Questo comportamento non è solo dichiarato: è verificato dai test
`test/rotateEncryptionKey.test.js` (dry-run che non scrive, rotazione che mantiene
i dati leggibili, valore non decifrabile lasciato byte-per-byte com'era) e
`test/checkSecrets.test.js`, che eseguono gli script veri su un DB temporaneo.

> **Nota per l'audit (8 agosto 2026).** Tra l'introduzione del key versioning
> (`fbd5402`, 7 agosto) e questa data, `scripts/rotate-encryption-key.js`
> leggeva una colonna DB inesistente (`address` invece di `master_address`) ed
> era **inutilizzabile per la rotazione delle chiavi agent** — falliva al
> primo `prepare()`, anche su un DB vuoto. Il runbook sopra descritto e il
> punto 4 di §12 non erano quindi mai stati eseguibili in quella finestra. Mai
> in produzione: il bug esisteva solo su `feat/perps-hardening`, non su
> `master`. Corretto e coperto dai test citati sopra durante lo Sprint 2
> (TEST-01), con verifica indipendente (i test falliscono ripristinando la
> colonna sbagliata).

### Se la chiave è persa davvero

Le chiavi agent nel DB non sono recuperabili. La via d'uscita esiste ed è
indolore sul piano dei fondi: **revoca l'agent dall'interfaccia Hyperliquid** (il
pannello dell'app sa solo *approvare* un agent, non revocarlo) e poi
**riapprovane uno nuovo** dal pannello. L'agent non custodisce capitale — solo il
permesso di firmare ordini — quindi il danno è operativo, non finanziario. Vale
la pena rigenerare anche il token Telegram.

---

## 11. Sicurezza della catena di fornitura (npm)

I segreti sono cifrati a riposo, ma **in esecuzione sono in chiaro nella memoria
del processo e nell'ambiente**. Qualsiasi dipendenza npm gira con gli stessi
privilegi dell'app: una libreria compromessa legge `.env` e le variabili
d'ambiente senza dover forzare alcuna cifratura. Per un progetto Node.js che
maneggia chiavi di trading, questa è la via d'attacco più realistica — vedi il
caso documentato in
[docs/KB/index/INDEX.md §D.1](KB/index/INDEX.md#d1--malicious-polymarket-bot-hides-in-hijacked-github-org),
dove il bersaglio primario del malware era esattamente il file `.env`.

**Già in atto**

- `Dockerfile` usa `npm ci --omit=dev`: installazione riproducibile dal lockfile,
  niente dipendenze di sviluppo in produzione.
- Il container gira come utente non-root (`node`).
- Immagini con tag fissati (`node:20-bookworm-slim`, `caddy:2`, Infisical su versione puntuale).

**Da adottare**

- **Rivedere il diff di `package-lock.json` a ogni aggiornamento.** È il punto di
  ingresso di questa classe di attacco: un pacchetto typosquattato entra come
  dipendenza transitiva e non compare mai in `package.json`.
- **Verificare i pacchetti nuovi** prima di aggiungerli: download count, data di
  pubblicazione, presenza di uno script `postinstall`, somiglianza sospetta col
  nome di un pacchetto noto.
- `npm audit signatures` e `npm audit` come step di CI.
- Valutare `ignore-scripts=true` in `.npmrc` — attenzione: `better-sqlite3` è un
  modulo nativo e **richiede** gli script di build, quindi va abilitato in modo
  mirato, non disattivato in blocco.
- Se il repo ha workflow GitHub Actions che installano dipendenze, aggiungere
  `step-security/harden-runner` con `egress-policy: block`: rileva connessioni di
  rete non previste durante `npm install`.

---

## 12. Risposta a un sospetto incidente

Se sospetti che il VPS, un backup o la chiave siano stati esposti, in quest'ordine:

1. **Ferma l'operatività.** Kill-switch (§8) con `closePositions: true`, oppure
   `/chiuditutto` da Telegram.
2. **Revoca l'agent dall'interfaccia Hyperliquid.** Toglie la capacità di piazzare
   ordini anche a chi ha già la chiave. È l'azione che interrompe il danno — falla
   per prima se hai un solo minuto. Va fatta su Hyperliquid, non dal pannello: qui
   puoi solo approvare un agent nuovo.
3. **Sposta i fondi** dal conto di trading. L'agent non può prelevare, quindi hai
   margine: usa il wallet master.
4. **Ruota tutti i segreti**: `AGENT_ENCRYPTION_KEY` (§10), `SESSION_SECRET` (invalida
   tutte le sessioni), `APP_PASSWORD_HASH`, `METRICS_TOKEN`, token Telegram, chiave
   Anthropic, e il token della machine identity Infisical.
5. **Se il sospetto è la supply chain npm** (§11): cerca i pacchetti sospetti in
   `node_modules/`, controlla `~/.ssh/authorized_keys` per chiavi che non riconosci
   e `ufw status` per porte aperte inattese, ricostruisci l'immagine da lockfile
   pulito.
6. **Ricostruisci l'host** se hai motivo di credere che l'accesso sia stato a
   livello di sistema. Ripristina i dati da un backup **precedente** alla finestra
   di compromissione e riapprova un agent nuovo.
