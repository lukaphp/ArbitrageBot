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
import { withRetry } from './retry.js';
import logger from '../utils/logger.js';

// QUAL-01 item 5 — retry SOLO per le notifiche urgenti. Un 429 di Telegram (o un
// 5xx, o un socket che cade) faceva perdere la notifica in silenzio: per un
// digest è irrilevante, per "stop loss non piazzabile → chiudo la posizione" no.
// Due tentativi in più con backoff breve: `withRetry` ritenta solo gli errori
// transitori (429 con Retry-After, 5xx, rete) e lascia passare subito un 400
// (chat_id sbagliato, HTML malformato) — ritentarlo sarebbe solo ritardo.
const URGENT_RETRY = { retries: 2, baseMs: 400, maxMs: 3000, label: 'telegram', metric: 'telegram_errors_total' };

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

  /**
   * @param text messaggio (HTML Telegram).
   * @param opts.urgent true per le notifiche che non si possono perdere
   *   (protezione della posizione, limiti di rischio, anomalie di esecuzione):
   *   ritentate sugli errori transitori. Default false = comportamento storico,
   *   un solo tentativo.
   * @returns true se Telegram ha accettato il messaggio.
   */
  async notify(text, { urgent = false } = {}) {
    const { token, chatId, enabled } = this.getConfig();
    if (!enabled || !token || !chatId) return false;
    const send = () => axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML' }, { timeout: 8000 });
    try {
      await (urgent ? withRetry(send, URGENT_RETRY) : send());
      return true;
    } catch (e) {
      // Anche esaurendo i retry non si solleva: una notifica persa non deve
      // interrompere la gestione di una posizione. Ma non è silenziosa, e per le
      // urgenti il log dice esplicitamente che si è perso un messaggio urgente.
      logger.warn(`Telegram: invio ${urgent ? 'URGENTE ' : ''}fallito`, e.response?.data?.description || e.message);
      return false;
    }
  }
}

export default new Notifier();
