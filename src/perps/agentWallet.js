/**
 * AGENT WALLET (Hyperliquid)
 * ==========================
 *
 * Gestisce il ciclo di vita dell'"agent wallet" (API wallet) Hyperliquid che
 * permette il trading autonomo 24/7 senza un popup MetaMask per ogni ordine.
 *
 * Flusso:
 *  1. prepare(): il server genera una coppia di chiavi agent, la cifra e la salva
 *     come "pending", e restituisce l'azione `approveAgent` + il typed data EIP-712
 *     da far firmare a MetaMask (master wallet) sul frontend.
 *  2. Il frontend firma con `eth_signTypedData_v4` e rimanda { action, signature }.
 *  3. Il server invia l'azione firmata a /exchange (vedi hyperliquidClient) e marca
 *     l'agent come approvato.
 *
 * Sicurezza:
 *  - La chiave agent è cifrata a riposo (AES-256-GCM, chiave da AGENT_ENCRYPTION_KEY).
 *  - L'agent può SOLO fare trading, NON può prelevare fondi (garanzia Hyperliquid).
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import db from '../db/database.js';
import logger from '../utils/logger.js';

const ALGO = 'aes-256-gcm';

// signatureChainId / domain.chainId per rete (devono combaciare per la verifica EIP-712).
const SIGN_CHAINS = {
  testnet: { chainId: 421614, hex: '0x66eee', hyperliquidChain: 'Testnet' },
  mainnet: { chainId: 42161, hex: '0xa4b1', hyperliquidChain: 'Mainnet' }
};

class AgentWallet {
  constructor() {
    const secret = process.env.AGENT_ENCRYPTION_KEY;
    const isProd = process.env.NODE_ENV === 'production';
    if (!secret || secret.length < 32) {
      if (isProd) {
        // In produzione la chiave agent firma ordini reali: niente fallback insicuro.
        throw new Error(
          'AGENT_ENCRYPTION_KEY mancante o troppo corta (≥32 caratteri). ' +
          'Obbligatoria in produzione per cifrare le chiavi agent. Avvio interrotto.'
        );
      }
      logger.warn('⚠️  AGENT_ENCRYPTION_KEY non impostata/corta: uso una chiave di SVILUPPO (NON sicura). ' +
        'Imposta AGENT_ENCRYPTION_KEY (≥32 caratteri) in .env per la persistenza sicura delle chiavi agent.');
    }
    // Deriva una chiave a 32 byte stabile dal segreto.
    this.encKey = crypto.createHash('sha256')
      .update(secret || 'arbitragebot-perps-dev-key')
      .digest();
  }

  // ---- Cifratura ----

  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, this.encKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  decrypt(payload) {
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }

  // ---- Lifecycle ----

  /**
   * Genera una nuova coppia agent e costruisce l'azione approveAgent + typed data.
   * Salva la chiave (cifrata) come pending (approved_at=null) finché non confermata.
   */
  prepareApproval(masterAddress, network = 'testnet', agentName = '', signatureChainId = null) {
    if (!ethers.isAddress(masterAddress)) {
      throw new Error('masterAddress non valido');
    }
    const sign = SIGN_CHAINS[network];
    if (!sign) throw new Error(`Rete non valida: ${network}`);

    // Chain di FIRMA: usa quella su cui è connesso il wallet (così MetaMask accetta
    // di firmare il dominio EIP-712), altrimenti la canonica per la rete.
    // Hyperliquid ricostruisce il dominio da action.signatureChainId: qualsiasi
    // chainId è valido finché domain.chainId combacia (verificato empiricamente).
    let chainHex = sign.hex;
    let chainIdNum = sign.chainId;
    if (signatureChainId) {
      chainHex = String(signatureChainId).startsWith('0x')
        ? String(signatureChainId)
        : '0x' + Number(signatureChainId).toString(16);
      chainIdNum = parseInt(chainHex, 16);
      if (!chainIdNum || isNaN(chainIdNum)) throw new Error('signatureChainId non valido');
    }

    const agent = ethers.Wallet.createRandom();
    const nonce = Date.now();

    // Salva subito la chiave agent cifrata (pending). approved_at resta null.
    db.upsertAgent({
      masterAddress,
      network,
      agentAddress: agent.address,
      encryptedKey: this.encrypt(agent.privateKey),
      agentName: agentName || null
    });
    // Riporta approved_at a null (upsert lo imposta a Date.now()): segna come pending.
    db.db.prepare(
      `UPDATE agent_wallets SET approved_at = NULL WHERE master_address = ? AND network = ?`
    ).run(masterAddress.toLowerCase(), network);

    const action = {
      type: 'approveAgent',
      hyperliquidChain: sign.hyperliquidChain,
      signatureChainId: chainHex,
      agentAddress: agent.address,
      agentName: agentName || '',
      nonce
    };

    const typedData = {
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: chainIdNum,
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      types: {
        'HyperliquidTransaction:ApproveAgent': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'agentAddress', type: 'address' },
          { name: 'agentName', type: 'string' },
          { name: 'nonce', type: 'uint64' }
        ]
      },
      primaryType: 'HyperliquidTransaction:ApproveAgent',
      message: {
        hyperliquidChain: action.hyperliquidChain,
        agentAddress: action.agentAddress,
        agentName: action.agentName,
        nonce: action.nonce
      }
    };

    logger.info('🔑 Agent wallet generato (pending approvazione)', {
      master: masterAddress, agent: agent.address, network
    });

    return { action, typedData, agentAddress: agent.address };
  }

  /** Risolve chainId di firma (override dalla rete attiva o canonico). */
  _resolveSignChain(network, signatureChainId) {
    const sign = SIGN_CHAINS[network];
    if (!sign) throw new Error(`Rete non valida: ${network}`);
    let chainHex = sign.hex;
    let chainIdNum = sign.chainId;
    if (signatureChainId) {
      chainHex = String(signatureChainId).startsWith('0x')
        ? String(signatureChainId)
        : '0x' + Number(signatureChainId).toString(16);
      chainIdNum = parseInt(chainHex, 16);
      if (!chainIdNum || isNaN(chainIdNum)) throw new Error('signatureChainId non valido');
    }
    return { chainHex, chainIdNum, hyperliquidChain: sign.hyperliquidChain };
  }

  /**
   * Costruisce l'azione usdClassTransfer (trasferimento Spot↔Perp) + typed data
   * da far firmare a MetaMask. toPerp=true sposta USDC da Spot a Perp.
   */
  prepareUsdClassTransfer(masterAddress, network, amount, toPerp = true, signatureChainId = null) {
    if (!ethers.isAddress(masterAddress)) throw new Error('masterAddress non valido');
    const amt = Number(amount);
    if (!amt || amt <= 0 || isNaN(amt)) throw new Error('Importo non valido');
    const { chainHex, chainIdNum, hyperliquidChain } = this._resolveSignChain(network, signatureChainId);
    const nonce = Date.now();
    const amountStr = String(amt);

    const action = {
      type: 'usdClassTransfer',
      hyperliquidChain,
      signatureChainId: chainHex,
      amount: amountStr,
      toPerp: !!toPerp,
      nonce
    };
    const typedData = {
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: chainIdNum,
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      types: {
        'HyperliquidTransaction:UsdClassTransfer': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'amount', type: 'string' },
          { name: 'toPerp', type: 'bool' },
          { name: 'nonce', type: 'uint64' }
        ]
      },
      primaryType: 'HyperliquidTransaction:UsdClassTransfer',
      message: { hyperliquidChain, amount: amountStr, toPerp: !!toPerp, nonce }
    };
    return { action, typedData };
  }

  /**
   * Marca l'agent come approvato dopo l'invio riuscito a Hyperliquid.
   */
  markApproved(masterAddress, network, agentAddress) {
    const row = db.getAgent(masterAddress, network);
    if (!row || row.agent_address.toLowerCase() !== agentAddress.toLowerCase()) {
      throw new Error('Agent non corrispondente: rigenera l\'approvazione');
    }
    db.db.prepare(
      `UPDATE agent_wallets SET approved_at = ? WHERE master_address = ? AND network = ?`
    ).run(Date.now(), masterAddress.toLowerCase(), network);
  }

  /**
   * Restituisce la chiave privata agent decifrata (per istanziare l'SDK).
   */
  getAgentKey(masterAddress, network) {
    const row = db.getAgent(masterAddress, network);
    if (!row || !row.approved_at) return null;
    return this.decrypt(row.encrypted_key);
  }

  isApproved(masterAddress, network) {
    const row = db.getAgent(masterAddress, network);
    return !!(row && row.approved_at);
  }

  getStatus(masterAddress, network) {
    const row = db.getAgent(masterAddress, network);
    if (!row) return { exists: false, approved: false };
    return {
      exists: true,
      approved: !!row.approved_at,
      agentAddress: row.agent_address,
      approvedAt: row.approved_at
    };
  }
}

export default new AgentWallet();
