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

export class PerpsDatabase {
  constructor({ dbPath = null } = {}) {
    this.db = null;
    this.dbPath = dbPath;
  }

  /**
   * Inizializza la connessione e crea lo schema se assente.
   */
  init() {
    if (this.db) return this.db;

    const dbPath = this.dbPath || path.join(__dirname, '../../data/perps.db');
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();

    logger.info('🗄️  Database Perps inizializzato', { path: dbPath });
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

      -- Storico qualità modelli ML nel tempo (per tracciare il decadimento).
      CREATE TABLE IF NOT EXISTS ml_history (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        coin      TEXT NOT NULL,
        interval  TEXT NOT NULL,
        accuracy  REAL,
        baseline  REAL,
        edge      REAL,
        auc       REAL,
        samples   INTEGER
      );

      -- Curva equity Perps per account/rete, usata dal Risk & Alerts cockpit.
      CREATE TABLE IF NOT EXISTS risk_equity_history (
        network  TEXT NOT NULL,
        address  TEXT NOT NULL,
        ts       INTEGER NOT NULL,
        equity   REAL NOT NULL,
        PRIMARY KEY (network, address, ts)
      );

      -- Ultimo stato drawdown derivato dalla curva persistita.
      CREATE TABLE IF NOT EXISTS risk_drawdown_state (
        network              TEXT NOT NULL,
        address              TEXT NOT NULL,
        peak_equity          REAL,
        current_equity       REAL,
        max_drawdown_usd     REAL NOT NULL DEFAULT 0,
        max_drawdown_pct     REAL NOT NULL DEFAULT 0,
        current_drawdown_usd REAL NOT NULL DEFAULT 0,
        current_drawdown_pct REAL NOT NULL DEFAULT 0,
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY (network, address)
      );

      -- ADV-02 — Sessioni del consulente AI conversazionale. Tabelle proprie e
      -- non settings (che è un key-value per flag, non un archivio): un
      -- transcript è anche traccia di AUDIT — "cosa mi ha detto prima che
      -- aprissi quella posizione" — e deve sopravvivere ai riavvii del
      -- container. Nessuna cifratura a riposo: è la stessa classe di dato di
      -- trades/positions, in chiaro per scelta dichiarata (DEPLOY.md §2.2);
      -- cifrarlo darebbe una falsa impressione di protezione senza cambiare il
      -- modello di minaccia (spike §5.2).
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id         TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_at    INTEGER NOT NULL,
        title      TEXT,
        cost_usd   REAL NOT NULL DEFAULT 0,
        tokens_in  INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        summary    TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT,
        tool_name  TEXT,
        tokens     INTEGER,
        cost_usd   REAL
      );

      CREATE INDEX IF NOT EXISTS idx_positions_bot ON positions(bot_id);
      CREATE INDEX IF NOT EXISTS idx_trades_bot ON trades(bot_id);
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
      CREATE INDEX IF NOT EXISTS idx_risk_equity_scope_ts ON risk_equity_history(network, address, ts);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_ts ON chat_messages(ts);
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_last ON chat_sessions(last_at);
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

  /** Chiude la connessione, utile per shutdown controllato e test isolati. */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
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

  /**
   * SEC-08: inserisce una posizione SOLO se non esiste già una riga `open` per
   * lo stesso `bot_id`+`coin`, altrimenti restituisce quella esistente.
   *
   * Su Hyperliquid un account ha al massimo UNA posizione per coin: due righe
   * `open` per lo stesso bot+coin non sono uno stato legittimo, sono un
   * duplicato. Il controllo vive qui — e non nel chiamante — perché
   * better-sqlite3 è sincrono: SELECT e INSERT stanno nello stesso blocco senza
   * `await` in mezzo, quindi nessun altro tick (o un'altra istanza di PerpsBot
   * dello stesso bot, vedi botManager.updateBot) può infilarsi tra i due e
   * creare la seconda riga. Fatto nel chiamante con un `await` in mezzo, la
   * finestra si riaprirebbe.
   *
   * @returns { id, created, row } — `created:false` + `row` se ne esisteva già una.
   */
  insertPositionIfNoneOpen(pos) {
    this.ensure();
    const existing = this.getOpenPositionByBotCoin(pos.botId, pos.coin);
    if (existing) return { id: existing.id, created: false, row: existing };
    return { id: this.insertPosition(pos), created: true, row: null };
  }

  updatePosition(id, fields) {
    const allowed = ['tp_px', 'sl_px', 'trailing_json', 'status', 'pnl', 'closed_at', 'entry_px', 'size', 'fee', 'close_reason', 'opened_at'];
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

  getPosition(id) {
    if (id == null) return undefined;
    return this.db.prepare(`SELECT * FROM positions WHERE id = ?`).get(id);
  }

  getOpenPositionByBot(botId) {
    return this.db.prepare(
      `SELECT * FROM positions WHERE bot_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`
    ).get(botId);
  }

  /**
   * SEC-08: posizione aperta per bot_id + coin. Un bot è legato a un solo
   * mercato, quindi in pratica coincide con getOpenPositionByBot; il filtro
   * esplicito sulla coin serve perché la coin di un bot è modificabile
   * (botManager.updateBot), e in quel caso una riga rimasta aperta sul mercato
   * PRECEDENTE non deve far sembrare "già tracciata" una posizione su quello nuovo.
   */
  getOpenPositionByBotCoin(botId, coin) {
    return this.db.prepare(
      `SELECT * FROM positions WHERE bot_id = ? AND coin = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`
    ).get(botId, coin);
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

  /**
   * ANA-01 — bucket del motivo di chiusura.
   *
   * `close_reason` è TESTO LIBERO (lo scrive `bot._registerClose` con la
   * motivazione del momento), non un enum: qualunque breakdown deve passare da
   * una classificazione dichiarata, non da un GROUP BY che sembra preciso e non
   * lo è. I bucket, nell'ordine in cui vengono provati:
   *
   *  - `safety` ← chiusure di sicurezza (SL non garantito, errore di verifica SL).
   *    **Deve restare il primo**: quelle stringhe contengono "SL", e se il match
   *    su stop loss venisse prima un GUASTO verrebbe contato come uno stop
   *    scattato normalmente;
   *  - `tp` / `sl` ← il trigger che si è davvero riempito. Disponibili da quando
   *    `bot._registerClose` confronta l'oid del fill di chiusura con gli oid dei
   *    trigger piazzati (`slOid`/`tpOids`): la distinzione è un fatto letto
   *    dall'exchange, non una deduzione dal segno del PnL;
   *  - `manual_or_external` ← il fill di chiusura non appartiene a nessun trigger
   *    del bot: pulsante del pannello, `/chiuditutto`, kill-switch con
   *    `closePositions`. Il nome dice "manuale **o** esterna" perché quei tre casi
   *    non sono distinguibili tra loro, e fingere che lo siano sarebbe lo stesso
   *    errore che questo lavoro ha appena corretto;
   *  - `strategy` ← uscita per regola della strategia o segnale esterno;
   *  - `trigger_or_external` ← 'chiusa (TP/SL o esterna)', cioè i casi in cui NON
   *    si è potuto stabilire quale ordine abbia chiuso (fill non ancora visibili,
   *    fill senza oid, posizione aperta prima del tracciamento degli oid). Ci
   *    resta anche tutto lo storico chiuso prima di quel fix: **non viene
   *    riclassificato**, perché a posteriori il dato non è ricostruibile e
   *    assegnarlo sarebbe inventarlo;
   *  - `other` ← tutto il resto, comprese le righe chiuse prima della migrazione
   *    v2 (che non hanno `close_reason`).
   *
   * Il conteggio per testo ESATTO resta comunque disponibile
   * (`closeReasonsRaw`): la classificazione aiuta a leggere, non nasconde il dato.
   */
  closeReasonBucket(reason) {
    const text = String(reason || '').toLowerCase();
    if (!text) return 'other';
    if (/sicurezza/.test(text)) return 'safety';
    if (/take profit/.test(text)) return 'tp';
    if (/stop loss/.test(text)) return 'sl';
    if (/manuale o esterna/.test(text)) return 'manual_or_external';
    if (/regola di uscita|segnale esterno/.test(text)) return 'strategy';
    if (/tp\/sl|più trigger|esterna/.test(text)) return 'trigger_or_external';
    return 'other';
  }

  /**
   * ANA-01 — performance storica di un bot, dalle posizioni chiuse.
   *
   * Affianca `getBotStats` (7 numeri) invece di sostituirla: quella alimenta la
   * card del bot e la sua forma è già consumata dalla UI e da `tools.js`.
   *
   * `expectancy` è in USD medi per trade — **la stessa definizione usata da
   * `backtester.js`** (`totalPnl / n`), così un confronto tra il backtest di una
   * strategia e il suo risultato live è un confronto tra numeri omogenei.
   * `expectancyRatio` è invece la forma adimensionale in stile Freqtrade
   * (>1 = profittevole): utile per confrontare bot con size diverse.
   *
   * `avgLoss` è NEGATIVO, come ogni altro PnL del progetto (`pnl`, `totalPnl`,
   * `worstUsd`, `expectancy`): una perdita media che arriva alla UI col segno
   * positivo verrebbe formattata come un guadagno. `avgLossAbs` è lo stesso
   * numero in valore assoluto, per chi lo vuole nelle formule.
   */
  getBotPerformance(botId) {
    this.ensure();
    const rows = this.db.prepare(
      `SELECT pnl, fee, close_reason, closed_at FROM positions
       WHERE bot_id = ? AND status = 'closed' ORDER BY COALESCE(closed_at, opened_at) ASC`
    ).all(botId);

    const n = rows.length;
    const wins = rows.filter(r => (r.pnl || 0) > 0);
    const losses = rows.filter(r => (r.pnl || 0) < 0);
    const grossWin = wins.reduce((s, r) => s + r.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
    const totalPnl = rows.reduce((s, r) => s + (r.pnl || 0), 0);
    const totalFees = rows.reduce((s, r) => s + (r.fee || 0), 0);
    const winRate = n ? wins.length / n : 0;
    const lossRate = n ? losses.length / n : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;

    // Drawdown sulla curva di PnL CUMULATO del bot (non sull'equity dell'account,
    // che mescola tutti i bot e i movimenti di cassa).
    let cum = 0, peak = 0, maxDrawdownUsd = 0;
    for (const r of rows) {
      cum += r.pnl || 0;
      if (cum > peak) peak = cum;
      maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - cum);
    }

    // Due viste dello stesso dato: `closeReasons` sono i CONTEGGI per bucket
    // (la forma dichiarata nel contratto e quella che consuma la UI),
    // `closeReasonDetail` aggiunge vinti/persi/PnL dentro ciascun bucket. Il
    // dettaglio serve perché `trigger_or_external` non distingue TP da SL: sapere
    // quanti di quei trade sono in utile è l'informazione più vicina al vero che i
    // dati attuali permettono.
    const closeReasons = {};
    const closeReasonDetail = {};
    const rawCounts = new Map();
    for (const r of rows) {
      const bucket = this.closeReasonBucket(r.close_reason);
      closeReasons[bucket] = (closeReasons[bucket] || 0) + 1;
      const b = closeReasonDetail[bucket] || (closeReasonDetail[bucket] = { trades: 0, wins: 0, losses: 0, pnl: 0 });
      b.trades++;
      if ((r.pnl || 0) > 0) b.wins++;
      else if ((r.pnl || 0) < 0) b.losses++;
      b.pnl += r.pnl || 0;
      const key = r.close_reason || '(non registrato)';
      const raw = rawCounts.get(key) || { reason: key, trades: 0, pnl: 0 };
      raw.trades++;
      raw.pnl += r.pnl || 0;
      rawCounts.set(key, raw);
    }

    return {
      trades: n,
      wins: wins.length,
      losses: losses.length,
      breakeven: n - wins.length - losses.length,
      winRate,
      expectancy: n ? totalPnl / n : 0,
      expectancyRatio: (lossRate > 0 && avgLoss > 0)
        ? (winRate * avgWin) / (lossRate * avgLoss)
        : (grossWin > 0 ? Infinity : 0),
      avgWin,
      // Negativo perché è una perdita (vedi nota sopra). Il ternario evita il
      // `-0` di `-0`: innocuo in JSON, ma un valore che non è quello che sembra.
      avgLoss: losses.length ? -avgLoss : 0,
      avgLossAbs: avgLoss,
      bestUsd: n ? Math.max(...rows.map(r => r.pnl || 0)) : 0,
      worstUsd: n ? Math.min(...rows.map(r => r.pnl || 0)) : 0,
      totalPnl,
      totalFees,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      maxDrawdownUsd,
      firstClosedAt: rows.length ? (rows[0].closed_at ?? null) : null,
      lastClosedAt: rows.length ? (rows[rows.length - 1].closed_at ?? null) : null,
      closeReasons,
      closeReasonDetail,
      closeReasonsRaw: [...rawCounts.values()].sort((a, b) => b.trades - a.trades)
    };
  }

  /**
   * ANA-01 — serie del PnL CUMULATO nel tempo per un bot (posizioni chiuse).
   * Ordine cronologico crescente: è una curva, e una curva si legge in avanti.
   */
  getBotPnlSeries(botId, limit = 500) {
    this.ensure();
    const keep = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 500)));
    const rows = this.db.prepare(
      `SELECT COALESCE(closed_at, opened_at) AS ts, pnl FROM positions
       WHERE bot_id = ? AND status = 'closed'
       ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT ?`
    ).all(botId, keep).reverse();
    let cum = 0;
    return rows.map(r => {
      cum += r.pnl || 0;
      return { ts: r.ts, pnl: r.pnl || 0, cumulative: cum };
    });
  }

  /**
   * ANA-01 — coppie (coin, interval) presenti in `ml_history`, con quanti
   * campioni ciascuna. Serve per sapere QUALI serie ML esistono senza doverle
   * indovinare: `listMlHistory` richiede coin e interval, e finora nessuno
   * sapeva quali chiedere (motivo per cui la tabella non aveva consumer in UI).
   */
  listMlHistoryScopes() {
    this.ensure();
    return this.db.prepare(
      `SELECT coin, interval, COUNT(*) AS samples, MAX(ts) AS lastAt
       FROM ml_history GROUP BY coin, interval ORDER BY lastAt DESC`
    ).all();
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

  /**
   * Storico fill filtrabile per bot e/o mercato (ADV-01, `get_trade_history`).
   * `listTrades` prende gli ultimi N globali: con più bot attivi il mercato che
   * interessa può non comparire affatto, quindi il filtro va applicato in SQL e
   * non dopo il LIMIT.
   */
  listTradesBy({ botId = null, coin = null, limit = 100 } = {}) {
    this.ensure();
    const where = [];
    const params = [];
    if (botId) { where.push('bot_id = ?'); params.push(botId); }
    if (coin) { where.push('coin = ?'); params.push(coin); }
    params.push(Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100))));
    return this.db.prepare(
      `SELECT * FROM trades ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`
    ).all(...params);
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

  // ---- Storico equity e drawdown Risk & Alerts ----

  _riskScope(network, address) {
    const normalizedNetwork = String(network || '').trim();
    const normalizedAddress = String(address || '').trim().toLowerCase();
    if (!normalizedNetwork || !normalizedAddress) {
      throw new Error('network e address sono richiesti per lo storico rischio');
    }
    return { network: normalizedNetwork, address: normalizedAddress };
  }

  /** Inserisce/aggiorna il campione equity per un account e una rete. */
  insertRiskEquitySample(network, address, time, equity, limit = 180) {
    this.ensure();
    const scope = this._riskScope(network, address);
    const ts = Math.floor(Number(time));
    const value = Number(equity);
    if (!Number.isFinite(ts) || !Number.isFinite(value)) return false;

    this.db.prepare(`
      INSERT INTO risk_equity_history (network, address, ts, equity)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(network, address, ts) DO UPDATE SET equity = excluded.equity
    `).run(scope.network, scope.address, ts, value);

    const keep = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 180)));
    this.db.prepare(`
      DELETE FROM risk_equity_history
      WHERE network = ? AND address = ? AND ts NOT IN (
        SELECT ts FROM risk_equity_history
        WHERE network = ? AND address = ?
        ORDER BY ts DESC LIMIT ?
      )
    `).run(scope.network, scope.address, scope.network, scope.address, keep);
    return true;
  }

  /** Ritorna i campioni più recenti in ordine cronologico per il cockpit. */
  listRiskEquityHistory(network, address, limit = 180) {
    this.ensure();
    const scope = this._riskScope(network, address);
    const keep = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 180)));
    return this.db.prepare(`
      SELECT ts AS time, equity AS value
      FROM risk_equity_history
      WHERE network = ? AND address = ?
      ORDER BY ts DESC LIMIT ?
    `).all(scope.network, scope.address, keep).reverse();
  }

  /** Salva l'ultimo drawdown derivato dalla curva equity persistita. */
  upsertRiskDrawdownState(network, address, drawdown, updatedAt = Date.now()) {
    this.ensure();
    const scope = this._riskScope(network, address);
    const state = {
      peakEquity: drawdown?.peak ?? null,
      currentEquity: drawdown?.current ?? null,
      maxDrawdownUsd: Number(drawdown?.maxUsd) || 0,
      maxDrawdownPct: Number(drawdown?.maxPct) || 0,
      currentDrawdownUsd: Number(drawdown?.currentUsd) || 0,
      currentDrawdownPct: Number(drawdown?.currentPct) || 0,
      updatedAt: Number(updatedAt) || Date.now()
    };
    this.db.prepare(`
      INSERT INTO risk_drawdown_state (
        network, address, peak_equity, current_equity,
        max_drawdown_usd, max_drawdown_pct,
        current_drawdown_usd, current_drawdown_pct, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(network, address) DO UPDATE SET
        peak_equity = excluded.peak_equity,
        current_equity = excluded.current_equity,
        max_drawdown_usd = excluded.max_drawdown_usd,
        max_drawdown_pct = excluded.max_drawdown_pct,
        current_drawdown_usd = excluded.current_drawdown_usd,
        current_drawdown_pct = excluded.current_drawdown_pct,
        updated_at = excluded.updated_at
    `).run(
      scope.network,
      scope.address,
      state.peakEquity,
      state.currentEquity,
      state.maxDrawdownUsd,
      state.maxDrawdownPct,
      state.currentDrawdownUsd,
      state.currentDrawdownPct,
      state.updatedAt
    );
    return state;
  }

  getRiskDrawdownState(network, address) {
    this.ensure();
    const scope = this._riskScope(network, address);
    const row = this.db.prepare(`
      SELECT peak_equity AS peakEquity,
             current_equity AS currentEquity,
             max_drawdown_usd AS maxDrawdownUsd,
             max_drawdown_pct AS maxDrawdownPct,
             current_drawdown_usd AS currentDrawdownUsd,
             current_drawdown_pct AS currentDrawdownPct,
             updated_at AS updatedAt
      FROM risk_drawdown_state
      WHERE network = ? AND address = ?
    `).get(scope.network, scope.address);
    if (!row) return null;
    return {
      ...row,
      scope: 'session'
    };
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

  /**
   * Storico delle strategie decise (approvate/rifiutate/scadute), più recenti prima.
   * Il filtro per stato è applicato in SQL: filtrare dopo il LIMIT farebbe
   * sparire intere categorie quando una sola satura il limite.
   */
  getStrategyHistory({ status, limit = 200 } = {}) {
    this.ensure();
    const where = [`type = 'new_strategy_candidate'`, `status != 'pending'`];
    const params = [];
    if (status) { where.push(`status = ?`); params.push(status); }
    params.push(limit);
    return this.db.prepare(
      `SELECT * FROM proposals WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?`
    ).all(...params);
  }

  /**
   * Strategie rifiutate di recente. Servono all'Analyst come contesto negativo:
   * sapere cosa l'utente ha già scartato evita di riproporlo e di spendere
   * token per idee destinate a essere bocciate di nuovo.
   */
  getRecentRejected(limit = 12) {
    this.ensure();
    return this.db.prepare(
      `SELECT coin, payload_json FROM proposals
       WHERE type = 'new_strategy_candidate' AND status = 'rejected'
       ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?`
    ).all(limit);
  }

  /** Conteggi esatti per stato, indipendenti dal LIMIT applicato alle righe. */
  getStrategyCounts() {
    this.ensure();
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) n FROM proposals
       WHERE type = 'new_strategy_candidate' AND status != 'pending' GROUP BY status`
    ).all();
    const out = { approved: 0, rejected: 0, expired: 0 };
    for (const r of rows) if (out[r.status] !== undefined) out[r.status] = r.n;
    return out;
  }

  /** Elimina una singola proposta. Ritorna true se esisteva. */
  deleteProposal(id) {
    this.ensure();
    return this.db.prepare(`DELETE FROM proposals WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Eliminazione massiva dallo storico strategie. Filtra per stato e/o per lista
   * di id. Non tocca mai le proposte 'pending': quelle si decidono, non si
   * cancellano dallo storico.
   */
  deleteStrategyHistory({ status, ids } = {}) {
    this.ensure();
    const where = [`type = 'new_strategy_candidate'`, `status != 'pending'`];
    const params = [];
    if (status) { where.push(`status = ?`); params.push(status); }
    if (Array.isArray(ids) && ids.length) {
      where.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    return this.db.prepare(`DELETE FROM proposals WHERE ${where.join(' AND ')}`).run(...params).changes;
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

  // ---- Storico qualità ML (decadimento nel tempo) ----

  insertMlHistory({ coin, interval, accuracy, baseline, edge, auc, samples }) {
    this.ensure();
    this.db.prepare(
      `INSERT INTO ml_history (ts, coin, interval, accuracy, baseline, edge, auc, samples)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(Date.now(), coin, interval, accuracy ?? null, baseline ?? null, edge ?? null, auc ?? null, samples ?? null);
  }

  /**
   * Storico qualità ML, più recenti prima.
   *
   * Il tie-break su `id` non è cosmetico: due retraining nello stesso
   * millisecondo darebbero un ordine non specificato, e in una SERIE TEMPORALE
   * un ordine instabile significa una curva che cambia forma tra due letture
   * identiche (trovato invertendo la serie per ANA-01).
   */
  listMlHistory(coin, interval, limit = 100) {
    this.ensure();
    return this.db.prepare(
      `SELECT * FROM ml_history WHERE coin = ? AND interval = ? ORDER BY ts DESC, id DESC LIMIT ?`
    ).all(coin, interval, limit);
  }

  // ---- Chat del consulente AI (ADV-02) ----

  createChatSession({ id, title = null, startedAt = Date.now() }) {
    this.ensure();
    this.db.prepare(`
      INSERT INTO chat_sessions (id, started_at, last_at, title, cost_usd, tokens_in, tokens_out, summary)
      VALUES (?, ?, ?, ?, 0, 0, 0, NULL)
    `).run(id, startedAt, startedAt, title);
    return this.getChatSession(id);
  }

  getChatSession(id) {
    this.ensure();
    return this.db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(id);
  }

  listChatSessions(limit = 50) {
    this.ensure();
    return this.db.prepare(`SELECT * FROM chat_sessions ORDER BY last_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(500, Math.floor(Number(limit) || 50))));
  }

  /** Titolo e riassunto rotante: si aggiornano, non si accumulano. */
  updateChatSession(id, { title, summary, lastAt } = {}) {
    this.ensure();
    const existing = this.getChatSession(id);
    if (!existing) return null;
    this.db.prepare(`UPDATE chat_sessions SET title = ?, summary = ?, last_at = ? WHERE id = ?`).run(
      title === undefined ? existing.title : title,
      summary === undefined ? existing.summary : summary,
      lastAt === undefined ? existing.last_at : lastAt,
      id
    );
    return this.getChatSession(id);
  }

  /**
   * Contabilità di sessione: si ACCUMULA (un turno alla volta), non si sovrascrive.
   * Fatto in SQL con `cost_usd = cost_usd + ?` e non leggendo-modificando-scrivendo
   * dal chiamante: better-sqlite3 è sincrono, così l'incremento resta atomico.
   */
  addChatSessionUsage(id, { costUsd = 0, tokensIn = 0, tokensOut = 0, lastAt = Date.now() } = {}) {
    this.ensure();
    this.db.prepare(`
      UPDATE chat_sessions
      SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, last_at = ?
      WHERE id = ?
    `).run(Number(costUsd) || 0, Math.round(Number(tokensIn) || 0), Math.round(Number(tokensOut) || 0), lastAt, id);
    return this.getChatSession(id);
  }

  insertChatMessage({ sessionId, role, content, toolName = null, tokens = null, costUsd = null, ts = Date.now() }) {
    this.ensure();
    const info = this.db.prepare(`
      INSERT INTO chat_messages (session_id, ts, role, content, tool_name, tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, ts, role, content ?? null, toolName, tokens, costUsd);
    return info.lastInsertRowid;
  }

  /** Messaggi in ordine cronologico (è così che si ricostruisce una conversazione). */
  listChatMessages(sessionId, limit = 500) {
    this.ensure();
    return this.db.prepare(`SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT ?`)
      .all(sessionId, Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500))));
  }

  /** Ultimi N messaggi in ordine cronologico (finestra scorrevole della chat). */
  listRecentChatMessages(sessionId, limit = 60) {
    this.ensure();
    return this.db.prepare(`SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sessionId, Math.max(1, Math.min(2000, Math.floor(Number(limit) || 60)))).reverse();
  }

  countChatMessages(sessionId) {
    this.ensure();
    return this.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`).get(sessionId).n;
  }

  /**
   * Elimina una conversazione con tutti i suoi messaggi. Stesso stile
   * dell'eliminazione massiva dello storico strategie (Sprint 2): messaggi prima,
   * sessione dopo, e ritorna quante righe sono state toccate — un'eliminazione
   * che non dice cosa ha eliminato non è verificabile.
   */
  deleteChatSession(id) {
    this.ensure();
    const messages = this.db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(id).changes;
    const sessions = this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id).changes;
    return { deleted: sessions > 0, sessions, messages };
  }

  /**
   * Retention: elimina le conversazioni non toccate da più di `days` giorni.
   * Il criterio è `last_at`, non `started_at`: una conversazione ripresa dopo tre
   * mesi è ancora viva e non va cancellata sotto il naso dell'utente.
   */
  purgeOldChatSessions(days = 90, now = Date.now()) {
    this.ensure();
    const cutoff = now - Math.max(1, Number(days) || 90) * 86400000;
    const ids = this.db.prepare(`SELECT id FROM chat_sessions WHERE last_at < ?`).all(cutoff).map(r => r.id);
    if (!ids.length) return { sessions: 0, messages: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const messages = this.db.prepare(`DELETE FROM chat_messages WHERE session_id IN (${placeholders})`).run(...ids).changes;
    const sessions = this.db.prepare(`DELETE FROM chat_sessions WHERE id IN (${placeholders})`).run(...ids).changes;
    return { sessions, messages, ids };
  }

  /**
   * Speso dal consulente da un istante in poi (ADV-03: mese corrente).
   *
   * Somma i `chat_messages.cost_usd` e non i `chat_sessions.cost_usd`: una
   * conversazione iniziata il 30 e continuata il 2 addebiterebbe al mese
   * sbagliato tutto il suo costo. Include anche le sessioni poi ELIMINATE? No —
   * ed è una scelta dichiarata: cancellare una conversazione non deve poter
   * azzerare il budget speso, quindi il totale mensile viene tenuto anche in un
   * contatore cumulativo in `settings` (vedi advisor.js), e qui si legge il
   * massimo tra i due.
   */
  getAdvisorSpend(sinceTs) {
    this.ensure();
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS turns
       FROM chat_messages WHERE ts >= ? AND cost_usd IS NOT NULL`
    ).get(Math.floor(Number(sinceTs) || 0));
    return { spentUsd: row.total || 0, turns: row.turns || 0 };
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
