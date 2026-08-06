#!/usr/bin/env bash
# Genera i segreti necessari all'istanza Infisical self-hosted.
#
# Scrive deploy/infisical/infisical.env con permessi 0600. NON stampa mai un
# valore: solo quali variabili ha creato. È idempotente — se il file esiste già
# non lo tocca, per non invalidare un'istanza in esercizio.
#
# ATTENZIONE: ENCRYPTION_KEY cifra i segreti dentro Infisical. Se la perdi, i
# segreti conservati non sono più recuperabili. Mettila al sicuro (password
# manager) PRIMA di caricare qualcosa di importante.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="deploy/infisical/infisical.env"
SITE_URL="${SITE_URL:-http://localhost:8080}"

if [ -f "$OUT" ]; then
  echo "ℹ️  $OUT esiste già: non lo tocco."
  echo "   Per rigenerarlo (⚠️  invalida i segreti già caricati) rimuovilo a mano."
  exit 0
fi

command -v openssl >/dev/null || { echo "❌ serve openssl" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
umask 077   # il file nasce già 0600, senza finestra di esposizione

PG_PASS="$(openssl rand -hex 24)"

cat > "$OUT" <<EOF
# Generato da scripts/infisical-bootstrap.sh — NON committare.
# Contiene i segreti dell'istanza Infisical stessa.

# Cifratura dei segreti dentro Infisical (16 byte esadecimali).
# Se la perdi, i segreti conservati NON sono recuperabili.
ENCRYPTION_KEY=$(openssl rand -hex 16)

# Firma dei token di sessione di Infisical (32 byte base64).
AUTH_SECRET=$(openssl rand -base64 32)

# PostgreSQL interno
POSTGRES_USER=infisical
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=infisical
DB_CONNECTION_URI=postgres://infisical:${PG_PASS}@db:5432/infisical

# Redis interno
REDIS_URL=redis://redis:6379

# URL con cui raggiungi l'interfaccia. Cambialo se usi Tailscale, es.
#   SITE_URL=http://infisical.<tuo-tailnet>.ts.net:8080
SITE_URL=${SITE_URL}
EOF

chmod 600 "$OUT"

echo "✅ Creato $OUT (permessi $(stat -f '%Lp' "$OUT" 2>/dev/null || stat -c '%a' "$OUT"))"
echo "   Variabili generate: ENCRYPTION_KEY, AUTH_SECRET, POSTGRES_PASSWORD,"
echo "   DB_CONNECTION_URI, REDIS_URL, SITE_URL"
echo ""
echo "   Nessun valore è stato stampato. Prossimo passo:"
echo "     cd deploy/infisical && docker compose up -d"
