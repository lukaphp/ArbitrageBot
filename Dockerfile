# ArbitrageBot — immagine di produzione
# Node 20 (better-sqlite3 nativo richiede toolchain di build durante npm ci).
FROM node:20-bookworm-slim

# Dipendenze di build per i moduli nativi (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installa le dipendenze sfruttando la cache dei layer
COPY package*.json ./
RUN npm ci --omit=dev

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

CMD ["node", "src/server.js"]
