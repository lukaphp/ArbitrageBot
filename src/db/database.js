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

      CREATE INDEX IF NOT EXISTS idx_positions_bot ON positions(bot_id);
      CREATE INDEX IF NOT EXISTS idx_trades_bot ON trades(bot_id);
    `);
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
    const allowed = ['tp_px', 'sl_px', 'trailing_json', 'status', 'pnl', 'closed_at', 'entry_px', 'size'];
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

  /** Statistiche reali di un bot dai trade chiusi (posizioni status='closed'). */
  getBotStats(botId) {
    this.ensure();
    const rows = this.db.prepare(
      `SELECT pnl FROM positions WHERE bot_id = ? AND status = 'closed'`
    ).all(botId);
    const n = rows.length;
    const wins = rows.filter(r => (r.pnl || 0) > 0);
    const grossWin = wins.reduce((s, r) => s + r.pnl, 0);
    const grossLoss = Math.abs(rows.filter(r => (r.pnl || 0) < 0).reduce((s, r) => s + r.pnl, 0));
    const totalPnl = rows.reduce((s, r) => s + (r.pnl || 0), 0);
    return {
      trades: n,
      wins: wins.length,
      winRate: n ? wins.length / n : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      totalPnl,
      avgPnl: n ? totalPnl / n : 0
    };
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
}

export default new PerpsDatabase();
