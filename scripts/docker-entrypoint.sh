#!/bin/sh
# Entrypoint del container.
#
# Se INFISICAL_TOKEN è presente, i segreti vengono iniettati nel processo da
# Infisical e nel container non resta alcun file di configurazione in chiaro.
# Se il token NON c'è, si avvia esattamente come prima (variabili passate da
# Docker): l'aggiornamento non rompe i deploy esistenti.
#
# Variabili riconosciute:
#   INFISICAL_TOKEN       token della machine identity (unico segreto di bootstrap)
#   INFISICAL_PROJECT_ID  id progetto (se non desumibile da .infisical.json)
#   INFISICAL_ENV         ambiente Infisical, es. "prod"
#
# SEC-06: la stessa condizione (NODE_ENV=production + INFISICAL_TOKEN assente)
# viene rilevata anche da src/config/config.js (validateConfig), che stampa un
# banner ben visibile all'avvio del processo Node — informativo, non bloccante.
set -e

if [ -n "${INFISICAL_TOKEN:-}" ]; then
  if ! command -v infisical >/dev/null 2>&1; then
    echo "❌ INFISICAL_TOKEN è impostato ma la CLI non è presente nell'immagine." >&2
    echo "   Ricostruisci l'immagine, oppure rimuovi il token per usare le variabili Docker." >&2
    exit 1
  fi
  set -- infisical run --silent
  [ -n "${INFISICAL_PROJECT_ID:-}" ] && set -- "$@" --projectId "$INFISICAL_PROJECT_ID"
  [ -n "${INFISICAL_ENV:-}" ] && set -- "$@" --env "$INFISICAL_ENV"
  echo "🔐 Segreti iniettati da Infisical"
  exec "$@" -- node src/server.js
fi

echo "ℹ️  Segreti dalle variabili d'ambiente Docker (Infisical non configurato)"
exec node src/server.js
