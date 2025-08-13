/**
 * ANALIZZATORE OPPORTUNITÀ ARBITRAGGIO
 * ===================================
 * 
 * Identifica opportunità di arbitraggio tra DEX:
 * - Confronta prezzi tra diverse piattaforme
 * - Calcola profitti potenziali
 * - Considera gas fees e slippage
 * - Filtra opportunità secondo parametri configurabili
 */

import { ethers } from 'ethers';
import { ARBITRAGE_CONFIG, TOKENS, DEX_CONFIG } from '../config/config.js';
import priceFeeds from '../data/priceFeeds.js';
import blockchainConnection from '../blockchain/connection.js';
import logger from '../utils/logger.js';

class ArbitrageAnalyzer {
  constructor() {
    this.opportunities = new Map();
    this.analysisInterval = null;
    this.isRunning = false;
    this.dailyTransactionCount = 0;
    this.lastResetDate = new Date().toDateString();
    
    // Parametri di analisi
    this.minProfitPercentage = ARBITRAGE_CONFIG.minProfitPercentage;
    this.maxTransactionAmount = ARBITRAGE_CONFIG.maxTransactionAmount;
    this.slippageTolerance = ARBITRAGE_CONFIG.slippageTolerance;
  }
  
  /**
   * Avvia l'analizzatore di arbitraggio
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Analizzatore arbitraggio già in esecuzione');
      return;
    }
    
    logger.info('🔍 Avvio analizzatore arbitraggio...');
    
    try {
      // Verifica che il sistema prezzi sia attivo
      const priceStatus = priceFeeds.getStatus();
      if (!priceStatus.isRunning) {
        throw new Error('Sistema prezzi non attivo. Avviare prima priceFeeds.');
      }
      
      // Avvia analisi periodica
      this.startPeriodicAnalysis();
      
      this.isRunning = true;
      logger.info('✅ Analizzatore arbitraggio attivo');
      
    } catch (error) {
      logger.error('❌ Errore avvio analizzatore:', error.message);
      throw error;
    }
  }
  
  /**
   * Ferma l'analizzatore
   */
  stop() {
    logger.info('🛑 Arresto analizzatore arbitraggio...');
    
    this.isRunning = false;
    
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
    
    this.opportunities.clear();
    logger.info('✅ Analizzatore arbitraggio arrestato');
  }
  
  /**
   * Avvia analisi periodica
   */
  startPeriodicAnalysis() {
    // Analisi ogni 10 secondi
    this.analysisInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        await this.analyzeAllOpportunities();
      } catch (error) {
        logger.error('❌ Errore analisi arbitraggio:', error.message);
      }
    }, 10000);
    
    logger.info('⏰ Analisi arbitraggio ogni 10 secondi');
  }
  
  /**
   * Analizza tutte le opportunità di arbitraggio
   */
  async analyzeAllOpportunities() {
    const allPrices = priceFeeds.getAllCurrentPrices();
    const newOpportunities = [];
    
    // Analizza ogni rete
    for (const [networkName, networkTokens] of Object.entries(allPrices)) {
      // Analizza ogni token
      for (const [tokenSymbol, tokenData] of Object.entries(networkTokens)) {
        const opportunities = await this.analyzeTokenArbitrage(
          networkName, 
          tokenSymbol, 
          tokenData.prices
        );
        
        newOpportunities.push(...opportunities);
      }
    }
    
    // Filtra e ordina opportunità
    const validOpportunities = this.filterAndRankOpportunities(newOpportunities);
    
    // Aggiorna cache opportunità
    this.updateOpportunityCache(validOpportunities);
    
    // Log opportunità trovate
    if (validOpportunities.length > 0) {
      logger.info(`🎯 Trovate ${validOpportunities.length} opportunità di arbitraggio`);
      
      // Log le migliori 3 opportunità
      validOpportunities.slice(0, 3).forEach(opp => {
        logger.arbitrageOpportunity(
          opp.fromDex,
          opp.toDex,
          opp.token,
          opp.profitPercentage,
          opp.estimatedProfit
        );
      });
    }
  }
  
  /**
   * Analizza arbitraggio per un token specifico
   */
  async analyzeTokenArbitrage(networkName, tokenSymbol, prices) {
    const opportunities = [];
    const dexPrices = [];
    
    // Estrai prezzi validi da ogni DEX
    for (const [dexName, priceData] of Object.entries(prices)) {
      if (priceData.price > 0 && priceData.source === 'on-chain') {
        dexPrices.push({
          dex: dexName,
          price: priceData.price,
          timestamp: priceData.timestamp
        });
      }
    }
    
    // Serve almeno 2 DEX per arbitraggio
    if (dexPrices.length < 2) {
      return opportunities;
    }
    
    // Confronta tutti i pair di DEX
    for (let i = 0; i < dexPrices.length; i++) {
      for (let j = i + 1; j < dexPrices.length; j++) {
        const dex1 = dexPrices[i];
        const dex2 = dexPrices[j];
        
        // Determina direzione arbitraggio (compra dal più economico, vendi al più caro)
        let buyDex, sellDex;
        if (dex1.price < dex2.price) {
          buyDex = dex1;
          sellDex = dex2;
        } else {
          buyDex = dex2;
          sellDex = dex1;
        }
        
        // Calcola profitto potenziale
        const opportunity = await this.calculateArbitrageOpportunity(
          networkName,
          tokenSymbol,
          buyDex,
          sellDex
        );
        
        if (opportunity && opportunity.profitPercentage >= this.minProfitPercentage) {
          opportunities.push(opportunity);
        }
      }
    }
    
    return opportunities;
  }
  
  /**
   * Calcola opportunità di arbitraggio dettagliata
   */
  async calculateArbitrageOpportunity(networkName, tokenSymbol, buyDex, sellDex) {
    try {
      // Calcola differenza prezzo base
      const priceDifference = sellDex.price - buyDex.price;
      const profitPercentage = (priceDifference / buyDex.price) * 100;
      
      // Determina importo ottimale per transazione
      const optimalAmount = Math.min(
        this.maxTransactionAmount,
        this.calculateOptimalTradeSize(buyDex.price, sellDex.price)
      );
      
      // Stima gas fees
      const gasCosts = await this.estimateGasCosts(networkName, tokenSymbol);
      
      // Calcola profitto netto considerando gas e slippage
      const grossProfit = optimalAmount * priceDifference;
      const slippageCost = grossProfit * (this.slippageTolerance / 100);
      const netProfit = grossProfit - gasCosts.totalGasCost - slippageCost;
      
      // Calcola profitto percentuale netto
      const netProfitPercentage = (netProfit / (optimalAmount * buyDex.price)) * 100;
      
      return {
        id: `${networkName}-${tokenSymbol}-${buyDex.dex}-${sellDex.dex}-${Date.now()}`,
        network: networkName,
        token: tokenSymbol,
        fromDex: buyDex.dex,
        toDex: sellDex.dex,
        buyPrice: buyDex.price,
        sellPrice: sellDex.price,
        priceDifference,
        profitPercentage: netProfitPercentage,
        grossProfitPercentage: profitPercentage,
        optimalAmount,
        estimatedProfit: netProfit,
        grossProfit,
        gasCosts,
        slippageCost,
        timestamp: Date.now(),
        confidence: this.calculateConfidenceScore(buyDex, sellDex)
      };
      
    } catch (error) {
      logger.debug(`Errore calcolo arbitraggio ${tokenSymbol}:`, error.message);
      return null;
    }
  }
  
  /**
   * Calcola dimensione ottimale del trade
   */
  calculateOptimalTradeSize(buyPrice, sellPrice) {
    // Formula semplificata - in produzione si dovrebbe considerare:
    // - Liquidità disponibile sui DEX
    // - Impatto del prezzo (slippage)
    // - Limiti di gas
    
    const priceDifference = sellPrice - buyPrice;
    const profitRatio = priceDifference / buyPrice;
    
    // Più alto il profitto, più grande può essere il trade
    const baseAmount = 0.05; // 0.05 ETH base
    const scaleFactor = Math.min(profitRatio * 10, 2); // Max 2x scaling
    
    return Math.min(baseAmount * scaleFactor, this.maxTransactionAmount);
  }
  
  /**
   * Stima costi gas per arbitraggio
   */
  async estimateGasCosts(networkName, tokenSymbol) {
    try {
      const provider = blockchainConnection.getProvider(networkName);
      const feeData = await provider.getFeeData();
      
      // Stima gas per operazioni tipiche di arbitraggio
      const estimatedGasUnits = {
        approve: 50000,    // Approvazione token
        swap1: 150000,     // Prima swap (compra)
        swap2: 150000,     // Seconda swap (vendi)
        transfer: 21000    // Transfer se necessario
      };
      
      const totalGasUnits = Object.values(estimatedGasUnits).reduce((a, b) => a + b, 0);
      const gasPrice = feeData.gasPrice || ethers.parseUnits('20', 'gwei');
      const totalGasCost = parseFloat(ethers.formatEther(gasPrice * BigInt(totalGasUnits)));
      
      return {
        gasPrice: parseFloat(ethers.formatUnits(gasPrice, 'gwei')),
        totalGasUnits,
        totalGasCost,
        breakdown: estimatedGasUnits
      };
      
    } catch (error) {
      logger.debug(`Errore stima gas ${networkName}:`, error.message);
      
      // Fallback con stime conservative
      return {
        gasPrice: 30,
        totalGasUnits: 400000,
        totalGasCost: 0.012, // ~$20 con ETH a $1600
        breakdown: { estimated: 400000 }
      };
    }
  }
  
  /**
   * Calcola score di confidenza per l'opportunità
   */
  calculateConfidenceScore(buyDex, sellDex) {
    let score = 100;
    
    // Penalizza dati vecchi
    const maxAge = 30000; // 30 secondi
    const buyAge = Date.now() - buyDex.timestamp;
    const sellAge = Date.now() - sellDex.timestamp;
    
    if (buyAge > maxAge) score -= Math.min(50, (buyAge - maxAge) / 1000);
    if (sellAge > maxAge) score -= Math.min(50, (sellAge - maxAge) / 1000);
    
    // Bonus per DEX affidabili
    const reliableDexes = ['uniswap', 'sushiswap', 'pancakeswap'];
    if (reliableDexes.includes(buyDex.dex)) score += 10;
    if (reliableDexes.includes(sellDex.dex)) score += 10;
    
    return Math.max(0, Math.min(100, score));
  }
  
  /**
   * Filtra e ordina opportunità per qualità
   */
  filterAndRankOpportunities(opportunities) {
    return opportunities
      .filter(opp => {
        // Filtra per profitto minimo
        if (opp.profitPercentage < this.minProfitPercentage) return false;
        
        // Filtra per confidenza minima
        if (opp.confidence < 50) return false;
        
        // Filtra per età dati
        const dataAge = Date.now() - opp.timestamp;
        if (dataAge > 60000) return false; // Max 1 minuto
        
        return true;
      })
      .sort((a, b) => {
        // Ordina per profitto ponderato per confidenza
        const scoreA = a.profitPercentage * (a.confidence / 100);
        const scoreB = b.profitPercentage * (b.confidence / 100);
        return scoreB - scoreA;
      });
  }
  
  /**
   * Aggiorna cache opportunità
   */
  updateOpportunityCache(opportunities) {
    // Pulisci opportunità vecchie
    const cutoffTime = Date.now() - 300000; // 5 minuti
    for (const [id, opp] of this.opportunities) {
      if (opp.timestamp < cutoffTime) {
        this.opportunities.delete(id);
      }
    }
    
    // Aggiungi nuove opportunità
    opportunities.forEach(opp => {
      this.opportunities.set(opp.id, opp);
    });
  }
  
  /**
   * Ottiene migliori opportunità correnti
   */
  getBestOpportunities(limit = 10) {
    const opportunities = Array.from(this.opportunities.values())
      .filter(opp => {
        // Filtra opportunità troppo vecchie
        const age = Date.now() - opp.timestamp;
        return age < 60000; // Max 1 minuto
      })
      .sort((a, b) => {
        const scoreA = a.profitPercentage * (a.confidence / 100);
        const scoreB = b.profitPercentage * (b.confidence / 100);
        return scoreB - scoreA;
      })
      .slice(0, limit);
    
    return opportunities;
  }
  
  /**
   * Verifica se si può eseguire più transazioni oggi
   */
  canExecuteTransaction() {
    // Reset contatore se è un nuovo giorno
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyTransactionCount = 0;
      this.lastResetDate = today;
    }
    
    return this.dailyTransactionCount < ARBITRAGE_CONFIG.dailyTransactionLimit;
  }
  
  /**
   * Incrementa contatore transazioni giornaliere
   */
  incrementTransactionCount() {
    this.dailyTransactionCount++;
    logger.info(`📊 Transazioni oggi: ${this.dailyTransactionCount}/${ARBITRAGE_CONFIG.dailyTransactionLimit}`);
  }
  
  /**
   * Ottiene statistiche analizzatore
   */
  getStats() {
    const opportunities = Array.from(this.opportunities.values());
    const recentOpportunities = opportunities.filter(opp => {
      const age = Date.now() - opp.timestamp;
      return age < 300000; // Ultimi 5 minuti
    });
    
    return {
      isRunning: this.isRunning,
      totalOpportunities: opportunities.length,
      recentOpportunities: recentOpportunities.length,
      dailyTransactions: this.dailyTransactionCount,
      dailyLimit: ARBITRAGE_CONFIG.dailyTransactionLimit,
      bestOpportunity: recentOpportunities.length > 0 ? 
        recentOpportunities.reduce((best, current) => 
          current.profitPercentage > best.profitPercentage ? current : best
        ) : null
    };
  }
}

// Esporta istanza singleton
export default new ArbitrageAnalyzer();