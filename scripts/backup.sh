#!/usr/bin/env bash
# Backup del database SQLite dei Perps (bot, posizioni, chiavi agent cifrate).
# Esegue un backup consistente con l'API .backup di sqlite3 e ruota i vecchi file.
#
# Uso (sul VPS, via cron notturno):
#   DB_PATH=/var/lib/docker/volumes/arbitragebot_perps-data/_data/perps.db \
#   BACKUP_DIR=/home/deploy/backups ./scripts/backup.sh
#
# Per backup off-box, dopo questo script sincronizza $BACKUP_DIR con rclone/restic
# verso object storage o un altro host (vedi docs/DEPLOY.md).

set -euo pipefail

DB_PATH="${DB_PATH:-./data/perps.db}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${RETENTION:-14}"   # quanti backup conservare

mkdir -p "$BACKUP_DIR"
ts="$(date +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/perps-$ts.db"

if [ ! -f "$DB_PATH" ]; then
  echo "❌ DB non trovato: $DB_PATH" >&2
  exit 1
fi

# Backup consistente (gestisce il WAL) — richiede sqlite3 installato.
sqlite3 "$DB_PATH" ".backup '$out'"
gzip -f "$out"
echo "✅ Backup creato: $out.gz"

# Rotazione: mantieni solo gli ultimi $RETENTION
ls -1t "$BACKUP_DIR"/perps-*.db.gz 2>/dev/null | tail -n +"$((RETENTION + 1))" | xargs -r rm -f
echo "🧹 Mantenuti gli ultimi $RETENTION backup in $BACKUP_DIR"
