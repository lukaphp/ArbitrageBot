/**
 * PROTOCOLLO GUARDRAILS (MCP PRE-FLIGHT VALIDATION)
 * =================================================
 *
 * Layer di sicurezza e pre-flight validation mandatorio per tutti i comandi MCP.
 * Nessun comando diretto a un bot raggiunge il database SQLite, il runtime in memoria
 * o l'exchange Hyperliquid senza superare questi 4 cancelli deterministici:
 *
 * 1. RISK CEILING HARD-GATE:
 *    - Max Account Leverage <= 5x
 *    - Account Exposure (somma posizioni aperte + ordine) <= maxPositionUsd
 *    - Daily Loss Limit: blocca gli ingressi se daily_pnl < -soglia_configurata
 *
 * 2. ORDER VELOCITY GATE:
 *    - Cooldown obbligatorio di X secondi tra ordini dello stesso bot (anti-loop)
 *
 * 3. INSTRUCTION OVERRIDE / BLACKLIST:
 *    - Rifiuta comandi su asset inseriti in blacklist dall'utente o dal sistema
 *
 * 4. CONFIRM EXECUTION MODE:
 *    - Conferma temporizzata a due stadi (token a 60 secondi) per azioni critiche
 *      (emergency_shutdown, update_strategy_params).
 */

import crypto from 'crypto';
import db from '../db/database.js';
import logger from '../utils/logger.js';

export const GUARDRAILS_CONFIG = {
  MAX_ACCOUNT_LEVERAGE: 5,
  DEFAULT_ORDER_COOLDOWN_SEC: 10,
  CONFIRMATION_TTL_SEC: 60,
  DEFAULT_MAX_DAILY_LOSS_USD: 500,
  DEFAULT_MAX_POSITION_USD: 5000,
  DEFAULT_BLACKLIST: ['FTT', 'LUNA', 'UST', 'LUNC']
};

/**
 * Memoria runtime per Order Velocity Gate (bot_id -> timestamp ms)
 */
const lastOrderTimestamps = new Map();

/**
 * Memoria runtime per Conferme a Due Stadi (confirmation_token -> { action, bot_id, payload, expiresAt })
 */
const pendingConfirmations = new Map();

/**
 * Pulizia periodica dei token di conferma scaduti
 */
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pendingConfirmations.entries()) {
    if (now > entry.expiresAt) {
      pendingConfirmations.delete(token);
    }
  }
}, 10_000).unref?.();

/**
 * ============================================================================
 * 1. INSTRUCTION OVERRIDE & BLACKLIST
 * ============================================================================
 */

/**
 * Recupera l'elenco consolidato degli asset in blacklist (DB settings + config + fallback).
 */
export function getBlacklistedAssets(botConfig = {}) {
  const list = new Set(GUARDRAILS_CONFIG.DEFAULT_BLACKLIST.map(s => s.toUpperCase()));

  try {
    db.ensure();
    const dbBlacklist = db.getSetting('guardrail_blacklisted_assets', null);
    if (dbBlacklist) {
      if (typeof dbBlacklist === 'string') {
        try {
          const parsed = JSON.parse(dbBlacklist);
          if (Array.isArray(parsed)) parsed.forEach(c => list.add(String(c).toUpperCase().trim()));
        } catch {
          dbBlacklist.split(',').forEach(c => list.add(c.toUpperCase().trim()));
        }
      }
    }
  } catch (err) {
    logger.warn('Recupero blacklist guardrail da DB fallito:', err.message);
  }

  // Blacklist specifica del bot
  if (Array.isArray(botConfig.blacklist)) {
    botConfig.blacklist.forEach(c => list.add(String(c).toUpperCase().trim()));
  }
  if (Array.isArray(botConfig.blacklistedCoins)) {
    botConfig.blacklistedCoins.forEach(c => list.add(String(c).toUpperCase().trim()));
  }

  return Array.from(list);
}

/**
 * Imposta gli asset in blacklist a livello globale nel database.
 */
export function setBlacklistedAssets(assets = []) {
  db.ensure();
  const normalized = Array.from(new Set(assets.map(a => String(a).toUpperCase().trim()))).filter(Boolean);
  db.setSetting('guardrail_blacklisted_assets', JSON.stringify(normalized));
  return normalized;
}

/**
 * Aggiunge un asset alla blacklist globale.
 */
export function addBlacklistedAsset(asset) {
  const current = getBlacklistedAssets();
  current.push(asset);
  return setBlacklistedAssets(current);
}

/**
 * Rimuove un asset dalla blacklist globale.
 */
export function removeBlacklistedAsset(asset) {
  const current = getBlacklistedAssets();
  const target = String(asset).toUpperCase().trim();
  const filtered = current.filter(a => a !== target && a !== `${target}-PERP`);
  return setBlacklistedAssets(filtered);
}

/**
 * Valida se un asset o una richiesta contravviene alle regole di blacklist / override.
 */
export function validateInstructionOverride({ coin, botConfig = {} }) {
  if (!coin) {
    return { ok: false, error: 'GUARDRAIL_VIOLATION: Coin non specificata per la validazione delle istruzioni.' };
  }

  const rawCoin = String(coin).toUpperCase().trim();
  const baseCoin = rawCoin.replace(/-PERP$/, '');
  const blacklist = getBlacklistedAssets(botConfig);

  const isBlacklisted = blacklist.some(b => {
    const bNorm = b.toUpperCase().trim();
    const bBase = bNorm.replace(/-PERP$/, '');
    return rawCoin === bNorm || baseCoin === bBase;
  });

  if (isBlacklisted) {
    return {
      ok: false,
      error: `GUARDRAIL_VIOLATION: Asset Blacklisted (${coin})`
    };
  }

  return { ok: true };
}

/**
 * ============================================================================
 * 2. ORDER VELOCITY GATE
 * ============================================================================
 */

/**
 * Controlla il cooldown tra ordini consecutivi dello stesso bot.
 */
export function checkOrderVelocity(botId, cooldownSec = GUARDRAILS_CONFIG.DEFAULT_ORDER_COOLDOWN_SEC) {
  if (!botId) return { ok: true };

  const now = Date.now();
  const lastTs = lastOrderTimestamps.get(botId);
  const cooldownMs = cooldownSec * 1000;

  if (lastTs && (now - lastTs < cooldownMs)) {
    const remainingMs = cooldownMs - (now - lastTs);
    const remainingSec = Math.ceil(remainingMs / 1000);
    return {
      ok: false,
      remainingSec,
      error: `GUARDRAIL_VIOLATION: Order velocity limit exceeded. Cooldown attivo: attendi ${remainingSec}s prima di inviare un nuovo ordine per questo bot.`
    };
  }

  return { ok: true };
}

/**
 * Registra l'avvenuta esecuzione di un ordine per il bot.
 */
export function recordOrderExecution(botId) {
  if (botId) {
    lastOrderTimestamps.set(botId, Date.now());
  }
}

/**
 * Resetta il cooldown (usato nei test o dopo reset manuale).
 */
export function resetOrderVelocity(botId = null) {
  if (botId) {
    lastOrderTimestamps.delete(botId);
  } else {
    lastOrderTimestamps.clear();
  }
}

/**
 * ============================================================================
 * 3. RISK CEILING HARD-GATE
 * ============================================================================
 */

/**
 * Esegue la validazione pre-flight completa su:
 * - Max Leverage (<= 5x)
 * - Account Exposure (esposizione aggregata posizioni + ordine <= maxPositionUsd)
 * - Daily Loss Limit (daily_pnl <= -soglia)
 */
export function validateRiskCeiling({
  botRow = {},
  botConfig = {},
  side,
  size,
  entryPrice,
  requestedLeverage = null,
  accountPositions = [],
  dailyPnl = 0
}) {
  const numericSize = parseFloat(size);
  const numericPrice = parseFloat(entryPrice);

  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return { ok: false, error: 'GUARDRAIL_VIOLATION: Size ordine non valida.' };
  }
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    return { ok: false, error: 'GUARDRAIL_VIOLATION: Prezzo di mercato non valido.' };
  }

  // A. Max Account Leverage (Hard-Gate: max 5x)
  const effectiveLeverage = parseInt(requestedLeverage ?? botConfig.leverage ?? 1, 10);
  if (effectiveLeverage > GUARDRAILS_CONFIG.MAX_ACCOUNT_LEVERAGE) {
    return {
      ok: false,
      error: `GUARDRAIL_VIOLATION: Max Account Leverage exceeded. Richiesta leva ${effectiveLeverage}x, ma il limite massimo consentito per agenti è ${GUARDRAILS_CONFIG.MAX_ACCOUNT_LEVERAGE}x.`
    };
  }

  // B. Daily Loss Limit
  const maxDailyLoss = Math.abs(
    parseFloat(
      botConfig.maxDailyLossUsd ||
      botConfig.risk?.maxDailyLossUsd ||
      db.getSetting('guardrail_max_daily_loss_usd', GUARDRAILS_CONFIG.DEFAULT_MAX_DAILY_LOSS_USD)
    )
  );
  const currentDailyPnl = Number(dailyPnl || 0);

  if (currentDailyPnl <= -maxDailyLoss) {
    return {
      ok: false,
      error: `GUARDRAIL_VIOLATION: Daily Loss Limit exceeded. Il Daily P&L attuale ($${currentDailyPnl.toFixed(2)}) ha raggiunto o superato il limite di sicurezza di -$${maxDailyLoss.toFixed(2)}. Tutti i nuovi ingressi sono bloccati.`
    };
  }

  // C. Account Exposure Hard-Gate
  const orderNotionalUsd = numericSize * numericPrice;
  const maxPositionUsd = parseFloat(
    botConfig.maxPositionUsd ||
    botConfig.max_position_usd ||
    botRow.max_allocation_usd ||
    GUARDRAILS_CONFIG.DEFAULT_MAX_POSITION_USD
  );

  // Calcola l'esposizione totale attuale sommando tutte le posizioni aperte nell'account
  let currentTotalExposure = 0;
  const coin = (botRow.coin || '').toUpperCase();
  const normalizedSide = String(side || '').toLowerCase();

  for (const pos of accountPositions) {
    const posNotional = Math.abs(Number(pos.size || 0) * Number(pos.entryPx || pos.entry_price || numericPrice));
    if ((pos.coin || '').toUpperCase() === coin && pos.side === normalizedSide) {
      // Stesso verso: l'ordine incrementa la posizione
      currentTotalExposure += posNotional;
    } else if ((pos.coin || '').toUpperCase() === coin && pos.side !== normalizedSide) {
      // Verso opposto (riduzione/chiusura): non incrementa il notional totale della coin
      // Consideriamo la posizione netta risultante
      const netSize = Math.abs(Number(pos.size || 0) - numericSize);
      currentTotalExposure += netSize * numericPrice;
    } else {
      currentTotalExposure += posNotional;
    }
  }

  // Esposizione risultante
  const isSameCoinPos = accountPositions.some(p => (p.coin || '').toUpperCase() === coin);
  const resultingExposure = isSameCoinPos
    ? currentTotalExposure + (accountPositions.find(p => (p.coin || '').toUpperCase() === coin && p.side === normalizedSide) ? orderNotionalUsd : 0)
    : currentTotalExposure + orderNotionalUsd;

  if (resultingExposure > maxPositionUsd) {
    return {
      ok: false,
      error: `GUARDRAIL_VIOLATION: Account Exposure exceeded. L'esposizione complessiva risultante ($${resultingExposure.toFixed(2)}) supera il tetto massimo configurato maxPositionUsd ($${maxPositionUsd.toFixed(2)}).`
    };
  }

  return {
    ok: true,
    data: {
      effectiveLeverage,
      orderNotionalUsd,
      resultingExposure,
      maxPositionUsd,
      currentDailyPnl
    }
  };
}

/**
 * ============================================================================
 * 4. CONFIRM EXECUTION MODE (TWO-STAGE CONFIRMATION)
 * ============================================================================
 */

/**
 * Crea una richiesta di conferma pendente (Stadio 1) valida per 60 secondi.
 */
export function requestTwoStageConfirmation({ action, botId = null, payload = {}, summary = '', ttlSec = GUARDRAILS_CONFIG.CONFIRMATION_TTL_SEC }) {
  const token = `conf_${crypto.randomBytes(12).toString('hex')}`;
  const now = Date.now();
  const expiresAt = now + ttlSec * 1000;

  const entry = {
    token,
    action,
    botId,
    payload,
    summary,
    createdAt: now,
    expiresAt
  };

  pendingConfirmations.set(token, entry);

  logger.info(`🛡️ Guardrail: Generato token di conferma a due stadi [${token}] per azione '${action}' (TTL: ${ttlSec}s)`);

  return {
    status: 'confirmation_required',
    message: `GUARDRAIL_CONFIRMATION_REQUIRED: L'operazione critica '${action}' richiede una conferma a due stadi entro ${ttlSec} secondi.`,
    confirmation_token: token,
    expires_in_seconds: ttlSec,
    action,
    bot_id: botId,
    action_summary: summary || `Esecuzione comando critico: ${action}`,
    instructions: `Per autorizzare l'esecuzione, re-invia la chiamata specificando 'confirmation_token': '${token}' entro ${ttlSec} secondi.`
  };
}

/**
 * Valida e consuma un token di conferma (Stadio 2).
 * Se valido, consuma immediatamente il token per prevenire attacchi replay.
 */
export function validateAndConsumeConfirmation({ confirmation_token, action, botId = null }) {
  if (!confirmation_token || typeof confirmation_token !== 'string') {
    return {
      ok: false,
      requires_prompt: true
    };
  }

  const entry = pendingConfirmations.get(confirmation_token);

  if (!entry) {
    return {
      ok: false,
      error: 'GUARDRAIL_VIOLATION: Confirmation token non valido o inesistente.'
    };
  }

  const now = Date.now();
  if (now > entry.expiresAt) {
    pendingConfirmations.delete(confirmation_token);
    return {
      ok: false,
      error: 'GUARDRAIL_VIOLATION: Confirmation token scaduto (la finestra di 60 secondi è trascorsa).'
    };
  }

  if (entry.action !== action) {
    return {
      ok: false,
      error: `GUARDRAIL_VIOLATION: Confirmation token emesso per '${entry.action}', non per '${action}'.`
    };
  }

  if (botId && entry.botId && entry.botId !== botId) {
    return {
      ok: false,
      error: 'GUARDRAIL_VIOLATION: Confirmation token emesso per un bot_id differente.'
    };
  }

  // Token valido: consuma (elimina) dalla memoria per anti-replay
  pendingConfirmations.delete(confirmation_token);

  logger.info(`🛡️ Guardrail: Token di conferma [${confirmation_token}] consumato con successo per azione '${action}'`);

  return {
    ok: true,
    payload: entry.payload
  };
}

export default {
  GUARDRAILS_CONFIG,
  getBlacklistedAssets,
  setBlacklistedAssets,
  addBlacklistedAsset,
  removeBlacklistedAsset,
  validateInstructionOverride,
  checkOrderVelocity,
  recordOrderExecution,
  resetOrderVelocity,
  validateRiskCeiling,
  requestTwoStageConfirmation,
  validateAndConsumeConfirmation
};
