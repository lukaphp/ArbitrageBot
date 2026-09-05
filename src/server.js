#!/usr/bin/env node

/**
 * 🌐 ARBITRAGE BOT - WEB SERVER
 * ===============================
 * 
 * Server Express per l'applicazione web di arbitraggio
 * - Serve l'interfaccia web HTML/CSS/JS
 * - Fornisce API REST per il bot
 * - Gestisce WebSocket per aggiornamenti real-time
 * - Integrazione completa con MetaMask
 * 
 * ⚠️  SOLO TESTNET - Nessuna transazione mainnet permessa
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import auth from './middleware/auth.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import crypto from 'crypto';

// Importa moduli bot
import config, { isMainnetAllowed } from './config/config.js';
import logger from './utils/logger.js';

// EVM-01: qui c'erano gli import della demo di arbitraggio EVM
// (blockchainConnection, priceFeedManager, arbitrageAnalyzer, transactionExecutor).
// Il server web non espone più nulla di quella demo, quindi non li importa: i
// moduli restano sul disco e continuano a servire la CLI legacy `npm run cli`,
// ma non vengono più caricati nel processo che serve il pannello Perps.

// Moduli Perps (Hyperliquid)
import db from './db/database.js';
import hyperliquid from './perps/hyperliquidClient.js';
import marketData from './perps/marketData.js';
import agentWallet from './perps/agentWallet.js';
import strategyEngine from './perps/strategyEngine.js';
import riskManager from './perps/riskManager.js';
import botManager from './perps/botManager.js';
import portfolio from './perps/portfolio.js';
import notifier from './perps/notifier.js';
import metrics from './perps/metrics.js';
import fxRate from './perps/fxRate.js';
import optimizer from './perps/optimizer.js';
import predictor from './perps/predictor.js';
import telegramControl from './perps/telegramControl.js';
import strategySchema from './perps/strategySchema.js';
import { runBacktest } from './perps/backtester.js';

// Polyfill globale per la serializzazione di BigInt in JSON (Express, Socket.IO, logger)
if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

// Sistema agentico (backbone + Analyst AI)
import agentRuntime from './agents/runtime.js';
import analyst from './agents/analyst/analyst.js';
import advisor from './agents/advisor/advisor.js';
import proposals from './agents/proposals.js';
import riskAgent from './agents/riskAgent.js';
import mlTrainer from './agents/mlTrainer.js';
import { calculateDrawdown, mergeDrawdownState, deriveRiskAlerts, summarizeRisk, deriveExecutionStatus, RISK_ALERT_THRESHOLDS, toRiskBotView } from './perps/riskSnapshot.js';
// DEBT-03: la profondità della coda di esecuzione (WARN-02) è la sola fonte reale
// per "Queue health" nella card EXECUTION STATUS della cockpit.
import execQueue from './perps/execQueue.js';

// Setup paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carica configurazione
dotenv.config();

/**
 * STRAT-01 — TTL delle candidature create da un import di strategie (24h).
 * Volutamente diverso da `AGENT_PROPOSAL_TTL_MIN` (30 min, pensato per proposte
 * legate allo stato del mercato di quel momento): una strategia importata a mano
 * non decade col mercato, e coi 30 minuti scadrebbe mentre l'utente sta ancora
 * leggendo la conferma dell'importazione.
 */
const IMPORT_PROPOSAL_TTL_MIN = 24 * 60;

/**
 * Confronta due stringhe in tempo costante (evita che un attaccante deduca il secret
 * misurando quanto ci mette il confronto a fallire, byte per byte). Ritorna `false`
 * su qualunque input non valido o di lunghezza diversa, senza mai lanciare — un
 * `timingSafeEqual` su buffer di lunghezza diversa lancerebbe invece un'eccezione.
 */
function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class ArbitrageBotServer {
  constructor() {
    this.app = express();
    // Dietro reverse proxy (Caddy): IP/protocollo corretti per cookie Secure e rate-limit
    this.app.set('trust proxy', 1);
    this.server = createServer(this.app);
    // CORS Socket.IO ristretto all'origine nota (default: stesso host)
    const appOrigin = process.env.APP_ORIGIN || true;
    this.io = new Server(this.server, {
      cors: { origin: appOrigin, methods: ["GET", "POST"], credentials: true }
    });
    // Autenticazione delle connessioni WebSocket
    this.io.use(auth.socketAuth);

    this.port = process.env.PORT || 3000;
    // In produzione si lega a localhost: l'esterno passa solo dal reverse proxy (Caddy).
    this.bindHost = process.env.BIND_HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');
    this.isRunning = false;
    this.connectedClients = new Set();
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupErrorHandling();
  }
  
  /**
   * Configura middleware Express
   */
  setupMiddleware() {
    // Header di sicurezza con CSP restrittiva. Lo script-src include i CDN usati
    // dalla UI (socket.io, ethers, lightweight-charts). Il 'unsafe-inline' resta
    // finché ci sono handler onclick inline nell'HTML: verrà rimosso con il build
    // step (Fase 3.5) passando a una CSP senza inline. Tutto il resto è bloccato.
    // NB: helmet imposta di default anche `script-src-attr 'none'`, direttiva
    // separata che NON eredita da script-src: senza l'override esplicito qui sotto
    // il browser blocca *tutti* gli handler onclick inline della UI (i pulsanti
    // smettono di rispondere). Va rimosso insieme agli onclick, non prima.
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.socket.io', 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:', 'https:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          // helmet la aggiunge di default: dice al browser di riscrivere ogni
          // asset in https:// prima di richiederlo. Innocuo dietro un dominio
          // HTTPS pubblico (Caddy la termina comunque), ma rompe silenziosamente
          // CSS/JS quando l'app è servita in HTTP puro (es. accesso via
          // Tailscale senza TLS, DEPLOY.md §3 opzione A) — nessun asset locale
          // qui usa URL http:// assolute, quindi non serve in nessuno dei due casi.
          upgradeInsecureRequests: null
        }
      },
      crossOriginEmbedderPolicy: false,
      // Come upgrade-insecure-requests: helmet la manda di default anche su
      // HTTP puro, dove è priva di senso (HSTS dice al browser "usa sempre
      // HTTPS per questo host", ma qui HTTPS non c'è). Il posto giusto per
      // annunciarla è Caddy, che è dove il TLS viene davvero terminato
      // nell'opzione con dominio pubblico (DEPLOY.md §3 opzione B) — non
      // l'app, che dietro Caddy non sa mai se la richiesta originale era HTTPS.
      hsts: false
    }));

    // CORS ristretto all'origine dell'app (default: stesso host)
    const appOrigin = process.env.APP_ORIGIN;
    this.app.use(cors(appOrigin ? { origin: appOrigin, credentials: true } : { credentials: true }));

    // JSON parsing + cookie per la sessione (limite anti-abuso sul body)
    this.app.use(express.json({ limit: '256kb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '256kb' }));
    this.app.use(cookieParser());

    // Rate-limit globale sulle API
    this.app.use('/api', rateLimit({
      windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false
    }));

    // Serve file statici (UI pubblica: necessaria per mostrare il login)
    this.app.use(express.static(path.join(__dirname, '../public')));

    // Logging middleware (non logga i body, che possono contenere segreti)
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, { ip: req.ip });
      next();
    });

    // --- Gate di autenticazione: protegge tutte le /api/* tranne login/logout/status ---
    const publicApi = new Set(['/api/login', '/api/logout', '/api/auth/status']);
    this.app.use((req, res, next) => {
      if (!req.path.startsWith('/api/')) return next();  // statici, /, /health → pubblici
      if (publicApi.has(req.path)) return next();
      return auth.requireAuth(req, res, next);
    });
  }

  /** Rate-limiter stretto per il login (anti brute-force). */
  loginLimiter() {
    return rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
  }
  
  /**
   * Configura routes API
   */
  setupRoutes() {
    // Route principale - serve l'app web
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });

    // --- Autenticazione (single-user) ---
    this.app.get('/api/auth/status', (req, res) => {
      const enabled = auth.isAuthEnabled();
      const authenticated = !enabled || auth.verifyToken(req.cookies?.[auth.COOKIE]);
      // EVM-01: `demoEvmEnabled` non viene più esposto — serviva solo a public/boot.js
      // per decidere se mostrare la vista Arbitrage, che non esiste più.
      res.json({ success: true, data: { enabled, authenticated } });
    });
    this.app.post('/api/login', this.loginLimiter(), (req, res) => {
      if (!auth.isAuthEnabled()) return res.json({ success: true, data: { authDisabled: true } });
      const { password } = req.body || {};
      if (!password || !auth.verifyPassword(password, process.env.APP_PASSWORD_HASH)) {
        return res.status(401).json({ success: false, error: 'Password errata' });
      }
      res.cookie(auth.COOKIE, auth.issueToken(), auth.cookieOptions());
      res.json({ success: true });
    });
    this.app.post('/api/logout', (req, res) => {
      res.clearCookie(auth.COOKIE, auth.cookieOptions());
      res.json({ success: true });
    });

    // EVM-01: rimosse le ~270 righe di route della demo di arbitraggio EVM
    // (/api/status, /api/prices, /api/opportunities, /api/stats, /api/wallet/connect,
    // /api/simulate/:id, /api/execute/:id, /api/history, /api/settings). Erano
    // registrate solo con DEMO_EVM_ENABLED=true, nessun client le chiamava più dopo
    // il ritiro di public/app.js, e condividere con Perps lo stesso stato di
    // connessione wallet è la causa dei due bug MetaMask corretti il 9 agosto.
    // Il pannello Perps usa esclusivamente /api/perps/*.

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Metriche Prometheus. Non sotto /api/* (quindi fuori dal gate cookie, per
    // permettere lo scraping). Se METRICS_TOKEN è impostato, richiede il token.
    this.app.get('/metrics', async (req, res) => {
      const required = process.env.METRICS_TOKEN;
      if (required) {
        const provided = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (provided !== required) return res.status(401).type('text/plain').send('# unauthorized\n');
      }
      try {
        res.set('Content-Type', 'text/plain; version=0.0.4');
        res.send(await metrics.render());
      } catch (e) {
        res.status(500).type('text/plain').send(`# errore metriche: ${e.message}\n`);
      }
    });

    // Tasso di cambio EUR/USD — SOLO visualizzazione (CUR-01).
    //
    // Sotto /api/* quindi dietro il gate cookie come le altre API della cockpit.
    // Risponde sempre 200 con `success: true` anche quando il tasso non c'è: per
    // chi disegna la UI "tasso non disponibile" è uno stato normale da mostrare,
    // non un errore da gestire in un catch — e `data.rate: null` + `data.stale:
    // true` lo dicono senza ambiguità. Un 5xx qui farebbe sembrare rotta la
    // cockpit per un dato accessorio.
    //
    // Nessun limite di rischio viene convertito in euro: vedi l'intestazione di
    // src/perps/fxRate.js.
    this.app.get('/api/fx/eurusd', async (_req, res) => {
      try {
        const fx = await fxRate.getEurUsd();
        res.json({ success: true, data: fx });
      } catch (e) {
        // Non dovrebbe accadere: getEurUsd() cattura già i suoi errori e li
        // riporta in `error`. Se accade, la forma della risposta resta quella che
        // la UI si aspetta, con rate null.
        logger.warn(`FX EUR/USD: errore inatteso nella route: ${e.message}`);
        res.json({
          success: true,
          data: { rate: null, asOf: null, stale: true, ageMs: null, fetchedAt: null, fetchAgeMs: null, source: 'frankfurter', error: e.message }
        });
      }
    });

    // Route del sottosistema Perps (Hyperliquid)
    this.setupPerpsRoutes();
  }

  /**
   * Route API per il trading Perps su Hyperliquid.
   * Tutte sotto /api/perps/*. Indipendenti dal modulo arbitraggio.
   */
  setupPerpsRoutes() {
    const app = this.app;

    // Stato rete + switch testnet/mainnet
    app.get('/api/perps/network', (req, res) => {
      res.json({ success: true, network: hyperliquid.getNetwork() });
    });

    app.post('/api/perps/network', async (req, res) => {
      try {
        const { network, confirm } = req.body;
        if (network === 'mainnet' && !confirm) {
          return res.status(400).json({ success: false, error: 'Conferma richiesta per passare a MAINNET (fondi reali)' });
        }
        // Stesso gate di validateConfig() per la rete di default all'avvio: qui
        // mancava, quindi il flag decideva solo il boot mentre lo switch a
        // runtime restava aperto — bastava confermare il dialogo del browser.
        // Trovato durante EVM-01, non ipotizzato.
        if (network === 'mainnet' && !isMainnetAllowed()) {
          return res.status(403).json({ success: false, error: 'MAINNET disattivata su questo deploy (ALLOW_MAINNET non è "true"). Impostala nei segreti e riavvia per abilitarla.' });
        }
        hyperliquid.setNetwork(network);
        await marketData.refreshMarkets().catch(() => {});
        this.io.emit('perps:network', { network });
        res.json({ success: true, network });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Lista mercati con leva max e mid
    app.get('/api/perps/markets', async (req, res) => {
      try {
        const markets = marketData.getMarkets().length
          ? marketData.getMarkets()
          : await marketData.refreshMarkets();
        res.json({ success: true, data: markets });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Ordini aperti (trigger TP/SL inclusi) per i livelli sul grafico
    app.get('/api/perps/orders', async (req, res) => {
      try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ success: false, error: 'address richiesto' });
        const orders = await hyperliquid.getFrontendOpenOrders(address);
        res.json({ success: true, data: orders });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Storico operazioni eseguite (fill Hyperliquid: manuali + bot)
    app.get('/api/perps/fills', async (req, res) => {
      try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ success: false, error: 'address richiesto' });
        const fills = await hyperliquid.getUserFills(address);

        // Attribuzione al bot d'origine: mappa oid->bot dai trade registrati,
        // più fallback per coin con un solo bot.
        const bots = db.listBots();
        const botById = new Map(bots.map(b => [b.id, b.name]));
        const oidToBot = new Map();
        for (const t of db.listTrades(500)) {
          if (t.hl_oid != null) oidToBot.set(String(t.hl_oid), t.bot_id ? (botById.get(t.bot_id) || 'Bot') : 'Manuale');
        }
        const coinBots = {};
        for (const b of bots) (coinBots[b.coin] ||= new Set()).add(b.name);

        const enriched = fills.map(f => {
          let botName = oidToBot.get(String(f.oid));
          if (!botName) {
            const s = coinBots[f.coin];
            botName = (s && s.size === 1) ? [...s][0] : null;
          }
          return { ...f, botName };
        });
        res.json({ success: true, data: enriched });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Stato account (equity, margine, posizioni)
    app.get('/api/perps/account', async (req, res) => {
      try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ success: false, error: 'address richiesto' });
        const account = await hyperliquid.getAccount(address);

        // Arricchisce le posizioni aperte con bot d'origine + data di apertura
        // incrociando le posizioni 'open' tracciate nel nostro DB (per coin+lato).
        const bots = db.listBots();
        const botById = new Map(bots.map(b => [b.id, b.name]));
        const coinBots = {};
        for (const b of bots) (coinBots[b.coin] ||= new Set()).add(b.name);
        const dbOpen = db.listPositions(200).filter(p => p.status === 'open');
        const key = (coin, side) => `${coin}|${side}`;
        const dbMap = new Map();
        for (const p of dbOpen) dbMap.set(key(p.coin, p.side), p);

        account.positions = account.positions.map(p => {
          const match = dbMap.get(key(p.coin, p.side)) || dbMap.get(key(p.coin + '-PERP', p.side));
          let botName = match ? (match.bot_id ? (botById.get(match.bot_id) || 'Bot') : 'Manuale') : null;
          if (!botName) { const s = coinBots[p.coin]; botName = (s && s.size === 1) ? [...s][0] : null; }
          return { ...p, botName, openedAt: match?.opened_at || null };
        });
        res.json({ success: true, data: account });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Snapshot aggregato per Risk & Alerts: una sola fonte per dashboard e tab rischio.
    app.get('/api/perps/risk', async (req, res) => {
      const requestedAddress = typeof req.query.address === 'string' && req.query.address.trim()
        ? req.query.address.trim()
        : null;
      const knownBotRows = db.listBots();
      const address = requestedAddress || knownBotRows[0]?.master_address || null;
      const now = Date.now();
      const network = hyperliquid.getNetwork();
      const sourceErrors = [];
      let account = null;
      let orders = [];
      let fills = [];
      let agent = null;
      // DEBT-03: `fills = []` non distingue "nessuna operazione" da "non ho
      // potuto leggere lo storico". La card EXECUTION STATUS deve poter dire
      // "non lo so" invece di mostrare uno zero che afferma il contrario, e
      // senza questo flag lo zero del catch sarebbe indistinguibile da una
      // misura. Parte da `false` proprio perché senza indirizzo non si è letto
      // nulla.
      let fillsAvailable = false;

      if (address) {
        try {
          account = await hyperliquid.getAccount(address, network);
        } catch (error) {
          sourceErrors.push('account');
          logger.warn('Risk snapshot: account non disponibile', error.message);
        }
        try {
          orders = await hyperliquid.getFrontendOpenOrders(address, network);
        } catch (error) {
          sourceErrors.push('ordini');
          logger.warn('Risk snapshot: ordini non disponibili', error.message);
        }
        try {
          fills = await hyperliquid.getUserFills(address, network);
          fillsAvailable = true;
        } catch (error) {
          logger.warn('Risk snapshot: fills non disponibili', error.message);
        }
        try {
          agent = agentWallet.getStatus(address, network);
        } catch (error) {
          sourceErrors.push('agent');
          logger.warn('Risk snapshot: stato agent non disponibile', error.message);
        }
      }

      // ADV-01: soglie e adattatore bot arrivano da riskSnapshot.js, così la
      // cockpit e lo strumento `get_risk_snapshot` del consulente AI leggono
      // esattamente le stesse regole invece di due copie che possono divergere.
      const limits = { ...portfolio.getLimits(), ...RISK_ALERT_THRESHOLDS };
      const botRows = new Map(knownBotRows.map(row => [row.id, row]));
      const allBots = botManager.listStates();
      const scopedBots = address
        ? allBots.filter(bot => botRows.get(bot.id)?.master_address?.toLowerCase() === address.toLowerCase())
        : allBots;
      const bots = scopedBots.map(bot => toRiskBotView(bot, {
        now,
        defaultLoopInterval: config.HYPERLIQUID_CONFIG.botLoopInterval,
        defaultMaxDailyLossUsd: config.HYPERLIQUID_CONFIG.risk.maxDailyLossUsd
      }));
      const marketStatus = marketData.getStatus();
      let equityHistory = address ? db.listRiskEquityHistory(network, address, 180) : [];
      const persistedDrawdown = address ? db.getRiskDrawdownState(network, address) : null;
      if (account && Number.isFinite(Number(account.equity)) && address) {
        db.insertRiskEquitySample(network, address, Math.floor(now / 1000), Number(account.equity), 180);
        equityHistory = db.listRiskEquityHistory(network, address, 180);
      }
      const drawdown = mergeDrawdownState(calculateDrawdown(equityHistory), persistedDrawdown);
      if (address) db.upsertRiskDrawdownState(network, address, drawdown, now);
      const unrealizedPnl = account?.positions?.reduce((sum, position) => sum + Number(position.unrealizedPnl || 0), 0) || 0;
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const realizedPnl = fills
        .filter(fill => Number(fill.time) >= dayStart.getTime())
        .reduce((sum, fill) => sum + Number(fill.closedPnl || 0) - Number(fill.fee || 0), 0);
      const killSwitch = riskAgent.isKillSwitchOn();
      const alerts = deriveRiskAlerts({
        now, address, account, orders, limits, bots, marketStatus, agent, killSwitch,
        drawdown, sourceErrors,
        defaultMaxDailyLossUsd: config.HYPERLIQUID_CONFIG.risk.maxDailyLossUsd
      });

      // DEBT-03 — dati veri per la card EXECUTION STATUS. Le proposte pendenti
      // ancora valide sono le sole che l'utente deve davvero decidere: quelle
      // già scadute vengono marcate `expired` dal runtime al giro successivo, e
      // contarle qui gonfierebbe una coda di lavoro che non esiste più.
      let pendingProposals = null;
      let proposalsAvailable = true;
      try {
        pendingProposals = db.listProposals({ status: 'pending', limit: 500 })
          .filter(row => !row.expires_at || Number(row.expires_at) > now).length;
      } catch (error) {
        proposalsAvailable = false;
        logger.warn('Risk snapshot: proposte pendenti non leggibili', error.message);
      }
      // `depthSnapshot()` include anche `byKey`, che è indicizzato per MASTER
      // ADDRESS: `deriveExecutionStatus` ne estrae solo `max` e `threshold` e non
      // lo ripropaga, quindi nella risposta non finisce nessun indirizzo. È la
      // stessa scelta già fatta per `perps_execqueue_depth` in metrics.js — chi
      // deve sapere QUALE wallet è in coda lo legge dal warning nei log.
      const execution = deriveExecutionStatus({
        now, fills, fillsAvailable, pendingProposals, proposalsAvailable,
        queue: execQueue.depthSnapshot(),
        killSwitch,
        botsRunning: bots.filter(bot => bot.status === 'running').length
      });

      res.json({
        success: true,
        data: {
          generatedAt: now,
          network,
          ownerAddress: address,
          account,
          limits,
          orders: {
            open: orders.length,
            pending: orders.filter(order => !order.isTrigger).length,
            trigger: orders.filter(order => order.isTrigger).length,
            items: orders
          },
          bots: {
            total: bots.length,
            running: bots.filter(bot => bot.status === 'running').length,
            errors: bots.filter(bot => bot.lastError || bot.tickErrors > 0).length,
            stale: bots.filter(bot => bot.stale).length,
            states: bots
          },
          system: {
            marketData: marketStatus,
            wsConnected: !!marketStatus.ws,
            wsFresh: !!marketStatus.wsFresh
          },
          agent,
          killSwitch,
          drawdown,
          equityHistory,
          pnl: {
            realized: realizedPnl,
            unrealized: unrealizedPnl,
            net: realizedPnl + unrealizedPnl
          },
          alerts,
          summary: summarizeRisk(alerts, { killSwitch }),
          execution,
          sourceErrors
        }
      });
    });

    // --- Agent wallet ---
    app.get('/api/perps/agent/status', (req, res) => {
      try {
        const { address } = req.query;
        if (!address) return res.status(400).json({ success: false, error: 'address richiesto' });
        res.json({ success: true, data: agentWallet.getStatus(address, hyperliquid.getNetwork()) });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Genera agent + azione approveAgent da firmare con MetaMask
    app.post('/api/perps/agent/prepare', (req, res) => {
      try {
        const { address, agentName, signatureChainId } = req.body;
        const network = hyperliquid.getNetwork();
        const result = agentWallet.prepareApproval(address, network, agentName || '', signatureChainId);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Invia l'azione approveAgent firmata a Hyperliquid e marca approvato
    app.post('/api/perps/agent/submit', async (req, res) => {
      try {
        const { address, action, signature } = req.body;
        const network = hyperliquid.getNetwork();
        // MetaMask restituisce una firma esadecimale singola: splittala in {r,s,v}
        const sig = ethers.Signature.from(signature);
        const result = await hyperliquid.submitSignedAction(action, { r: sig.r, s: sig.s, v: sig.v }, network);
        agentWallet.markApproved(address, network, action.agentAddress);
        hyperliquid.resetSignSdk(address, network);
        this.io.emit('perps:agentStatus', agentWallet.getStatus(address, network));
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore approveAgent:', error.message);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // --- Trasferimento Spot <-> Perp (usdClassTransfer, firmato da MetaMask) ---
    app.post('/api/perps/transfer/prepare', (req, res) => {
      try {
        const { address, amount, toPerp, signatureChainId } = req.body;
        const network = hyperliquid.getNetwork();
        const result = agentWallet.prepareUsdClassTransfer(
          address, network, amount, toPerp !== false, signatureChainId
        );
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.post('/api/perps/transfer/submit', async (req, res) => {
      try {
        const { action, signature } = req.body;
        const network = hyperliquid.getNetwork();
        const sig = ethers.Signature.from(signature);
        const result = await hyperliquid.submitSignedAction(action, { r: sig.r, s: sig.s, v: sig.v }, network);
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore trasferimento Spot/Perp:', error.message);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Backtest di una strategia sui dati storici
    app.post('/api/perps/backtest', async (req, res) => {
      try {
        const { coin, config: botConfig, interval, lookbackDays } = req.body;
        if (!coin || !botConfig) return res.status(400).json({ success: false, error: 'coin e config richiesti' });
        const result = await runBacktest(botConfig, coin, { interval, lookbackDays });
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore backtest:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Ottimizzazione parametri (Hyperopt + walk-forward)
    app.post('/api/perps/optimize', async (req, res) => {
      try {
        const { coin, config: botConfig, interval, lookbackDays, method, maxEvals, objective, oosFraction } = req.body;
        if (!coin || !botConfig) return res.status(400).json({ success: false, error: 'coin e config richiesti' });
        const result = await optimizer.optimize(botConfig, coin, { interval, lookbackDays, method, maxEvals, objective, oosFraction });
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore optimize:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Stima ML (FreqAI-lite): probabilità di rialzo per la candela corrente
    app.get('/api/perps/predict', async (req, res) => {
      try {
        const { coin, interval = '15m' } = req.query;
        if (!coin) return res.status(400).json({ success: false, error: 'coin richiesto' });
        const result = await predictor.predict(coin, interval);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // (Ri)addestramento esplicito del modello ML
    app.post('/api/perps/predict/train', async (req, res) => {
      try {
        const { coin, interval = '15m', lookbackDays } = req.body;
        if (!coin) return res.status(400).json({ success: false, error: 'coin richiesto' });
        const result = await predictor.train(coin, interval, { lookbackDays });
        res.json({ success: true, data: result });
      } catch (error) {
        logger.error('Errore train ML:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Stato del controllo comandi Telegram
    app.get('/api/perps/telegram/status', (req, res) => {
      res.json({ success: true, data: telegramControl.status() });
    });

    // 🛑 Kill-switch: ferma tutti i bot e (opzionale) chiude tutte le posizioni
    app.post('/api/perps/killswitch', async (req, res) => {
      try {
        const closePositions = req.body?.closePositions === true;
        // Attiva il flag persistente: il RiskAgent bloccherà ogni nuova apertura
        riskAgent.setKillSwitch(true);
        const states = botManager.listStates();
        for (const s of states) {
          if (s.status === 'running') { try { botManager.stopBot(s.id); } catch { /* noop */ } }
        }
        let closed = [];
        if (closePositions) {
          const master = req.body?.masterAddress
            || [...botManager.bots.values()][0]?.masterAddress
            || process.env.WALLET_ADDRESS;
          const network = [...botManager.bots.values()][0]?.network || hyperliquid.network;
          if (master) {
            const acc = await hyperliquid.getAccount(master, network);
            for (const p of acc.positions) {
              try { const r = await hyperliquid.closePosition({ masterAddress: master, coin: p.coin }, network); closed.push({ coin: p.coin, ok: !r.error }); }
              catch (e) { closed.push({ coin: p.coin, ok: false, error: e.message }); }
            }
          }
        }
        notifier.notify(`🛑 <b>KILL-SWITCH</b> attivato: ${states.filter(s => s.status === 'running').length} bot fermati${closePositions ? `, posizioni chiuse: ${closed.length}` : ''}`);
        logger.warn('🛑 Kill-switch attivato', { closePositions, closed: closed.length });
        res.json({ success: true, data: { stopped: states.length, closed } });
      } catch (error) {
        logger.error('Errore kill-switch:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Candele storiche (per grafici e backtest UI)
    app.get('/api/perps/candles', async (req, res) => {
      try {
        const { coin, interval = '15m', lookback } = req.query;
        if (!coin) return res.status(400).json({ success: false, error: 'coin richiesto' });
        const lookbackMs = lookback ? parseInt(lookback) : 1000 * 60 * 60 * 24 * 3;
        const candles = await hyperliquid.getCandles(coin, interval, lookbackMs);
        res.json({ success: true, data: candles });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // --- Bot ---
    // AGENT-AWARE: filtro opzionale ?agent_id=hermes|user_manual per isolare la vista
    app.get('/api/perps/bots', (req, res) => {
      const agentId = req.query.agent_id || null;
      res.json({ success: true, data: botManager.listStates(agentId) });
    });

    // Monitor live: cosa sta valutando il bot (indicatori vs soglie, distanza al segnale)
    app.get('/api/perps/bots/:id/monitor', async (req, res) => {
      try {
        res.json({ success: true, data: await botManager.getMonitor(req.params.id) });
      } catch (error) {
        res.status(404).json({ success: false, error: error.message });
      }
    });

    // Statistiche reali di un bot (trade chiusi)
    app.get('/api/perps/bots/:id/stats', (req, res) => {
      try {
        res.json({ success: true, data: db.getBotStats(req.params.id) });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // CRIT-03-EXTRA — `data.warning` è valorizzato (stringa) quando sul mercato
    // scelto c'è già un altro bot IN ESECUZIONE sullo stesso wallet, altrimenti
    // `null`. Non è un errore e non cambia lo status HTTP: la creazione avviene
    // comunque, perché due strategie diverse sullo stesso asset sono una scelta
    // legittima. Il campo arriva da `botManager.createBot()` e passa da qui senza
    // essere toccato — la decisione di cosa sia una sovrapposizione sta nel
    // manager, che è l'unico a sapere quali bot sono davvero in esecuzione.
    //
    // AGENT-AWARE: accetta `linked_agent_id` ('user_manual' default) e
    // `max_allocation_usd` (Budget Ceiling, null = nessun limite).
    app.post('/api/perps/bots', (req, res) => {
      try {
        const { name, coin, masterAddress, config: botConfig, linked_agent_id, max_allocation_usd } = req.body;
        const state = botManager.createBot({
          name, coin, masterAddress, network: hyperliquid.getNetwork(), config: botConfig,
          linked_agent_id, max_allocation_usd
        });
        res.json({ success: true, data: state });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // STRAT-01 — Esportazione della configurazione di un bot come file scaricabile.
    // Stesso formato dell'export dello storico strategie (una sola definizione in
    // strategySchema), così un bot esportato è re-importabile dalla stessa strada.
    // NON esporta master_address né stato/PnL: un file di strategia descrive come
    // si opera, non su quale conto.
    app.get('/api/perps/bots/:id/export', (req, res) => {
      try {
        const row = db.getBot(req.params.id);
        if (!row) return res.status(404).json({ success: false, error: 'Bot non trovato' });
        const envelope = strategySchema.buildEnvelope(
          [strategySchema.botExportItem(row)],
          { network: row.network, source: 'bot' }
        );
        const filename = strategySchema.exportFileName(row.name || row.coin, 1);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(envelope, null, 2));
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // STRAT-01 — Creazione di bot da un file di strategie importato.
    //
    // È il percorso in cui il criterio "un file malformato non crea un bot con
    // configurazione parzialmente vuota" si applica alla lettera: la validazione
    // avviene TUTTA prima della prima createBot(), e se una sola voce non passa
    // non viene creato nessun bot. Niente valori di default al posto dei campi
    // mancanti, niente leva ridotta di nascosto per rientrare nei limiti.
    //
    // I bot nascono FERMI: importare una strategia non è deciderne l'avvio.
    app.post('/api/perps/bots/import', (req, res) => {
      try {
        const body = req.body || {};
        const result = Array.isArray(body.items) && body.kind === undefined
          ? strategySchema.validateItemList(body.items, { maxItems: 25 })
          : strategySchema.validateEnvelope(body, { maxItems: 25 });

        if (!result.ok) {
          return res.status(400).json({
            success: false,
            error: result.errors[0] || 'File di strategie non valido',
            data: { imported: 0, errors: result.errors.map(reason => ({ reason })) }
          });
        }

        const masterAddress = body.masterAddress || [...botManager.bots.values()][0]?.masterAddress;
        if (!masterAddress) {
          return res.status(400).json({ success: false, error: 'masterAddress richiesto: nessun wallet noto a cui collegare i bot importati' });
        }

        // Seconda validazione, questa volta di contesto: senza di essa il primo
        // bot verrebbe creato e il secondo rifiutato, cioè esattamente l'import
        // parziale che si vuole evitare.
        const existing = new Set([...botManager.bots.values()].map(b => (b.name || '').toLowerCase()));
        const clashes = [];
        for (const it of result.items) {
          const name = it.name || `${it.coin} importata`;
          if (existing.has(name.toLowerCase())) clashes.push(name);
          existing.add(name.toLowerCase());
        }
        if (clashes.length) {
          return res.status(409).json({
            success: false,
            error: `Esiste già un bot con questo nome: ${clashes.join(', ')}. Rinominalo nel file o elimina quello esistente.`,
            data: { imported: 0, errors: clashes.map(n => ({ reason: `nome già in uso: ${n}` })) }
          });
        }

        const created = [];
        for (const it of result.items) {
          created.push(botManager.createBot({
            name: it.name || `${it.coin} importata`,
            coin: it.coin,
            masterAddress,
            network: hyperliquid.getNetwork(),
            config: it.config
          }));
        }

        db.insertAudit('human', 'bots.imported', { count: created.length, coins: result.items.map(i => i.coin) });
        if (created.length) {
          notifier.notify(`📥 <b>${created.length} bot importat${created.length === 1 ? 'o' : 'i'}</b> da file, ferm${created.length === 1 ? 'o' : 'i'}: ${created.map(b => b.name).join(', ')}. Avviali dalla tab System quando vuoi.`);
        }
        logger.info(`📥 Import bot: ${created.length} creati (fermi)`);
        res.json({ success: true, data: { imported: created.length, errors: [], bots: created } });
      } catch (error) {
        logger.error('Errore import bot:', error.message);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // DEBT-01: `updateBot` è asincrono perché attende il tick in volo prima di
    // sostituire l'istanza — senza `await` qui si risponderebbe con una promise.
    app.patch('/api/perps/bots/:id', async (req, res) => {
      try {
        const state = await botManager.updateBot(req.params.id, req.body);
        res.json({ success: true, data: state });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.delete('/api/perps/bots/:id', (req, res) => {
      try {
        botManager.deleteBot(req.params.id);
        res.json({ success: true });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.post('/api/perps/bots/:id/start', (req, res) => {
      try {
        res.json({ success: true, data: botManager.startBot(req.params.id) });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    app.post('/api/perps/bots/:id/stop', (req, res) => {
      try {
        res.json({ success: true, data: botManager.stopBot(req.params.id) });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // --- AGENT-AWARE: Kill Switch "Safe-Exit" ---

    //
    // Filosofia: non chiude tutto "a colpo" per evitare slippage devastante.
    //
    // Body:
    //   agent_id          : (required) 'hermes' | 'user_manual' | ...
    //   size_threshold_usd: (optional, default 500) soglia in USD.
    //                       Le posizioni con notional > soglia vengono chiuse subito
    //                       via market order (pericolose per il capitale).
    //                       Le posizioni < soglia vengono lasciate aperte per una
    //                       gestione manuale più ponderata (evita slippage su size piccole).
    //
    // Risposta: include `skipped` (posizioni sotto soglia, lasciate aperte).
    app.post('/api/perps/kill-switch', async (req, res) => {
      try {
        const { agent_id, size_threshold_usd } = req.body || {};
        if (!agent_id) return res.status(400).json({ success: false, error: 'agent_id richiesto' });

        // Soglia: default 500 USD, null/0 = chiudi tutto (nessuna soglia)
        const threshold = size_threshold_usd != null ? Number(size_threshold_usd) : 500;

        // Trova tutti i bot dell'agente (in memoria)
        const targets = [...botManager.bots.values()].filter(
          b => (b.linked_agent_id || 'user_manual') === agent_id
        );

        const stopped = [];           // bot fermati
        const closedPositions = [];   // posizioni chiuse (size > soglia)
        const skippedPositions = [];  // posizioni lasciate aperte (size <= soglia)
        const errors = [];

        for (const bot of targets) {
          try {
            // STEP 1 — Ferma SEMPRE il bot (nessuna nuova apertura da questo momento)
            if (bot.status === 'running') {
              bot.stop();
              stopped.push(bot.id);
            }

            // STEP 2 — Valuta la posizione aperta (Safe-Exit)
            if (bot.position) {
              // Stima del notional: size * entryPx (prezzo di ingresso come proxy)
              // Se entryPx non disponibile, usiamo il prezzo mid live come fallback
              const entryPx = bot.position.entryPx || 0;
              const size = bot.position.size || 0;
              const estimatedNotional = size * entryPx;

              // Una posizione > soglia è pericolosa → chiudi subito
              // threshold=0 → chiudi tutto (nessuna soglia)
              const exceedsThreshold = threshold === 0 || estimatedNotional > threshold;

              if (exceedsThreshold) {
                try {
                  const result = await hyperliquid.closePosition(
                    { masterAddress: bot.masterAddress, coin: bot.coin },
                    hyperliquid.getNetwork()
                  );
                  closedPositions.push({
                    botId: bot.id, coin: bot.coin,
                    notionalUsd: estimatedNotional, result
                  });
                } catch (closeErr) {
                  errors.push({ botId: bot.id, action: 'close_position', error: closeErr.message });
                }
            } else {
                // Posizione piccola: lascia aperta, segnala per gestione manuale.
                // Il uPNL live viene arricchito dopo il loop (batch per wallet).
                skippedPositions.push({
                  botId: bot.id,
                  coin: bot.coin,
                  masterAddress: bot.masterAddress,
                  notionalUsd: estimatedNotional,
                  side: bot.position.side,
                  size: bot.position.size,
                  unrealizedPnl: null, // popolato sotto
                  reason: `notional ${estimatedNotional.toFixed(2)} USD <= soglia ${threshold} USD — gestione manuale raccomandata`
                });
              }
            }
          } catch (botErr) {
            errors.push({ botId: bot.id, action: 'stop', error: botErr.message });
          }
        }

        // --- Arricchimento uPNL live per le posizioni skippate ---
        // Una singola call getAccount per wallet (non per bot) per minimizzare le API call.
        // Il uPNL è l'informazione critica per decidere se chiudere manualmente.
        if (skippedPositions.length > 0) {
          const uniqueWallets = [...new Set(skippedPositions.map(p => p.masterAddress))];
          const accountsByWallet = new Map();
          await Promise.allSettled(
            uniqueWallets.map(async addr => {
              try {
                const acc = await hyperliquid.getAccount(addr, hyperliquid.getNetwork());
                // Mappa coin → unrealizedPnl per lookup O(1)
                const pnlByCoin = new Map(
                  (acc.positions || []).map(pos => [pos.coin, pos.unrealizedPnl])
                );
                accountsByWallet.set(addr, pnlByCoin);
              } catch (e) {
                logger.warn(`Kill Switch: impossibile recuperare uPNL per ${addr}: ${e.message}`);
              }
            })
          );

          // Arricchisci ogni posizione skippata con il uPNL live
          for (const sp of skippedPositions) {
            const pnlByCoin = accountsByWallet.get(sp.masterAddress);
            if (pnlByCoin) {
              sp.unrealizedPnl = pnlByCoin.get(sp.coin) ?? null;
            }
          }
        }

        db.insertAudit('system', 'kill_switch_safe_exit', {
          agent_id, threshold, stopped, closedPositions: closedPositions.length,
          skippedPositions: skippedPositions.length, errors
        });

        const logMsg = `🛑 Kill Switch Safe-Exit: agent=${agent_id}, soglia=${threshold} USD, ` +
          `fermati=${stopped.length}, chiuse=${closedPositions.length}, skip=${skippedPositions.length}`;
        logger.warn(logMsg);

        // Notifica Telegram con dettaglio Safe-Exit
        const notifParts = [
          `🛑 <b>Kill Switch Safe-Exit</b> [${agent_id}]`,
          `🔴 ${stopped.length} bot fermat${stopped.length === 1 ? 'o' : 'i'} (nessuna nuova apertura)`
        ];
        if (closedPositions.length) {
          notifParts.push(`⚡ ${closedPositions.length} posizion${closedPositions.length === 1 ? 'e chiusa' : 'i chiuse'} (notional > ${threshold} USD)`);
        }
        if (skippedPositions.length) {
          const skLines = skippedPositions.map(p => {
            const pnl = p.unrealizedPnl;
            let pnlStr;
            if (pnl == null) {
              pnlStr = '⚪ uPNL n/d';
            } else if (pnl >= 0) {
              pnlStr = `🟢 uPNL +$${pnl.toFixed(2)}`;
            } else {
              pnlStr = `🔴 uPNL -$${Math.abs(pnl).toFixed(2)}`;
            }
            return `  • ${p.coin} ${(p.side || '').toUpperCase()} | $${p.notionalUsd?.toFixed(0)} | ${pnlStr}`;
          }).join('\n');
          notifParts.push(
            `⏸️ ${skippedPositions.length} posizion${skippedPositions.length === 1 ? 'e lasciata aperta' : 'i lasciate aperte'} (size &lt; soglia):\n${skLines}`
          );
        }
        if (errors.length) notifParts.push(`⚠️ ${errors.length} errori`);
        if (stopped.length || closedPositions.length || skippedPositions.length) {
          notifier.notify(notifParts.join('\n'), { urgent: closedPositions.length > 0 });
        }

        this.io.emit('perps:killSwitch', {
          agent_id, threshold, stopped, closedPositions, skippedPositions, errors
        });

        res.json({
          success: true,
          data: {
            agent_id, threshold,
            botsFound: targets.length,
            stopped,
            closedPositions,
            skippedPositions,
            errors
          }
        });
      } catch (error) {
        logger.error('Kill Switch errore:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // --- AGENT-AWARE: Posizioni con filtro opzionale per agent ---

    // GET /api/perps/positions?agent_id=hermes&limit=50
    app.get('/api/perps/positions', (req, res) => {
      try {
        const agentId = req.query.agent_id || null;
        const limit = parseInt(req.query.limit) || 100;
        const rows = db.listPositions(limit, agentId);
        res.json({ success: true, data: rows });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // --- AGENT-AWARE: Trades con filtro opzionale per agent ---
    // GET /api/perps/trades?agent_id=hermes&limit=50
    app.get('/api/perps/trades', (req, res) => {
      try {
        const agentId = req.query.agent_id || null;
        const botId = req.query.bot_id || null;
        const coin = req.query.coin || null;
        const limit = parseInt(req.query.limit) || 100;
        const rows = db.listTradesBy({ agentId, botId, coin, limit });
        res.json({ success: true, data: rows });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });


    app.post('/api/perps/order', async (req, res) => {
      try {
        const { masterAddress, coin, side, sizeUsd, size, leverage, tp, sl, slippage } = req.body;
        if (!masterAddress || !coin || !side) {
          return res.status(400).json({ success: false, error: 'masterAddress, coin e side richiesti' });
        }
        const network = hyperliquid.getNetwork();
        const lev = leverage || config.HYPERLIQUID_CONFIG.risk.defaultLeverage;
        const mid = await hyperliquid.getMid(coin, network);
        if (!mid) throw new Error(`Prezzo non disponibile per ${coin}`);

        const market = marketData.getMarkets().find(m => m.coin === coin);
        const szDecimals = market?.szDecimals ?? 3;

        // size esplicita oppure derivata dal notional USD
        let orderSize = size;
        if (!orderSize) {
          const notional = (sizeUsd || 0) * 1; // sizeUsd = notional desiderato
          orderSize = riskManager.roundSize(notional / mid, szDecimals);
        }
        if (!orderSize || orderSize <= 0) throw new Error('Size non valida');

        // Limiti di rischio
        const account = await hyperliquid.getAccount(masterAddress, network);
        const plan = { notionalUsd: orderSize * mid, leverage: lev };
        const check = riskManager.checkLimits({ leverage: lev }, account, plan, 0);
        if (!check.ok) return res.status(400).json({ success: false, error: check.reason });

        await hyperliquid.setLeverage(masterAddress, coin, lev, 'cross', network);
        const isBuy = side === 'long';
        const order = await hyperliquid.placeMarketOrder({
          masterAddress, coin, isBuy, size: orderSize, slippage: slippage ?? 0.02
        }, network);
        if (order.error) throw new Error(order.error);

        // TP/SL opzionali
        const entryPx = order.avgPx || mid;
        const tpsl = riskManager.computeTpSl(entryPx, side, {
          tp: tp ? { enabled: true, mode: tp.mode || 'percent', value: tp.value } : { enabled: false },
          sl: sl ? { enabled: true, mode: sl.mode || 'percent', value: sl.value } : { enabled: false }
        });
        const closeIsBuy = side === 'short';
        if (tpsl.tpPx) {
          await hyperliquid.placeTriggerOrder({ masterAddress, coin, isBuy: closeIsBuy, size: orderSize, triggerPx: tpsl.tpPx, tpsl: 'tp' }, network).catch(e => logger.warn('TP fallito', e.message));
        }
        if (tpsl.slPx) {
          await hyperliquid.placeTriggerOrder({ masterAddress, coin, isBuy: closeIsBuy, size: orderSize, triggerPx: tpsl.slPx, tpsl: 'sl' }, network).catch(e => logger.warn('SL fallito', e.message));
        }

        db.insertTrade({ coin, side, px: entryPx, sz: orderSize, hlOid: order.oid });
        this.io.emit('perps:fill', { coin, side, size: orderSize, px: entryPx });
        res.json({ success: true, data: { order, entryPx, size: orderSize, ...tpsl } });
      } catch (error) {
        logger.error('Errore ordine Perps:', error.message);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Chiusura manuale di una posizione
    app.post('/api/perps/positions/:coin/close', async (req, res) => {
      try {
        const { masterAddress } = req.body;
        const coin = decodeURIComponent(req.params.coin);
        const result = await hyperliquid.closePosition({ masterAddress, coin }, hyperliquid.getNetwork());
        this.io.emit('perps:position', { coin, closed: true });
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // --- Risk di portafoglio (limiti globali) ---
    app.get('/api/perps/portfolio', (req, res) => {
      res.json({ success: true, data: portfolio.getLimits() });
    });
    app.post('/api/perps/portfolio', (req, res) => {
      try {
        res.json({ success: true, data: portfolio.setLimits(req.body || {}) });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // --- Notifiche Telegram ---
    app.get('/api/perps/notifications', (req, res) => {
      res.json({ success: true, data: notifier.status() });
    });
    app.post('/api/perps/notifications', (req, res) => {
      try {
        const data = notifier.setConfig(req.body || {});
        // (Ri)avvia o ferma il polling dei comandi Telegram in base alla nuova config
        telegramControl.refresh();
        res.json({ success: true, data });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });
    app.post('/api/perps/notifications/test', async (req, res) => {
      try {
        const ok = await notifier.notify('✅ Test notifica da ArbitrageBot Perps');
        res.json({ success: true, data: { sent: ok } });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Webhook segnali esterni (TradingView-style).
    //
    // Scelta deliberata (Sprint 1, SEC-04): questa rotta vive sotto '/api/*' e quindi
    // dietro il gate `requireAuth` applicato in setupMiddleware() a tutte le API tranne
    // login/logout/status. Di fatto non è raggiungibile da un servizio esterno come
    // TradingView o TrendSpider, che non possiede un cookie di sessione autenticata:
    // può chiamarla solo un client che ha già fatto login sull'app (es. uno script tuo).
    // È voluto — vedi la sezione "Segnali esterni via webhook" in docs/MANUAL.md — non
    // una svista: aprire l'endpoint a fonti realmente esterne è stato valutato (opzione A
    // nel backlog Sprint 1) e scartato per questo sprint perché introdurrebbe un nuovo
    // endpoint pubblico capace di scatenare ordini reali, cosa che non va decisa dentro
    // uno sprint di hardening. Se in futuro serve davvero, va costruita come un progetto
    // a sé con almeno: firma HMAC del corpo grezzo (es. header X-Signature, chiave da
    // secret manager), un timestamp nel payload firmato con rifiuto oltre pochi minuti
    // (anti-replay: il TTL di 5 minuti qui sotto è solo lato ricezione, non impedisce di
    // re-inviare un payload catturato), whitelist esplicita di questo path fuori dal gate
    // cookie (match esatto, con test di regressione che nessun'altra rotta resti aperta
    // per errore), e un rate limit dedicato più stretto di quello globale su '/api'.
    app.post('/api/perps/webhook', (req, res) => {
      try {
        const { coin, signal, secret } = req.body;
        if (process.env.PERPS_WEBHOOK_SECRET && !constantTimeEquals(secret, process.env.PERPS_WEBHOOK_SECRET)) {
          return res.status(401).json({ success: false, error: 'Secret non valido' });
        }
        if (!coin || !signal) return res.status(400).json({ success: false, error: 'coin e signal richiesti' });
        strategyEngine.pushExternalSignal(coin, signal);
        res.json({ success: true });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ===== Sistema agentico + Analyst AI =====
    app.get('/api/agents/status', (req, res) => {
      res.json({ success: true, data: {
        runtime: agentRuntime.status(),
        analyst: analyst.status(),
        killSwitch: riskAgent.isKillSwitchOn()
      }});
    });

    app.get('/api/agents/proposals', (req, res) => {
      const status = req.query.status || undefined;
      res.json({ success: true, data: proposals.list({ status, limit: 50 }) });
    });

    app.post('/api/agents/proposals/:id/approve', async (req, res) => {
      try {
        const r = await proposals.approve(req.params.id);
        res.json({ success: r.ok, data: r, error: r.ok ? undefined : r.reason });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post('/api/agents/proposals/:id/reject', (req, res) => {
      const r = proposals.reject(req.params.id);
      res.json({ success: r.ok, data: r, error: r.ok ? undefined : r.reason });
    });

    // Collega un bot creato a una proposta approvata (per seguirne l'esito)
    app.post('/api/agents/proposals/:id/link', (req, res) => {
      try {
        const { botId } = req.body || {};
        if (!botId) return res.status(400).json({ success: false, error: 'botId richiesto' });
        res.json({ success: true, data: proposals.linkBot(req.params.id, botId) });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Storico strategie (approvate/rifiutate) con esito live di quelle avviate
    // Righe (filtrabili per stato) + conteggi esatti per stato. I conteggi sono
    // calcolati in SQL, così i badge dei tab restano corretti anche quando le
    // righe vengono troncate dal limite.
    app.get('/api/agents/strategy-history', (req, res) => {
      const { status } = req.query;
      const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
      res.json({
        success: true,
        data: { items: proposals.history({ status, limit }), counts: db.getStrategyCounts() }
      });
    });

    // STRAT-01 — Esportazione dello storico strategie come file scaricabile.
    // La UI può già costruirsi il file da sola con i dati che ha a schermo; questa
    // route serve per l'export che NON passa dalla UI (script, backup, condivisione)
    // e per garantire che il formato del file abbia una sola definizione
    // (strategySchema), non una per produttore.
    app.get('/api/agents/strategy-history/export', (req, res) => {
      try {
        const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
        const status = req.query.status;
        const all = proposals.history({ status, limit: 1000 });
        const items = ids.length ? all.filter(h => ids.includes(h.id)) : all;
        if (!items.length) {
          return res.status(404).json({ success: false, error: 'Nessuna strategia da esportare per i criteri indicati' });
        }
        const envelope = strategySchema.buildEnvelope(
          items.map(strategySchema.historyExportItem),
          { network: hyperliquid.getNetwork(), source: 'strategy-history' }
        );
        const filename = strategySchema.exportFileName(items.length === 1 ? items[0].coin : 'storico', items.length);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(envelope, null, 2));
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // STRAT-01 — Importazione nello storico strategie.
    //
    // Accetta la busta completa (`{kind, version, items}`) o la sola lista
    // `items` già estratta dalla UI. La validazione qui è quella che DECIDE:
    // quella del client è solo il primo filtro, perché è il server che scrive.
    //
    // Tutto-o-nulla: se una sola voce non passa, non viene scritto niente. Un
    // import parziale lascerebbe l'utente a indovinare cosa è entrato, ed è la
    // via più diretta a una strategia con configurazione a metà.
    //
    // Le strategie importate entrano come CANDIDATURE pendenti, non come bot:
    // per diventare operative devono passare dall'approvazione e quindi dal gate
    // deterministico di riskAgent, esattamente come una proposta dell'Analyst.
    // Un file importato è codice di qualcun altro: non può creare bot da solo.
    app.post('/api/agents/strategy-history/import', (req, res) => {
      try {
        const body = req.body || {};
        const result = Array.isArray(body.items) && body.kind === undefined
          ? strategySchema.validateItemList(body.items)
          : strategySchema.validateEnvelope(body);

        if (!result.ok) {
          return res.status(400).json({
            success: false,
            error: result.errors[0] || 'File di strategie non valido',
            data: { imported: 0, skipped: result.errors.length, errors: result.errors.map(reason => ({ reason })) }
          });
        }

        const created = [];
        for (const it of result.items) {
          const row = proposals.create({
            type: 'new_strategy_candidate',
            coin: it.coin,
            payload: { coin: it.coin, interval: it.interval, config: it.config },
            rationale: it.rationale || 'Strategia importata da file',
            confidence: it.confidence,
            source: 'import',
            model: it.model || null,
            // TTL lungo: una candidatura importata a mano non decade col mercato
            // come un "chiudi adesso", e coi 30 minuti di default scadrebbe
            // mentre l'utente legge la conferma dell'import.
            ttlMin: IMPORT_PROPOSAL_TTL_MIN,
            // Una notifica per import, non una per strategia (vedi sotto).
            notify: false
          });
          created.push({ id: row?.id, coin: it.coin });
        }

        db.insertAudit('human', 'strategies.imported', { count: created.length, coins: created.map(c => c.coin) });
        if (created.length) {
          notifier.notify(`📥 <b>${created.length} strateg${created.length === 1 ? 'ia' : 'ie'} importate</b> come candidature in attesa di approvazione: ${created.map(c => c.coin).join(', ')}`);
        }
        logger.info(`📥 Import strategie: ${created.length} candidature create`);
        res.json({ success: true, data: { imported: created.length, skipped: 0, errors: [], items: created, target: 'pending_proposals' } });
      } catch (error) {
        logger.error('Errore import strategie:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Riciclo di strategie scadute: ri-backtest locale e riproposta se l'edge
    // regge. Nessun costo AI. Le rifiutate non sono riciclabili per scelta.
    app.post('/api/agents/strategy-history/recycle', async (req, res) => {
      try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
        if (!ids.length) return res.status(400).json({ success: false, error: 'Specificare ids[]' });
        res.json({ success: true, data: await proposals.recycle(ids) });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Eliminazione dallo storico strategie: singola (ids) o massiva (status).
    // Serve almeno un criterio: senza, si rischierebbe di svuotare tutto per errore.
    app.delete('/api/agents/strategy-history', (req, res) => {
      try {
        const { ids, status } = req.body || {};
        const idList = Array.isArray(ids) ? ids.filter(Boolean) : [];
        if (!idList.length && !status) {
          return res.status(400).json({ success: false, error: 'Specificare ids[] oppure status' });
        }
        if (status && !['approved', 'rejected', 'expired'].includes(status)) {
          return res.status(400).json({ success: false, error: `Stato non valido: ${status}` });
        }
        const deleted = proposals.deleteHistory({ ids: idList.length ? idList : undefined, status });
        res.json({ success: true, data: { deleted } });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Preventivo token/costo PRIMA di lanciare l'analisi (non consuma inferenza)
    app.post('/api/agents/analyst/estimate', async (req, res) => {
      try {
        const { model, riskAppetite, focusMarkets, maxProposals, exploration, notes } = req.body || {};
        const opts = {
          model, riskAppetite, maxProposals, exploration, notes,
          focusMarkets: Array.isArray(focusMarkets) ? focusMarkets
            : (typeof focusMarkets === 'string' && focusMarkets.trim() ? focusMarkets.split(',').map(s => s.trim()).filter(Boolean) : undefined)
        };
        const r = await analyst.estimate(opts);
        res.json({ success: !r?.error, data: r, error: r?.error, code: r?.code });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Esegue subito un ciclo dell'Analyst (on-demand), con parametri opzionali
    app.post('/api/agents/analyst/run', async (req, res) => {
      try {
        const { model, riskAppetite, focusMarkets, maxProposals, exploration, notes } = req.body || {};
        const opts = {
          model, riskAppetite, maxProposals, exploration, notes,
          focusMarkets: Array.isArray(focusMarkets) ? focusMarkets
            : (typeof focusMarkets === 'string' && focusMarkets.trim() ? focusMarkets.split(',').map(s => s.trim()).filter(Boolean) : undefined)
        };
        const r = await analyst.run(opts);
        res.json({ success: !r?.error, data: r, error: r?.error });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Pausa/stop dell'Analyst — persistiti, sopravvivono a un riavvio.
    // Pausa: nessuna run futura, quella in corso (se c'è) finisce da sola.
    // Stop: come pausa, ma annulla anche la run in corso e azzera il cap orario.
    app.post('/api/agents/analyst/pause', (req, res) => {
      analyst.pause();
      res.json({ success: true, data: analyst.status() });
    });
    app.post('/api/agents/analyst/resume', (req, res) => {
      analyst.resume();
      res.json({ success: true, data: analyst.status() });
    });
    app.post('/api/agents/analyst/stop', (req, res) => {
      analyst.stop();
      res.json({ success: true, data: analyst.status() });
    });

    // Audit trail
    app.get('/api/agents/audit', (req, res) => {
      res.json({ success: true, data: db.listAudit(parseInt(req.query.limit) || 100) });
    });

    /**
     * Kill-switch on/off esplicito (lo stato persiste e blocca le aperture).
     *
     * DEBT-01 item 3 — NOTIFICA su Telegram, come fa TG-01 dal lato chat. Questa
     * è l'unica rotta che SPEGNE il kill-switch (la usa
     * `perps.resumeFromKillSwitch` nella cockpit) e finora lo faceva in silenzio:
     * le aperture tornavano consentite senza che ne restasse traccia sul canale
     * che l'operatore guarda davvero. Un kill-switch non è un'azione privata di
     * chi l'ha premuto.
     *
     * Due vincoli sul testo, entrambi verificati da test:
     *  - una notifica per CAMBIO reale di stato, non per click: premere due volte
     *    "riattiva" non deve produrre due messaggi (stesso principio del cooldown
     *    di portafoglio e del watchdog WS). L'audit invece registra ogni
     *    tentativo — la traccia di chi ha premuto non si perde;
     *  - il messaggio dichiara solo ciò che questa rotta fa davvero: scrive il
     *    flag. NON ferma i bot in esecuzione (quello è `/api/perps/killswitch`) e
     *    non chiude posizioni. Annunciare un effetto non prodotto è il modo
     *    peggiore di sbagliare: l'operatore crederebbe di essere protetto.
     */
    app.post('/api/agents/killswitch', (req, res) => {
      const on = req.body?.on !== false;
      const was = riskAgent.isKillSwitchOn();
      riskAgent.setKillSwitch(on);
      if (was !== on) {
        if (on) {
          logger.warn('🛑 Kill-switch attivato dal pannello web (solo flag: nessun bot fermato)');
          notifier.notify('🛑 <b>Kill-switch attivato</b> dal pannello web: nuove aperture <b>bloccate</b>.\nI bot in esecuzione <b>non</b> sono stati fermati e le posizioni aperte <b>non</b> sono state chiuse da questa azione.');
        } else {
          logger.warn('✅ Kill-switch disattivato dal pannello web: aperture di nuovo consentite');
          notifier.notify('✅ <b>Kill-switch disattivato</b> dal pannello web: nuove aperture di nuovo <b>consentite</b>.\nI bot fermati <b>non</b> sono stati riavviati: riprendere a operare resta una decisione separata.');
        }
      }
      res.json({ success: true, data: { killSwitch: on, changed: was !== on } });
    });

    /**
     * ANA-01 — performance storica aggregata (una chiamata, non un polling).
     *
     * I dati esistevano già tutti (posizioni chiuse con `close_reason`,
     * `risk_equity_history`, `ml_history`): mancava l'aggregazione e la
     * restituzione. Qui si mettono insieme senza ricalcolare nulla altrove:
     * expectancy/avgWin/avgLoss/breakdown arrivano da `db.getBotPerformance`, la
     * curva equity da `db.listRiskEquityHistory` e le serie ML da
     * `db.listMlHistory` — gli stessi metodi che già alimentano il resto.
     *
     * Pensata per essere chiamata all'APERTURA della sezione, non in loop: una
     * sola risposta con tutto (criterio «nessun nuovo fetch pesante in loop»).
     */
    app.get('/api/perps/performance', (req, res) => {
      try {
        const botRows = db.listBots();
        const requestedAddress = typeof req.query.address === 'string' && req.query.address.trim()
          ? req.query.address.trim()
          : null;
        const address = requestedAddress || botRows[0]?.master_address || null;
        const network = hyperliquid.getNetwork();
        const seriesLimit = Math.max(10, Math.min(2000, parseInt(req.query.limit) || 500));

        const liveById = new Map(botManager.listStates().map(s => [s.id, s]));
        const bots = botRows.map(row => {
          const perf = db.getBotPerformance(row.id);
          const live = liveById.get(row.id);
          return {
            botId: row.id,
            name: row.name,
            coin: row.coin,
            status: live?.status || row.status,
            paper: !!live?.paper,
            trades: perf.trades,
            wins: perf.wins,
            losses: perf.losses,
            winRate: perf.winRate,
            expectancy: perf.expectancy,
            expectancyRatio: perf.expectancyRatio,
            avgWin: perf.avgWin,
            avgLoss: perf.avgLoss,        // negativo, come ogni PnL esposto
            avgLossAbs: perf.avgLossAbs,
            bestUsd: perf.bestUsd,
            worstUsd: perf.worstUsd,
            totalPnl: perf.totalPnl,
            totalFees: perf.totalFees,
            profitFactor: perf.profitFactor,
            maxDrawdownUsd: perf.maxDrawdownUsd,
            firstClosedAt: perf.firstClosedAt,
            lastClosedAt: perf.lastClosedAt,
            closeReasons: perf.closeReasons,             // { bucket: conteggio }
            closeReasonDetail: perf.closeReasonDetail,   // { bucket: {trades,wins,losses,pnl} }
            closeReasonsRaw: perf.closeReasonsRaw,       // testo esatto, niente nascosto
            pnlSeries: db.getBotPnlSeries(row.id, seriesLimit)
          };
        });

        // Aggregato di portafoglio: la somma dei bot, non un secondo calcolo.
        const closedTrades = bots.reduce((s, b) => s + b.trades, 0);
        const totals = {
          bots: bots.length,
          trades: closedTrades,
          wins: bots.reduce((s, b) => s + b.wins, 0),
          totalPnl: bots.reduce((s, b) => s + b.totalPnl, 0),
          totalFees: bots.reduce((s, b) => s + b.totalFees, 0)
        };
        totals.winRate = closedTrades ? totals.wins / closedTrades : 0;
        totals.expectancy = closedTrades ? totals.totalPnl / closedTrades : 0;

        const equityHistory = address ? db.listRiskEquityHistory(network, address, Math.min(seriesLimit, 5000)) : [];
        const drawdown = mergeDrawdownState(
          calculateDrawdown(equityHistory),
          address ? db.getRiskDrawdownState(network, address) : null
        );

        // ml_history esisteva ed era senza consumer perché `listMlHistory` vuole
        // coin e interval e nessuno sapeva quali chiedere: si enumerano le serie
        // presenti (`mlScopes`, per popolare un selettore) e si restituiscono i
        // punti in un unico array PIATTO, ciascuno con la sua coin/interval —
        // filtrare un array piatto per coin è ciò che serve a un grafico, mentre
        // una struttura annidata costringerebbe la UI a srotolarla.
        const mlScopes = db.listMlHistoryScopes();
        const mlHistory = mlScopes.flatMap(scope =>
          db.listMlHistory(scope.coin, scope.interval, Math.min(seriesLimit, 500))
            .map(r => ({
              coin: scope.coin, interval: scope.interval, ts: r.ts,
              accuracy: r.accuracy, baseline: r.baseline, edge: r.edge, auc: r.auc, samples: r.samples
            }))
            .reverse() // cronologico crescente: è una serie temporale
        );

        res.json({
          success: true,
          data: {
            generatedAt: Date.now(),
            network,
            ownerAddress: address,
            totals,
            bots,
            equityHistory,
            drawdown,
            mlScopes,
            mlHistory
          }
        });
      } catch (error) {
        logger.error('Errore performance storica:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Storico qualità ML nel tempo (decadimento dell'edge)
    app.get('/api/perps/ml/history', (req, res) => {
      const { coin, interval = '15m', limit } = req.query;
      if (!coin) return res.status(400).json({ success: false, error: 'coin richiesto' });
      res.json({ success: true, data: db.listMlHistory(coin, interval, parseInt(limit) || 100) });
    });

    // Retraining ML on-demand (per i modelli usati dai bot con gate ML)
    app.post('/api/perps/ml/retrain', async (req, res) => {
      try {
        const results = await mlTrainer.runOnce();
        res.json({ success: true, data: results });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    this.setupAdvisorRoutes();
  }

  /**
   * ADV-02/03 — Rotte del CONSULENTE AI conversazionale (sola lettura).
   *
   * Nessuna di queste rotte arriva a `POST /api/agents/proposals/:id/approve`,
   * a `/killswitch` o a `/analyst/*`: il consulente produce testo, e al massimo
   * righe in `chat_sessions`/`chat_messages`/`audit`. È l'invariante di disegno
   * dello spike §0, e va verificata guardando gli import di `agents/advisor/`.
   *
   * Convenzione di errore, importante per la UI: i rifiuti PREVISTI (consulente
   * disattivato, chiave assente, budget mensile raggiunto, sessione inesistente)
   * tornano con HTTP 200 e `{success:false, error, code}`. Mai un 200
   * "riuscito" con una risposta vuota: `perps.api()` lancia su `success:false` e
   * mostra `error`, quindi l'utente legge sempre il motivo vero.
   */
  setupAdvisorRoutes() {
    const app = this.app;

    // Stato del consulente (modello, disponibilità, budget, retention).
    // Additiva rispetto al contratto concordato: serve alla UI per mostrare lo
    // stato degradato senza dover prima provare a mandare un messaggio.
    app.get('/api/advisor/status', (req, res) => {
      res.json({ success: true, data: advisor.status() });
    });

    // Budget mensile: SOLA LETTURA. Non esiste (e non deve esistere) alcuna
    // rotta web che lo modifichi — la modifica passa solo da Telegram con
    // conferma a due passi (`/advisorbudget`), così chi compromette la sessione
    // web non può alzarsi il budget da solo. Verificato da test.
    app.get('/api/advisor/budget', (req, res) => {
      const b = advisor.budget();
      res.json({
        success: true,
        data: {
          monthlyLimitUsd: b.monthlyLimitUsd,
          spentUsd: b.spentUsd,
          remainingUsd: b.remainingUsd,
          resetsAt: b.resetsAt,
          exceeded: b.exceeded,
          changeableVia: 'telegram:/advisorbudget'
        }
      });
    });

    app.get('/api/advisor/sessions', (req, res) => {
      try {
        const data = advisor.listSessions(parseInt(req.query.limit) || 50)
          .map(s => ({ id: s.id, title: s.title, startedAt: s.startedAt, lastAt: s.lastAt, costUsd: s.costUsd }));
        res.json({ success: true, data });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    app.post('/api/advisor/sessions', (req, res) => {
      try {
        const s = advisor.createSession({ title: req.body?.title || null });
        res.json({ success: true, data: { id: s.id, startedAt: s.startedAt } });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    app.get('/api/advisor/sessions/:id/messages', (req, res) => {
      if (!advisor.getSession(req.params.id)) {
        return res.status(404).json({ success: false, error: 'Conversazione non trovata', code: 'session_not_found' });
      }
      res.json({ success: true, data: advisor.getMessages(req.params.id) });
    });

    app.post('/api/advisor/sessions/:id/messages', async (req, res) => {
      try {
        const out = await advisor.chat(req.params.id, req.body?.message);
        if (out.error) {
          // Rifiuto previsto: success:false con il motivo LEGGIBILE e un codice
          // per distinguerlo senza interpretare il testo.
          return res.json({ success: false, error: out.error, code: out.code, data: out.budget ? { budget: out.budget } : undefined });
        }
        res.json({
          success: true,
          data: {
            reply: out.reply,
            toolsUsed: out.toolsUsed,
            costUsd: out.costUsd,
            budgetRemainingUsd: out.budgetRemainingUsd,
            messageId: out.messageId,
            model: out.model
          }
        });
      } catch (e) {
        logger.error('Errore turno advisor:', e.message);
        res.status(500).json({ success: false, error: e.message });
      }
    });

    app.delete('/api/advisor/sessions/:id', (req, res) => {
      const r = advisor.deleteSession(req.params.id);
      if (!r.deleted) {
        return res.status(404).json({ success: false, error: 'Conversazione non trovata', code: 'session_not_found' });
      }
      res.json({ success: true });
    });
  }

  /**
   * Configura WebSocket per aggiornamenti real-time
   */
  setupWebSocket() {
    this.io.on('connection', (socket) => {
      logger.info('🔌 Client connesso via WebSocket', { socketId: socket.id });
      this.connectedClients.add(socket.id);
      
      // Invia stato iniziale
      socket.emit('status', { bot: { running: this.isRunning } });

      // Gestisci disconnessione
      socket.on('disconnect', () => {
        logger.info('🔌 Client disconnesso', { socketId: socket.id });
        this.connectedClients.delete(socket.id);
      });

      // EVM-01: rimossi gli handler `requestPrices`/`requestOpportunities` e il
      // campo `blockchain` dallo stato iniziale — erano l'unico canale WebSocket
      // della demo EVM e, a differenza delle route REST, non erano nemmeno dietro
      // DEMO_EVM_ENABLED: restavano registrati sempre. Nessun client li usava
      // (la cockpit ascolta solo gli eventi `perps:*`).
    });
  }
  
  /**
   * Configura gestione errori
   */
  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ 
        success: false, 
        error: 'Endpoint non trovato' 
      });
    });
    
    // Error handler globale
    this.app.use((err, req, res, next) => {
      logger.error('Errore server:', err);
      res.status(500).json({ 
        success: false, 
        error: 'Errore interno del server' 
      });
    });
  }
  
  /**
   * Avvia il server e i moduli bot
   */
  async start() {
    try {
      logger.info('🚀 Avvio Arbitrage Bot Web Server...');
      
      // Validazione configurazione
      logger.info('🔧 Validazione configurazione...');
      config.validateConfig();
      
      // EVM-01: qui partivano provider RPC, price feed e analizzatore della demo
      // EVM quando DEMO_EVM_ENABLED=true. Il server web non avvia più nulla di
      // quel modulo: senza route né canale WebSocket, tenerlo in piedi avrebbe
      // significato far girare tre sottosistemi che nessuno può più osservare.

      // Inizializzazione sottosistema Perps (Hyperliquid)
      try {
        logger.info('🗄️  Inizializzazione database Perps...');
        db.init();
        hyperliquid.init();
        logger.info('📈 Avvio market data Perps...');
        await marketData.start(this.io);
        botManager.setIo(this.io);
        botManager.loadFromDb();
        botManager.startWatchdog();
        // ADV-02: retention dei transcript di chat applicata all'avvio (oltre che
        // alla creazione di una nuova conversazione), così un deploy fermo per
        // settimane non si ritrova con mesi di storico oltre la soglia.
        try {
          const purged = advisor.purgeExpired();
          if (purged.sessions) logger.info(`💬 Advisor: retention all'avvio — ${purged.sessions} conversazioni eliminate`);
        } catch (e) {
          logger.warn('💬 Advisor: retention all\'avvio non applicata', e.message);
        }
        // Avvia il controllo comandi Telegram se configurato
        telegramControl.refresh();
        // Avvia il runtime degli agenti (Analyst AI + janitor proposte)
        agentRuntime.register(analyst);
        agentRuntime.register(proposals.janitorAgent());
        agentRuntime.register(mlTrainer);
        await agentRuntime.startAll();
        logger.info('🤖 Sottosistema Perps + agenti pronto');
      } catch (perpsError) {
        logger.error('⚠️ Errore inizializzazione Perps:', perpsError.message);
      }

      // EVM-01: qui c'era `this.setupBotEvents()`, che serviva solo a trasmettere
      // ogni 15s le statistiche dell'analizzatore EVM (`statsUpdate`,
      // `opportunitiesUpdate`). Gli eventi Perps li emette marketData/botManager
      // direttamente, quindi il metodo è stato rimosso, non svuotato.

      // Avvia server HTTP
      this.server.listen(this.port, this.bindHost, () => {
        this.isRunning = true;
        logger.info(`🌐 Server avviato su http://${this.bindHost}:${this.port}`);
        logger.info(`🔐 Auth: ${auth.isAuthEnabled() ? 'ATTIVA' : 'DISATTIVA (solo sviluppo)'} · HL network: ${config.HYPERLIQUID_CONFIG.defaultNetwork}`);
        
        console.log(`
📈 PERPS TRADING (Hyperliquid)`);
        console.log(`=====================================`);
        console.log(`🌐 Web Interface: http://localhost:${this.port}`);
        console.log(`📊 API Endpoint: http://localhost:${this.port}/api`);
        console.log(`🔌 WebSocket: ws://localhost:${this.port}`);
        console.log(`🟢 HL network: ${config.HYPERLIQUID_CONFIG.defaultNetwork}`);
        console.log(`=====================================\n`);
      });
      
    } catch (error) {
        logger.error('❌ Errore avvio server:', error.message || error);
        logger.info('🔄 Tentativo di avvio in modalità limitata...');
        
        // Avvia comunque il server web anche se alcuni moduli falliscono
        try {
          this.server.listen(this.port, this.bindHost, () => {
            this.isRunning = true;
            logger.info(`🌐 Server web attivo su http://${this.bindHost}:${this.port}`);
            logger.info('⚠️ Modalità limitata - Alcune funzionalità potrebbero non essere disponibili');
          });
        } catch (serverError) {
          logger.error('❌ Impossibile avviare server web:', serverError.message);
          process.exit(1);
        }
      }
    }
  
  /**
   * Arresta il server gracefully
   */
  async stop() {
    logger.info('🛑 Arresto server...');
    
    this.isRunning = false;

    // Arresta sottosistema Perps
    try {
      botManager.stopAll();
      marketData.stop();
    } catch (error) {
      logger.error('Errore arresto Perps:', error.message);
    }
    
    // Chiudi connessioni WebSocket
    this.io.close();
    
    // Chiudi server HTTP
    this.server.close(() => {
      logger.info('✅ Server arrestato');
      process.exit(0);
    });
  }
}

// Istanza server
const server = new ArbitrageBotServer();

// Gestione segnali di arresto
process.on('SIGINT', () => server.stop());
process.on('SIGTERM', () => server.stop());

// Gestione errori non catturati
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  server.stop();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  server.stop();
});

// Avvia server solo se eseguito direttamente
if (process.argv[1] === __filename) {
  server.start();
}

// Per Vercel, esportiamo l'app express
export default server.app;