/**
 * ARBITRAGE BOT - MAIN APPLICATION
 * ===============================
 * 
 * Bot di arbitraggio sicuro per testnet
 * 
 * ATTENZIONE: Questo bot funziona SOLO su testnet!
 * Non utilizzare mai in mainnet senza audit completo.
 * 
 * Funzionalità:
 * - Monitoraggio prezzi multi-DEX in tempo reale
 * - Identificazione automatica opportunità arbitraggio
 * - Esecuzione sicura con simulazione preventiva
 * - Logging completo e sicuro
 * - Interfaccia web per monitoraggio
 */

import chalk from 'chalk';
import cron from 'node-cron';
import { validateConfig } from './config/config.js';
import blockchainConnection from './blockchain/connection.js';
import priceFeeds from './data/priceFeeds.js';
import arbitrageAnalyzer from './analysis/arbitrageAnalyzer.js';
import transactionExecutor from './execution/transactionExecutor.js';
import logger from './utils/logger.js';

class ArbitrageBot {
  constructor() {
    this.isRunning = false;
    this.startTime = null;
    this.stats = {
      totalOpportunities: 0,
      executedTransactions: 0,
      totalProfit: 0,
      uptime: 0
    };
    
    // Bind methods
    this.handleShutdown = this.handleShutdown.bind(this);
  }
  
  /**
   * Avvia il bot di arbitraggio
   */
  async start() {
    try {
      console.log(chalk.cyan('\n🤖 ARBITRAGE BOT - TESTNET ONLY'));
      console.log(chalk.cyan('=====================================\n'));
      
      // 1. Validazione configurazione
      logger.info('🔧 Validazione configurazione...');
      validateConfig();
      
      // 2. Inizializzazione connessioni blockchain
      logger.info('🔗 Inizializzazione connessioni blockchain...');
      await this.initializeBlockchainConnections();
      
      // 3. Avvio sistema raccolta prezzi
      logger.info('📊 Avvio sistema raccolta prezzi...');
      await priceFeeds.start();
      
      // 4. Avvio analizzatore arbitraggio
      logger.info('🔍 Avvio analizzatore arbitraggio...');
      await arbitrageAnalyzer.start();
      
      // 5. Configurazione task automatici
      this.setupAutomaticTasks();
      
      // 6. Setup gestori eventi
      this.setupEventHandlers();
      
      // 7. Avvio interfaccia utente
      this.startUserInterface();
      
      this.isRunning = true;
      this.startTime = Date.now();
      
      logger.info('🚀 Bot di arbitraggio avviato con successo!');
      logger.info('⚠️  MODALITÀ TESTNET ATTIVA - Nessuna transazione mainnet');
      
      // Mostra stato iniziale
      await this.displayStatus();
      
    } catch (error) {
      logger.error('❌ Errore avvio bot:', error.message);
      console.error(chalk.red('\n💥 Avvio fallito!'));
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  }
  
  /**
   * Inizializza connessioni blockchain
   */
  async initializeBlockchainConnections() {
    // Le connessioni RPC sono già inizializzate nel costruttore
    const status = blockchainConnection.getConnectionStatus();
    
    logger.info('✅ Provider blockchain inizializzati', {
      networks: status.availableNetworks,
      securityMode: status.securityMode
    });
    
    // Mostra istruzioni per connessione MetaMask
    if (!status.isConnected) {
      console.log(chalk.yellow('\n📱 Per eseguire transazioni, connetti MetaMask:'));
      console.log(chalk.yellow('   1. Apri MetaMask'));
      console.log(chalk.yellow('   2. Seleziona una testnet supportata'));
      console.log(chalk.yellow('   3. Il bot rileverà automaticamente la connessione\n'));
    }
  }
  
  /**
   * Configura task automatici
   */
  setupAutomaticTasks() {
    // Report giornaliero alle 00:00
    cron.schedule('0 0 * * *', () => {
      logger.generateDailyReport();
      this.generateDailyStats();
    });
    
    // Pulizia cache ogni ora
    cron.schedule('0 * * * *', () => {
      this.cleanupCache();
    });
    
    // Esecuzione automatica arbitraggio ogni 30 secondi (se abilitata)
    cron.schedule('*/30 * * * * *', async () => {
      if (this.isRunning && blockchainConnection.getConnectionStatus().isConnected) {
        try {
          await transactionExecutor.executeAutomaticArbitrage();
        } catch (error) {
          logger.debug('Errore esecuzione automatica:', error.message);
        }
      }
    });
    
    logger.info('⏰ Task automatici configurati');
  }
  
  /**
   * Configura gestori eventi
   */
  setupEventHandlers() {
    // Gestione shutdown graceful
    process.on('SIGINT', this.handleShutdown);
    process.on('SIGTERM', this.handleShutdown);
    process.on('uncaughtException', (error) => {
      logger.error('💥 Eccezione non gestita:', error.message);
      this.handleShutdown();
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('💥 Promise rejection non gestita:', reason);
    });
  }
  
  /**
   * Avvia interfaccia utente interattiva
   */
  startUserInterface() {
    // Mostra menu comandi
    this.showCommandMenu();
    
    // Gestione input utente
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (input) => {
      this.handleUserInput(input.toString().trim());
    });
  }
  
  /**
   * Mostra menu comandi
   */
  showCommandMenu() {
    console.log(chalk.blue('\n📋 COMANDI DISPONIBILI:'));
    console.log(chalk.white('  status    - Mostra stato del bot'));
    console.log(chalk.white('  prices    - Mostra prezzi correnti'));
    console.log(chalk.white('  opportunities - Mostra opportunità arbitraggio'));
    console.log(chalk.white('  execute   - Esegui migliore opportunità'));
    console.log(chalk.white('  connect   - Connetti MetaMask'));
    console.log(chalk.white('  stats     - Mostra statistiche'));
    console.log(chalk.white('  history   - Mostra storico transazioni'));
    console.log(chalk.white('  help      - Mostra questo menu'));
    console.log(chalk.white('  quit      - Arresta il bot'));
    console.log(chalk.gray('\nDigita un comando e premi INVIO\n'));
  }
  
  /**
   * Gestisce input utente
   */
  async handleUserInput(input) {
    const command = input.toLowerCase();
    
    try {
      switch (command) {
        case 'status':
          await this.displayStatus();
          break;
          
        case 'prices':
          await this.displayPrices();
          break;
          
        case 'opportunities':
          await this.displayOpportunities();
          break;
          
        case 'execute':
          await this.executeManualArbitrage();
          break;
          
        case 'connect':
          await this.connectMetaMask();
          break;
          
        case 'stats':
          await this.displayStats();
          break;
          
        case 'history':
          await this.displayHistory();
          break;
          
        case 'help':
          this.showCommandMenu();
          break;
          
        case 'quit':
        case 'exit':
          await this.handleShutdown();
          break;
          
        default:
          if (command) {
            console.log(chalk.red(`❌ Comando sconosciuto: ${command}`));
            console.log(chalk.gray('Digita "help" per vedere i comandi disponibili'));
          }
          break;
      }
    } catch (error) {
      logger.error('❌ Errore esecuzione comando:', error.message);
      console.log(chalk.red(`❌ Errore: ${error.message}`));
    }
  }
  
  /**
   * Mostra stato del bot
   */
  async displayStatus() {
    const connectionStatus = blockchainConnection.getConnectionStatus();
    const priceStatus = priceFeeds.getStatus();
    const analyzerStats = arbitrageAnalyzer.getStats();
    const executorStats = transactionExecutor.getExecutionStats();
    
    console.log(chalk.blue('\n📊 STATO BOT'));
    console.log(chalk.blue('============='));
    
    // Stato generale
    console.log(chalk.green(`🤖 Bot: ${this.isRunning ? 'ATTIVO' : 'INATTIVO'}`));
    console.log(chalk.yellow(`⏱️  Uptime: ${this.getUptime()}`));
    console.log(chalk.cyan(`🔒 Modalità: TESTNET ONLY`));
    
    // Connessioni
    console.log(chalk.blue('\n🔗 CONNESSIONI:'));
    console.log(`   MetaMask: ${connectionStatus.isConnected ? 
      chalk.green('✅ Connesso') : chalk.yellow('⚠️  Non connesso')}`);
    if (connectionStatus.isConnected) {
      console.log(`   Wallet: ${connectionStatus.walletAddress}`);
      console.log(`   Rete: ${connectionStatus.connectedNetwork}`);
    }
    console.log(`   Provider RPC: ${connectionStatus.availableNetworks.length} reti`);
    
    // Sistema prezzi
    console.log(chalk.blue('\n💰 SISTEMA PREZZI:'));
    console.log(`   Stato: ${priceStatus.isRunning ? 
      chalk.green('✅ Attivo') : chalk.red('❌ Inattivo')}`);
    console.log(`   Token monitorati: ${priceStatus.cachedTokens}`);
    
    // Analizzatore
    console.log(chalk.blue('\n🔍 ANALIZZATORE:'));
    console.log(`   Stato: ${analyzerStats.isRunning ? 
      chalk.green('✅ Attivo') : chalk.red('❌ Inattivo')}`);
    console.log(`   Opportunità recenti: ${analyzerStats.recentOpportunities}`);
    console.log(`   Transazioni oggi: ${analyzerStats.dailyTransactions}/${analyzerStats.dailyLimit}`);
    
    // Esecutore
    console.log(chalk.blue('\n⚡ ESECUTORE:'));
    console.log(`   Stato: ${executorStats.isExecuting ? 
      chalk.yellow('🔄 In esecuzione') : chalk.green('✅ Pronto')}`);
    console.log(`   Successo rate: ${executorStats.successRate.toFixed(1)}%`);
    console.log(`   Profitto 24h: ${executorStats.totalProfit24h.toFixed(6)} ETH`);
    
    console.log('');
  }
  
  /**
   * Mostra prezzi correnti
   */
  async displayPrices() {
    const allPrices = priceFeeds.getAllCurrentPrices();
    
    console.log(chalk.blue('\n💰 PREZZI CORRENTI'));
    console.log(chalk.blue('=================='));
    
    for (const [network, tokens] of Object.entries(allPrices)) {
      console.log(chalk.cyan(`\n🌐 ${network.toUpperCase()}:`));
      
      for (const [token, data] of Object.entries(tokens)) {
        console.log(chalk.white(`\n  ${token}:`));
        console.log(`    Prezzo medio: $${data.averagePrice.toFixed(6)}`);
        
        for (const [source, priceData] of Object.entries(data.prices)) {
          const age = Math.round((Date.now() - priceData.timestamp) / 1000);
          console.log(`    ${source}: $${priceData.price.toFixed(6)} (${age}s fa)`);
        }
      }
    }
    
    console.log('');
  }
  
  /**
   * Mostra opportunità di arbitraggio
   */
  async displayOpportunities() {
    const opportunities = arbitrageAnalyzer.getBestOpportunities(10);
    
    console.log(chalk.blue('\n🎯 OPPORTUNITÀ ARBITRAGGIO'));
    console.log(chalk.blue('==========================='));
    
    if (opportunities.length === 0) {
      console.log(chalk.yellow('⚠️  Nessuna opportunità disponibile al momento'));
      return;
    }
    
    opportunities.forEach((opp, index) => {
      const age = Math.round((Date.now() - opp.timestamp) / 1000);
      
      console.log(chalk.white(`\n${index + 1}. ${opp.token} su ${opp.network}`));
      console.log(`   ${opp.fromDex} → ${opp.toDex}`);
      console.log(`   Profitto: ${chalk.green(opp.profitPercentage.toFixed(2) + '%')}`);
      console.log(`   Importo: ${opp.optimalAmount.toFixed(4)} ETH`);
      console.log(`   Stima guadagno: ${opp.estimatedProfit.toFixed(6)} ETH`);
      console.log(`   Confidenza: ${opp.confidence.toFixed(0)}%`);
      console.log(`   Età: ${age}s`);
    });
    
    console.log('');
  }
  
  /**
   * Esegue arbitraggio manuale
   */
  async executeManualArbitrage() {
    const opportunities = arbitrageAnalyzer.getBestOpportunities(1);
    
    if (opportunities.length === 0) {
      console.log(chalk.yellow('⚠️  Nessuna opportunità disponibile'));
      return;
    }
    
    const opportunity = opportunities[0];
    
    console.log(chalk.blue('\n🚀 ESECUZIONE MANUALE ARBITRAGGIO'));
    console.log(chalk.blue('=================================='));
    console.log(`Token: ${opportunity.token}`);
    console.log(`Rete: ${opportunity.network}`);
    console.log(`${opportunity.fromDex} → ${opportunity.toDex}`);
    console.log(`Profitto stimato: ${opportunity.profitPercentage.toFixed(2)}%`);
    
    const result = await transactionExecutor.executeArbitrage(opportunity);
    
    if (result.success) {
      console.log(chalk.green('\n✅ Arbitraggio completato con successo!'));
      console.log(`TX Hash: ${result.txHash}`);
      console.log(`Profitto reale: ${result.actualProfit.toFixed(6)} ETH`);
    } else {
      console.log(chalk.red('\n❌ Arbitraggio fallito'));
      console.log(`Errore: ${result.error}`);
    }
    
    console.log('');
  }
  
  /**
   * Connette MetaMask
   */
  async connectMetaMask() {
    console.log(chalk.blue('\n🦊 CONNESSIONE METAMASK'));
    console.log(chalk.blue('========================'));
    
    try {
      const connection = await blockchainConnection.connectMetaMask();
      
      console.log(chalk.green('✅ MetaMask connesso con successo!'));
      console.log(`Indirizzo: ${connection.address}`);
      console.log(`Rete: ${connection.network}`);
      console.log(`Chain ID: ${connection.chainId}`);
      
    } catch (error) {
      console.log(chalk.red('❌ Errore connessione MetaMask'));
      console.log(chalk.red(error.message));
    }
    
    console.log('');
  }
  
  /**
   * Mostra statistiche dettagliate
   */
  async displayStats() {
    const analyzerStats = arbitrageAnalyzer.getStats();
    const executorStats = transactionExecutor.getExecutionStats();
    
    console.log(chalk.blue('\n📈 STATISTICHE DETTAGLIATE'));
    console.log(chalk.blue('==========================='));
    
    console.log(chalk.cyan('\n🔍 ANALISI:'));
    console.log(`   Opportunità totali: ${analyzerStats.totalOpportunities}`);
    console.log(`   Opportunità recenti: ${analyzerStats.recentOpportunities}`);
    console.log(`   Transazioni oggi: ${analyzerStats.dailyTransactions}`);
    
    if (analyzerStats.bestOpportunity) {
      console.log(`   Migliore opportunità: ${analyzerStats.bestOpportunity.profitPercentage.toFixed(2)}%`);
    }
    
    console.log(chalk.cyan('\n⚡ ESECUZIONE:'));
    console.log(`   Esecuzioni totali: ${executorStats.totalExecutions}`);
    console.log(`   Esecuzioni recenti: ${executorStats.recentExecutions}`);
    console.log(`   Tasso successo: ${executorStats.successRate.toFixed(1)}%`);
    console.log(`   Profitto 24h: ${executorStats.totalProfit24h.toFixed(6)} ETH`);
    console.log(`   Profitto medio: ${executorStats.averageProfit.toFixed(6)} ETH`);
    
    console.log('');
  }
  
  /**
   * Mostra storico transazioni
   */
  async displayHistory() {
    const history = transactionExecutor.getRecentExecutions(10);
    
    console.log(chalk.blue('\n📜 STORICO TRANSAZIONI'));
    console.log(chalk.blue('======================'));
    
    if (history.length === 0) {
      console.log(chalk.yellow('⚠️  Nessuna transazione eseguita'));
      return;
    }
    
    history.forEach((exec, index) => {
      const date = new Date(exec.timestamp).toLocaleString();
      const status = exec.success ? chalk.green('✅') : chalk.red('❌');
      
      console.log(`\n${index + 1}. ${status} ${exec.token} su ${exec.network}`);
      console.log(`   Data: ${date}`);
      console.log(`   Profitto: ${exec.profitPercentage.toFixed(2)}% (${exec.actualProfit.toFixed(6)} ETH)`);
      console.log(`   TX: ${exec.txHash}`);
    });
    
    console.log('');
  }
  
  /**
   * Genera statistiche giornaliere
   */
  generateDailyStats() {
    const stats = {
      date: new Date().toISOString().split('T')[0],
      uptime: this.getUptime(),
      ...arbitrageAnalyzer.getStats(),
      ...transactionExecutor.getExecutionStats()
    };
    
    logger.info('📊 Report giornaliero generato', stats);
  }
  
  /**
   * Pulizia cache periodica
   */
  cleanupCache() {
    logger.debug('🧹 Pulizia cache periodica...');
    // La pulizia è gestita automaticamente dai singoli moduli
  }
  
  /**
   * Calcola uptime
   */
  getUptime() {
    if (!this.startTime) return '0s';
    
    const uptime = Date.now() - this.startTime;
    const hours = Math.floor(uptime / 3600000);
    const minutes = Math.floor((uptime % 3600000) / 60000);
    const seconds = Math.floor((uptime % 60000) / 1000);
    
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  
  /**
   * Gestisce shutdown graceful
   */
  async handleShutdown() {
    if (!this.isRunning) {
      process.exit(0);
    }
    
    console.log(chalk.yellow('\n🛑 Arresto bot in corso...'));
    logger.info('🛑 Shutdown graceful avviato');
    
    this.isRunning = false;
    
    try {
      // Arresta tutti i moduli
      await arbitrageAnalyzer.stop();
      await priceFeeds.stop();
      
      // Genera report finale
      this.generateDailyStats();
      
      logger.info('✅ Bot arrestato correttamente');
      console.log(chalk.green('✅ Bot arrestato correttamente'));
      
    } catch (error) {
      logger.error('❌ Errore durante shutdown:', error.message);
      console.log(chalk.red('❌ Errore durante arresto'));
    }
    
    process.exit(0);
  }
}

// Avvia il bot
const bot = new ArbitrageBot();
bot.start().catch(error => {
  console.error(chalk.red('💥 Errore fatale:'), error);
  process.exit(1);
});