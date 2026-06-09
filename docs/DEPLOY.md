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
```

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
