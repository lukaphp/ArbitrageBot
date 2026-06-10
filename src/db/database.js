/**
 * PERSISTENZA SQLITE (Perps)
 * ==========================
 *
 * Storage locale per il sottosistema di trading Perps:
 * - agent_wallets : chiave agent cifrata per (master_address, network)
 * - bots          : configurazione e stato di ogni bot
 * - positions     : posizioni aperte/chiuse tracciate dai bot
 * - trades        : storico fill/ordini
 * - settings       : impostazioni runtime (es. rete attiva)
 *
 * Usa better-sqlite3 (API sincrona). Il file vive in data/perps.db.
 * Sopravvive ai riavvii del server: indispensabile per i bot autonomi 24/7.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PerpsDatabase {
  constructor() {
    this.db = null;
  }

  /**
   * Inizializza la connessione e crea lo schema se assente.
   */
  init() {
    if (this.db) return this.db;

    const dataDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, 'perps.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();

    logger.info('🗄️  Database Perps inizializzato', { path: 'data/perps.db' });
    return this.db;
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_wallets (
        master_address TEXT NOT NULL,
        network        TEXT NOT NULL,
        agent_address  TEXT NOT NULL,
        encrypted_key  TEXT NOT NULL,
        agent_name     TEXT,
        approved_at    INTEGER,
        PRIMARY KEY (master_address, network)
      );

      CREATE TABLE IF NOT EXISTS bots (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        coin           TEXT NOT NULL,
        network        TEXT NOT NULL,
        master_address TEXT NOT NULL,
        config_json    TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'stopped',
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id        TEXT,
        coin          TEXT NOT NULL,
        side          TEXT NOT NULL,
        size          REAL NOT NULL,
        entry_px      REAL,
        leverage      REAL,
        tp_px         REAL,
        sl_px         REAL,
        trailing_json TEXT,
        status        TEXT NOT NULL DEFAULT 'open',
        pnl           REAL DEFAULT 0,
        opened_at     INTEGER NOT NULL,
        closed_at     INTEGER
      );

      CREATE TABLE IF NOT EXISTS trades (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id  TEXT,
        coin    TEXT NOT NULL,
        side    TEXT NOT NULL,
        px      REAL,
        sz      REAL,
        fee     REAL DEFAULT 0,
        hl_oid  INTEGER,
        ts      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      -- Proposte dell'Analyst AI (advisory): mai eseguite senza approvazione.
      CREATE TABLE IF NOT EXISTS proposals (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        coin          TEXT,
        payload_json  TEXT NOT NULL,
        rationale     TEXT,
        confidence    REAL,
        backtest_json TEXT,
        source        TEXT DEFAULT 'analyst',
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    INTEGER NOT NULL,
        decided_at    INTEGER,
        expires_at    INTEGER
      );

      -- Audit trail: ogni proposta/decisione/esecuzione degli agenti.
      CREATE TABLE IF NOT EXISTS audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        actor       TEXT NOT NULL,
        action      TEXT NOT NULL,
        detail_json TEXT
      );

      -- Idempotenza persistita delle azioni eseguite (sopravvive ai riavvii).
      CREATE TABLE IF NOT EXISTS executed_actions (
        action_id   TEXT PRIMARY KEY,
        executed_at INTEGER NOT NULL,
        result_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_positions_bot ON positions(bot_id);
      CREATE INDEX IF NOT EXISTS idx_trades_bot ON trades(bot_id);
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
    `);
    this._migrate();
  }

  /** Aggiunge una colonna se mancante (idempotente). */
  _addColumn(table, name, type) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }

  /**
   * Migrazioni VERSIONATE e idempotenti. Ogni voce dell'array è applicata in
   * ordine una sola volta; `schema_version` traccia fino a dove siamo arrivati.
   * Le singole migrazioni restano idempotenti (usano _addColumn) così sono
   * sicure anche su DB preesistenti senza schema_version.
   */
  _migrations() {
    return [
      // v1 — tracciamento modello/costo AI sulle proposte
      () => {
        this._addColumn('proposals', 'linked_bot_id', 'TEXT');
        this._addColumn('proposals', 'model', 'TEXT');
        this._addColumn('proposals', 'cost_usd', 'REAL');
        this._addColumn('proposals', 'tokens_in', 'INTEGER');
        this._addColumn('proposals', 'tokens_out', 'INTEGER');
      },
      // v2 — PnL reale netto fee + motivo chiusura sulle posizioni
      () => {
        this._addColumn('positions', 'fee', 'REAL DEFAULT 0');
        this._addColumn('positions', 'close_reason', 'TEXT');
      }
    ];
  }

  _migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    let row = this.db.prepare(`SELECT version FROM schema_version LIMIT 1`).get();
    if (!row) {
      this.db.prepare(`INSERT INTO schema_version (version) VALUES (0)`).run();
      row = { version: 0 };
    }
    const migrations = this._migrations();
    const apply = this.db.transaction((from) => {
      for (let v = from; v < migrations.length; v++) migrations[v]();
      this.db.prepare(`UPDATE schema_version SET version = ?`).run(migrations.length);
    });
    if (row.version < migrations.length) {
      apply(row.version);
      logger.info(`🗄️  Schema DB migrato: v${row.version} → v${migrations.length}`);
    }
  }

  /** Garantisce che la connessione sia aperta (auto-init lazy). */
  ensure() {
    if (!this.db) this.init();
    return this.db;
  }

  // ---- Agent wallets ----

  upsertAgent({ masterAddress, network, agentAddress, encryptedKey, agentName }) {
    this.ensure();
    this.db.prepare(`
      INSERT INTO agent_wallets (master_address, network, agent_address, encrypted_key, agent_name, approved_at)
      VALUES (@masterAddress, @network, @agentAddress, @encryptedKey, @agentName, @approvedAt)
      ON CONFLICT(master_address, network) DO UPDATE SET
        agent_address = excluded.agent_address,
        encrypted_key = excluded.encrypted_key,
        agent_name    = excluded.agent_name,
        approved_at   = excluded.approved_at
    `).run({
      masterAddress: masterAddress.toLowerCase(),
      network,
      agentAddress: agentAddress.toLowerCase(),
      encryptedKey,
      agentName: agentName || null,
      approvedAt: Date.now()
    });
  }

  getAgent(masterAddress, network) {
    this.ensure();
    return this.db.prepare(
      `SELECT * FROM agent_wallets WHERE master_address = ? AND network = ?`
    ).get(masterAddress.toLowerCase(), network);
  }

  // ---- Bots ----

  insertBot(bot) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO bots (id, name, coin, network, master_address, config_json, status, created_at, updated_at)
      VALUES (@id, @name, @coin, @network, @masterAddress, @configJson, @status, @createdAt, @updatedAt)
    `).run({
      id: bot.id,
      name: bot.name,
      coin: bot.coin,
      network: bot.network,
      masterAddress: bot.masterAddress.toLowerCase(),
      configJson: JSON.stringify(bot.config),
      status: bot.status || 'stopped',
      createdAt: now,
      updatedAt: now
    });
  }

  updateBot(id, { config, status, name, coin }) {
    const existing = this.getBot(id);
    if (!existing) return null;
    this.db.prepare(`
      UPDATE bots SET
        name = @name,
        coin = @coin,
        config_json = @configJson,
        status = @status,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      name: name ?? existing.name,
      coin: coin ?? existing.coin,
      configJson: JSON.stringify(config ?? JSON.parse(existing.config_json)),
      status: status ?? existing.status,
      updatedAt: Date.now()
    });
    return this.getBot(id);
  }

  setBotStatus(id, status) {
    this.db.prepare(`UPDATE bots SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  getBot(id) {
    return this.db.prepare(`SELECT * FROM bots WHERE id = ?`).get(id);
  }

  listBots() {
    return this.db.prepare(`SELECT * FROM bots ORDER BY created_at DESC`).all();
  }

  deleteBot(id) {
    this.db.prepare(`DELETE FROM bots WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM positions WHERE bot_id = ?`).run(id);
  }

  // ---- Positions ----

  insertPosition(pos) {
    const info = this.db.prepare(`
      INSERT INTO positions (bot_id, coin, side, size, entry_px, leverage, tp_px, sl_px, trailing_json, status, pnl, opened_at)
      VALUES (@botId, @coin, @side, @size, @entryPx, @leverage, @tpPx, @slPx, @trailingJson, 'open', 0, @openedAt)
    `).run({
      botId: pos.botId || null,
      coin: pos.coin,
      side: pos.side,
      size: pos.size,
      entryPx: pos.entryPx || null,
      leverage: pos.leverage || null,
      tpPx: pos.tpPx || null,
      slPx: pos.slPx || null,
      trailingJson: pos.trailing ? JSON.stringify(pos.trailing) : null,
      openedAt: Date.now()
    });
    return info.lastInsertRowid;
  }

  updatePosition(id, fields) {
    const allowed = ['tp_px', 'sl_px', 'trailing_json', 'status', 'pnl', 'closed_at', 'entry_px', 'size', 'fee', 'close_reason'];
    const sets = [];
    const params = { id };
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = @${key}`);
        params[key] = val;
      }
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE positions SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  getOpenPositionByBot(botId) {
    return this.db.prepare(
      `SELECT * FROM positions WHERE bot_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`
    ).get(botId);
  }

  listPositions(limit = 100) {
    return this.db.prepare(`SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?`).all(limit);
  }

  /**
   * Statistiche reali di un bot dalle posizioni chiuse. Il campo `pnl` è già
   * NETTO delle fee (vedi bot._registerClose), quindi win-rate/PF/expectancy
   * riflettono il risultato effettivo. `totalFees` è esposto per trasparenza.
   */
  getBotStats(botId) {
    this.ensure();
    const rows = this.db.prepare(
      `SELECT pnl, fee FROM positions WHERE bot_id = ? AND status = 'closed'`
    ).all(botId);
    const n = rows.length;
    const wins = rows.filter(r => (r.pnl || 0) > 0);
    const grossWin = wins.reduce((s, r) => s + r.pnl, 0);
    const grossLoss = Math.abs(rows.filter(r => (r.pnl || 0) < 0).reduce((s, r) => s + r.pnl, 0));
    const totalPnl = rows.reduce((s, r) => s + (r.pnl || 0), 0);
    const totalFees = rows.reduce((s, r) => s + (r.fee || 0), 0);
    return {
      trades: n,
      wins: wins.length,
      winRate: n ? wins.length / n : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      totalPnl,
      totalFees,
      avgPnl: n ? totalPnl / n : 0
    };
  }

  /** Timestamp (ms) dell'ultima posizione chiusa di un bot, o null. */
  lastClosedAt(botId) {
    this.ensure();
    const row = this.db.prepare(
      `SELECT closed_at FROM positions WHERE bot_id = ? AND status = 'closed' AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1`
    ).get(botId);
    return row ? row.closed_at : null;
  }

  /** Conta le perdite consecutive più recenti di un bot. */
  getConsecutiveLosses(botId) {
    this.ensure();
    const rows = this.db.prepare(
      `SELECT pnl FROM positions WHERE bot_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 20`
    ).all(botId);
    let count = 0;
    for (const r of rows) {
      if ((r.pnl || 0) < 0) count++;
      else break;
    }
    return count;
  }

  // ---- Trades ----

  insertTrade(trade) {
    this.db.prepare(`
      INSERT INTO trades (bot_id, coin, side, px, sz, fee, hl_oid, ts)
      VALUES (@botId, @coin, @side, @px, @sz, @fee, @hlOid, @ts)
    `).run({
      botId: trade.botId || null,
      coin: trade.coin,
      side: trade.side,
      px: trade.px || null,
      sz: trade.sz || null,
      fee: trade.fee || 0,
      hlOid: trade.hlOid || null,
      ts: Date.now()
    });
  }

  listTrades(limit = 100) {
    return this.db.prepare(`SELECT * FROM trades ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  // ---- Settings ----

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  getSetting(key, fallback = null) {
    this.ensure();
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    return row ? row.value : fallback;
  }

  // ---- Proposte (Analyst AI) ----

  insertProposal(p) {
    this.ensure();
    this.db.prepare(`
      INSERT INTO proposals (id, type, coin, payload_json, rationale, confidence, backtest_json, source, status, created_at, expires_at, model, cost_usd, tokens_in, tokens_out)
      VALUES (@id, @type, @coin, @payloadJson, @rationale, @confidence, @backtestJson, @source, 'pending', @createdAt, @expiresAt, @model, @costUsd, @tokensIn, @tokensOut)
    `).run({
      id: p.id,
      type: p.type,
      coin: p.coin || null,
      payloadJson: JSON.stringify(p.payload || {}),
      rationale: p.rationale || null,
      confidence: p.confidence ?? null,
      backtestJson: p.backtest ? JSON.stringify(p.backtest) : null,
      source: p.source || 'analyst',
      createdAt: Date.now(),
      expiresAt: p.expiresAt || null,
      model: p.model || null,
      costUsd: p.costUsd ?? null,
      tokensIn: p.tokensIn ?? null,
      tokensOut: p.tokensOut ?? null
    });
    return this.getProposal(p.id);
  }

  /** Costo totale stimato delle proposte AI (somma di cost_usd). */
  getAnalystCostTotal() {
    this.ensure();
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS runs FROM proposals WHERE cost_usd IS NOT NULL`).get();
    return { total: row.total || 0, proposals: row.runs || 0 };
  }

  getProposal(id) {
    this.ensure();
    return this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id);
  }

  listProposals({ status, limit = 50 } = {}) {
    this.ensure();
    if (status) {
      return this.db.prepare(`SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit);
    }
    return this.db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?`).all(limit);
  }

  setProposalStatus(id, status) {
    this.ensure();
    this.db.prepare(`UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
    return this.getProposal(id);
  }

  /** Collega un bot creato a una proposta (per seguirne l'esito nel tempo). */
  linkProposalBot(id, botId) {
    this.ensure();
    this.db.prepare(`UPDATE proposals SET linked_bot_id = ? WHERE id = ?`).run(botId, id);
    return this.getProposal(id);
  }

  /** Storico delle strategie decise (approvate/rifiutate/scadute), più recenti prima. */
  getStrategyHistory(limit = 50) {
    this.ensure();
    return this.db.prepare(
      `SELECT * FROM proposals WHERE type = 'new_strategy_candidate' AND status != 'pending'
       ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?`
    ).all(limit);
  }

  /** Marca come 'expired' le proposte pendenti scadute. Ritorna il numero aggiornato. */
  expireStaleProposals(now = Date.now()) {
    this.ensure();
    const info = this.db.prepare(
      `UPDATE proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`
    ).run(now, now);
    return info.changes;
  }

  // ---- Audit ----

  insertAudit(actor, action, detail) {
    this.ensure();
    this.db.prepare(`INSERT INTO audit (ts, actor, action, detail_json) VALUES (?, ?, ?, ?)`)
      .run(Date.now(), actor, action, detail ? JSON.stringify(detail) : null);
  }

  listAudit(limit = 100) {
    this.ensure();
    return this.db.prepare(`SELECT * FROM audit ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  // ---- Idempotenza azioni eseguite (persistita) ----

  /** True se l'azione con questo id è già stata eseguita (anche prima di un riavvio). */
  wasActionExecuted(actionId) {
    if (!actionId) return false;
    this.ensure();
    return !!this.db.prepare(`SELECT 1 FROM executed_actions WHERE action_id = ?`).get(actionId);
  }

  /** Registra l'azione come eseguita. Idempotente (INSERT OR IGNORE). */
  markActionExecuted(actionId, result = null) {
    if (!actionId) return;
    this.ensure();
    this.db.prepare(
      `INSERT OR IGNORE INTO executed_actions (action_id, executed_at, result_json) VALUES (?, ?, ?)`
    ).run(actionId, Date.now(), result ? JSON.stringify(result).slice(0, 2000) : null);
  }

  /** Rimuove la marcatura (per consentire un retry dopo un errore di esecuzione). */
  unmarkActionExecuted(actionId) {
    if (!actionId) return;
    this.ensure();
    this.db.prepare(`DELETE FROM executed_actions WHERE action_id = ?`).run(actionId);
  }

  // ---- PnL giornaliero persistito (per-bot, per-giorno) ----

  _dailyKey(botId, day) { return `daily_pnl_${botId}_${day}`; }

  /** PnL giornaliero persistito del bot per il giorno indicato (YYYY-MM-DD). */
  getDailyPnl(botId, day) {
    this.ensure();
    const v = this.getSetting(this._dailyKey(botId, day), null);
    return v == null ? 0 : (parseFloat(v) || 0);
  }

  /** Salva il PnL giornaliero del bot (sopravvive ai riavvii). */
  setDailyPnl(botId, day, value) {
    this.ensure();
    this.setSetting(this._dailyKey(botId, day), Number(value).toFixed(6));
  }
}

export default new PerpsDatabase();
