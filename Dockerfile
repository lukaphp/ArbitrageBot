# ArbitrageBot — immagine di produzione
# Node 20 (better-sqlite3 nativo richiede toolchain di build durante npm ci).
FROM node:20-bookworm-slim

# Dipendenze di build per i moduli nativi (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# CLI Infisical: serve solo se il container riceve INFISICAL_TOKEN. Senza token
# l'entrypoint la ignora, quindi la sua presenza non cambia il comportamento.
RUN curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
    && apt-get update && apt-get install -y --no-install-recommends infisical \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installa le dipendenze sfruttando la cache dei layer.
# .npmrc (ignore-scripts=true) blocca gli script preinstall/install/postinstall/
# prepare di TUTTE le dipendenze — vedi SEC-02. `npm ci` gira quindi senza
# eseguire alcuno script di terze parti; riabilitiamo poi in modo MIRATO solo
# quello che serve davvero per partire (better-sqlite3, modulo nativo: senza il
# suo script di build l'app non si avvia), NON riabilitando gli script in blocco.
#
# fsevents (watcher dev-only per macOS) e hyperliquid (SDK dell'exchange) restano
# bloccati di proposito: fsevents non serve in produzione (ed è comunque
# un'optional dependency solo-macOS, inerte su Linux); lo script "prepare"/
# "postinstall" di hyperliquid è stato ispezionato (node_modules/hyperliquid/
# package.json) ed è una no-op fuori da un checkout git locale — controlla
# `fs.existsSync('.git')`, cartella assente nel pacchetto scaricato da registry —
# e il pacchetto pubblica già la build compilata in dist/, quindi non c'è nulla
# da ricompilare: nessun bisogno di allowlist.
# NOTA: `npm rebuild` eredita ignore-scripts da .npmrc, quindi va sbloccato
# esplicitamente per questo solo pacchetto con --ignore-scripts=false — senza,
# `npm rebuild better-sqlite3` non farebbe nulla e il binario nativo mancherebbe.
COPY package*.json .npmrc ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3 --ignore-scripts=false

# Copia il resto del codice
COPY . .

# Utente non-root + cartella dati scrivibile (montata come volume)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV BIND_HOST=0.0.0.0
EXPOSE 3000

# Healthcheck sull'endpoint pubblico /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
