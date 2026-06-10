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
      name: 'SushiSwap V2',
      router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      enabled: false // Disabilitato - non deployato su Sepolia testnet
    }
  },
  bsc: {
    pancakeswap: {
      name: 'PancakeSwap V3',
      router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
      factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
      quoter: '0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2',
      enabled: false // Disabilitato temporaneamente - pool non disponibili su testnet
    }
  },
  polygon: {
    quickswap: {
      name: 'QuickSwap V2',
      router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
      factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
      enabled: true // Abilitato con prezzi simulati per Amoy testnet
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
 * Modulo Arbitraggio EVM — DEMO EDUCATIVA
 * =======================================
 * Prezzi simulati, opportunità casuali, "esecuzione" = self-transfer di 0 ETH.
 * NON è arbitraggio reale. Disattivato di default e fuori dalla build di produzione.
 * Attivare solo per dimostrazione con DEMO_EVM_ENABLED=true.
 */
export const DEMO_EVM = {
  enabled: process.env.DEMO_EVM_ENABLED === 'true'
};

/**
 * Configurazione Perps Trading (Hyperliquid)
 * =========================================
 * Endpoint testnet/mainnet, limiti di rischio e parametri auto-pilot.
 * Lo switch tra testnet e mainnet è gestito a runtime (vedi src/perps/hyperliquidClient.js).
 */
export const HYPERLIQUID_CONFIG = {
  // Endpoint REST/WS ufficiali
  endpoints: {
    testnet: {
      api: 'https://api.hyperliquid-testnet.xyz',
      ws: 'wss://api.hyperliquid-testnet.xyz/ws',
      explorer: 'https://app.hyperliquid-testnet.xyz',
      hyperliquidChain: 'Testnet'
    },
    mainnet: {
      api: 'https://api.hyperliquid.xyz',
      ws: 'wss://api.hyperliquid.xyz/ws',
      explorer: 'https://app.hyperliquid.xyz',
      hyperliquidChain: 'Mainnet'
    }
  },
  // Rete attiva di default (testnet per sicurezza). Sovrascrivibile via ENV o API.
  defaultNetwork: process.env.HYPERLIQUID_NETWORK || 'testnet',
  // signatureChainId usato nel dominio EIP-712 per le user-signed action (approveAgent).
  // Arbitrum One (0xa4b1) è il valore canonico accettato da Hyperliquid per la firma,
  // indipendentemente dalla rete HL effettiva (differenziata da hyperliquidChain).
  signatureChainId: '0xa4b1',
  // Limiti di rischio di default applicati lato server prima di ogni ordine
  risk: {
    maxLeverage: parseInt(process.env.PERPS_MAX_LEVERAGE) || 20,
    maxPositionUsd: parseFloat(process.env.PERPS_MAX_POSITION_USD) || 5000,
    defaultLeverage: parseInt(process.env.PERPS_DEFAULT_LEVERAGE) || 3,
    maxDailyLossUsd: parseFloat(process.env.PERPS_MAX_DAILY_LOSS_USD) || 1000
  },
  // Intervallo (ms) del loop di valutazione di ogni bot auto-pilot
  botLoopInterval: parseInt(process.env.PERPS_BOT_INTERVAL) || 10000,
  // Optimizer (Hyperopt): default conservativi per restare reattivo (il backtester
  // è O(N²) per valutazione, quindi limitiamo evals e candele).
  optimizer: {
    maxEvals: parseInt(process.env.PERPS_OPT_MAX_EVALS) || 50,
    minTrades: parseInt(process.env.PERPS_OPT_MIN_TRADES) || 10,
    oosFraction: parseFloat(process.env.PERPS_OPT_OOS_FRACTION) || 0.3,
    candleCap: parseInt(process.env.PERPS_OPT_CANDLE_CAP) || 1500
  },
  // Predittore ML (FreqAI-lite): orizzonte di previsione e soglia di rialzo.
  predictor: {
    lookbackDays: parseInt(process.env.PERPS_ML_LOOKBACK_DAYS) || 90,
    lookforward: parseInt(process.env.PERPS_ML_LOOKFORWARD) || 5,
    threshold: parseFloat(process.env.PERPS_ML_THRESHOLD) || 0.003,
    candleCap: parseInt(process.env.PERPS_ML_CANDLE_CAP) || 2000
  },
  // Sistema agentico + Analyst AI (Claude). L'AI è solo advisory.
  agents: {
    enabled: process.env.AGENTS_ENABLED === 'true',
    analystModel: process.env.AGENT_ANALYST_MODEL || 'claude-sonnet-4-6',
    cadenceMin: parseInt(process.env.AGENT_CADENCE_MIN) || 30,        // ogni quanto gira l'Analyst
    maxCallsPerHour: parseInt(process.env.AGENT_MAX_CALLS_PER_HOUR) || 8, // cap costi/latenza
    proposalTtlMin: parseInt(process.env.AGENT_PROPOSAL_TTL_MIN) || 30,   // scadenza proposte
    // Whitelist mercati per le azioni di apertura (vuota = tutti). Es: "ETH,BTC,SOL"
    marketWhitelist: (process.env.AGENT_MARKET_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean),
    // Prezzi STIMATI dei modelli Claude in USD per 1M di token (input/output).
    // Configurabili: aggiorna se i listini cambiano. La scelta del tier avviene
    // per sottostringa del nome modello (opus/sonnet/haiku).
    pricing: {
      opus: { in: parseFloat(process.env.PRICE_OPUS_IN) || 15, out: parseFloat(process.env.PRICE_OPUS_OUT) || 75 },
      sonnet: { in: parseFloat(process.env.PRICE_SONNET_IN) || 3, out: parseFloat(process.env.PRICE_SONNET_OUT) || 15 },
      haiku: { in: parseFloat(process.env.PRICE_HAIKU_IN) || 1, out: parseFloat(process.env.PRICE_HAIKU_OUT) || 5 }
    }
  }
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
  const isProd = process.env.NODE_ENV === 'production';
  const hlNetwork = HYPERLIQUID_CONFIG.defaultNetwork;

  // --- Sicurezza di produzione (segreti obbligatori) ---
  // NOTA: NETWORK_MODE riguarda l'arbitraggio EVM (resta testnet); la rete
  // Hyperliquid è separata e governata da HYPERLIQUID_NETWORK.
  if (isProd) {
    const encKey = process.env.AGENT_ENCRYPTION_KEY || '';
    if (encKey.length < 32) {
      errors.push('PROD: AGENT_ENCRYPTION_KEY mancante o troppo corta (richiesti ≥32 caratteri).');
    }
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
      errors.push('PROD: SESSION_SECRET mancante o troppo corta (richiesti ≥16 caratteri).');
    }
    if (!process.env.APP_PASSWORD_HASH) {
      errors.push('PROD: APP_PASSWORD_HASH mancante (genera con: node scripts/hash-password.js).');
    }
  }

  // --- Guard mainnet Hyperliquid: conferma esplicita per denaro reale ---
  if (hlNetwork === 'mainnet' && process.env.ALLOW_MAINNET !== 'true') {
    errors.push('Hyperliquid MAINNET richiede ALLOW_MAINNET=true (conferma esplicita per operare con denaro reale).');
  }
  if (hlNetwork === 'mainnet' && process.env.ALLOW_MAINNET === 'true') {
    console.warn('\n🔴🔴🔴 ATTENZIONE: Hyperliquid MAINNET ATTIVO — gli ordini useranno DENARO REALE 🔴🔴🔴\n');
  }

  // --- Verifiche specifiche del modulo demo Arbitraggio EVM (solo se attivo) ---
  if (DEMO_EVM.enabled) {
    if (SECURITY_CONFIG.networkMode !== 'testnet') {
      errors.push('ERRORE CRITICO: la demo EVM deve funzionare SOLO in modalità testnet (NETWORK_MODE=testnet)!');
    }
    Object.entries(NETWORKS).forEach(([network, config]) => {
      if (!config.rpcUrl) {
        errors.push(`RPC URL mancante per ${network}`);
      }
      if (!config.isTestnet) {
        errors.push(`ERRORE CRITICO: ${network} non è configurato come testnet!`);
      }
    });
    if (!process.env.WALLET_ADDRESS) {
      errors.push('Indirizzo wallet mancante (richiesto dalla demo EVM)');
    }
  }

  if (errors.length > 0) {
    console.error('❌ Errori di configurazione:');
    errors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
  }

  console.log(`✅ Configurazione validata — HL: ${hlNetwork}${DEMO_EVM.enabled ? ' · demo EVM attiva' : ''}`);
}

/**
 * Esporta configurazione completa
 */
export default {
  NETWORKS,
  DEX_CONFIG,
  TOKENS,
  ARBITRAGE_CONFIG,
  DEMO_EVM,
  HYPERLIQUID_CONFIG,
  SECURITY_CONFIG,
  LOGGING_CONFIG,
  API_CONFIG,
  validateConfig
};