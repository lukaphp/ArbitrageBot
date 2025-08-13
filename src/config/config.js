/**
 * CONFIGURAZIONE PRINCIPALE ARBITRAGE BOT
 * =====================================
 * 
 * Gestisce tutte le configurazioni del sistema in modo sicuro
 * IMPORTANTE: Funziona SOLO in testnet per sicurezza
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Carica variabili d'ambiente
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Configurazione delle reti supportate (SOLO TESTNET)
 */
export const NETWORKS = {
  ethereum: {
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    rpcUrl: process.env.ETHEREUM_TESTNET_RPC,
    nativeCurrency: 'ETH',
    blockExplorer: 'https://sepolia.etherscan.io',
    isTestnet: true
  },
  bsc: {
    name: 'BSC Testnet',
    chainId: 97,
    rpcUrl: process.env.BSC_TESTNET_RPC,
    nativeCurrency: 'BNB',
    blockExplorer: 'https://testnet.bscscan.com',
    isTestnet: true
  },
  polygon: {
    name: 'Polygon Amoy',
    chainId: 80002,
    rpcUrl: process.env.POLYGON_TESTNET_RPC,
    nativeCurrency: 'MATIC',
    blockExplorer: 'https://amoy.polygonscan.com',
    isTestnet: true
  }
};

/**
 * Configurazione DEX supportati per ogni rete
 */
export const DEX_CONFIG = {
  ethereum: {
    uniswap: {
      name: 'Uniswap V3',
      router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
    },
    sushiswap: {
      name: 'SushiSwap',
      router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4'
    }
  },
  bsc: {
    pancakeswap: {
      name: 'PancakeSwap V3',
      router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
      factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
    }
  },
  polygon: {
    quickswap: {
      name: 'QuickSwap',
      router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
      factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32'
    }
  }
};

/**
 * Token comuni per arbitraggio (indirizzi testnet)
 */
export const TOKENS = {
  ethereum: {
    WETH: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
    USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    USDT: '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06',
    DAI: '0x3e622317f8C93f7328350cF0B56d9eD4C620C5d6'
  },
  bsc: {
    WBNB: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
    USDC: '0x64544969ed7EBf5f083679233325356EbE738930',
    USDT: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
    BUSD: '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee'
  },
  polygon: {
    WMATIC: '0x9c3C9283D3e44854697Cd22D3Faa240Cfb032889',
    USDC: '0x2058A9D7613eEE744279e3856Ef0eAda5FCbaA7e',
    USDT: '0x3813e82e6f7098b9583FC0F33a962D02018B6803',
    DAI: '0x001B3B4d0F3714Ca98ba10F6042DaEbF0B1B7b6F'
  }
};

/**
 * Configurazione parametri arbitraggio
 */
export const ARBITRAGE_CONFIG = {
  minProfitPercentage: parseFloat(process.env.MIN_PROFIT_PERCENTAGE) || 0.5,
  maxTransactionAmount: parseFloat(process.env.MAX_TRANSACTION_AMOUNT) || 0.1,
  maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 50,
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 1.0,
  dailyTransactionLimit: parseInt(process.env.DAILY_TRANSACTION_LIMIT) || 10,
  priceUpdateInterval: parseInt(process.env.PRICE_UPDATE_INTERVAL) || 5000
};

/**
 * Configurazione sicurezza
 */
export const SECURITY_CONFIG = {
  enableSecurityChecks: process.env.ENABLE_SECURITY_CHECKS === 'true',
  enableSimulation: process.env.ENABLE_SIMULATION === 'true',
  networkMode: process.env.NETWORK_MODE || 'testnet',
  maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3,
  retryInterval: parseInt(process.env.RETRY_INTERVAL) || 2000,
  httpTimeout: parseInt(process.env.HTTP_TIMEOUT) || 10000
};

/**
 * Configurazione logging
 */
export const LOGGING_CONFIG = {
  level: process.env.LOG_LEVEL || 'info',
  enableFileLogging: process.env.ENABLE_FILE_LOGGING === 'true',
  logDirectory: process.env.LOG_DIRECTORY || './logs'
};

/**
 * Configurazione API
 */
export const API_CONFIG = {
  coingecko: {
    apiKey: process.env.COINGECKO_API_KEY,
    baseUrl: 'https://api.coingecko.com/api/v3'
  },
  oneInch: {
    apiKey: process.env.ONEINCH_API_KEY,
    baseUrl: 'https://api.1inch.io/v5.0'
  },
  moralis: {
    apiKey: process.env.MORALIS_API_KEY,
    baseUrl: 'https://deep-index.moralis.io/api/v2'
  }
};

/**
 * Validazione configurazione critica
 */
export function validateConfig() {
  const errors = [];
  
  // Verifica modalità testnet
  if (SECURITY_CONFIG.networkMode !== 'testnet') {
    errors.push('ERRORE CRITICO: Il bot deve funzionare SOLO in modalità testnet!');
  }
  
  // Verifica RPC URLs
  Object.entries(NETWORKS).forEach(([network, config]) => {
    if (!config.rpcUrl) {
      errors.push(`RPC URL mancante per ${network}`);
    }
    if (!config.isTestnet) {
      errors.push(`ERRORE CRITICO: ${network} non è configurato come testnet!`);
    }
  });
  
  // Verifica wallet address
  if (!process.env.WALLET_ADDRESS) {
    errors.push('Indirizzo wallet mancante');
  }
  
  if (errors.length > 0) {
    console.error('❌ Errori di configurazione:');
    errors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
  }
  
  console.log('✅ Configurazione validata - Modalità TESTNET attiva');
}

/**
 * Esporta configurazione completa
 */
export default {
  NETWORKS,
  DEX_CONFIG,
  TOKENS,
  ARBITRAGE_CONFIG,
  SECURITY_CONFIG,
  LOGGING_CONFIG,
  API_CONFIG,
  validateConfig
};