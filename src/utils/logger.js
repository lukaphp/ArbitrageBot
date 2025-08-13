/**
 * SISTEMA DI LOGGING SICURO
 * ========================
 * 
 * Gestisce tutti i log del sistema garantendo che:
 * - Nessun dato sensibile venga mai loggato
 * - I log siano strutturati e facilmente analizzabili
 * - Supporti diversi livelli di logging
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { LOGGING_CONFIG } from '../config/config.js';

class SecureLogger {
  constructor() {
    this.logLevels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    
    this.currentLevel = this.logLevels[LOGGING_CONFIG.level] || 1;
    this.logDirectory = LOGGING_CONFIG.logDirectory;
    
    // Crea directory log se abilitata
    if (LOGGING_CONFIG.enableFileLogging) {
      this.ensureLogDirectory();
    }
    
    // Pattern per identificare dati sensibili
    this.sensitivePatterns = [
      /0x[a-fA-F0-9]{64}/g, // Private keys
      /\b[A-Za-z0-9]{12}\s+[A-Za-z0-9]{12}\s+[A-Za-z0-9]{12}\b/g, // Seed phrases
      /"privateKey"\s*:\s*"[^"]+"/g, // JSON private keys
      /"mnemonic"\s*:\s*"[^"]+"/g, // JSON mnemonics
      /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, // Bearer tokens
      /api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9]+/gi // API keys
    ];
  }
  
  /**
   * Crea la directory dei log se non esiste
   */
  ensureLogDirectory() {
    try {
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true });
      }
    } catch (error) {
      console.error('❌ Impossibile creare directory log:', error.message);
    }
  }
  
  /**
   * Sanitizza il messaggio rimuovendo dati sensibili
   */
  sanitizeMessage(message) {
    let sanitized = typeof message === 'object' ? JSON.stringify(message) : String(message);
    
    // Rimuove pattern sensibili
    this.sensitivePatterns.forEach(pattern => {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    });
    
    // Maschera indirizzi wallet (mostra solo primi e ultimi 4 caratteri)
    sanitized = sanitized.replace(/0x[a-fA-F0-9]{40}/g, (match) => {
      return `${match.slice(0, 6)}...${match.slice(-4)}`;
    });
    
    return sanitized;
  }
  
  /**
   * Formatta il timestamp
   */
  getTimestamp() {
    return new Date().toISOString();
  }
  
  /**
   * Scrive log su file se abilitato
   */
  writeToFile(level, message, data = null) {
    if (!LOGGING_CONFIG.enableFileLogging) return;
    
    try {
      const timestamp = this.getTimestamp();
      const logEntry = {
        timestamp,
        level: level.toUpperCase(),
        message: this.sanitizeMessage(message),
        data: data ? this.sanitizeMessage(data) : null
      };
      
      const logLine = JSON.stringify(logEntry) + '\n';
      const logFile = path.join(this.logDirectory, `arbitrage-bot-${new Date().toISOString().split('T')[0]}.log`);
      
      fs.appendFileSync(logFile, logLine);
    } catch (error) {
      console.error('❌ Errore scrittura log:', error.message);
    }
  }
  
  /**
   * Log generico
   */
  log(level, message, data = null) {
    if (this.logLevels[level] < this.currentLevel) return;
    
    const timestamp = this.getTimestamp();
    const sanitizedMessage = this.sanitizeMessage(message);
    const sanitizedData = data ? this.sanitizeMessage(data) : null;
    
    // Colori per console
    const colors = {
      debug: chalk.gray,
      info: chalk.blue,
      warn: chalk.yellow,
      error: chalk.red
    };
    
    const color = colors[level] || chalk.white;
    const levelTag = `[${level.toUpperCase()}]`;
    
    // Output console
    console.log(
      chalk.gray(`${timestamp}`) + ' ' +
      color(levelTag) + ' ' +
      sanitizedMessage +
      (sanitizedData ? ' ' + chalk.gray(JSON.stringify(sanitizedData)) : '')
    );
    
    // Scrivi su file
    this.writeToFile(level, message, data);
  }
  
  /**
   * Metodi di logging specifici
   */
  debug(message, data = null) {
    this.log('debug', message, data);
  }
  
  info(message, data = null) {
    this.log('info', message, data);
  }
  
  warn(message, data = null) {
    this.log('warn', message, data);
  }
  
  error(message, data = null) {
    this.log('error', message, data);
  }
  
  /**
   * Log specifici per arbitraggio
   */
  arbitrageOpportunity(fromDex, toDex, token, profitPercentage, estimatedProfit) {
    this.info('🎯 Opportunità arbitraggio rilevata', {
      fromDex,
      toDex,
      token,
      profitPercentage: `${profitPercentage.toFixed(2)}%`,
      estimatedProfit: `${estimatedProfit.toFixed(6)} ETH`
    });
  }
  
  transactionStart(txType, fromDex, toDex, amount) {
    this.info('🚀 Avvio transazione', {
      type: txType,
      fromDex,
      toDex,
      amount: `${amount} ETH`
    });
  }
  
  transactionSuccess(txHash, profit) {
    this.info('✅ Transazione completata', {
      txHash: txHash.slice(0, 10) + '...',
      profit: `${profit.toFixed(6)} ETH`
    });
  }
  
  transactionFailed(reason, gasUsed = null) {
    this.error('❌ Transazione fallita', {
      reason,
      gasUsed: gasUsed ? `${gasUsed} gas` : null
    });
  }
  
  securityAlert(alertType, details) {
    this.error('🚨 ALERT SICUREZZA', {
      type: alertType,
      details: this.sanitizeMessage(details),
      timestamp: this.getTimestamp()
    });
  }
  
  priceUpdate(dex, token, price, change24h = null) {
    this.debug('💰 Aggiornamento prezzo', {
      dex,
      token,
      price: `$${price.toFixed(6)}`,
      change24h: change24h ? `${change24h.toFixed(2)}%` : null
    });
  }
  
  /**
   * Genera report giornaliero
   */
  generateDailyReport() {
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.logDirectory, `arbitrage-bot-${today}.log`);
    
    if (!fs.existsSync(logFile)) {
      this.warn('Nessun log trovato per oggi');
      return;
    }
    
    try {
      const logs = fs.readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
      
      const stats = {
        totalLogs: logs.length,
        errors: logs.filter(log => log.level === 'ERROR').length,
        warnings: logs.filter(log => log.level === 'WARN').length,
        transactions: logs.filter(log => log.message.includes('transazione')).length,
        opportunities: logs.filter(log => log.message.includes('Opportunità')).length
      };
      
      this.info('📊 Report giornaliero', stats);
      
    } catch (error) {
      this.error('Errore generazione report', error.message);
    }
  }
}

// Esporta istanza singleton
export default new SecureLogger();