#!/usr/bin/env bash
# Verifica del RESTORE di un backup SQLite dei Perps.
# Un backup non verificato è un backup che non esiste: questo script ripristina
# l'ultimo backup (o uno indicato) su un DB temporaneo e ne controlla l'integrità
# e la presenza delle tabelle attese. NON tocca il DB di produzione.
#
# Uso:
#   ./scripts/restore-verify.sh                       # ultimo backup in ./backups
#   BACKUP_DIR=/home/deploy/backups ./scripts/restore-verify.sh
#   ./scripts/restore-verify.sh /percorso/perps-XXXX.db.gz   # backup specifico
#
# Esce con codice 0 se il restore è integro, !=0 altrimenti (usabile in cron/CI).

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
ARG_BACKUP="${1:-}"
EXPECTED_TABLES=(bots positions trades settings agent_wallets proposals audit)

# Individua il backup da verificare
if [ -n "$ARG_BACKUP" ]; then
  backup="$ARG_BACKUP"
else
  backup="$(ls -1t "$BACKUP_DIR"/perps-*.db.gz 2>/dev/null | head -n1 || true)"
fi

if [ -z "${backup:-}" ] || [ ! -f "$backup" ]; then
  echo "❌ Nessun backup da verificare (BACKUP_DIR=$BACKUP_DIR)" >&2
  exit 1
fi

echo "🔎 Verifica restore di: $backup"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
tmpdb="$tmpdir/restore.db"

# Decomprimi (o copia) su DB temporaneo
case "$backup" in
  *.gz) gunzip -c "$backup" > "$tmpdb" ;;
  *)    cp "$backup" "$tmpdb" ;;
esac

# 1) Integrità strutturale
integrity="$(sqlite3 "$tmpdb" 'PRAGMA integrity_check;')"
if [ "$integrity" != "ok" ]; then
  echo "❌ integrity_check fallito: $integrity" >&2
  exit 2
fi
echo "✅ integrity_check = ok"

# 2) Tabelle attese presenti
missing=()
for t in "${EXPECTED_TABLES[@]}"; do
  found="$(sqlite3 "$tmpdb" "SELECT name FROM sqlite_master WHERE type='table' AND name='$t';")"
  [ "$found" = "$t" ] || missing+=("$t")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "❌ Tabelle mancanti: ${missing[*]}" >&2
  exit 3
fi
echo "✅ Tabelle attese presenti (${EXPECTED_TABLES[*]})"

# 3) Conteggi indicativi (non bloccanti, solo informativi)
bots="$(sqlite3 "$tmpdb" 'SELECT COUNT(*) FROM bots;')"
pos="$(sqlite3 "$tmpdb" 'SELECT COUNT(*) FROM positions;')"
echo "ℹ️  Contenuto: $bots bot, $pos posizioni"

echo "✅ Restore verificato con successo."
