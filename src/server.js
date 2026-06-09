#!/usr/bin/env node

/**
 * 🌐 ARBITRAGE BOT - WEB SERVER
 * ===============================
 * 
 * Server Express per l'applicazione web di arbitraggio
 * - Serve l'interfaccia web HTML/CSS/JS
 * - Fornisce API REST per il bot
 * - Gestisce WebSocket per aggiornamenti real-time
 * - Integrazione completa con MetaMask
 * 
 * ⚠️  SOLO TESTNET - Nessuna transazione mainnet permessa
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import auth from './middleware/auth.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

// Importa moduli bot
import config from './config/config.js';
import logger from './utils/logger.js';
import blockchainConnection from './blockchain/connection.js';
import priceFeedManager from './data/priceFeeds.js';
import arbitrageAnalyzer from './analysis/arbitrageAnalyzer.js';
import transactionExecutor from './execution/transactionExecutor.js';

// Moduli Perps (Hyperliquid)
import db from './db/database.js';
import hyperliquid from './perps/hyperliquidClient.js';
import marketData from './perps/marketData.js';
import agentWallet from './perps/agentWallet.js';
import strategyEngine from './perps/strategyEngine.js';
import riskManager from './perps/riskManager.js';
import botManager from './perps/botManager.js';
import portfolio from './perps/portfolio.js';
import notifier from './perps/notifier.js';
import optimizer from './perps/optimizer.js';
import predictor from './perps/predictor.js';
import telegramControl from './perps/telegramControl.js';
import { runBacktest } from './perps/backtester.js';

// Sistema agentico (backbone + Analyst AI)
import agentRuntime from './agents/runtime.js';
import analyst from './agents/analyst/analyst.js';
import proposals from './agents/proposals.js';
import riskAgent from './agents/riskAgent.js';

// Setup paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carica configurazione
dotenv.config();

class ArbitrageBotServer {
  constructor() {
    this.app = express();
    // Dietro reverse proxy (Caddy): IP/protocollo corretti per cookie Secure e rate-limit
    this.app.set('trust proxy', 1);
    this.server = createServer(this.app);
    // CORS Socket.IO ristretto all'origine nota (default: stesso host)
    const appOrigin = process.env.APP_ORIGIN || true;
    this.io = new Server(this.server, {
      cors: { origin: appOrigin, methods: ["GET", "POST"], credentials: true }
    });
    // Autenticazione delle connessioni WebSocket
    this.io.use(auth.socketAuth);

    this.port = process.env.PORT || 3000;
    // In produzione si lega a localhost: l'esterno passa solo dal reverse proxy (Caddy).
    this.bindHost = process.env.BIND_HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');
    this.isRunning = false;
    this.connectedClients = new Set();
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupErrorHandling();
  }
  
  /**
   * Configura middleware Express
   */
  setupMiddleware() {
    // Header di sicurezza (CSP permissiva per la UI inline esistente + CDN charts)
    this.app.use(helmet({
      contentSecurityPolicy: false,        // la UI usa script inline + CDN; CSP gestita a parte se necessario
      crossOriginEmbedderPolicy: false
    }));

    // CORS ristretto all'origine dell'app (default: stesso host)
    const appOrigin = process.env.APP_ORIGIN;
    this.app.use(cors(appOrigin ? { origin: appOrigin, credentials: true } : { credentials: true }));

    // JSON parsing + cookie per la sessione
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(cookieParser());

    // Rate-limit globale sulle API
    this.app.use('/api', rateLimit({
      windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false
    }));

    // Serve file statici (UI pubblica: necessaria per mostrare il login)
    this.app.use(express.static(path.join(__dirname, '../public')));

    // Logging middleware (non logga i body, che possono contenere segreti)
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, { ip: req.ip });
      next();
    });

    // --- Gate di autenticazione: protegge tutte le /api/* tranne login/logout/status ---
    const publicApi = new Set(['/api/login', '/api/logout', '/api/auth/status']);
    this.app.use((req, res, next) => {
      if (!req.path.startsWith('/api/')) return next();  // statici, /, /health → pubblici
      if (publicApi.has(req.path)) return next();
      return auth.requireAuth(req, res, next);
    });
  }

  /** Rate-limiter stretto per il login (anti brute-force). */
  loginLimiter() {
    return rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
  }
  
  /**
   * Configura routes API
   */
  setupRoutes() {
    // Route principale - serve l'app web
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });

    // --- Autenticazione (single-user) ---
    this.app.get('/api/auth/status', (req, res) => {
      const enabled = auth.isAuthEnabled();
      const authenticated = !enabled || auth.verifyToken(req.cookies?.[auth.COOKIE]);
      res.json({ success: true, data: { enabled, authenticated } });
    });
    this.app.post('/api/login', this.loginLimiter(), (req, res) => {
      if (!auth.isAuthEnabled()) return res.json({ success: true, data: { authDisabled: true } });
      const { password } = req.body || {};
      if (!password || !auth.verifyPassword(password, process.env.APP_PASSWORD_HASH)) {
        return res.status(401).json({ success: false, error: 'Password errata' });
      }
      res.cookie(auth.COOKIE, auth.issueToken(), auth.cookieOptions());
      res.json({ success: true });
    });
    this.app.post('/api/logout', (req, res) => {
      res.clearCookie(auth.COOKIE, auth.cookieOptions());
      res.json({ success: true });
    });

    // API Status
    this.app.get('/api/status', async (req, res) => {
      try {
        const status = {
          bot: {
            running: this.isRunning,
            uptime: process.uptime(),
            mode: config.SECURITY_CONFIG.networkMode,
            executionMode: transactionExecutor.executionMode, // Aggiunto executionMode
            version: '1.0.0'
          },
          blockchain: blockchainConnection.getConnectionStatus(),
          priceFeeds: priceFeedManager.getStatus(),
          analyzer: arbitrageAnalyzer.getStats(),
          executor: transactionExecutor.getExecutionStats(),
          perps: { network: hyperliquid.getNetwork(), ...marketData.getStatus(), bots: botManager.listStates().length }
        };
        
        res.json({ success: true, data: status });
      } catch (error) {
        logger.error('Errore API status:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // API Prezzi
    this.app.get('/api/prices', async (req, res) => {
      try {
        // Vercel fix: Ensure data is loaded
        if (process.env.VERCEL && priceFeedManager.priceCache.size === 0) {
           await priceFeedManager.initializePriceCache();
        }

        const { network, token } = req.query;
        let prices;
        
        if (network && token) {
          // Prezzi per un token specifico
          prices = priceFeedManager.getTokenPrices(network, token);
        } else if (network) {
          // Prezzi per una rete specifica
          const allPrices = priceFeedManager.getAllCurrentPrices();
          prices = allPrices[network] || {};
        } else {
          // Tutti i prezzi
          prices = priceFeedManager.getAllCurrentPrices();
        }
        
        res.json({ success: true, data: prices });
      } catch (error) {
        logger.error('Errore API prices:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // API Opportunità
    this.app.get('/api/opportunities', async (req, res) => {
      try {
        // Vercel fix: Run analysis on demand
        if (process.env.VERCEL) {
           if (priceFeedManager.priceCache.size === 0) {
               await priceFeedManager.initializePriceCache();
           }
           await arbitrageAnalyzer.analyzeAllOpportunities();
        }

        const opportunities = arbitrageAnalyzer.getBestOpportunities();
        res.json({ success: true, data: opportunities });
      } catch (error) {
        logger.error('Errore API opportunities:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // API Statistiche
    this.app.get('/api/stats', async (req, res) => {
      try {
        const stats = arbitrageAnalyzer.getStats();
        const execStats = transactionExecutor.getExecutionStats();
        
        const enhancedStats = {
          totalOpportunities: stats.totalOpportunities || 0,
          recentOpportunities: stats.recentOpportunities || 0,
          executedTrades: execStats.totalExecutions || 0,
          totalProfit: execStats.totalProfit24h || 0,
          successRate: execStats.successRate || 0,
          isRunning: stats.isRunning,
          dailyLimit: stats.dailyLimit
        };
        res.json(enhancedStats);
       } catch (error) {
         logger.error('Errore API stats:', error);
         res.status(500).json({ success: false, error: error.message });
       }
     });
    
    // API Wallet Connection
    this.app.post('/api/wallet/connect', async (req, res) => {
      try {
        const { address, chainId } = req.body;
        
        if (!address || !chainId) {
          return res.status(400).json({
            success: false,
            error: 'Address e chainId richiesti'
          });
        }
        
        // Connetti wallet tramite blockchain connection
        const result = await blockchainConnection.connectMetaMaskFromBrowser(address, chainId);
        
        // Notifica tutti i client connessi
        this.io.emit('walletConnected', result);
        
        res.json({
          success: true,
          data: result
        });
        
      } catch (error) {
        logger.error('Errore connessione wallet:', error);
        res.status(400).json({
          success: false,
          error: error.message
        });
      }
    });
    
    // API Opportunità Specifica
    this.app.get('/api/opportunities/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const opportunity = arbitrageAnalyzer.getOpportunityById ? 
          arbitrageAnalyzer.getOpportunityById(id) : null;
        
        if (!opportunity) {
          return res.status(404).json({
            success: false,
            error: 'Opportunità non trovata'
          });
        }
        
        res.json({ success: true, data: opportunity });
      } catch (error) {
        logger.error('Errore API opportunity:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // API Simulazione
    this.app.post('/api/simulate/:opportunityId', async (req, res) => {
      try {
        const { opportunityId } = req.params;
        
        if (!transactionExecutor.simulateArbitrage) {
          return res.json({
            success: true,
            message: 'Simulazione non implementata - modalità demo'
          });
        }
        
        const result = await transactionExecutor.simulateArbitrage(opportunityId);
        
        res.json({
          success: true,
          message: 'Simulazione completata',
          data: result
        });
      } catch (error) {
        logger.error('Errore simulazione:', error);
        res.status(400).json({
          success: false,
          error: error.message
        });
      }
    });

    // API Esecuzione
    this.app.post('/api/execute/:opportunityId', async (req, res) => {
      try {
        const { opportunityId } = req.params;
        const { walletAddress } = req.body;
        
        // In modalità testnet, permettiamo l'esecuzione senza wallet per la simulazione
        if (config.SECURITY_CONFIG.networkMode !== 'testnet') {
          if (!walletAddress) {
            return res.status(400).json({ 
              success: false, 
              error: 'Wallet address richiesto' 
            });
          }
          
          if (!blockchainConnection.isConnected) {
            return res.status(400).json({
              success: false,
              error: 'Wallet non connesso'
            });
          }
        }
        
        const opportunity = arbitrageAnalyzer.getOpportunityById(opportunityId);
        if (!opportunity) {
          return res.status(404).json({ 
            success: false, 
            error: 'Opportunità non trovata' 
          });
        }
        
        if (!transactionExecutor.executeArbitrage) {
          return res.status(400).json({
            success: false,
            error: 'Esecuzione non implementata - modalità demo'
          });
        }
        
        // In modalità testnet, usa un indirizzo fittizio se non fornito
        const effectiveWalletAddress = walletAddress || (config.SECURITY_CONFIG.networkMode === 'testnet' ? '0x0000000000000000000000000000000000000000' : null);
        
        const result = await transactionExecutor.executeArbitrage(opportunity, effectiveWalletAddress);
        
        // Notifica tutti i client
        this.io.emit('transactionUpdate', {
          type: 'execution',
          opportunityId,
          result
        });
        
        res.json({ success: true, data: result });
        
      } catch (error) {
        logger.error('Errore API execute:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // API Statistiche
    this.app.get('/api/stats', async (req, res) => {
      try {
        const stats = {
          execution: transactionExecutor.getExecutionStats(),
          analyzer: arbitrageAnalyzer.getStats(),
          priceFeeds: priceFeedManager.getStatus()
        };
        res.json({ success: true, data: stats });
      } catch (error) {
        logger.error('Errore API stats:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // API History
    this.app.get('/api/history', async (req, res) => {
      try {
        const { limit = 100 } = req.query;
        // Se limit è 'all', restituisce tutto (fino al limite interno del transactionExecutor)
        const limitVal = limit === 'all' ? 1000 : parseInt(limit);
        const history = transactionExecutor.getRecentExecutions(limitVal);
        res.json({ success: true, data: history });
      } catch (error) {
        logger.error('Errore API history:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // API Settings - Cambio modalità esecuzione
    this.app.post('/api/settings', async (req, res) => {
      try {
        const { executionMode } = req.body;
        
        if (executionMode !== 'simulation' && executionMode !== 'testnet') {
           return res.status(400).json({ success: false, error: 'Modalità non valida' });
        }
        
        // Aggiorna modalità esecutore
        transactionExecutor.setExecutionMode(executionMode);
        
        // Aggiorna modalità prezzi (Simulazione = Mock, Testnet = Reali)
        const isSimulation = executionMode === 'simulation';
        priceFeedManager.setSimulationMode(isSimulation);
        
        logger.info(`⚙️ Impostazioni aggiornate: Mode=${executionMode}`);
        
        res.json({ 
            success: true, 
            mode: executionMode,
            message: `Modalità cambiata in ${executionMode.toUpperCase()}`
        });
      } catch (error) {
        logger.error('Errore API settings:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Serve index.html per tutte le altre route (SPA)

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Route del sottosistema Perps (Hyperliquid)
    this.setupPerpsRoutes();
  }

  /**
   * Route API per il trading Perps su Hyperliquid.
   * Tutte sotto /api/perps/*. Indipendenti dal modulo arbitraggio.
   */
  setupPerpsRoutes() {
    const app = this.app;

    // Stato rete + switch testnet/mainnet
    app.get('/api/perps/network', (req, res) => {
      res.json({ success: true, network: hyperliquid.getNetwork() });
    });

    app.post('/api/perps/network', async (req, res) => {
      try {
        const { network, confirm } = req.body;
        if (network === 'mainnet' && !confirm) {
          return res.status(400).json({ success: false, error: 'Conferma richiesta per passare a MAINNET (fondi reali)' });
        }
        hyperliquid.setNetwork(network);
        await marketData.refreshMarkets().catch(() => {});
        this.io.emit('perps:network', { network });
        res.json({ success: true, network });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Lista mercati con leva max e mid
    app.get('/api/perps/markets', async (req, res) => {
      try {
        const markets = marketData.getMarkets().length
          ? marketData.getMarkets()
          : await marketData.refreshMarkets();
        res.json({ success: true, data: markets });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Ordini aperti (trigger TP/SL inclusi) per i livelli sul grafico
    app.get('/api/perps/orders', async (req, res) => {
      try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ success: false, error: 'address richiesto' });
        const orders = await hyperliquid.getFrontendOpenOrders(address);
        res.json({ success: true, data: orders });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Storico operazioni eseguite (fill Hyperliquid: manuali + bot)
    app.get('/api/perps/fills', async (req, res) => {
      try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ success: false, error: 'address richiesto' });
        const fills = await hyperliquid.getUserFills(address);

        // Attribuzione al bot d'origine: mappa oid->bot dai trade registrati,
        // più fallback per coin con un solo bot.
        const bots = db.listBots();
        const botById = new Map(bots.map(b => [b.id, b.name]));
        const oidToBot = new Map();
        for (const t of db.listTrades(500)) {
          if (t.hl_oid != null) oidToBot.set(String(t.hl_oid), t.bot_id ? (botById.get(t.bot_id) || 'Bot') : 'Manuale');
        }
        const coinBots = {};
        for (const b of bots) (coinBots[b.coin] ||= new Set()).add(b.name);

        const enriched = fills.map(f => {
          let botName = oidToBot.get(String(f.oid));
          if (!botName) {
            const s = coinBots[f.coin];
            botName = (s && s.size === 1) ? [...s][0] : null;
          }
          return { ...f, botName };
        });
        res.json({ success: true, data: enriched });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Stato account (equity, margine, posizioni)
    app.get('/api/perps/account', async (req, res) => {
      try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ success: false, error: 'address richiesto' });
        const account = await hyperliquid.getAccount(address);

        // Arricchisce le posizioni aperte con bot d'origine + data di apertura
        // incrociando le posizioni 'open' tracciate nel nostro DB (per coin+lato).
        const bots = db.listBots();
        const botById = new Map(bots.map(b => [b.id, b.name]));
        const coinBots = {};
        for (const b of bots) (coinBots[b.coin] ||= new Set()).add(b.name);
        const dbOpen = db.listPositions(200).filter(p => p.status === 'open');
        const key = (coin, side) => `${coin}|${side}`;
        const dbMap = new Map();
        for (const p of dbOpen) dbMap.set(key(p.coin, p.side), p);

        account.positions = account.positions.map(p => {
          const match = dbMap.get(key(p.coin, p.side)) || dbMap.get(key(p.coin + '-PERP', p.side));
          let botName = match ? (match.bot_id ? (botById.get(match.bot_id) || 'Bot') : 'Manuale') : null;
          if (!botName) { const s = coinBots[p.coin]; botName = (s && s.size === 1) ? [...s][0] : null; }
          return { ...p, botName, openedAt: match?.opened_at || null };
        });
        res.json({ success: true, data: account });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // --- Agent wallet ---
    app.get('/api/perps/agent/status', (req, res) => {
      try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ success: false, error: 'address richiesto' });
        res.json({ success: true, data: agentWallet.getStatus(address, hyperliquid.getNetwork()) });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Genera agent + azione approveAgent da firmare con MetaMask
    app.post('/api/perps/agent/prepare', (req, res) => {
      try {
        const { address, agentName, signatureChainId } = req.body;
        const network = hyperliquid.getNetwork();
        const result = agentWallet.prepareApproval(address, network, agentName || '', signatureChainId);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Invia l'azione approveAgent firmata a Hyperliquid e marca approvato
    app.post('/api/perps/agent/submit', async (req, res) => {
      try {
        const { address, action, signature } = req.body;
        const network = hyperliquid.getNetwork();
        // MetaMask restituisce una firma esadecimale singola: splittala in {r,s,v}
        const sig = ethers.Signature.from(signature);
        const result = await hyperliquid.submitSignedAction(action, { r: sig.r, s: sig.s, v: sig.v }, network);
        agentWallet.markApproved(address, network, action.agentAddress);
        hyperliquid.resetSignSdk(address, network);
        this.io.emit('perps:agentStatus', agentWallet.getStatus(address, network));
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore approveAgent:', error.message);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // --- Trasferimento Spot <-> Perp (usdClassTransfer, firmato da MetaMask) ---
    app.post('/api/perps/transfer/prepare', (req, res) => {
      try {
        const { address, amount, toPerp, signatureChainId } = req.body;
        const network = hyperliquid.getNetwork();
        const result = agentWallet.prepareUsdClassTransfer(
          address, network, amount, toPerp !== false, signatureChainId
        );
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.post('/api/perps/transfer/submit', async (req, res) => {
      try {
        const { action, signature } = req.body;
        const network = hyperliquid.getNetwork();
        const sig = ethers.Signature.from(signature);
        const result = await hyperliquid.submitSignedAction(action, { r: sig.r, s: sig.s, v: sig.v }, network);
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore trasferimento Spot/Perp:', error.message);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Backtest di una strategia sui dati storici
    app.post('/api/perps/backtest', async (req, res) => {
      try {
        const { coin, config: botConfig, interval, lookbackDays } = req.body;
        if (!coin || !botConfig) return res.status(400).json({ success: false, error: 'coin e config richiesti' });
        const result = await runBacktest(botConfig, coin, { interval, lookbackDays });
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore backtest:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Ottimizzazione parametri (Hyperopt + walk-forward)
    app.post('/api/perps/optimize', async (req, res) => {
      try {
        const { coin, config: botConfig, interval, lookbackDays, method, maxEvals, objective, oosFraction } = req.body;
        if (!coin || !botConfig) return res.status(400).json({ success: false, error: 'coin e config richiesti' });
        const result = await optimizer.optimize(botConfig, coin, { interval, lookbackDays, method, maxEvals, objective, oosFraction });
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore optimize:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Stima ML (FreqAI-lite): probabilità di rialzo per la candela corrente
    app.get('/api/perps/predict', async (req, res) => {
      try {
        const { coin, interval = '15m' } = req.query;
        if (!coin) return res.status(400).json({ success: false, error: 'coin richiesto' });
        const result = await predictor.predict(coin, interval);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // (Ri)addestramento esplicito del modello ML
    app.post('/api/perps/predict/train', async (req, res) => {
      try {
        const { coin, interval = '15m', lookbackDays } = req.body;
        if (!coin) return res.status(400).json({ success: false, error: 'coin richiesto' });
        const result = await predictor.train(coin, interval, { lookbackDays });
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore train ML:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Stato del controllo comandi Telegram
    app.get('/api/perps/telegram/status', (req, res) => {
      res.json({ success: true, data: telegramControl.status() });
    });

    // 🛑 Kill-switch: ferma tutti i bot e (opzionale) chiude tutte le posizioni
    app.post('/api/perps/killswitch', async (req, res) => {
      try {
        const closePositions = req.body?.closePositions === true;
        // Attiva il flag persistente: il RiskAgent bloccherà ogni nuova apertura
        riskAgent.setKillSwitch(true);
        const states = botManager.listStates();
        for (const s of states) {
          if (s.status === 'running') { try { botManager.stopBot(s.id); } catch { /* noop */ } }
        }
        let closed = [];
        if (closePositions) {
          const master = req.body?.masterAddress
            || [...botManager.bots.values()][0]?.masterAddress
            || process.env.WALLET_ADDRESS;
          const network = [...botManager.bots.values()][0]?.network || hyperliquid.network;
          if (master) {
            const acc = await hyperliquid.getAccount(master, network);
            for (const p of acc.positions) {
              try { const r = await hyperliquid.closePosition({ masterAddress: master, coin: p.coin }, network); closed.push({ coin: p.coin, ok: !r.error }); }
              catch (e) { closed.push({ coin: p.coin, ok: false, error: e.message }); }
            }
          }
        }
        notifier.notify(`🛑 <b>KILL-SWITCH</b> attivato: ${states.filter(s => s.status === 'running').length} bot fermati${closePositions ? `, posizioni chiuse: ${closed.length}` : ''}`);
        logger.warn('🛑 Kill-switch attivato', { closePositions, closed: closed.length });
        res.json({ success: true, data: { stopped: states.length, closed } });
      } catch (error) {
        logger.error('Errore kill-switch:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Candele storiche (per grafici e backtest UI)
    app.get('/api/perps/candles', async (req, res) => {
      try {
        const { coin, interval = '15m', lookback } = req.query;
        if (!coin) return res.status(400).json({ success: false, error: 'coin richiesto' });
        const lookbackMs = lookback ? parseInt(lookback) : 1000 * 60 * 60 * 24 * 3;
        const candles = await hyperliquid.getCandles(coin, interval, lookbackMs);
        res.json({ success: true, data: candles });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // --- Bot ---
    app.get('/api/perps/bots', (req, res) => {
      res.json({ success: true, data: botManager.listStates() });
    });

    // Monitor live: cosa sta valutando il bot (indicatori vs soglie, distanza al segnale)
    app.get('/api/perps/bots/:id/monitor', async (req, res) => {
      try {
        res.json({ success: true, data: await botManager.getMonitor(req.params.id) });
      } catch (error) {
        res.status(404).json({ success: false, error: error.message });
      }
    });

    // Statistiche reali di un bot (trade chiusi)
    app.get('/api/perps/bots/:id/stats', (req, res) => {
      try {
        res.json({ success: true, data: db.getBotStats(req.params.id) });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post('/api/perps/bots', (req, res) => {
      try {
        const { name, coin, masterAddress, config: botConfig } = req.body;
        const state = botManager.createBot({
          name, coin, masterAddress, network: hyperliquid.getNetwork(), config: botConfig
        });
        res.json({ success: true, data: state });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.patch('/api/perps/bots/:id', (req, res) => {
      try {
        const state = botManager.updateBot(req.params.id, req.body);
        res.json({ success: true, data: state });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.delete('/api/perps/bots/:id', (req, res) => {
      try {
        botManager.deleteBot(req.params.id);
        res.json({ success: true });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.post('/api/perps/bots/:id/start', (req, res) => {
      try {
        res.json({ success: true, data: botManager.startBot(req.params.id) });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.post('/api/perps/bots/:id/stop', (req, res) => {
      try {
        res.json({ success: true, data: botManager.stopBot(req.params.id) });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // --- Ordine manuale ---
    app.post('/api/perps/order', async (req, res) => {
      try {
        const { masterAddress, coin, side, sizeUsd, size, leverage, tp, sl, slippage } = req.body;
        if (!masterAddress || !coin || !side) {
          return res.status(400).json({ success: false, error: 'masterAddress, coin e side richiesti' });
        }
        const network = hyperliquid.getNetwork();
        const lev = leverage || config.HYPERLIQUID_CONFIG.risk.defaultLeverage;
        const mid = await hyperliquid.getMid(coin, network);
        if (!mid) throw new Error(`Prezzo non disponibile per ${coin}`);

        const market = marketData.getMarkets().find(m => m.coin === coin);
        const szDecimals = market?.szDecimals ?? 3;

        // size esplicita oppure derivata dal notional USD
        let orderSize = size;
        if (!orderSize) {
          const notional = (sizeUsd || 0) * 1; // sizeUsd = notional desiderato
          orderSize = riskManager.roundSize(notional / mid, szDecimals);
        }
        if (!orderSize || orderSize <= 0) throw new Error('Size non valida');

        // Limiti di rischio
        const account = await hyperliquid.getAccount(masterAddress, network);
        const plan = { notionalUsd: orderSize * mid, leverage: lev };
        const check = riskManager.checkLimits({ leverage: lev }, account, plan, 0);
        if (!check.ok) return res.status(400).json({ success: false, error: check.reason });

        await hyperliquid.setLeverage(masterAddress, coin, lev, 'cross', network);
        const isBuy = side === 'long';
        const order = await hyperliquid.placeMarketOrder({
          masterAddress, coin, isBuy, size: orderSize, slippage: slippage ?? 0.02
        }, network);
        if (order.error) throw new Error(order.error);

        // TP/SL opzionali
        const entryPx = order.avgPx || mid;
        const tpsl = riskManager.computeTpSl(entryPx, side, {
          tp: tp ? { enabled: true, mode: tp.mode || 'percent', value: tp.value } : { enabled: false },
          sl: sl ? { enabled: true, mode: sl.mode || 'percent', value: sl.value } : { enabled: false }
        });
        const closeIsBuy = side === 'short';
        if (tpsl.tpPx) {
          await hyperliquid.placeTriggerOrder({ masterAddress, coin, isBuy: closeIsBuy, size: orderSize, triggerPx: tpsl.tpPx, tpsl: 'tp' }, network).catch(e => logger.warn('TP fallito', e.message));
        }
        if (tpsl.slPx) {
          await hyperliquid.placeTriggerOrder({ masterAddress, coin, isBuy: closeIsBuy, size: orderSize, triggerPx: tpsl.slPx, tpsl: 'sl' }, network).catch(e => logger.warn('SL fallito', e.message));
        }

        db.insertTrade({ coin, side, px: entryPx, sz: orderSize, hlOid: order.oid });
        this.io.emit('perps:fill', { coin, side, size: orderSize, px: entryPx });
        res.json({ success: true, data: { order, entryPx, size: orderSize, ...tpsl } });
      } catch (error) {
        logger.error('Errore ordine Perps:', error.message);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Chiusura manuale di una posizione
    app.post('/api/perps/positions/:coin/close', async (req, res) => {
      try {
        const { masterAddress } = req.body;
        const coin = decodeURIComponent(req.params.coin);
        const result = await hyperliquid.closePosition({ masterAddress, coin }, hyperliquid.getNetwork());
        this.io.emit('perps:position', { coin, closed: true });
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // --- Risk di portafoglio (limiti globali) ---
    app.get('/api/perps/portfolio', (req, res) => {
      res.json({ success: true, data: portfolio.getLimits() });
    });
    app.post('/api/perps/portfolio', (req, res) => {
      try {
        res.json({ success: true, data: portfolio.setLimits(req.body || {}) });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // --- Notifiche Telegram ---
    app.get('/api/perps/notifications', (req, res) => {
      res.json({ success: true, data: notifier.status() });
    });
    app.post('/api/perps/notifications', (req, res) => {
      try {
        const data = notifier.setConfig(req.body || {});
        // (Ri)avvia o ferma il polling dei comandi Telegram in base alla nuova config
        telegramControl.refresh();
        res.json({ success: true, data });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });
    app.post('/api/perps/notifications/test', async (req, res) => {
      try {
        const ok = await notifier.notify('✅ Test notifica da ArbitrageBot Perps');
        res.json({ success: true, data: { sent: ok } });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Webhook segnali esterni (TradingView-style)
    app.post('/api/perps/webhook', (req, res) => {
      try {
        const { coin, signal, secret } = req.body;
        if (process.env.PERPS_WEBHOOK_SECRET && secret !== process.env.PERPS_WEBHOOK_SECRET) {
          return res.status(401).json({ success: false, error: 'Secret non valido' });
        }
        if (!coin || !signal) return res.status(400).json({ success: false, error: 'coin e signal richiesti' });
        strategyEngine.pushExternalSignal(coin, signal);
        res.json({ success: true });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ===== Sistema agentico + Analyst AI =====
    app.get('/api/agents/status', (req, res) => {
      res.json({ success: true, data: {
        runtime: agentRuntime.status(),
        analyst: analyst.status(),
        killSwitch: riskAgent.isKillSwitchOn()
      }});
    });

    app.get('/api/agents/proposals', (req, res) => {
      const status = req.query.status || undefined;
      res.json({ success: true, data: proposals.list({ status, limit: 50 }) });
    });

    app.post('/api/agents/proposals/:id/approve', async (req, res) => {
      try {
        const r = await proposals.approve(req.params.id);
        res.json({ success: r.ok, data: r, error: r.ok ? undefined : r.reason });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post('/api/agents/proposals/:id/reject', (req, res) => {
      const r = proposals.reject(req.params.id);
      res.json({ success: r.ok, data: r, error: r.ok ? undefined : r.reason });
    });

    // Collega un bot creato a una proposta approvata (per seguirne l'esito)
    app.post('/api/agents/proposals/:id/link', (req, res) => {
      try {
        const { botId } = req.body || {};
        if (!botId) return res.status(400).json({ success: false, error: 'botId richiesto' });
        res.json({ success: true, data: proposals.linkBot(req.params.id, botId) });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Storico strategie (approvate/rifiutate) con esito live di quelle avviate
    app.get('/api/agents/strategy-history', (req, res) => {
      res.json({ success: true, data: proposals.history() });
    });

    // Esegue subito un ciclo dell'Analyst (on-demand)
    app.post('/api/agents/analyst/run', async (req, res) => {
      try {
        const r = await analyst.run();
        res.json({ success: !r?.error, data: r, error: r?.error });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Audit trail
    app.get('/api/agents/audit', (req, res) => {
      res.json({ success: true, data: db.listAudit(parseInt(req.query.limit) || 100) });
    });

    // Kill-switch on/off esplicito (lo stato persiste e blocca le aperture)
    app.post('/api/agents/killswitch', (req, res) => {
      const on = req.body?.on !== false;
      riskAgent.setKillSwitch(on);
      res.json({ success: true, data: { killSwitch: on } });
    });
  }

  /**
   * Configura WebSocket per aggiornamenti real-time
   */
  setupWebSocket() {
    this.io.on('connection', (socket) => {
      logger.info('🔌 Client connesso via WebSocket', { socketId: socket.id });
      this.connectedClients.add(socket.id);
      
      // Invia stato iniziale
      socket.emit('status', {
        bot: { running: this.isRunning },
        blockchain: blockchainConnection.getConnectionStatus()
      });
      
      // Gestisci disconnessione
      socket.on('disconnect', () => {
        logger.info('🔌 Client disconnesso', { socketId: socket.id });
        this.connectedClients.delete(socket.id);
      });
      
      // Gestisci richieste client
      socket.on('requestPrices', async (data) => {
        try {
          let prices;
          
          if (data.network && data.token) {
            // Prezzi per un token specifico
            prices = priceFeedManager.getTokenPrices(data.network, data.token);
          } else {
            // Tutti i prezzi
            prices = priceFeedManager.getAllCurrentPrices();
          }
          
          socket.emit('pricesUpdate', prices);
        } catch (error) {
          socket.emit('error', { message: error.message });
        }
      });
      
      socket.on('requestOpportunities', () => {
        try {
          const opportunities = arbitrageAnalyzer.getBestOpportunities();
          socket.emit('opportunitiesUpdate', opportunities);
        } catch (error) {
          socket.emit('error', { message: error.message });
        }
      });
    });
  }
  
  /**
   * Configura gestione errori
   */
  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ 
        success: false, 
        error: 'Endpoint non trovato' 
      });
    });
    
    // Error handler globale
    this.app.use((err, req, res, next) => {
      logger.error('Errore server:', err);
      res.status(500).json({ 
        success: false, 
        error: 'Errore interno del server' 
      });
    });
  }
  
  /**
   * Avvia il server e i moduli bot
   */
  async start() {
    try {
      logger.info('🚀 Avvio Arbitrage Bot Web Server...');
      
      // Validazione configurazione
      logger.info('🔧 Validazione configurazione...');
      config.validateConfig();
      
      // Inizializzazione moduli
      logger.info('🔗 Inizializzazione connessioni blockchain...');
      await blockchainConnection.initializeProviders();
      
      logger.info('📊 Avvio sistema raccolta prezzi...');
      await priceFeedManager.start();
      
      logger.info('🔍 Avvio analizzatore arbitraggio...');
      await arbitrageAnalyzer.start();
      
      logger.info('⚡ Executor pronto...');

      // Inizializzazione sottosistema Perps (Hyperliquid)
      try {
        logger.info('🗄️  Inizializzazione database Perps...');
        db.init();
        hyperliquid.init();
        logger.info('📈 Avvio market data Perps...');
        await marketData.start(this.io);
        botManager.setIo(this.io);
        botManager.loadFromDb();
        // Avvia il controllo comandi Telegram se configurato
        telegramControl.refresh();
        // Avvia il runtime degli agenti (Analyst AI + janitor proposte)
        agentRuntime.register(analyst);
        agentRuntime.register(proposals.janitorAgent());
        await agentRuntime.startAll();
        logger.info('🤖 Sottosistema Perps + agenti pronto');
      } catch (perpsError) {
        logger.error('⚠️ Errore inizializzazione Perps (arbitraggio resta attivo):', perpsError.message);
      }

      // Setup eventi per WebSocket
      this.setupBotEvents();
      
      // Avvia server HTTP
      this.server.listen(this.port, this.bindHost, () => {
        this.isRunning = true;
        logger.info(`🌐 Server avviato su http://${this.bindHost}:${this.port}`);
        logger.info(`🔐 Auth: ${auth.isAuthEnabled() ? 'ATTIVA' : 'DISATTIVA (solo sviluppo)'} · HL network: ${config.HYPERLIQUID_CONFIG.defaultNetwork}`);
        
        console.log(`
🤖 ARBITRAGE BOT WEB - TESTNET ONLY`);
        console.log(`=====================================`);
        console.log(`🌐 Web Interface: http://localhost:${this.port}`);
        console.log(`📊 API Endpoint: http://localhost:${this.port}/api`);
        console.log(`🔌 WebSocket: ws://localhost:${this.port}`);
        console.log(`⚠️  MODALITÀ TESTNET ATTIVA`);
        console.log(`=====================================\n`);
      });
      
    } catch (error) {
        logger.error('❌ Errore avvio server:', error.message || error);
        logger.info('🔄 Tentativo di avvio in modalità limitata...');
        
        // Avvia comunque il server web anche se alcuni moduli falliscono
        try {
          this.server.listen(this.port, this.bindHost, () => {
            this.isRunning = true;
            logger.info(`🌐 Server web attivo su http://${this.bindHost}:${this.port}`);
            logger.info('⚠️ Modalità limitata - Alcune funzionalità potrebbero non essere disponibili');
          });
        } catch (serverError) {
          logger.error('❌ Impossibile avviare server web:', serverError.message);
          process.exit(1);
        }
      }
    }
  
    /**
     * Setup eventi bot per WebSocket
     * NOTA: Commentato perché i moduli non estendono EventEmitter
     */
    setupBotEvents() {
    // Invia aggiornamenti periodici delle statistiche
    setInterval(() => {
      if (this.connectedClients.size > 0) {
        try {
          const stats = arbitrageAnalyzer.getStats();
          const execStats = transactionExecutor.getExecutionStats();
          
          const enhancedStats = {
            totalOpportunities: stats.totalOpportunities || 0,
            recentOpportunities: stats.recentOpportunities || 0,
            executedTrades: execStats.totalExecutions || 0,
            totalProfit: execStats.totalProfit24h || 0,
            successRate: execStats.successRate || 0,
            isRunning: stats.isRunning,
            dailyLimit: stats.dailyLimit
          };
          
          this.io.emit('statsUpdate', enhancedStats);
          
          // Invia anche aggiornamento opportunità
          const opportunities = arbitrageAnalyzer.getBestOpportunities();
          this.io.emit('opportunitiesUpdate', opportunities);
          
        } catch (error) {
          logger.error('Errore invio aggiornamenti WebSocket:', error);
        }
      }
    }, 15000); // Ogni 15 secondi
  }
  
  /**
   * Arresta il server gracefully
   */
  async stop() {
    logger.info('🛑 Arresto server...');
    
    this.isRunning = false;
    
    // Arresta moduli bot
    await priceFeedManager.stop();
    await arbitrageAnalyzer.stop();

    // Arresta sottosistema Perps
    try {
      botManager.stopAll();
      marketData.stop();
    } catch (error) {
      logger.error('Errore arresto Perps:', error.message);
    }
    
    // Chiudi connessioni WebSocket
    this.io.close();
    
    // Chiudi server HTTP
    this.server.close(() => {
      logger.info('✅ Server arrestato');
      process.exit(0);
    });
  }
}

// Istanza server
const server = new ArbitrageBotServer();

// Gestione segnali di arresto
process.on('SIGINT', () => server.stop());
process.on('SIGTERM', () => server.stop());

// Gestione errori non catturati
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  server.stop();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  server.stop();
});

// Avvia server solo se eseguito direttamente
if (process.argv[1] === __filename) {
  server.start();
}

// Per Vercel, esportiamo l'app express
export default server.app;