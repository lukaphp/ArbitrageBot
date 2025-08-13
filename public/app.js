// Arbitrage Bot Web App
class ArbitrageBotApp {
    constructor() {
        this.socket = null;
        this.provider = null;
        this.signer = null;
        this.walletAddress = null;
        this.isConnected = false;
        this.autoRefresh = true;
        this.refreshInterval = null;
        
        this.init();
    }

    async init() {
        console.log('🤖 Inizializzazione Arbitrage Bot Web App...');
        
        // Inizializza Socket.IO
        this.initSocket();
        
        // Inizializza event listeners
        this.initEventListeners();
        
        // Controlla se MetaMask è disponibile
        this.checkMetaMaskAvailability();
        
        // Carica dati iniziali
        await this.loadInitialData();
        
        console.log('✅ App inizializzata con successo');
    }

    initSocket() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('🔌 Connesso al server');
            this.updateServerStatus(true);
            this.showToast('Connesso al server', 'success');
        });
        
        this.socket.on('disconnect', () => {
            console.log('❌ Disconnesso dal server');
            this.updateServerStatus(false);
            this.showToast('Disconnesso dal server', 'error');
        });
        
        this.socket.on('priceUpdate', (data) => {
            this.updatePrices(data);
        });
        
        this.socket.on('opportunityFound', (data) => {
            this.addOpportunity(data);
            this.showToast(`Nuova opportunità: ${data.pair}`, 'success');
        });
        
        this.socket.on('transactionUpdate', (data) => {
            this.updateTransactionHistory(data);
        });
        
        this.socket.on('statsUpdate', (data) => {
            this.updateStats(data);
        });
        
        this.socket.on('error', (error) => {
            console.error('Socket error:', error);
            this.showToast(error.message || 'Errore di connessione', 'error');
        });
    }

    initEventListeners() {
        // Wallet connection
        document.getElementById('connectWallet').addEventListener('click', () => {
            this.connectWallet();
        });
        
        document.getElementById('disconnectWallet').addEventListener('click', () => {
            this.disconnectWallet();
        });
        
        // Opportunities
        document.getElementById('refreshOpportunities').addEventListener('click', () => {
            this.refreshOpportunities();
        });
        
        document.getElementById('autoRefresh').addEventListener('change', (e) => {
            this.autoRefresh = e.target.checked;
            if (this.autoRefresh) {
                this.startAutoRefresh();
            } else {
                this.stopAutoRefresh();
            }
        });
        
        // Network selector
        document.getElementById('networkSelect').addEventListener('change', (e) => {
            this.switchNetwork(e.target.value);
        });
        
        // History
        document.getElementById('clearHistory').addEventListener('click', () => {
            this.clearHistory();
        });
        
        // Modal close on background click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                this.closeModal(e.target.id);
            }
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeAllModals();
            }
        });
    }

    checkMetaMaskAvailability() {
        console.log('🔍 Debug - Checking MetaMask availability...');
        console.log('🔍 Debug - window.ethereum:', typeof window.ethereum);
        console.log('🔍 Debug - window.ethereum object:', window.ethereum);
        
        if (typeof window.ethereum !== 'undefined') {
            console.log('🦊 MetaMask rilevato');
            console.log('🔍 Debug - MetaMask provider info:', {
                isMetaMask: window.ethereum.isMetaMask,
                chainId: window.ethereum.chainId,
                selectedAddress: window.ethereum.selectedAddress
            });
            this.provider = new ethers.providers.Web3Provider(window.ethereum);
        } else {
            console.warn('⚠️ MetaMask non trovato');
            this.showToast('MetaMask non trovato. Installa l\'estensione MetaMask.', 'warning');
            document.getElementById('connectWallet').disabled = true;
        }
    }

    async connectWallet() {
        console.log('🔍 Debug - connectWallet called');
        
        if (!this.provider) {
            console.log('🔍 Debug - No provider available');
            this.showToast('MetaMask non disponibile', 'error');
            return;
        }

        try {
            console.log('🔄 Connessione a MetaMask...');
            console.log('🔍 Debug - About to request accounts...');
            
            // Richiedi accesso agli account
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            console.log('🔍 Debug - Accounts received:', accounts);
            
            this.signer = this.provider.getSigner();
            this.walletAddress = await this.signer.getAddress();
            
            // Verifica la rete
            const network = await this.provider.getNetwork();
            console.log('🔍 Debug - Network info:', {
                chainId: network.chainId,
                chainIdType: typeof network.chainId,
                chainIdHex: '0x' + network.chainId.toString(16)
            });
            
            const isTestnet = this.isTestnetChain(network.chainId);
            console.log('🔍 Debug - isTestnet result:', isTestnet);
            
            if (!isTestnet) {
                throw new Error(`⚠️ Rete non supportata (Chain ID: ${network.chainId}). Usa solo testnet (Goerli, Sepolia, BSC Testnet, Polygon Amoy)`);
            }
            
            // Ottieni il saldo
            const balance = await this.signer.getBalance();
            const balanceEth = ethers.utils.formatEther(balance);
            
            // Aggiorna UI
            this.isConnected = true;
            this.updateWalletUI({
                address: this.walletAddress,
                network: this.getNetworkName(network.chainId),
                balance: `${parseFloat(balanceEth).toFixed(4)} ${this.getNetworkCurrency(network.chainId)}`
            });
            
            // Notifica il server
            this.socket.emit('walletConnected', {
                address: this.walletAddress,
                chainId: network.chainId
            });
            
            this.showToast('Wallet connesso con successo', 'success');
            console.log('✅ Wallet connesso:', this.walletAddress);
            
        } catch (error) {
            console.error('❌ Errore connessione wallet:', error);
            this.showToast(error.message || 'Errore durante la connessione', 'error');
        }
    }

    disconnectWallet() {
        this.isConnected = false;
        this.walletAddress = null;
        this.signer = null;
        
        this.updateWalletUI(null);
        this.socket.emit('walletDisconnected');
        
        this.showToast('Wallet disconnesso', 'success');
        console.log('🔌 Wallet disconnesso');
    }

    updateWalletUI(walletInfo) {
        const walletInfoDiv = document.getElementById('walletInfo');
        const connectBtn = document.getElementById('connectWallet');
        const disconnectBtn = document.getElementById('disconnectWallet');
        const walletStatus = document.getElementById('walletStatus');
        
        if (walletInfo) {
            // Mostra info wallet
            document.getElementById('walletAddress').textContent = 
                `${walletInfo.address.slice(0, 6)}...${walletInfo.address.slice(-4)}`;
            document.getElementById('walletNetwork').textContent = walletInfo.network;
            document.getElementById('walletBalance').textContent = walletInfo.balance;
            
            walletInfoDiv.classList.remove('hidden');
            connectBtn.classList.add('hidden');
            disconnectBtn.classList.remove('hidden');
            
            walletStatus.classList.remove('offline');
            walletStatus.classList.add('online');
        } else {
            // Nascondi info wallet
            walletInfoDiv.classList.add('hidden');
            connectBtn.classList.remove('hidden');
            disconnectBtn.classList.add('hidden');
            
            walletStatus.classList.remove('online');
            walletStatus.classList.add('offline');
        }
    }

    updateServerStatus(isOnline) {
        const serverStatus = document.getElementById('serverStatus');
        
        if (isOnline) {
            serverStatus.classList.remove('offline');
            serverStatus.classList.add('online');
        } else {
            serverStatus.classList.remove('online');
            serverStatus.classList.add('offline');
        }
    }

    isTestnetChain(chainId) {
        // Converti chainId in numero se è in formato esadecimale
        const numericChainId = typeof chainId === 'string' ? parseInt(chainId, 16) : chainId;
        
        const testnetChains = {
            5: 'Ethereum Goerli',
            11155111: 'Ethereum Sepolia',
            97: 'BSC Testnet',
            80002: 'Polygon Amoy'
        };
        return numericChainId in testnetChains;
    }

    getNetworkName(chainId) {
        // Converti chainId in numero se è in formato esadecimale
        const numericChainId = typeof chainId === 'string' ? parseInt(chainId, 16) : chainId;
        
        const networks = {
            5: 'Ethereum Goerli',
            11155111: 'Ethereum Sepolia',
            97: 'BSC Testnet',
            80002: 'Polygon Amoy'
        };
        return networks[numericChainId] || `Chain ${numericChainId}`;
    }

    getNetworkCurrency(chainId) {
        // Converti chainId in numero se è in formato esadecimale
        const numericChainId = typeof chainId === 'string' ? parseInt(chainId, 16) : chainId;
        
        const currencies = {
            5: 'ETH',
            11155111: 'ETH',
            97: 'BNB',
            80002: 'MATIC'
        };
        return currencies[numericChainId] || 'ETH';
    }

    async loadInitialData() {
        try {
            // Carica statistiche
            const statsResponse = await fetch('/api/stats');
            if (statsResponse.ok) {
                const stats = await statsResponse.json();
                this.updateStats(stats);
            }
            
            // Carica opportunità
            await this.refreshOpportunities();
            
            // Carica prezzi
            await this.refreshPrices();
            
            // Carica storico
            await this.refreshHistory();
            
            // Avvia auto-refresh se abilitato
            if (this.autoRefresh) {
                this.startAutoRefresh();
            }
            
        } catch (error) {
            console.error('Errore caricamento dati iniziali:', error);
        }
    }

    async refreshOpportunities() {
        try {
            document.getElementById('opportunitiesLoading').classList.remove('hidden');
            document.getElementById('opportunitiesList').classList.add('hidden');
            document.getElementById('noOpportunities').classList.add('hidden');
            
            const response = await fetch('/api/opportunities');
            const opportunities = await response.json();
            
            document.getElementById('opportunitiesLoading').classList.add('hidden');
            
            if (opportunities.length > 0) {
                this.displayOpportunities(opportunities);
                document.getElementById('opportunitiesList').classList.remove('hidden');
            } else {
                document.getElementById('noOpportunities').classList.remove('hidden');
            }
            
        } catch (error) {
            console.error('Errore refresh opportunità:', error);
            document.getElementById('opportunitiesLoading').classList.add('hidden');
            this.showToast('Errore nel caricamento delle opportunità', 'error');
        }
    }

    displayOpportunities(opportunities) {
        const container = document.getElementById('opportunitiesList');
        container.innerHTML = '';
        
        opportunities.forEach(opp => {
            const oppElement = this.createOpportunityElement(opp);
            container.appendChild(oppElement);
        });
    }

    createOpportunityElement(opportunity) {
        const div = document.createElement('div');
        div.className = 'opportunity-item';
        
        const profitPercentage = ((opportunity.profit / opportunity.inputAmount) * 100).toFixed(2);
        
        div.innerHTML = `
            <div class="opportunity-header">
                <div class="opportunity-pair">${opportunity.pair}</div>
                <div class="opportunity-profit">+${profitPercentage}%</div>
            </div>
            <div class="opportunity-details">
                <div class="opportunity-detail">
                    <span class="label">DEX A:</span>
                    <span class="value">${opportunity.dexA}</span>
                </div>
                <div class="opportunity-detail">
                    <span class="label">DEX B:</span>
                    <span class="value">${opportunity.dexB}</span>
                </div>
                <div class="opportunity-detail">
                    <span class="label">Prezzo A:</span>
                    <span class="value">${opportunity.priceA.toFixed(6)}</span>
                </div>
                <div class="opportunity-detail">
                    <span class="label">Prezzo B:</span>
                    <span class="value">${opportunity.priceB.toFixed(6)}</span>
                </div>
                <div class="opportunity-detail">
                    <span class="label">Profitto:</span>
                    <span class="value">${opportunity.profit.toFixed(6)} ETH</span>
                </div>
                <div class="opportunity-detail">
                    <span class="label">Gas Stimato:</span>
                    <span class="value">${opportunity.estimatedGas || 'N/A'}</span>
                </div>
            </div>
            <div class="opportunity-actions">
                <button class="btn btn-outline" onclick="app.simulateArbitrage('${opportunity.id}')">
                    🧪 Simula
                </button>
                <button class="btn btn-primary" onclick="app.executeArbitrage('${opportunity.id}')" 
                        ${!this.isConnected ? 'disabled' : ''}>
                    ⚡ Esegui
                </button>
            </div>
        `;
        
        return div;
    }

    async simulateArbitrage(opportunityId) {
        try {
            this.showToast('Simulazione in corso...', 'info');
            
            const response = await fetch(`/api/simulate/${opportunityId}`, {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.showToast(`Simulazione completata: ${result.message}`, 'success');
            } else {
                this.showToast(`Simulazione fallita: ${result.error}`, 'error');
            }
            
        } catch (error) {
            console.error('Errore simulazione:', error);
            this.showToast('Errore durante la simulazione', 'error');
        }
    }

    async executeArbitrage(opportunityId) {
        if (!this.isConnected) {
            this.showToast('Connetti prima il wallet', 'warning');
            return;
        }
        
        try {
            // Mostra modal di conferma
            const response = await fetch(`/api/opportunities/${opportunityId}`);
            const opportunity = await response.json();
            
            this.showExecuteModal(opportunity);
            
        } catch (error) {
            console.error('Errore preparazione esecuzione:', error);
            this.showToast('Errore nella preparazione dell\'esecuzione', 'error');
        }
    }

    showExecuteModal(opportunity) {
        const modal = document.getElementById('executeModal');
        const detailsDiv = document.getElementById('executeDetails');
        
        const profitPercentage = ((opportunity.profit / opportunity.inputAmount) * 100).toFixed(2);
        
        detailsDiv.innerHTML = `
            <div class="execution-details">
                <h4>Dettagli Esecuzione</h4>
                <div class="detail">
                    <span class="label">Coppia:</span>
                    <span class="value">${opportunity.pair}</span>
                </div>
                <div class="detail">
                    <span class="label">Profitto Stimato:</span>
                    <span class="value">${opportunity.profit.toFixed(6)} ETH (+${profitPercentage}%)</span>
                </div>
                <div class="detail">
                    <span class="label">Gas Stimato:</span>
                    <span class="value">${opportunity.estimatedGas || 'Calcolo in corso...'}</span>
                </div>
                <div class="warning">
                    ⚠️ <strong>Attenzione:</strong> Questa è una transazione reale su testnet. 
                    Verifica tutti i dettagli prima di procedere.
                </div>
            </div>
        `;
        
        document.getElementById('confirmExecute').onclick = () => {
            this.confirmExecution(opportunity.id);
        };
        
        this.showModal('executeModal');
    }

    async confirmExecution(opportunityId) {
        try {
            this.closeModal('executeModal');
            this.showToast('Esecuzione in corso...', 'info');
            
            const response = await fetch(`/api/execute/${opportunityId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    walletAddress: this.walletAddress
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.showToast('Transazione inviata con successo!', 'success');
                // Aggiorna le statistiche e lo storico
                setTimeout(() => {
                    this.refreshHistory();
                    this.loadInitialData();
                }, 2000);
            } else {
                this.showToast(`Esecuzione fallita: ${result.error}`, 'error');
            }
            
        } catch (error) {
            console.error('Errore esecuzione:', error);
            this.showToast('Errore durante l\'esecuzione', 'error');
        }
    }

    async refreshPrices() {
        try {
            const network = document.getElementById('networkSelect').value;
            const response = await fetch(`/api/prices?network=${network}`);
            const prices = await response.json();
            
            this.displayPrices(prices);
            
        } catch (error) {
            console.error('Errore refresh prezzi:', error);
        }
    }

    displayPrices(prices) {
        const container = document.getElementById('pricesGrid');
        container.innerHTML = '';
        
        if (prices && typeof prices === 'object') {
            Object.entries(prices).forEach(([token, tokenPrices]) => {
                if (tokenPrices && typeof tokenPrices === 'object') {
                    Object.entries(tokenPrices).forEach(([dex, priceData]) => {
                        if (priceData && typeof priceData === 'object') {
                            const priceElement = this.createPriceElement(token, dex, priceData);
                            container.appendChild(priceElement);
                        }
                    });
                }
            });
        }
    }

    createPriceElement(token, dex, priceData) {
        const div = document.createElement('div');
        div.className = 'price-item';
        
        const price = priceData.price || 0;
        const change = priceData.change || 0;
        const changeClass = change >= 0 ? 'positive' : 'negative';
        const changeSymbol = change >= 0 ? '+' : '';
        
        div.innerHTML = `
            <div class="price-header">
                <div class="price-token">${token}</div>
                <div class="price-dex">${dex}</div>
            </div>
            <div class="price-value">$${price.toFixed(6)}</div>
            <div class="price-change ${changeClass}">
                ${changeSymbol}${change.toFixed(2)}%
            </div>
        `;
        
        return div;
    }

    async refreshHistory() {
        try {
            const response = await fetch('/api/history');
            const history = await response.json();
            
            this.displayHistory(history);
            
        } catch (error) {
            console.error('Errore refresh storico:', error);
        }
    }

    displayHistory(history) {
        const container = document.getElementById('historyList');
        const noHistory = document.getElementById('noHistory');
        
        if (!Array.isArray(history) || history.length === 0) {
            if (container) container.classList.add('hidden');
            if (noHistory) noHistory.classList.remove('hidden');
            return;
        }
        
        if (container) {
            container.classList.remove('hidden');
            container.innerHTML = '';
            
            history.forEach(tx => {
                const historyElement = this.createHistoryElement(tx);
                container.appendChild(historyElement);
            });
        }
        
        if (noHistory) noHistory.classList.add('hidden');
    }

    createHistoryElement(transaction) {
        const div = document.createElement('div');
        div.className = `history-item ${transaction.status}`;
        
        const date = new Date(transaction.timestamp).toLocaleString('it-IT');
        
        div.innerHTML = `
            <div class="history-header">
                <div class="history-pair">${transaction.pair}</div>
                <div class="history-status ${transaction.status}">${transaction.status}</div>
            </div>
            <div class="history-details">
                <div class="detail">
                    <span class="label">Data:</span>
                    <span class="value">${date}</span>
                </div>
                <div class="detail">
                    <span class="label">Profitto:</span>
                    <span class="value">${transaction.profit?.toFixed(6) || 'N/A'} ETH</span>
                </div>
                <div class="detail">
                    <span class="label">Gas:</span>
                    <span class="value">${transaction.gasUsed || 'N/A'}</span>
                </div>
                ${transaction.txHash ? `
                <div class="detail">
                    <span class="label">TX Hash:</span>
                    <span class="value">
                        <a href="#" onclick="app.viewTransaction('${transaction.txHash}')">
                            ${transaction.txHash.slice(0, 10)}...
                        </a>
                    </span>
                </div>
                ` : ''}
            </div>
        `;
        
        return div;
    }

    updateStats(stats) {
        if (stats && typeof stats === 'object') {
            const totalOpportunitiesEl = document.getElementById('totalOpportunities');
            const executedTradesEl = document.getElementById('executedTrades');
            const totalProfitEl = document.getElementById('totalProfit');
            const successRateEl = document.getElementById('successRate');
            
            if (totalOpportunitiesEl) totalOpportunitiesEl.textContent = stats.totalOpportunities || 0;
            if (executedTradesEl) executedTradesEl.textContent = stats.executedTrades || 0;
            if (totalProfitEl) totalProfitEl.textContent = (stats.totalProfit || 0).toFixed(6);
            if (successRateEl) successRateEl.textContent = `${stats.successRate || 0}%`;
        }
    }

    startAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        
        this.refreshInterval = setInterval(() => {
            this.refreshOpportunities();
            this.refreshPrices();
        }, 30000); // Refresh ogni 30 secondi
    }

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    async switchNetwork(network) {
        await this.refreshPrices();
    }

    async clearHistory() {
        if (confirm('Sei sicuro di voler cancellare tutto lo storico?')) {
            try {
                const response = await fetch('/api/history', {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    this.showToast('Storico cancellato', 'success');
                    await this.refreshHistory();
                } else {
                    this.showToast('Errore nella cancellazione', 'error');
                }
                
            } catch (error) {
                console.error('Errore clear history:', error);
                this.showToast('Errore nella cancellazione', 'error');
            }
        }
    }

    viewTransaction(txHash) {
        // Apri explorer della transazione
        const network = document.getElementById('networkSelect').value;
        let explorerUrl;
        
        switch (network) {
            case 'ethereum':
                explorerUrl = `https://goerli.etherscan.io/tx/${txHash}`;
                break;
            case 'bsc':
                explorerUrl = `https://testnet.bscscan.com/tx/${txHash}`;
                break;
            case 'polygon':
                explorerUrl = `https://amoy.polygonscan.com/tx/${txHash}`;
                break;
            default:
                explorerUrl = `#`;
        }
        
        window.open(explorerUrl, '_blank');
    }

    showModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.classList.remove('hidden');
        modal.classList.add('show');
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.classList.remove('show');
        setTimeout(() => {
            modal.classList.add('hidden');
        }, 300);
    }

    closeAllModals() {
        const modals = document.querySelectorAll('.modal');
        modals.forEach(modal => {
            modal.classList.remove('show');
            setTimeout(() => {
                modal.classList.add('hidden');
            }, 300);
        });
    }

    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️'
        };
        
        toast.innerHTML = `
            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span>${icons[type] || icons.info}</span>
                <span>${message}</span>
            </div>
        `;
        
        container.appendChild(toast);
        
        // Mostra toast
        setTimeout(() => {
            toast.classList.add('show');
        }, 100);
        
        // Rimuovi toast dopo 5 secondi
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                container.removeChild(toast);
            }, 300);
        }, 5000);
    }

    // Funzioni globali per i modal
    showSecurityInfo() {
        this.showModal('securityModal');
    }

    showHelp() {
        this.showToast('Consulta la documentazione per maggiori informazioni', 'info');
    }
}

// Funzioni globali
function showSecurityInfo() {
    app.showSecurityInfo();
}

function showHelp() {
    app.showHelp();
}

function closeModal(modalId) {
    app.closeModal(modalId);
}

// Inizializza l'app quando il DOM è pronto
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new ArbitrageBotApp();
});

// Gestisci eventi MetaMask
if (typeof window.ethereum !== 'undefined') {
    window.ethereum.on('accountsChanged', (accounts) => {
        if (accounts.length === 0) {
            app?.disconnectWallet();
        } else if (app?.walletAddress !== accounts[0]) {
            app?.connectWallet();
        }
    });
    
    window.ethereum.on('chainChanged', (chainId) => {
        window.location.reload();
    });
}