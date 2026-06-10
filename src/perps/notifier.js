/**
 * NOTIFIER (Telegram)
 * ===================
 *
 * Invia notifiche su entrate/uscite/errori/limiti dei bot via Telegram.
 * Token e chat id sono configurabili da UI (persistiti in `settings`) o da
 * variabili d'ambiente (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).
 */

import axios from 'axios';
import db from '../db/database.js';
import secretBox from './secretBox.js';
import logger from '../utils/logger.js';

class Notifier {
  getConfig() {
    let cfg = {};
    try { cfg = JSON.parse(db.getSetting('telegram_config') || '{}'); } catch { /* noop */ }
    // Token cifrato a riposo (tokenEnc). Retrocompat: vecchio `token` in chiaro.
    let token = '';
    if (cfg.tokenEnc) {
      try { token = secretBox.decrypt(cfg.tokenEnc); } catch { token = ''; }
    } else if (cfg.token) {
      token = cfg.token; // legacy plaintext
    }
    token = token || process.env.TELEGRAM_BOT_TOKEN || '';
    const chatId = cfg.chatId || process.env.TELEGRAM_CHAT_ID || '';
    const enabled = cfg.enabled !== undefined ? cfg.enabled : !!(token && chatId);
    return { token, chatId, enabled };
  }

  setConfig({ token, chatId, enabled }) {
    const cur = this.getConfig();
    const merged = {
      token: token !== undefined ? token : cur.token,
      chatId: chatId !== undefined ? chatId : cur.chatId,
      enabled: enabled !== undefined ? enabled : cur.enabled
    };
    // Persisti il token SEMPRE cifrato (mai in chiaro nel DB).
    const toStore = {
      tokenEnc: merged.token ? secretBox.encrypt(merged.token) : '',
      chatId: merged.chatId,
      enabled: merged.enabled
    };
    db.setSetting('telegram_config', JSON.stringify(toStore));
    return { ...merged, configured: !!(merged.token && merged.chatId) };
  }

  status() {
    const { token, chatId, enabled } = this.getConfig();
    return { configured: !!(token && chatId), enabled };
  }

  async notify(text) {
    const { token, chatId, enabled } = this.getConfig();
    if (!enabled || !token || !chatId) return false;
    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
        { chat_id: chatId, text, parse_mode: 'HTML' }, { timeout: 8000 });
      return true;
    } catch (e) {
      logger.warn('Telegram: invio fallito', e.response?.data?.description || e.message);
      return false;
    }
  }
}

export default new Notifier();
