/**
 * GESTORE CONNESSIONI BLOCKCHAIN SICURE
 * ====================================
 * 
 * Gestisce connessioni sicure a blockchain testnet:
 * - Connessione a MetaMask (non-custodial)
 * - Provider RPC per lettura dati
 * - Validazione sicurezza prima di ogni operazione
 */

import { ethers } from 'ethers';
import { NETWORKS, SECURITY_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

class BlockchainConnection {
  constructor() {
    this.providers = new Map();
    this.signer = null;
    this.connectedNetwork = null;
    this.walletAddress = null;
    this.isBrowser = typeof window !== 'undefined' && typeof window.ethereum !== 'undefined';
    
    // Inizializza provider per tutte le reti testnet
    this.initializeProviders();
  }
  
  /**
   * Inizializza provider RPC per tutte le reti testnet
   */
  async initializeProviders() {
    logger.info('🔗 Inizializzazione provider blockchain...');
    
    for (const [networkName, config] of Object.entries(NETWORKS)) {
      try {
        // CONTROLLO SICUREZZA: Verifica che sia testnet
        if (!config.isTestnet) {
          logger.securityAlert('MAINNET_DETECTED', `Rete ${networkName} non è testnet!`);
          continue;
        }
        
        if (!config.rpcUrl) {
          logger.warn(`RPC URL mancante per ${networkName}`);
          continue;
        }
        
        const provider = new ethers.JsonRpcProvider(config.rpcUrl);
        
        // Test connessione
        const network = await provider.getNetwork();
        
        // CONTROLLO SICUREZZA: Verifica chain ID
        if (Number(network.chainId) !== config.chainId) {
          logger.securityAlert('CHAIN_ID_MISMATCH', 
            `Chain ID mismatch per ${networkName}: atteso ${config.chainId}, ricevuto ${network.chainId}`);
          continue;
        }
        
        this.providers.set(networkName, provider);
        logger.info(`✅ Provider ${networkName} connesso (Chain ID: ${network.chainId})`);
        
      } catch (error) {
        logger.error(`❌ Errore connessione ${networkName}:`, error.message);
      }
    }
    
    if (this.providers.size === 0) {
      if (process.env.VERCEL) {
        logger.warn('⚠️ Nessun provider blockchain disponibile (OK per Vercel serverless)');
      } else {
        throw new Error('Nessun provider blockchain disponibile!');
      }
    }
    
    // Se siamo in un browser, inizializza anche MetaMask
    if (this.isBrowser) {
      logger.info('🦊 Ambiente browser rilevato - MetaMask disponibile');
    } else {
      logger.info('🖥️ Ambiente Node.js - Solo provider RPC disponibili');
    }
  }
  
  /**
   * Connette a MetaMask (solo per testnet)
   */
  async connectMetaMask() {
    logger.info('🦊 Tentativo connessione MetaMask...');
    
    try {
      // Verifica se siamo in ambiente browser
      if (!this.isBrowser) {
        throw new Error('MetaMask disponibile solo in ambiente browser. Usa il server web per la connessione MetaMask.');
      }
      
      // Verifica disponibilità MetaMask
      if (!window.ethereum) {
        throw new Error('MetaMask non disponibile. Installa l\'estensione MetaMask.');
      }
      
      // Richiedi connessione account
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts'
      });
      
      if (accounts.length === 0) {
        throw new Error('Nessun account MetaMask disponibile');
      }
      
      // Crea provider e signer
      const provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await provider.getSigner();
      this.walletAddress = await this.signer.getAddress();
      
      // Verifica rete corrente
      const network = await provider.getNetwork();
      const networkName = this.getNetworkNameByChainId(Number(network.chainId));
      
      if (!networkName) {
        logger.securityAlert('UNKNOWN_NETWORK', `Chain ID sconosciuto: ${network.chainId}`);
        throw new Error(`Rete non supportata. Connettiti a una testnet supportata.`);
      }
      
      // CONTROLLO SICUREZZA: Verifica che sia testnet
      const networkConfig = NETWORKS[networkName];
      if (!networkConfig || !networkConfig.isTestnet) {
        logger.securityAlert('MAINNET_CONNECTION_ATTEMPT', 
          `Tentativo connessione a mainnet rilevato: ${networkName}`);
        throw new Error('ERRORE SICUREZZA: Connessione a mainnet non permessa!');
      }
      
      this.connectedNetwork = networkName;
      
      logger.info('✅ MetaMask connesso', {
        address: this.walletAddress,
        network: networkConfig.name,
        chainId: network.chainId
      });
      
      // Ascolta cambi di account/rete
      this.setupEventListeners();
      
      return {
        address: this.walletAddress,
        network: networkName,
        chainId: Number(network.chainId)
      };
      
    } catch (error) {
      logger.error('❌ Errore connessione MetaMask:', error.message);
      throw error;
    }
  }
  
  /**
   * Metodo per connessione MetaMask dal browser (chiamato via API)
   */
  async connectMetaMaskFromBrowser(walletAddress, chainId) {
    logger.info('🦊 Connessione MetaMask dal browser...');
    
    try {
      // Verifica che sia una testnet
      const networkName = this.getNetworkNameByChainId(chainId);
      if (!networkName) {
        throw new Error(`Chain ID non supportato: ${chainId}. Usa solo testnet.`);
      }
      
      const networkConfig = NETWORKS[networkName];
      if (!networkConfig || !networkConfig.isTestnet) {
        throw new Error(`Rete non supportata: Chain ID ${chainId}. Usa solo testnet.`);
      }
      
      this.walletAddress = walletAddress;
      this.connectedNetwork = networkName;
      
      logger.info(`✅ Wallet connesso dal browser:`, {
        address: this.walletAddress,
        network: networkConfig.name,
        chainId: chainId
      });
      
      return {
        address: this.walletAddress,
        network: networkName,
        chainId: chainId
      };
      
    } catch (error) {
      logger.error('❌ Errore connessione wallet dal browser:', error.message);
      throw error;
    }
  }
  
  /**
   * Configura listener per eventi MetaMask
   */
  setupEventListeners() {
    if (typeof window === 'undefined' || !window.ethereum) return;
    
    // Cambio account
    window.ethereum.on('accountsChanged', (accounts) => {
      if (accounts.length === 0) {
        logger.warn('🦊 MetaMask disconnesso');
        this.disconnect();
      } else {
        logger.info('🦊 Account MetaMask cambiato');
        this.connectMetaMask(); // Riconnetti
      }
    });
    
    // Cambio rete
    window.ethereum.on('chainChanged', (chainId) => {
      const networkName = this.getNetworkNameByChainId(parseInt(chainId, 16));
      
      if (!networkName || !NETWORKS[networkName]?.isTestnet) {
        logger.securityAlert('NETWORK_CHANGE_TO_MAINNET', 
          `Cambio rete a mainnet rilevato: ${chainId}`);
        this.disconnect();
        return;
      }
      
      logger.info('🔄 Rete cambiata', { chainId: parseInt(chainId, 16), network: networkName });
      this.connectedNetwork = networkName;
    });
  }
  
  /**
   * Ottiene nome rete da chain ID
   */
  getNetworkNameByChainId(chainId) {
    for (const [name, config] of Object.entries(NETWORKS)) {
      if (config.chainId === chainId) {
        return name;
      }
    }
    return null;
  }
  
  /**
   * Ottiene provider per una rete specifica
   */
  getProvider(networkName = null) {
    const network = networkName || this.connectedNetwork || 'ethereum';
    const provider = this.providers.get(network);
    
    if (!provider) {
      throw new Error(`Provider non disponibile per ${network}`);
    }
    
    return provider;
  }
  
  /**
   * Ottiene signer (solo se MetaMask connesso)
   */
  getSigner() {
    if (!this.signer) {
      throw new Error('MetaMask non connesso. Chiamare connectMetaMask() prima.');
    }
    return this.signer;
  }
  
  /**
   * Verifica connessione e sicurezza prima di operazioni critiche
   */
  async validateSecurityChecks() {
    if (!SECURITY_CONFIG.enableSecurityChecks) {
      logger.warn('⚠️ Controlli sicurezza disabilitati!');
      return true;
    }
    
    // Verifica modalità testnet
    if (SECURITY_CONFIG.networkMode !== 'testnet') {
      logger.securityAlert('INVALID_NETWORK_MODE', 
        `Modalità rete non sicura: ${SECURITY_CONFIG.networkMode}`);
      return false;
    }
    
    // Verifica rete connessa
    if (this.connectedNetwork && NETWORKS[this.connectedNetwork]) {
      const networkConfig = NETWORKS[this.connectedNetwork];
      if (!networkConfig.isTestnet) {
        logger.securityAlert('MAINNET_OPERATION_BLOCKED', 
          `Operazione su mainnet bloccata: ${this.connectedNetwork}`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Ottiene bilancio nativo (ETH, BNB, MATIC)
   */
  async getNativeBalance(address = null) {
    const targetAddress = address || this.walletAddress;
    if (!targetAddress) {
      throw new Error('Indirizzo wallet non disponibile');
    }
    
    const provider = this.getProvider();
    const balance = await provider.getBalance(targetAddress);
    
    return ethers.formatEther(balance);
  }
  
  /**
   * Ottiene bilancio token ERC20
   */
  async getTokenBalance(tokenAddress, walletAddress = null) {
    const targetAddress = walletAddress || this.walletAddress;
    if (!targetAddress) {
      throw new Error('Indirizzo wallet non disponibile');
    }
    
    const provider = this.getProvider();
    
    // ABI minimo per balanceOf
    const erc20Abi = [
      'function balanceOf(address owner) view returns (uint256)',
      'function decimals() view returns (uint8)'
    ];
    
    const contract = new ethers.Contract(tokenAddress, erc20Abi, provider);
    
    const [balance, decimals] = await Promise.all([
      contract.balanceOf(targetAddress),
      contract.decimals()
    ]);
    
    return ethers.formatUnits(balance, decimals);
  }
  
  /**
   * Stima gas per transazione
   */
  async estimateGas(transaction) {
    const provider = this.getProvider();
    
    try {
      const gasEstimate = await provider.estimateGas(transaction);
      const gasPrice = await provider.getFeeData();
      
      return {
        gasLimit: gasEstimate,
        gasPrice: gasPrice.gasPrice,
        maxFeePerGas: gasPrice.maxFeePerGas,
        maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas
      };
    } catch (error) {
      logger.error('❌ Errore stima gas:', error.message);
      throw error;
    }
  }
  
  /**
   * Disconnette da MetaMask
   */
  disconnect() {
    this.signer = null;
    this.walletAddress = null;
    this.connectedNetwork = null;
    
    logger.info('🔌 Disconnesso da MetaMask');
  }
  
  /**
   * Ottiene informazioni stato connessione
   */
  getConnectionStatus() {
    return {
      isConnected: !!this.signer,
      walletAddress: this.walletAddress,
      connectedNetwork: this.connectedNetwork,
      availableNetworks: Array.from(this.providers.keys()),
      securityMode: SECURITY_CONFIG.networkMode
    };
  }
}

// Esporta istanza singleton
export default new BlockchainConnection();