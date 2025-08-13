# 🤖 Arbitrage Bot - Testnet Only

**Bot di arbitraggio sicuro per reti di test blockchain**

⚠️ **ATTENZIONE**: Questo bot funziona **SOLO su testnet**. Non utilizzare mai in mainnet senza audit completo di sicurezza.

## 🎯 Caratteristiche

- ✅ **Sicurezza First**: Nessuna esposizione di seed phrase o chiavi private
- 🔒 **Solo Testnet**: Protezioni integrate contro transazioni mainnet
- 🦊 **MetaMask Integration**: Connessione sicura wallet non-custodial
- 📊 **Multi-DEX**: Monitoraggio prezzi da Uniswap, SushiSwap, PancakeSwap, QuickSwap
- ⚡ **Real-time**: Analisi opportunità in tempo reale
- 🎯 **Smart Execution**: Simulazione e ottimizzazione gas automatica
- 📈 **Analytics**: Logging completo e reportistica
- 🌐 **Multi-Chain**: Supporto Ethereum, BSC, Polygon (testnet)

## 🏗️ Architettura

```
┌─────────────────────────────────────────────────────────────┐
│                    ARBITRAGE BOT                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   CONFIG    │    │   LOGGER    │    │    MAIN     │     │
│  │             │    │             │    │             │     │
│  │ • Networks  │    │ • Secure    │    │ • CLI       │     │
│  │ • DEXs      │    │ • Filtering │    │ • Scheduler │     │
│  │ • Tokens    │    │ • Reports   │    │ • Events    │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ BLOCKCHAIN  │    │ PRICE FEEDS │    │  ANALYZER   │     │
│  │             │    │             │    │             │     │
│  │ • MetaMask  │    │ • DEX APIs  │    │ • Detection │     │
│  │ • RPC       │    │ • WebSocket │    │ • Filtering │     │
│  │ • Security  │    │ • Cache     │    │ • Ranking   │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │  EXECUTOR   │    │ TRANSACTION │    │  MONITOR    │     │
│  │             │    │             │    │             │     │
│  │ • Simulate  │    │ • Security  │    │ • Status    │     │
│  │ • Execute   │    │ • Gas Opt   │    │ • Alerts    │     │
│  │ • Monitor   │    │ • Retry     │    │ • Reports   │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Installazione

### Prerequisiti

- **Node.js** >= 18.0.0
- **npm** o **yarn**
- **MetaMask** installato nel browser
- **Fondi testnet** per le transazioni

### 1. Clone Repository

```bash
git clone <repository-url>
cd ArbitrageBot
```

### 2. Installa Dipendenze

```bash
npm install
```

### 3. Configurazione

```bash
# Copia il file di esempio
cp .env.example .env

# Modifica la configurazione
nano .env
```

**Configurazione minima richiesta:**

```env
# Modalità (DEVE essere testnet)
NETWORK_MODE=testnet

# Il tuo indirizzo wallet (pubblico)
WALLET_ADDRESS=0x...

# RPC URLs per testnet
ETHEREUM_RPC_URL=https://goerli.infura.io/v3/YOUR_KEY
BSC_RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545
POLYGON_RPC_URL=https://rpc-mumbai.maticvigil.com
```

### 4. Setup Testnet

#### Ethereum Goerli/Sepolia
1. Vai su [Goerli Faucet](https://goerlifaucet.com/)
2. Richiedi ETH testnet
3. Configura MetaMask per Goerli

#### BSC Testnet
1. Vai su [BSC Faucet](https://testnet.binance.org/faucet-smart)
2. Richiedi BNB testnet
3. Aggiungi BSC Testnet a MetaMask:
   - Network Name: BSC Testnet
   - RPC URL: https://data-seed-prebsc-1-s1.binance.org:8545
   - Chain ID: 97
   - Symbol: BNB

#### Polygon Mumbai
1. Vai su [Mumbai Faucet](https://faucet.polygon.technology/)
2. Richiedi MATIC testnet
3. Aggiungi Mumbai a MetaMask:
   - Network Name: Mumbai
   - RPC URL: https://rpc-mumbai.maticvigil.com
   - Chain ID: 80001
   - Symbol: MATIC

## 🎮 Utilizzo

### Avvio Bot

```bash
# Modalità sviluppo (con auto-restart)
npm run dev

# Modalità produzione
npm start
```

### Interfaccia Comandi

Una volta avviato, il bot offre un'interfaccia interattiva:

```
📋 COMANDI DISPONIBILI:
  status        - Mostra stato del bot
  prices        - Mostra prezzi correnti
  opportunities - Mostra opportunità arbitraggio
  execute       - Esegui migliore opportunità
  connect       - Connetti MetaMask
  stats         - Mostra statistiche
  history       - Mostra storico transazioni
  help          - Mostra menu comandi
  quit          - Arresta il bot
```

### Esempio Output

```
🤖 ARBITRAGE BOT - TESTNET ONLY
=====================================

🔧 Validazione configurazione...
🔗 Inizializzazione connessioni blockchain...
📊 Avvio sistema raccolta prezzi...
🔍 Avvio analizzatore arbitraggio...
🚀 Bot di arbitraggio avviato con successo!
⚠️  MODALITÀ TESTNET ATTIVA - Nessuna transazione mainnet

📊 STATO BOT
=============
🤖 Bot: ATTIVO
⏱️  Uptime: 0h 2m 15s
🔒 Modalità: TESTNET ONLY

🔗 CONNESSIONI:
   MetaMask: ✅ Connesso
   Wallet: 0x742d35Cc6634C0532925a3b8D4C9db96590b5
   Rete: goerli
   Provider RPC: 3 reti
```

## 🔧 Configurazione Avanzata

### Parametri Arbitraggio

```env
# Profitto minimo per eseguire arbitraggio (2%)
MIN_PROFIT_PERCENTAGE=2.0

# Importo massimo per transazione (0.1 ETH)
MAX_TRANSACTION_AMOUNT=0.1

# Prezzo gas massimo (20 Gwei)
MAX_GAS_PRICE=20

# Tolleranza slippage (1%)
SLIPPAGE_TOLERANCE=1.0
```

### Sicurezza

```env
# Abilita controlli di sicurezza
ENABLE_SECURITY_CHECKS=true

# Abilita simulazione prima dell'esecuzione
ENABLE_SIMULATION=true

# Limite transazioni giornaliere
DAILY_TRANSACTION_LIMIT=50
```

### Logging

```env
# Livello log (debug, info, warn, error)
LOG_LEVEL=info

# Abilita log su file
ENABLE_FILE_LOGGING=true

# Directory log
LOG_DIRECTORY=./logs
```

## 📊 Monitoraggio

### Log Files

- `logs/arbitrage-YYYY-MM-DD.log` - Log giornalieri
- `logs/transactions-YYYY-MM-DD.log` - Storico transazioni
- `logs/errors-YYYY-MM-DD.log` - Log errori
- `logs/security-YYYY-MM-DD.log` - Alert sicurezza

### Metriche

- **Opportunità rilevate**: Numero opportunità identificate
- **Tasso successo**: Percentuale transazioni riuscite
- **Profitto medio**: Guadagno medio per transazione
- **Gas utilizzato**: Costi gas totali
- **Uptime**: Tempo di attività del bot

## 🛡️ Sicurezza

### Protezioni Integrate

- ✅ **Nessuna seed phrase**: Mai richiesta o memorizzata
- ✅ **Solo testnet**: Controlli multipli anti-mainnet
- ✅ **Validazione transazioni**: Simulazione preventiva
- ✅ **Limiti automatici**: Protezione da perdite eccessive
- ✅ **Log sicuri**: Nessun dato sensibile nei log
- ✅ **Connessioni HTTPS**: Solo connessioni sicure

### Best Practices

1. **Mai condividere** il file `.env`
2. **Utilizzare solo** fondi testnet
3. **Monitorare** i log per anomalie
4. **Aggiornare** regolarmente le dipendenze
5. **Testare** sempre su testnet prima di mainnet

## 🚨 Troubleshooting

### Errori Comuni

#### "MetaMask not connected"
```bash
# Soluzione:
1. Apri MetaMask
2. Seleziona una testnet supportata
3. Usa il comando 'connect' nel bot
```

#### "Insufficient funds"
```bash
# Soluzione:
1. Verifica saldo testnet
2. Richiedi fondi dai faucet
3. Riduci MAX_TRANSACTION_AMOUNT
```

#### "No opportunities found"
```bash
# Soluzione:
1. Verifica connessioni RPC
2. Controlla configurazione DEX
3. Riduci MIN_PROFIT_PERCENTAGE
```

#### "Gas price too high"
```bash
# Soluzione:
1. Aumenta MAX_GAS_PRICE
2. Attendi condizioni di rete migliori
3. Usa reti con gas più basso
```

### Debug Mode

```bash
# Avvia con debug completo
LOG_LEVEL=debug npm run dev
```

## 📈 Ottimizzazione Performance

### Configurazione Rete

```env
# Intervallo aggiornamento prezzi (ms)
PRICE_UPDATE_INTERVAL=5000

# Timeout richieste API (ms)
API_TIMEOUT=10000

# Cache TTL prezzi (ms)
PRICE_CACHE_TTL=30000
```

### Risorse Sistema

- **RAM**: Minimo 512MB, consigliato 1GB
- **CPU**: Minimo 1 core, consigliato 2+ core
- **Rete**: Connessione stabile, latenza <100ms

## 🔄 Aggiornamenti

```bash
# Controlla aggiornamenti
npm outdated

# Aggiorna dipendenze
npm update

# Aggiorna versioni major (attenzione!)
npm install package@latest
```

## 🤝 Contributi

1. Fork del repository
2. Crea feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit modifiche (`git commit -m 'Add AmazingFeature'`)
4. Push branch (`git push origin feature/AmazingFeature`)
5. Apri Pull Request

## 📄 Licenza

Questo progetto è rilasciato sotto licenza MIT. Vedi `LICENSE` per dettagli.

## ⚠️ Disclaimer

- **Solo per scopi educativi e di test**
- **Non utilizzare in mainnet senza audit**
- **Gli autori non sono responsabili per perdite**
- **Testare sempre su testnet prima**
- **Il trading comporta sempre dei rischi**

## 📞 Supporto

Per supporto e domande:

- 📧 Email: support@arbitragebot.dev
- 💬 Discord: [ArbitrageBot Community](https://discord.gg/arbitragebot)
- 📖 Wiki: [GitHub Wiki](https://github.com/arbitragebot/wiki)
- 🐛 Issues: [GitHub Issues](https://github.com/arbitragebot/issues)

---

**🚀 Happy Trading (on Testnet)! 🚀**