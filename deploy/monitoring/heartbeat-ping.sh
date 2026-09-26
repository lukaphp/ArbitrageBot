#!/usr/bin/env bash
# =============================================================================
# Dead-man's switch — heartbeat verso un servizio ESTERNO all'host (issue #29)
#
# PERCHÉ: Prometheus → Alertmanager → Telegram vive dentro lo stesso host che
# dovrebbe sorvegliare. Se il VPS si spegne, se il demone Docker muore o se
# l'host perde la rete, l'alerting muore con l'applicazione: silenzio totale,
# indistinguibile dall'esterno da "tutto va bene". Nessuno script SU questo host
# può risolverlo da solo — per definizione. L'unica uscita è invertire la
# logica: un servizio esterno che avvisa per ASSENZA di ping, non per presenza
# di un alert. Questo script è il ping; la sveglia è del servizio esterno.
#
# COSA FA, in ordine:
#   1. controlla che lo stack locale sia vivo (app + Prometheus su loopback);
#   2. se è vivo → ping di successo   → il timer del servizio esterno si azzera;
#   3. se è rotto → ping di fallimento → il servizio esterno notifica SUBITO,
#      senza aspettare la scadenza della soglia di assenza.
#   Se l'host è morto non parte nessuno dei due, e scatta la soglia di assenza.
#
# CONFIGURAZIONE — nessun URL nel codice, nessun URL nel repo:
#   DEADMAN_PING_URL   (obbligatoria) URL di ping del servizio esterno. Contiene
#                      un token segreto: lo script NON lo stampa mai, nei log
#                      compare solo mascherato.
#   DEADMAN_APP_URL    (default http://127.0.0.1:3000/health)
#   DEADMAN_PROM_URL   (default http://127.0.0.1:9090/-/healthy)
#   DEADMAN_TIMEOUT    (default 10) secondi per ogni richiesta.
#   DEADMAN_ENV_FILE   (default /etc/arbitragebot/deadman.env) file `chmod 600`
#                      con `DEADMAN_PING_URL=...`, letto se la variabile non è
#                      già nell'ambiente. Tenerlo FUORI dal repo.
#
# INSTALLAZIONE E PASSI MANUALI: docs/DEPLOY.md §6.2.
# Uso a mano:  DEADMAN_PING_URL=... deploy/monitoring/heartbeat-ping.sh
# Uscita: 0 ping inviato (successo o fallimento), 1 errore di configurazione,
#         2 ping non consegnato (servizio esterno irraggiungibile).
# =============================================================================
set -euo pipefail

ENV_FILE="${DEADMAN_ENV_FILE:-/etc/arbitragebot/deadman.env}"

# `set -a` + source: prende le variabili dal file senza eseguire altro.
# Il file va letto solo se l'URL non è già in ambiente, così un'invocazione
# manuale può sovrascriverlo senza toccare il file. DEVE avvenire PRIMA di
# risolvere i default di APP_URL/PROM_URL/TIMEOUT qui sotto: se il file arriva
# dopo, un DEADMAN_APP_URL scritto lì non ha mai effetto — è già stato
# sostituito dal default hardcoded (bug osservato: lo script continuava a
# controllare 127.0.0.1:3000 con l'app reale in ascolto su 8080, nonostante
# DEADMAN_APP_URL fosse impostata in deadman.env).
if [[ -z "${DEADMAN_PING_URL:-}" && -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

APP_URL="${DEADMAN_APP_URL:-http://127.0.0.1:3000/health}"
PROM_URL="${DEADMAN_PROM_URL:-http://127.0.0.1:9090/-/healthy}"
TIMEOUT="${DEADMAN_TIMEOUT:-10}"
TAG="arbitragebot-deadman"

# Log su stderr E su syslog: il cron di solito manda la mail a nessuno, syslog
# resta consultabile con `journalctl -t arbitragebot-deadman`.
log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
  command -v logger >/dev/null 2>&1 && logger -t "$TAG" -- "$*" || true
}

# L'URL di ping È un segreto (token nel path). Mai in chiaro nei log e mai in
# argv visibile; qui si stampa host + i primi 4 caratteri del path, quanto basta
# a distinguere due endpoint senza rivelare il token.
# `.*` fino a fine riga di proposito: mascherare un solo segmento lascerebbe in
# chiaro tutti quelli dopo (es. /ping/<token>/fail → il token uscirebbe).
mask_url() {
  printf '%s' "$1" | sed -E 's#(://[^/]+/.{0,4}).*#\1…#'
}

if [[ -z "${DEADMAN_PING_URL:-}" ]]; then
  log "ERRORE: DEADMAN_PING_URL non impostata (né in ambiente né in $ENV_FILE). Vedi docs/DEPLOY.md §6.2"
  exit 1
fi
if [[ "$DEADMAN_PING_URL" != https://* ]]; then
  log "ERRORE: DEADMAN_PING_URL deve essere https:// — un ping in chiaro espone il token"
  exit 1
fi

# --- 1. stato dello stack locale ---------------------------------------------
# `--fail` perché un 502 del reverse proxy è un guasto, non una risposta.
probe() {
  curl -fsS -o /dev/null --max-time "$TIMEOUT" "$1"
}

reason=""
if ! probe "$APP_URL"; then
  reason="app non risponde su $APP_URL"
elif ! probe "$PROM_URL"; then
  reason="Prometheus non risponde su $PROM_URL"
fi

# --- 2. ping ------------------------------------------------------------------
# Convenzione Healthchecks.io (e compatibili): <url> = OK, <url>/fail = guasto.
# Se il servizio scelto usa un'altra convenzione, cambia SOLO questa riga.
ping_url="${DEADMAN_PING_URL%/}"
if [[ -n "$reason" ]]; then
  ping_url="${ping_url}/fail"
fi

# 3 tentativi: un ping perso per un TCP reset non deve far credere l'host morto.
# L'URL arriva da un file di config su stdin (`-K -`), non da argv: così non
# compare in `ps` per gli altri utenti dell'host.
if printf 'url = "%s"\n' "$ping_url" \
  | curl -fsS -o /dev/null --max-time "$TIMEOUT" --retry 3 --retry-delay 5 \
         --user-agent "$TAG" -K -; then
  if [[ -n "$reason" ]]; then
    log "ping di FALLIMENTO inviato a $(mask_url "$ping_url") — $reason"
  else
    log "heartbeat OK inviato a $(mask_url "$ping_url")"
  fi
  exit 0
fi

# Ping non consegnato: o il servizio esterno è giù, o è questo host a non avere
# rete in uscita. Nel secondo caso è il servizio esterno che, non ricevendo
# nulla, farà scattare la soglia di assenza: è esattamente il comportamento
# voluto, quindi qui non c'è niente da "riparare" localmente.
log "ERRORE: ping non consegnato a $(mask_url "$ping_url") dopo 3 tentativi${reason:+ (stack locale già guasto: $reason)}"
exit 2
