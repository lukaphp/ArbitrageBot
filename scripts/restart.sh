#!/usr/bin/env bash
# Riavvio dell'app Perps (sviluppo / VPS senza Docker).
# Ferma l'istanza in esecuzione (graceful, poi forzata) e ne avvia una nuova in
# background, scrivendo log e PID, e verifica /health.
#
# Uso:
#   ./scripts/restart.sh            # riavvia (porta da .env o 3000)
#   PORT=4000 ./scripts/restart.sh  # override porta
#   ./scripts/restart.sh stop       # solo stop
#   ./scripts/restart.sh status     # stato
#
# In produzione con Docker usa invece: docker compose restart (vedi docs/DEPLOY.md).

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-3000}"
LOG_DIR="logs"
LOG_FILE="$LOG_DIR/app.log"
PID_FILE="$LOG_DIR/app.pid"
ENTRY="src/server.js"

mkdir -p "$LOG_DIR"

# Ferma ogni processo che esegue il server (per PID file e per pattern).
stop_app() {
  local stopped=0
  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true; stopped=1
    fi
    rm -f "$PID_FILE"
  fi
  # Sweep di sicurezza: qualsiasi altra istanza dello stesso entrypoint.
  for pid in $(pgrep -f "node .*$ENTRY" 2>/dev/null || true); do
    kill "$pid" 2>/dev/null || true; stopped=1
  done
  if [ "$stopped" = 1 ]; then
    # Attende l'uscita pulita, poi forza se necessario.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -f "node .*$ENTRY" >/dev/null 2>&1 || break
      sleep 0.5
    done
    for pid in $(pgrep -f "node .*$ENTRY" 2>/dev/null || true); do
      kill -9 "$pid" 2>/dev/null || true
    done
    echo "🛑 Istanza precedente fermata."
  else
    echo "ℹ️  Nessuna istanza in esecuzione."
  fi
}

status_app() {
  if pgrep -f "node .*$ENTRY" >/dev/null 2>&1; then
    echo "🟢 In esecuzione (PID: $(pgrep -f "node .*$ENTRY" | tr '\n' ' '))"
  else
    echo "🔴 Non in esecuzione."
  fi
}

start_app() {
  echo "🚀 Avvio app sulla porta ${PORT}..."
  # Avvio in background, scollegato dal terminale; log accodato.
  export PORT
  nohup node "$ENTRY" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Verifica /health (fino a ~15s).
  local ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done

  if [ "$ok" = 1 ]; then
    echo "✅ App avviata (PID $pid) — http://127.0.0.1:$PORT  ·  log: $LOG_FILE"
  else
    echo "❌ Avvio non confermato entro il timeout. Ultime righe di log:" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    exit 1
  fi
}

case "${1:-restart}" in
  stop)    stop_app ;;
  status)  status_app ;;
  start)   start_app ;;
  restart) stop_app; start_app ;;
  *) echo "Uso: $0 [restart|stop|start|status]" >&2; exit 2 ;;
esac
