# Deploy in produzione — VPS + Docker (mainnet, single-user)

Guida per far girare ArbitrageBot **24/7** in sicurezza su un piccolo VPS, con
denaro reale su Hyperliquid mainnet, accessibile **solo a te**.

> ⚠️ Il server custodisce una **chiave agent** capace di **piazzare ordini reali**
> (non può prelevare). Tratta `.env` e il volume `perps-data` come segreti critici.

---

## 0. Perché NON serverless (Vercel)

I bot girano in un loop persistente (`setInterval`) e scrivono su SQLite
(`better-sqlite3`, nativo). Il serverless è stateless, effimero e a tempo: **non
può** tenere i bot attivi né conservare il database. Serve un **processo
persistente** → VPS o container. Il vecchio `vercel.json` non va usato per l'app live.

---

## 1. Provisioning del VPS

- Provider consigliato: **Hetzner CX22** (~4€/mese) o DigitalOcean (1 vCPU/2GB bastano).
- SO: Debian 12 / Ubuntu 22.04.
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

## 2. Codice e segreti

```bash
git clone <repo> /home/deploy/arbitragebot && cd /home/deploy/arbitragebot
cp .env.example .env && chmod 600 .env
```

Genera i segreti e mettili in `.env`:

```bash
# Password del pannello
node scripts/hash-password.js 'una-password-lunga-e-robusta'   # -> APP_PASSWORD_HASH=...
openssl rand -hex 32                                            # -> SESSION_SECRET=...
openssl rand -hex 32                                            # -> AGENT_ENCRYPTION_KEY=...
```

Imposta in `.env` almeno:

```
NODE_ENV=production
APP_PASSWORD_HASH=scrypt$...
SESSION_SECRET=...
AGENT_ENCRYPTION_KEY=...           # >=32 char; NON cambiarla dopo aver salvato chiavi agent
APP_ORIGIN=https://trading.tuodominio.it
HYPERLIQUID_NETWORK=testnet        # parti da testnet, poi mainnet
ALLOW_MAINNET=false
PERPS_MAX_POSITION_USD=500         # cap prudenti
PERPS_MAX_DAILY_LOSS_USD=100
DEMO_EVM_ENABLED=false             # in produzione tieni la demo EVM DISATTIVATA
```

> **Modulo Arbitraggio EVM**: è una *demo educativa* a prezzi simulati (non arbitraggio
> reale). In produzione resta disattivata (`DEMO_EVM_ENABLED=false`, default): non vengono
> registrate le sue route né avviati i suoi servizi. Il prodotto in produzione è **solo Perps**.

> Se manca uno dei segreti obbligatori in `NODE_ENV=production`, **il server non parte**
> (fail-fast voluto). La chiave agent senza `AGENT_ENCRYPTION_KEY` interrompe l'avvio.

---

## 3. Esposizione: due opzioni

### Opzione A — consigliata per single-user: **Tailscale** (niente porte pubbliche)
Solo i tuoi dispositivi raggiungono il pannello; superficie d'attacco minima.

```bash
curl -fsSL https://tailscale.com/install.sh | sh && tailscale up
```

In `Caddyfile` usa il blocco `:8080` (in fondo al file) e pubblica la porta solo
sull'IP Tailscale, oppure raggiungi direttamente `http://<tailscale-ip>:3000`
mappando la porta dell'app in `docker-compose.yml` su `100.x.x.x:3000`.

### Opzione B — HTTPS pubblico con dominio
1. Punta un record DNS `A` del tuo dominio all'IP del VPS.
2. In `Caddyfile` sostituisci `trading.tuodominio.it` col tuo dominio.
3. Caddy ottiene e rinnova il certificato Let's Encrypt da solo.

In entrambi i casi la password app resta come secondo livello.

---

## 4. Avvio

```bash
docker compose up -d --build
docker compose logs -f app          # verifica il banner di avvio e l'auth ATTIVA
```

`restart: unless-stopped` riavvia i container dopo crash o reboot; i bot che erano
`running` ripartono da soli (`botManager.loadFromDb`).

---

## 5. Backup off-box

Backup notturno via cron (sull'host):

```bash
# crontab -e  (utente deploy)
0 3 * * *  DB_PATH=/var/lib/docker/volumes/arbitragebot_perps-data/_data/perps.db \
           BACKUP_DIR=/home/deploy/backups /home/deploy/arbitragebot/scripts/backup.sh
```

Poi sincronizza `/home/deploy/backups` **fuori dal VPS** (es. `rclone` verso object
storage, o `restic`). Fai una prova di **restore** prima di andare live.

---

## 6. Monitoraggio e allerte

- **Uptime**: punta UptimeRobot / healthchecks.io su `https://.../health`.
- **Telegram**: configura token + chat id nell'app → ricevi avvisi su entrate/uscite,
  errori e kill-switch, e puoi comandare i bot da chat (`/status`, `/chiuditutto`).
- Log: `docker compose logs`.

---

## 7. Checklist GO-LIVE mainnet

1. ✅ Segreti generati e `.env` a `600`; backup testato (restore ok).
2. ✅ Auth attiva (login richiesto), pannello non raggiungibile in chiaro dall'esterno.
3. ✅ **Dry-run su testnet** sul VPS: approva agent, 1 ordine manuale, 1 ciclo bot,
   kill-switch, `docker compose restart` → i bot ripartono, allerta Telegram arriva.
4. ✅ Passa a mainnet: `HYPERLIQUID_NETWORK=mainnet` **e** `ALLOW_MAINNET=true`,
   con **cap minimi**. Riavvia e rifai le verifiche con importi piccoli.
5. ✅ Finanzia solo il capitale che puoi permetterti di perdere. L'agent **non può
   prelevare**: tieni i fondi non operativi fuori dal conto di trading.

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

### Perché

- Sul VPS non resta alcun segreto in chiaro su disco.
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
senza stamparne i valori, ed è idempotente.

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

### 9.6 Rotazione della chiave di cifratura

Spostare la chiave di cifratura a riposo in Infisical ha senso proprio perché ora
è ruotabile: vedi `scripts/rotate-encryption-key.js` e il file di esempio della
configurazione.
