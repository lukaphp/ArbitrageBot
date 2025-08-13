#!/usr/bin/env node

/**
 * SETUP SCRIPT - Arbitrage Bot
 * ============================
 * 
 * Script di configurazione iniziale per il bot di arbitraggio
 * Verifica dipendenze, configura l'ambiente e prepara il sistema
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

class SetupManager {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.success = [];
  }
  
  /**
   * Esegue il setup completo
   */
  async run() {
    console.log(chalk.cyan('\n🚀 ARBITRAGE BOT - SETUP'));
    console.log(chalk.cyan('========================\n'));
    
    try {
      await this.checkNodeVersion();
      await this.checkDependencies();
      await this.setupEnvironment();
      await this.createDirectories();
      await this.validateConfiguration();
      await this.runInitialTests();
      
      this.showResults();
      
    } catch (error) {
      console.error(chalk.red('💥 Setup fallito:'), error.message);
      process.exit(1);
    }
  }
  
  /**
   * Verifica versione Node.js
   */
  async checkNodeVersion() {
    console.log(chalk.blue('🔍 Verifica versione Node.js...'));
    
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
    
    if (majorVersion >= 18) {
      this.success.push(`Node.js ${nodeVersion} ✅`);
    } else {
      this.errors.push(`Node.js ${nodeVersion} non supportato. Richiesto >= 18.0.0`);
    }
  }
  
  /**
   * Verifica dipendenze installate
   */
  async checkDependencies() {
    console.log(chalk.blue('📦 Verifica dipendenze...'));
    
    const packageJsonPath = path.join(projectRoot, 'package.json');
    
    if (!fs.existsSync(packageJsonPath)) {
      this.errors.push('package.json non trovato');
      return;
    }
    
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    // Verifica node_modules
    const nodeModulesPath = path.join(projectRoot, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      console.log(chalk.yellow('📦 Installazione dipendenze...'));
      try {
        execSync('npm install', { cwd: projectRoot, stdio: 'inherit' });
        this.success.push('Dipendenze installate ✅');
      } catch (error) {
        this.errors.push('Errore installazione dipendenze');
      }
    } else {
      this.success.push('Dipendenze già installate ✅');
    }
    
    // Verifica dipendenze critiche
    const criticalDeps = ['ethers', 'dotenv', 'axios', 'ws', 'chalk'];
    for (const dep of criticalDeps) {
      const depPath = path.join(nodeModulesPath, dep);
      if (fs.existsSync(depPath)) {
        this.success.push(`${dep} ✅`);
      } else {
        this.errors.push(`Dipendenza mancante: ${dep}`);
      }
    }
  }
  
  /**
   * Configura ambiente
   */
  async setupEnvironment() {
    console.log(chalk.blue('⚙️  Configurazione ambiente...'));
    
    const envPath = path.join(projectRoot, '.env');
    const envExamplePath = path.join(projectRoot, '.env.example');
    
    // Crea .env se non esiste
    if (!fs.existsSync(envPath)) {
      if (fs.existsSync(envExamplePath)) {
        fs.copyFileSync(envExamplePath, envPath);
        this.success.push('File .env creato da .env.example ✅');
        this.warnings.push('⚠️  Configura il file .env con i tuoi parametri');
      } else {
        this.errors.push('File .env.example non trovato');
      }
    } else {
      this.success.push('File .env già esistente ✅');
    }
    
    // Verifica variabili critiche
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const criticalVars = [
        'NETWORK_MODE',
        'WALLET_ADDRESS',
        'ETHEREUM_RPC_URL',
        'BSC_RPC_URL',
        'POLYGON_RPC_URL'
      ];
      
      for (const varName of criticalVars) {
        if (envContent.includes(`${varName}=`) && !envContent.includes(`${varName}=YOUR_`)) {
          this.success.push(`${varName} configurato ✅`);
        } else {
          this.warnings.push(`⚠️  Configura ${varName} nel file .env`);
        }
      }
    }
  }
  
  /**
   * Crea directory necessarie
   */
  async createDirectories() {
    console.log(chalk.blue('📁 Creazione directory...'));
    
    const directories = [
      'logs',
      'data',
      'backups',
      'temp'
    ];
    
    for (const dir of directories) {
      const dirPath = path.join(projectRoot, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        this.success.push(`Directory ${dir} creata ✅`);
      } else {
        this.success.push(`Directory ${dir} già esistente ✅`);
      }
    }
    
    // Crea .gitignore per directory sensibili
    const gitignoreContent = `
# Logs
logs/*.log

# Data
data/*.json
data/*.db

# Backups
backups/*

# Temp
temp/*

# Environment
.env
.env.local

# Node modules
node_modules/

# OS
.DS_Store
Thumbs.db
`;
    
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, gitignoreContent.trim());
      this.success.push('.gitignore creato ✅');
    }
  }
  
  /**
   * Valida configurazione
   */
  async validateConfiguration() {
    console.log(chalk.blue('✅ Validazione configurazione...'));
    
    try {
      // Importa e valida config (solo se .env è configurato)
      const envPath = path.join(projectRoot, '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        
        // Verifica modalità testnet
        if (envContent.includes('NETWORK_MODE=testnet')) {
          this.success.push('Modalità testnet configurata ✅');
        } else if (envContent.includes('NETWORK_MODE=mainnet')) {
          this.warnings.push('⚠️  ATTENZIONE: Modalità mainnet rilevata!');
          this.warnings.push('⚠️  Assicurati di aver completato la security checklist');
        } else {
          this.warnings.push('⚠️  NETWORK_MODE non configurato');
        }
        
        // Verifica presenza wallet address
        if (envContent.includes('WALLET_ADDRESS=0x') && !envContent.includes('WALLET_ADDRESS=0xYOUR_')) {
          this.success.push('Wallet address configurato ✅');
        } else {
          this.warnings.push('⚠️  Configura WALLET_ADDRESS nel file .env');
        }
      }
      
    } catch (error) {
      this.warnings.push('⚠️  Impossibile validare configurazione completa');
    }
  }
  
  /**
   * Esegue test iniziali
   */
  async runInitialTests() {
    console.log(chalk.blue('🧪 Test iniziali...'));
    
    try {
      // Test import moduli principali
      const configPath = path.join(projectRoot, 'src', 'config', 'config.js');
      if (fs.existsSync(configPath)) {
        this.success.push('Modulo config trovato ✅');
      } else {
        this.errors.push('Modulo config mancante');
      }
      
      const loggerPath = path.join(projectRoot, 'src', 'utils', 'logger.js');
      if (fs.existsSync(loggerPath)) {
        this.success.push('Modulo logger trovato ✅');
      } else {
        this.errors.push('Modulo logger mancante');
      }
      
      // Test scrittura log
      const logsDir = path.join(projectRoot, 'logs');
      const testLogPath = path.join(logsDir, 'setup-test.log');
      try {
        fs.writeFileSync(testLogPath, `Setup test - ${new Date().toISOString()}\n`);
        fs.unlinkSync(testLogPath); // Rimuovi file di test
        this.success.push('Scrittura log funzionante ✅');
      } catch (error) {
        this.warnings.push('⚠️  Problemi con scrittura log');
      }
      
    } catch (error) {
      this.warnings.push('⚠️  Alcuni test iniziali falliti');
    }
  }
  
  /**
   * Mostra risultati setup
   */
  showResults() {
    console.log(chalk.blue('\n📊 RISULTATI SETUP'));
    console.log(chalk.blue('==================\n'));
    
    // Successi
    if (this.success.length > 0) {
      console.log(chalk.green('✅ SUCCESSI:'));
      this.success.forEach(msg => console.log(chalk.green(`   ${msg}`)));
      console.log('');
    }
    
    // Warning
    if (this.warnings.length > 0) {
      console.log(chalk.yellow('⚠️  AVVERTIMENTI:'));
      this.warnings.forEach(msg => console.log(chalk.yellow(`   ${msg}`)));
      console.log('');
    }
    
    // Errori
    if (this.errors.length > 0) {
      console.log(chalk.red('❌ ERRORI:'));
      this.errors.forEach(msg => console.log(chalk.red(`   ${msg}`)));
      console.log('');
    }
    
    // Risultato finale
    if (this.errors.length === 0) {
      console.log(chalk.green('🎉 SETUP COMPLETATO CON SUCCESSO!'));
      console.log(chalk.white('\n📋 PROSSIMI PASSI:'));
      console.log(chalk.white('1. Configura il file .env con i tuoi parametri'));
      console.log(chalk.white('2. Ottieni fondi testnet dai faucet'));
      console.log(chalk.white('3. Avvia il bot con: npm run dev'));
      console.log(chalk.white('4. Connetti MetaMask quando richiesto'));
      console.log(chalk.white('\n📖 Leggi README.md per istruzioni dettagliate'));
      console.log(chalk.white('🛡️  Consulta SECURITY_CHECKLIST.md prima di usare mainnet'));
    } else {
      console.log(chalk.red('💥 SETUP FALLITO!'));
      console.log(chalk.red('Risolvi gli errori sopra elencati e riprova.'));
      process.exit(1);
    }
  }
}

// Esegui setup se chiamato direttamente
if (import.meta.url === `file://${process.argv[1]}`) {
  const setup = new SetupManager();
  setup.run();
}

export default SetupManager;