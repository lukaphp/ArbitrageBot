/**
 * SISTEMA RACCOLTA DATI PREZZI DEX
 * ===============================
 * 
 * Raccoglie prezzi da multiple fonti:
 * - DEX on-chain (Uniswap, SushiSwap, PancakeSwap)
 * - API aggregatori (1inch, CoinGecko)
 * - WebSocket feeds per aggiornamenti real-time
 */

import { ethers } from 'ethers';
import axios from 'axios';
import WebSocket from 'ws';
import { DEX_CONFIG, TOKENS, API_CONFIG, ARBITRAGE_CONFIG, SECURITY_CONFIG } from '../config/config.js';
import blockchainConnection from '../blockchain/connection.js';
import logger from '../utils/logger.js';

class PriceFeedManager {
  constructor() {
    this.priceCache = new Map();
    this.lastUpdate = new Map();
    this.websockets = new Map();
    this.updateInterval = null;
    this.isRunning = false;
    
    // ABI per interagire con DEX
    this.uniswapV3QuoterAbi = [
      'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
    ];
    
    this.erc20Abi = [
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)'
    ];
  }
  
  /**
   * Avvia il sistema di raccolta prezzi
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Sistema prezzi già in esecuzione');
      return;
    }
    
    logger.info('🚀 Avvio sistema raccolta prezzi...');
    
    try {
      // Inizializza cache prezzi
      await this.initializePriceCache();
      
      // Avvia aggiornamenti periodici
      this.startPeriodicUpdates();
      
      // Connetti WebSocket feeds (se disponibili)
      await this.connectWebSocketFeeds();
      
      this.isRunning = true;
      logger.info('✅ Sistema prezzi attivo');
      
    } catch (error) {
      logger.error('❌ Errore avvio sistema prezzi:', error.message);
      throw error;
    }
  }
  
  /**
   * Ferma il sistema di raccolta prezzi
   */
  async stop() {
    logger.info('🛑 Arresto sistema prezzi...');
    
    this.isRunning = false;
    
    // Ferma aggiornamenti periodici
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    // Chiudi WebSocket connections
    for (const [name, ws] of this.websockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    this.websockets.clear();
    
    logger.info('✅ Sistema prezzi arrestato');
  }
  
  /**
   * Inizializza cache prezzi con dati iniziali
   */
  async initializePriceCache() {
    logger.info('📊 Inizializzazione cache prezzi...');
    
    const promises = [];

    for (const [networkName, tokens] of Object.entries(TOKENS)) {
      for (const [tokenSymbol, tokenAddress] of Object.entries(tokens)) {
        promises.push(this.loadTokenPrice(networkName, tokenSymbol, tokenAddress));
      }
    }

    await Promise.allSettled(promises);
    logger.info(`✅ Cache prezzi inizializzata (${this.priceCache.size} entry)`);
  }

  /**
   * Carica prezzo singolo token (helper per inizializzazione)
   */
  async loadTokenPrice(networkName, tokenSymbol, tokenAddress) {
    try {
      // Ottieni prezzi da tutte le fonti disponibili
      const prices = await this.getAllPricesForToken(networkName, tokenSymbol, tokenAddress);
      
      const cacheKey = `${networkName}-${tokenSymbol}`;
      this.priceCache.set(cacheKey, prices);
      this.lastUpdate.set(cacheKey, Date.now());
      
      logger.debug(`💰 Prezzi iniziali ${tokenSymbol} su ${networkName}`, prices);
      
    } catch (error) {
      logger.warn(`⚠️ Errore inizializzazione prezzi ${tokenSymbol}:`, error.message);
    }
  }
  
  /**
   * Ottiene prezzi da tutte le fonti per un token
   */
  async getAllPricesForToken(networkName, tokenSymbol, tokenAddress) {
    const prices = {};
    
    // Prezzi da DEX on-chain
    const dexPrices = await this.getDexPrices(networkName, tokenSymbol, tokenAddress);
    Object.assign(prices, dexPrices);
    
    // In testnet saltiamo le API esterne per velocità e per evitare conflitti con i prezzi simulati
    if (SECURITY_CONFIG.networkMode !== 'testnet') {
      // Prezzi da API esterne
      const apiPrices = await this.getApiPrices(tokenSymbol);
      Object.assign(prices, apiPrices);
    }
    
    return prices;
  }
  
  /**
   * Ottiene prezzi da DEX on-chain
   */
  async getDexPrices(networkName, tokenSymbol, tokenAddress) {
    const prices = {};
    const dexes = DEX_CONFIG[networkName] || {};
    
    // In modalità testnet, genera sempre prezzi simulati per garantire dati visibili
    // Questo è necessario perché:
    // 1. Polygon Amoy non ha DEX ufficiali
    // 2. BSC Testnet ha liquidità limitata/assente
    // 3. Sepolia ha pool con liquidità frammentata o assente
    // 4. Vercel ha limitazioni di timeout per chiamate RPC multiple
    if (SECURITY_CONFIG.networkMode === 'testnet') {
      return this.generateMockPrices(networkName, tokenSymbol);
    }
    
    // Token di riferimento per verificare liquidità
    const referenceToken = TOKENS[networkName]?.USDC;
    if (!referenceToken) {
      logger.debug(`Token di riferimento non trovato per ${networkName}`);
      return prices;
    }
    
    for (const [dexName, dexConfig] of Object.entries(dexes)) {
      try {
        // Salta DEX disabilitati
        if (dexConfig.enabled === false) {
          logger.debug(`⏭️ DEX ${dexName} disabilitato, saltando...`);
          continue;
        }
        
        // Prima verifica se esiste liquidità nel pool
        const hasLiquidity = await this.checkPoolLiquidity(networkName, dexName, tokenAddress, referenceToken);
        
        if (!hasLiquidity) {
          logger.debug(`⚠️ Pool ${dexName} ${tokenSymbol}/USDC: nessuna liquidità`);
          continue;
        }
        
        const price = await this.getTokenPriceFromDex(
          networkName, 
          dexName, 
          tokenAddress, 
          dexConfig
        );
        
        if (price > 0) {
          prices[dexName] = {
            price,
            source: 'on-chain',
            timestamp: Date.now(),
            hasLiquidity: true
          };
        }
        
      } catch (error) {
        logger.debug(`Errore prezzo ${dexName} per ${tokenSymbol}:`, error.message);
      }
    }
    
    return prices;
  }
  
  /**
   * Genera prezzi simulati per testnet
   * Simula prezzi realistici basati su valori di mercato attuali
   */
  generateMockPrices(networkName, tokenSymbol) {
    logger.info(`🎭 Generando prezzi simulati per ${tokenSymbol} su ${networkName}`);
    
    // Prezzi base simulati (in USD)
    const basePrices = {
      'WMATIC': 0.85,
      'USDC': 1.00,
      'USDT': 0.999,
      'WETH': 2400.00,
      'WBTC': 45000.00,
      'DAI': 1.001,
      'WBNB': 320.00,
      'BUSD': 1.00
    };
    
    const basePrice = basePrices[tokenSymbol] || 1.0;
    
    // Mappa dei DEX per network
    const networkDexes = {
      'ethereum': ['Uniswap', 'SushiSwap', 'Balancer'],
      'bsc': ['PancakeSwap', 'BiSwap', 'Apeswap'],
      'polygon': ['QuickSwap', 'SushiSwap', 'Uniswap']
    };
    
    const dexList = networkDexes[networkName] || ['Uniswap', 'SushiSwap'];
    const mockPrices = {};
    
    dexList.forEach(dexName => {
        // Simula variazioni di prezzo tra DEX (spread del 0.1-0.5%)
        mockPrices[dexName] = {
            price: basePrice * (1 + (Math.random() - 0.5) * 0.005),
            source: 'mock-testnet',
            timestamp: Date.now(),
            hasLiquidity: true,
            note: `Prezzo simulato per ${networkName}`
        };
    });
    
    return mockPrices;
  }
  
  /**
   * Ottiene prezzo da un DEX specifico
   */
  async getTokenPriceFromDex(networkName, dexName, tokenAddress, dexConfig) {
    const provider = blockchainConnection.getProvider(networkName);
    
    // Indirizzo token di riferimento (USDC per il prezzo in USD)
    const referenceToken = TOKENS[networkName]?.USDC;
    if (!referenceToken) {
      throw new Error(`Token di riferimento non trovato per ${networkName}`);
    }
    
    // Quantità di test (1 token)
    const amountIn = ethers.parseUnits('1', 18);
    
    try {
      if (dexName === 'uniswap' && dexConfig.quoter) {
        // Uniswap V3 - Usa callStatic per evitare errori di transazione
        const quoter = new ethers.Contract(dexConfig.quoter, this.uniswapV3QuoterAbi, provider);
        
        const amountOut = await quoter.quoteExactInputSingle.staticCall(
          tokenAddress,
          referenceToken,
          3000, // Fee tier 0.3%
          amountIn,
          0 // No price limit
        );
        
        return parseFloat(ethers.formatUnits(amountOut, 6)); // USDC ha 6 decimali
        
      } else if (dexName === 'pancakeswap' && dexConfig.router) {
        // PancakeSwap V3 su BSC
        return await this.getPancakeSwapPrice(provider, tokenAddress, referenceToken, amountIn);
        
      } else if (dexName === 'sushiswap' && dexConfig.router) {
        // SushiSwap su Ethereum
        return await this.getSushiSwapPrice(provider, tokenAddress, referenceToken, amountIn);
        
      } else if (dexName === 'quickswap' && dexConfig.router) {
        // QuickSwap su Polygon
        return await this.getQuickSwapPrice(provider, tokenAddress, referenceToken, amountIn);
        
      } else {
        logger.debug(`Implementazione prezzo per ${dexName} non ancora disponibile`);
        return 0;
      }
      
    } catch (error) {
      logger.debug(`Errore quotazione ${dexName}:`, error.message);
      return 0;
    }
  }

  /**
   * Ottiene prezzo da PancakeSwap V3 (BSC)
   */
  async getPancakeSwapPrice(provider, tokenIn, tokenOut, amountIn) {
    try {
      // ABI per PancakeSwap V3 Quoter
      const pancakeQuoterAbi = [
        'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
      ];
      
      // PancakeSwap V3 Quoter su BSC Testnet
      const quoterAddress = '0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2';
      const quoter = new ethers.Contract(quoterAddress, pancakeQuoterAbi, provider);
      
      const result = await quoter.quoteExactInputSingle.staticCall(
        tokenIn,
        tokenOut,
        2500, // Fee tier 0.25%
        amountIn,
        0 // sqrtPriceLimitX96
      );
      
      // Il risultato è un array con [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate]
      const amountOut = result[0];
      
      return parseFloat(ethers.formatUnits(amountOut, 6));
      
    } catch (error) {
      logger.debug(`Errore PancakeSwap:`, error.message);
      return 0;
    }
  }

  /**
   * Ottiene prezzo da SushiSwap V2 (Ethereum)
   */
  async getSushiSwapPrice(provider, tokenIn, tokenOut, amountIn) {
    try {
      // ABI per SushiSwap V2 Router
      const sushiRouterAbi = [
        'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
      ];
      
      // SushiSwap V2 Router su Ethereum Sepolia
      const routerAddress = '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506';
      const router = new ethers.Contract(routerAddress, sushiRouterAbi, provider);
      
      const path = [tokenIn, tokenOut];
      const amounts = await router.getAmountsOut(amountIn, path);
      
      return parseFloat(ethers.formatUnits(amounts[1], 6));
      
    } catch (error) {
      logger.debug(`Errore SushiSwap:`, error.message);
      return 0;
    }
  }

  /**
   * Ottiene prezzo da QuickSwap V2 (Polygon)
   */
  async getQuickSwapPrice(provider, tokenIn, tokenOut, amountIn) {
    try {
      // ABI per QuickSwap V2 Router
      const quickRouterAbi = [
        'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
      ];
      
      // QuickSwap V2 Router su Polygon Amoy
      const routerAddress = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
      const router = new ethers.Contract(routerAddress, quickRouterAbi, provider);
      
      const path = [tokenIn, tokenOut];
      const amounts = await router.getAmountsOut(amountIn, path);
      
      return parseFloat(ethers.formatUnits(amounts[1], 6));
      
    } catch (error) {
      logger.debug(`Errore QuickSwap:`, error.message);
      return 0;
    }
  }

  /**
   * Verifica liquidità pool per una coppia di token
   * Semplificata per testnet - assume liquidità presente se il DEX è configurato
   */
  async checkPoolLiquidity(networkName, dexName, tokenA, tokenB) {
    try {
      const dexConfig = DEX_CONFIG[networkName]?.[dexName];
      
      if (!dexConfig) {
        logger.debug(`DEX ${dexName} non configurato per ${networkName}`);
        return false;
      }
      
      // Per testnet, assumiamo liquidità presente se il DEX è configurato
      // In produzione si dovrebbe verificare effettivamente la liquidità
      logger.debug(`✅ Pool ${dexName} ${tokenA}/${tokenB}: assumendo liquidità presente (testnet)`);
      return true;
      
    } catch (error) {
      logger.debug(`Errore verifica liquidità ${dexName}:`, error.message);
      return false;
    }
  }

  /**
   * Ottiene prezzi da API esterne
   */
  async getApiPrices(tokenSymbol) {
    const prices = {};
    
    // CoinGecko API
    try {
      const cgPrice = await this.getCoinGeckoPrice(tokenSymbol);
      if (cgPrice > 0) {
        prices.coingecko = {
          price: cgPrice,
          source: 'api',
          timestamp: Date.now()
        };
      }
    } catch (error) {
      logger.debug(`Errore CoinGecko per ${tokenSymbol}:`, error.message);
    }
    
    // 1inch API
    try {
      const oneInchPrice = await this.get1inchPrice(tokenSymbol);
      if (oneInchPrice > 0) {
        prices.oneinch = {
          price: oneInchPrice,
          source: 'api',
          timestamp: Date.now()
        };
      }
    } catch (error) {
      logger.debug(`Errore 1inch per ${tokenSymbol}:`, error.message);
    }
    
    return prices;
  }
  
  /**
   * Ottiene prezzo da CoinGecko
   */
  async getCoinGeckoPrice(tokenSymbol) {
    if (!API_CONFIG.coingecko.apiKey) {
      return 0;
    }
    
    const tokenMap = {
      'WETH': 'ethereum',
      'USDC': 'usd-coin',
      'USDT': 'tether',
      'DAI': 'dai',
      'WBNB': 'binancecoin',
      'WMATIC': 'matic-network'
    };
    
    const coinId = tokenMap[tokenSymbol];
    if (!coinId) return 0;
    
    try {
      const response = await axios.get(
        `${API_CONFIG.coingecko.baseUrl}/simple/price`,
        {
          params: {
            ids: coinId,
            vs_currencies: 'usd'
          },
          headers: {
            'X-CG-Demo-API-Key': API_CONFIG.coingecko.apiKey
          },
          timeout: 5000
        }
      );
      
      return response.data[coinId]?.usd || 0;
      
    } catch (error) {
      logger.debug('Errore CoinGecko API:', error.message);
      return 0;
    }
  }
  
  /**
   * Ottiene prezzo da 1inch
   */
  async get1inchPrice(tokenSymbol) {
    // Implementazione 1inch API
    // Per ora ritorna 0, da implementare se necessario
    return 0;
  }
  
  /**
   * Avvia aggiornamenti periodici
   */
  startPeriodicUpdates() {
    this.updateInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        await this.updateAllPrices();
      } catch (error) {
        logger.error('❌ Errore aggiornamento prezzi:', error.message);
      }
    }, ARBITRAGE_CONFIG.priceUpdateInterval);
    
    logger.info(`⏰ Aggiornamenti prezzi ogni ${ARBITRAGE_CONFIG.priceUpdateInterval}ms`);
  }
  
  /**
   * Aggiorna tutti i prezzi
   */
  async updateAllPrices() {
    const updatePromises = [];
    
    for (const [networkName, tokens] of Object.entries(TOKENS)) {
      for (const [tokenSymbol, tokenAddress] of Object.entries(tokens)) {
        updatePromises.push(
          this.updateTokenPrice(networkName, tokenSymbol, tokenAddress)
        );
      }
    }
    
    await Promise.allSettled(updatePromises);
  }
  
  /**
   * Aggiorna prezzo di un token specifico
   */
  async updateTokenPrice(networkName, tokenSymbol, tokenAddress) {
    try {
      const prices = await this.getAllPricesForToken(networkName, tokenSymbol, tokenAddress);
      
      const cacheKey = `${networkName}-${tokenSymbol}`;
      const oldPrices = this.priceCache.get(cacheKey) || {};
      
      this.priceCache.set(cacheKey, prices);
      this.lastUpdate.set(cacheKey, Date.now());
      
      // Log solo se c'è una variazione significativa
      const avgOldPrice = this.calculateAveragePrice(oldPrices);
      const avgNewPrice = this.calculateAveragePrice(prices);
      
      if (avgOldPrice > 0 && avgNewPrice > 0) {
        const change = ((avgNewPrice - avgOldPrice) / avgOldPrice) * 100;
        
        if (Math.abs(change) > 0.1) { // Log solo variazioni > 0.1%
          logger.priceUpdate(networkName, tokenSymbol, avgNewPrice, change);
        }
      }
      
    } catch (error) {
      logger.debug(`Errore aggiornamento ${tokenSymbol}:`, error.message);
    }
  }
  
  /**
   * Calcola prezzo medio da multiple fonti
   */
  calculateAveragePrice(prices) {
    const validPrices = Object.values(prices)
      .map(p => p.price)
      .filter(p => p > 0);
    
    if (validPrices.length === 0) return 0;
    
    return validPrices.reduce((sum, price) => sum + price, 0) / validPrices.length;
  }
  
  /**
   * Connette WebSocket feeds per aggiornamenti real-time
   */
  async connectWebSocketFeeds() {
    // Implementazione WebSocket feeds
    // Per ora placeholder, da implementare se necessario
    logger.debug('WebSocket feeds non ancora implementati');
  }
  
  /**
   * Ottiene prezzi correnti per un token
   */
  getTokenPrices(networkName, tokenSymbol) {
    const cacheKey = `${networkName}-${tokenSymbol}`;
    const prices = this.priceCache.get(cacheKey);
    const lastUpdate = this.lastUpdate.get(cacheKey);
    
    if (!prices) {
      throw new Error(`Prezzi non disponibili per ${tokenSymbol} su ${networkName}`);
    }
    
    // Verifica se i dati sono troppo vecchi (> 1 minuto)
    const dataAge = Date.now() - (lastUpdate || 0);
    if (dataAge > 60000) {
      logger.warn(`⚠️ Dati prezzi obsoleti per ${tokenSymbol} (${Math.round(dataAge/1000)}s)`);
    }
    
    return {
      prices,
      averagePrice: this.calculateAveragePrice(prices),
      lastUpdate,
      dataAge
    };
  }
  
  /**
   * Ottiene tutti i prezzi correnti
   */
  getAllCurrentPrices() {
    const allPrices = {};
    
    logger.debug(`📊 Cache prezzi - Elementi totali: ${this.priceCache.size}`);
    logger.debug(`📊 Cache keys:`, Array.from(this.priceCache.keys()));
    
    for (const [cacheKey, prices] of this.priceCache) {
      const [network, token] = cacheKey.split('-');
      
      logger.debug(`💰 Elaborando ${cacheKey}:`, prices);
      
      if (!allPrices[network]) {
        allPrices[network] = {};
      }
      
      allPrices[network][token] = {
        prices,
        averagePrice: this.calculateAveragePrice(prices),
        lastUpdate: this.lastUpdate.get(cacheKey)
      };
    }
    
    logger.debug(`📊 Risultato getAllCurrentPrices:`, Object.keys(allPrices).length > 0 ? allPrices : 'Cache vuota');
    
    return allPrices;
  }
  
  /**
   * Ottiene stato del sistema prezzi
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      cachedTokens: this.priceCache.size,
      lastGlobalUpdate: Math.max(...Array.from(this.lastUpdate.values())),
      websocketConnections: this.websockets.size
    };
  }
}

// Esporta istanza singleton
export default new PriceFeedManager();