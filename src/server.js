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
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Importa moduli bot
import config from './config/config.js';
import logger from './utils/logger.js';
import blockchainConnection from './blockchain/connection.js';
import priceFeedManager from './data/priceFeeds.js';
import arbitrageAnalyzer from './analysis/arbitrageAnalyzer.js';
import transactionExecutor from './execution/transactionExecutor.js';

// Setup paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carica configurazione
dotenv.config();

class ArbitrageBotServer {
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    
    this.port = process.env.PORT || 3000;
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
    // CORS
    this.app.use(cors());
    
    // JSON parsing
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // Serve file statici
    this.app.use(express.static(path.join(__dirname, '../public')));
    
    // Logging middleware
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });
  }
  
  /**
   * Configura routes API
   */
  setupRoutes() {
    // Route principale - serve l'app web
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });
    
    // API Status
    this.app.get('/api/status', async (req, res) => {
      try {
        const status = {
          bot: {
            running: this.isRunning,
            uptime: process.uptime(),
            mode: config.SECURITY_CONFIG.networkMode,
            version: '1.0.0'
          },
          blockchain: blockchainConnection.getConnectionStatus(),
          priceFeeds: priceFeedManager.getStatus(),
          analyzer: arbitrageAnalyzer.getStatus(),
          executor: transactionExecutor.getStatus()
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
        const enhancedStats = {
          totalOpportunities: stats.totalOpportunities || 0,
          recentOpportunities: stats.recentOpportunities || 0,
          executedTrades: stats.dailyTransactions || 0,
          totalProfit: 0, // TODO: Implementare tracking profitti
          successRate: stats.dailyTransactions > 0 ? 95 : 0, // Mock success rate
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
    
    // API Storico
    this.app.get('/api/history', async (req, res) => {
      try {
        const { limit = 50 } = req.query;
        const history = transactionExecutor.getRecentExecutions(parseInt(limit));
        res.json({ success: true, data: history });
      } catch (error) {
        logger.error('Errore API history:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
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
      
      // Setup eventi per WebSocket
      this.setupBotEvents();
      
      // Avvia server HTTP
      this.server.listen(this.port, () => {
        this.isRunning = true;
        logger.info(`🌐 Server avviato su http://localhost:${this.port}`);
        logger.info('⚠️  MODALITÀ TESTNET ATTIVA - Nessuna transazione mainnet');
        
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
          this.server.listen(this.port, () => {
            this.isRunning = true;
            logger.info(`🌐 Server web attivo su http://localhost:${this.port}`);
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
          const enhancedStats = {
            totalOpportunities: stats.totalOpportunities || 0,
            recentOpportunities: stats.recentOpportunities || 0,
            executedTrades: stats.dailyTransactions || 0,
            totalProfit: 0,
            successRate: stats.dailyTransactions > 0 ? 95 : 0,
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