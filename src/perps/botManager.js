/**
 * BOT MANAGER (Perps)
 * ===================
 *
 * Gestisce il ciclo di vita di tutti i PerpsBot: creazione, modifica, avvio,
 * arresto, eliminazione. Carica i bot da SQLite all'avvio e riavvia quelli che
 * erano in esecuzione (auto-pilot persistente ai riavvii del server).
 */

import crypto from 'crypto';
import { PerpsBot } from './bot.js';
import db from '../db/database.js';
import logger from '../utils/logger.js';

class BotManager {
  constructor() {
    this.bots = new Map(); // id -> PerpsBot
    this.io = null;
  }

  setIo(io) {
    this.io = io;
  }

  _onUpdate = (state) => {
    if (this.io) this.io.emit('perps:botUpdate', state);
  };

  /** Carica i bot dal DB e riavvia quelli che risultavano in esecuzione. */
  loadFromDb() {
    const rows = db.listBots();
    for (const row of rows) {
      const bot = new PerpsBot(row, this._onUpdate);
      this.bots.set(bot.id, bot);
      if (row.status === 'running') {
        bot.start();
      }
    }
    logger.info(`🤖 Bot Perps caricati: ${rows.length} (${rows.filter(r => r.status === 'running').length} attivi)`);
  }

  createBot({ name, coin, network, masterAddress, config }) {
    if (!name || !coin || !masterAddress) {
      throw new Error('name, coin e masterAddress sono obbligatori');
    }
    const id = crypto.randomUUID();
    const record = {
      id, name, coin, network: network || 'testnet',
      masterAddress, config: config || {}, status: 'stopped'
    };
    db.insertBot(record);
    const bot = new PerpsBot(db.getBot(id), this._onUpdate);
    this.bots.set(id, bot);
    logger.info(`➕ Bot creato: ${name} (${coin})`, { id });
    return bot.getState();
  }

  updateBot(id, { name, coin, config }) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error('Bot non trovato');
    const wasRunning = bot.status === 'running';
    if (wasRunning) bot.stop();

    db.updateBot(id, { name, coin, config });
    const fresh = new PerpsBot(db.getBot(id), this._onUpdate);
    this.bots.set(id, fresh);
    if (wasRunning) fresh.start();
    return fresh.getState();
  }

  deleteBot(id) {
    const bot = this.bots.get(id);
    if (bot) bot.stop();
    db.deleteBot(id);
    this.bots.delete(id);
    logger.info(`🗑️  Bot eliminato`, { id });
  }

  startBot(id) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error('Bot non trovato');
    bot.start();
    return bot.getState();
  }

  stopBot(id) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error('Bot non trovato');
    bot.stop();
    return bot.getState();
  }

  getBotState(id) {
    const bot = this.bots.get(id);
    return bot ? bot.getState() : null;
  }

  /** Diagnostica live di un bot (cosa sta valutando in questo momento). */
  async getMonitor(id) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error('Bot non trovato');
    return bot.getMonitor();
  }

  listStates() {
    return [...this.bots.values()].map(b => b.getState());
  }

  /** Shutdown del server: ferma i timer senza cambiare lo stato persistito. */
  stopAll() {
    for (const bot of this.bots.values()) bot.shutdown();
  }
}

export default new BotManager();
