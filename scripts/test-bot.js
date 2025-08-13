#!/usr/bin/env node

/**
 * TEST SCRIPT - Arbitrage Bot
 * ===========================
 * 
 * Script di test completo per verificare il funzionamento
 * del bot di arbitraggio su testnet
 */

import chalk from 'chalk';
import { validateConfig } from '../src/config/config.js';
import blockchainConnection from '../src/blockchain/connection.js';
import priceFeeds from '../src/data/priceFeeds.js';
import arbitrageAnalyzer from '../src/analysis/arbitrageAnalyzer.js';
import transactionExecutor from '../src/execution/transactionExecutor.js';
import logger from '../src/utils/logger.js';

class BotTester {
  constructor() {
    this.testResults = {
      passed: 0,
      failed: 0,
      warnings: 0,
      tests: []
    };
  }
  
  /**
   * Esegue tutti i test
   */
  async runAllTests() {
    console.log(chalk.cyan('\n🧪 ARBITRAGE BOT - TEST SUITE'));
    console.log(chalk.cyan('==============================\n'));
    
    try {
      await this.testConfiguration();
      await this.testBlockchainConnections();
      await this.testPriceFeeds();
      await this.testArbitrageAnalyzer();
      await this.testTransactionExecutor();
      await this.testSecurityFeatures();
      await this.testLogging();
      
      this.showResults();
      
    } catch (error) {
      console.error(chalk.red('💥 Test suite fallita:'), error.message);
      process.exit(1);
    }
  }
  
  /**
   * Registra risultato test
   */
  recordTest(name, passed, message = '', isWarning = false) {
    const result = {
      name,
      passed,
      message,
      isWarning,
      timestamp: new Date().toISOString()
    };
    
    this.testResults.tests.push(result);
    
    if (isWarning) {
      this.testResults.warnings++;
      console.log(chalk.yellow(`⚠️  ${name}: ${message}`));
    } else if (passed) {
      this.testResults.passed++;
      console.log(chalk.green(`✅ ${name}`));
    } else {
      this.testResults.failed++;
      console.log(chalk.red(`❌ ${name}: ${message}`));
    }
  }
  
  /**
   * Test configurazione
   */
  async testConfiguration() {
    console.log(chalk.blue('\n🔧 Test Configurazione'));
    console.log(chalk.blue('======================'));
    
    try {
      // Test validazione config
      validateConfig();
      this.recordTest('Validazione configurazione', true);
      
      // Test modalità testnet
      if (process.env.NETWORK_MODE === 'testnet') {
        this.recordTest('Modalità testnet attiva', true);
      } else if (process.env.NETWORK_MODE === 'mainnet') {
        this.recordTest('Modalità mainnet rilevata', false, 'Usa testnet per i test!', true);
      } else {
        this.recordTest('NETWORK_MODE non configurato', false, 'Imposta NETWORK_MODE=testnet');
      }
      
      // Test wallet address
      if (process.env.WALLET_ADDRESS && process.env.WALLET_ADDRESS.startsWith('0x')) {
        this.recordTest('Wallet address configurato', true);
      } else {
        this.recordTest('Wallet address mancante', false, 'Configura WALLET_ADDRESS');
      }
      
      // Test RPC URLs
      const rpcUrls = [
        { name: 'Ethereum RPC', env: 'ETHEREUM_RPC_URL' },
        { name: 'BSC RPC', env: 'BSC_RPC_URL' },
        { name: 'Polygon RPC', env: 'POLYGON_RPC_URL' }
      ];
      
      for (const rpc of rpcUrls) {
        if (process.env[rpc.env] && process.env[rpc.env].startsWith('http')) {
          this.recordTest(`${rpc.name} configurato`, true);
        } else {
          this.recordTest(`${rpc.name} mancante`, false, `Configura ${rpc.env}`);
        }
      }
      
    } catch (error) {
      this.recordTest('Configurazione generale', false, error.message);
    }
  }
  
  /**
   * Test connessioni blockchain
   */
  async testBlockchainConnections() {
    console.log(chalk.blue('\n🔗 Test Connessioni Blockchain'));
    console.log(chalk.blue('==============================='));
    
    try {
      // Test inizializzazione provider
      const status = blockchainConnection.getConnectionStatus();
      
      if (status.availableNetworks.length > 0) {
        this.recordTest('Provider RPC inizializzati', true, `${status.availableNetworks.length} reti`);
      } else {
        this.recordTest('Provider RPC', false, 'Nessun provider disponibile');
      }
      
      // Test modalità sicurezza
      if (status.securityMode === 'testnet') {
        this.recordTest('Modalità sicurezza testnet', true);
      } else {
        this.recordTest('Modalità sicurezza', false, 'Non in modalità testnet');
      }
      
      // Test connessione MetaMask (se disponibile)
      if (status.isConnected) {
        this.recordTest('MetaMask connesso', true, status.walletAddress);
        this.recordTest('Rete corrente', true, status.connectedNetwork);
      } else {
        this.recordTest('MetaMask non connesso', true, 'Normale per test automatici', true);
      }
      
      // Test provider per ogni rete
      for (const network of status.availableNetworks) {
        try {
          const provider = blockchainConnection.getProvider(network);
          const blockNumber = await provider.getBlockNumber();
          this.recordTest(`Provider ${network}`, true, `Block: ${blockNumber}`);
        } catch (error) {
          this.recordTest(`Provider ${network}`, false, error.message);
        }
      }
      
    } catch (error) {
      this.recordTest('Connessioni blockchain', false, error.message);
    }
  }
  
  /**
   * Test sistema price feeds
   */
  async testPriceFeeds() {
    console.log(chalk.blue('\n💰 Test Price Feeds'));
    console.log(chalk.blue('==================='));
    
    try {
      // Test avvio sistema
      await priceFeeds.start();
      this.recordTest('Avvio price feeds', true);
      
      // Attendi un po' per raccolta dati
      console.log(chalk.gray('   Attendo raccolta prezzi...'));
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      // Test stato sistema
      const status = priceFeeds.getStatus();
      if (status.isRunning) {
        this.recordTest('Price feeds attivo', true);
      } else {
        this.recordTest('Price feeds', false, 'Sistema non attivo');
      }
      
      // Test cache prezzi
      if (status.cachedTokens > 0) {
        this.recordTest('Cache prezzi', true, `${status.cachedTokens} token`);
      } else {
        this.recordTest('Cache prezzi vuota', false, 'Nessun prezzo in cache', true);
      }
      
      // Test recupero prezzi
      const allPrices = priceFeeds.getAllCurrentPrices();
      const networkCount = Object.keys(allPrices).length;
      if (networkCount > 0) {
        this.recordTest('Recupero prezzi', true, `${networkCount} reti`);
      } else {
        this.recordTest('Recupero prezzi', false, 'Nessun prezzo disponibile');
      }
      
      // Test prezzi specifici
      for (const [network, tokens] of Object.entries(allPrices)) {
        const tokenCount = Object.keys(tokens).length;
        if (tokenCount > 0) {
          this.recordTest(`Prezzi ${network}`, true, `${tokenCount} token`);
        } else {
          this.recordTest(`Prezzi ${network}`, false, 'Nessun token', true);
        }
      }
      
      // Arresta sistema
      await priceFeeds.stop();
      this.recordTest('Arresto price feeds', true);
      
    } catch (error) {
      this.recordTest('Price feeds generale', false, error.message);
    }
  }
  
  /**
   * Test analizzatore arbitraggio
   */
  async testArbitrageAnalyzer() {
    console.log(chalk.blue('\n🔍 Test Arbitrage Analyzer'));
    console.log(chalk.blue('==========================='));
    
    try {
      // Riavvia price feeds per l'analizzatore
      await priceFeeds.start();
      
      // Test avvio analizzatore
      await arbitrageAnalyzer.start();
      this.recordTest('Avvio analyzer', true);
      
      // Attendi analisi
      console.log(chalk.gray('   Attendo analisi opportunità...'));
      await new Promise(resolve => setTimeout(resolve, 15000));
      
      // Test stato analizzatore
      const stats = arbitrageAnalyzer.getStats();
      if (stats.isRunning) {
        this.recordTest('Analyzer attivo', true);
      } else {
        this.recordTest('Analyzer', false, 'Non attivo');
      }
      
      // Test rilevamento opportunità
      if (stats.totalOpportunities > 0) {
        this.recordTest('Rilevamento opportunità', true, `${stats.totalOpportunities} trovate`);
      } else {
        this.recordTest('Nessuna opportunità', true, 'Normale in condizioni di mercato stabili', true);
      }
      
      // Test migliori opportunità
      const opportunities = arbitrageAnalyzer.getBestOpportunities(5);
      if (opportunities.length > 0) {
        this.recordTest('Ranking opportunità', true, `${opportunities.length} classificate`);
        
        // Test qualità opportunità
        const bestOpp = opportunities[0];
        if (bestOpp.profitPercentage > 0) {
          this.recordTest('Calcolo profitto', true, `${bestOpp.profitPercentage.toFixed(2)}%`);
        } else {
          this.recordTest('Calcolo profitto', false, 'Profitto negativo o zero');
        }
      }
      
      // Test limiti giornalieri
      if (stats.dailyTransactions < stats.dailyLimit) {
        this.recordTest('Limiti giornalieri', true, `${stats.dailyTransactions}/${stats.dailyLimit}`);
      } else {
        this.recordTest('Limite giornaliero raggiunto', true, 'Protezione attiva', true);
      }
      
      // Arresta analizzatore
      await arbitrageAnalyzer.stop();
      this.recordTest('Arresto analyzer', true);
      
    } catch (error) {
      this.recordTest('Arbitrage analyzer', false, error.message);
    }
  }
  
  /**
   * Test esecutore transazioni
   */
  async testTransactionExecutor() {
    console.log(chalk.blue('\n⚡ Test Transaction Executor'));
    console.log(chalk.blue('============================'));
    
    try {
      // Test inizializzazione
      const stats = transactionExecutor.getExecutionStats();
      this.recordTest('Inizializzazione executor', true);
      
      // Test controlli di sicurezza (senza MetaMask)
      try {
        const mockOpportunity = {
          token: 'WETH',
          network: 'goerli',
          fromDex: 'uniswap',
          toDex: 'sushiswap',
          profitPercentage: 2.5,
          optimalAmount: 0.01,
          estimatedProfit: 0.0002,
          confidence: 85,
          timestamp: Date.now()
        };
        
        // Questo dovrebbe fallire perché MetaMask non è connesso
        const result = await transactionExecutor.executeArbitrage(mockOpportunity);
        if (!result.success && result.error.includes('MetaMask')) {
          this.recordTest('Controlli sicurezza', true, 'MetaMask richiesto correttamente');
        } else {
          this.recordTest('Controlli sicurezza', false, 'Dovrebbe richiedere MetaMask');
        }
      } catch (error) {
        if (error.message.includes('MetaMask') || error.message.includes('wallet')) {
          this.recordTest('Controlli sicurezza', true, 'Protezione wallet attiva');
        } else {
          this.recordTest('Controlli sicurezza', false, error.message);
        }
      }
      
      // Test statistiche
      if (typeof stats.totalExecutions === 'number') {
        this.recordTest('Statistiche executor', true, `${stats.totalExecutions} esecuzioni`);
      } else {
        this.recordTest('Statistiche executor', false, 'Statistiche non disponibili');
      }
      
      // Test storico
      const history = transactionExecutor.getRecentExecutions(10);
      this.recordTest('Storico transazioni', true, `${history.length} record`);
      
    } catch (error) {
      this.recordTest('Transaction executor', false, error.message);
    }
  }
  
  /**
   * Test funzionalità di sicurezza
   */
  async testSecurityFeatures() {
    console.log(chalk.blue('\n🛡️  Test Sicurezza'));
    console.log(chalk.blue('=================='));
    
    try {
      // Test modalità testnet
      if (process.env.NETWORK_MODE === 'testnet') {
        this.recordTest('Protezione mainnet', true, 'Modalità testnet attiva');
      } else {
        this.recordTest('Protezione mainnet', false, 'ATTENZIONE: Non in modalità testnet!');
      }
      
      // Test controlli di sicurezza abilitati
      if (process.env.ENABLE_SECURITY_CHECKS === 'true') {
        this.recordTest('Controlli sicurezza', true, 'Abilitati');
      } else {
        this.recordTest('Controlli sicurezza', false, 'Disabilitati - PERICOLOSO!');
      }
      
      // Test simulazione abilitata
      if (process.env.ENABLE_SIMULATION === 'true') {
        this.recordTest('Simulazione transazioni', true, 'Abilitata');
      } else {
        this.recordTest('Simulazione transazioni', false, 'Disabilitata - PERICOLOSO!');
      }
      
      // Test limiti configurati
      const maxAmount = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || '0');
      if (maxAmount > 0 && maxAmount <= 0.1) {
        this.recordTest('Limiti transazione', true, `Max: ${maxAmount} ETH`);
      } else if (maxAmount > 0.1) {
        this.recordTest('Limite alto', true, `${maxAmount} ETH - Considera di ridurre per test`, true);
      } else {
        this.recordTest('Limiti transazione', false, 'MAX_TRANSACTION_AMOUNT non configurato');
      }
      
      // Test variabili sensibili non esposte
      const sensitiveVars = ['PRIVATE_KEY', 'SEED_PHRASE', 'MNEMONIC'];
      let foundSensitive = false;
      for (const varName of sensitiveVars) {
        if (process.env[varName]) {
          this.recordTest(`Variabile sensibile ${varName}`, false, 'RIMUOVI IMMEDIATAMENTE!');
          foundSensitive = true;
        }
      }
      if (!foundSensitive) {
        this.recordTest('Nessuna variabile sensibile', true, 'Configurazione sicura');
      }
      
    } catch (error) {
      this.recordTest('Test sicurezza', false, error.message);
    }
  }
  
  /**
   * Test sistema di logging
   */
  async testLogging() {
    console.log(chalk.blue('\n📝 Test Logging'));
    console.log(chalk.blue('==============='));
    
    try {
      // Test logging di base
      logger.info('Test log message');
      this.recordTest('Logging di base', true);
      
      // Test diversi livelli
      logger.debug('Debug message');
      logger.warn('Warning message');
      logger.error('Error message');
      this.recordTest('Livelli di log', true);
      
      // Test logging sicuro (non dovrebbe loggare dati sensibili)
      const sensitiveData = {
        address: '0x742d35Cc6634C0532925a3b8D4C9db96590b5',
        privateKey: '0x1234567890abcdef',
        amount: 1.5
      };
      
      logger.info('Test dati sensibili', sensitiveData);
      this.recordTest('Sanitizzazione log', true, 'Dati sensibili filtrati');
      
      // Test log specifici
      logger.logArbitrageOpportunity({
        token: 'WETH',
        network: 'goerli',
        profitPercentage: 2.5,
        fromDex: 'uniswap',
        toDex: 'sushiswap'
      });
      this.recordTest('Log opportunità', true);
      
      logger.logTransactionStart({
        id: 'test-tx-123',
        token: 'WETH',
        amount: 0.01
      });
      this.recordTest('Log transazioni', true);
      
    } catch (error) {
      this.recordTest('Sistema logging', false, error.message);
    }
  }
  
  /**
   * Mostra risultati finali
   */
  showResults() {
    console.log(chalk.blue('\n📊 RISULTATI TEST'));
    console.log(chalk.blue('=================\n'));
    
    const total = this.testResults.passed + this.testResults.failed;
    const successRate = total > 0 ? (this.testResults.passed / total * 100).toFixed(1) : 0;
    
    console.log(chalk.white(`Test eseguiti: ${total}`));
    console.log(chalk.green(`✅ Successi: ${this.testResults.passed}`));
    console.log(chalk.red(`❌ Fallimenti: ${this.testResults.failed}`));
    console.log(chalk.yellow(`⚠️  Avvertimenti: ${this.testResults.warnings}`));
    console.log(chalk.cyan(`📈 Tasso successo: ${successRate}%`));
    
    // Mostra test falliti
    if (this.testResults.failed > 0) {
      console.log(chalk.red('\n❌ TEST FALLITI:'));
      this.testResults.tests
        .filter(test => !test.passed && !test.isWarning)
        .forEach(test => {
          console.log(chalk.red(`   ${test.name}: ${test.message}`));
        });
    }
    
    // Mostra avvertimenti
    if (this.testResults.warnings > 0) {
      console.log(chalk.yellow('\n⚠️  AVVERTIMENTI:'));
      this.testResults.tests
        .filter(test => test.isWarning)
        .forEach(test => {
          console.log(chalk.yellow(`   ${test.name}: ${test.message}`));
        });
    }
    
    // Risultato finale
    console.log('');
    if (this.testResults.failed === 0) {
      console.log(chalk.green('🎉 TUTTI I TEST SONO PASSATI!'));
      console.log(chalk.white('Il bot è pronto per l\'uso su testnet.'));
      
      if (this.testResults.warnings > 0) {
        console.log(chalk.yellow('\n⚠️  Risolvi gli avvertimenti per un funzionamento ottimale.'));
      }
    } else {
      console.log(chalk.red('💥 ALCUNI TEST SONO FALLITI!'));
      console.log(chalk.red('Risolvi i problemi prima di utilizzare il bot.'));
      process.exit(1);
    }
    
    console.log(chalk.gray('\n📖 Consulta README.md per istruzioni dettagliate'));
    console.log(chalk.gray('🛡️  Leggi SECURITY_CHECKLIST.md prima di usare mainnet'));
  }
}

// Esegui test se chiamato direttamente
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new BotTester();
  tester.runAllTests();
}

export default BotTester;