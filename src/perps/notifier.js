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
import logger from '../utils/logger.js';

class Notifier {
  getConfig() {
    let cfg = {};
    try { cfg = JSON.parse(db.getSetting('telegram_config') || '{}'); } catch { /* noop */ }
    const token = cfg.token || process.env.TELEGRAM_BOT_TOKEN || '';
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
    db.setSetting('telegram_config', JSON.stringify(merged));
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
