/**
 * TELEGRAM CONTROL (comandi bidirezionali)
 * ========================================
 *
 * Estende le notifiche in uscita con il CONTROLLO REMOTO via Telegram, in stile
 * Freqtrade: long-polling di `getUpdates` e dispatch dei comandi sui bot e
 * sull'account Hyperliquid.
 *
 * Modulo separato dal notifier (che resta solo invio) per evitare cicli di
 * import: qui importiamo botManager + client. Avviato da server.js dopo il load
 * dei bot, e (ri)avviato quando la configurazione Telegram cambia.
 *
 * 🔒 SICUREZZA: risponde SOLO al chatId configurato. I comandi distruttivi
 * (chiusura posizioni) confermano l'esito via messaggio.
 */

import axios from 'axios';
import botManager from './botManager.js';
import client from './hyperliquidClient.js';
import notifier from './notifier.js';
import proposals from '../agents/proposals.js';
import logger from '../utils/logger.js';

const HELP = [
  '🤖 <b>Comandi disponibili</b>',
  '/status — stato generale (rete, bot attivi, equity)',
  '/saldo — saldo e margine dell\'account',
  '/posizioni — posizioni aperte con PnL',
  '/bot — elenco bot con stato e win-rate',
  '/avvia &lt;id|nome&gt; — avvia un bot',
  '/ferma &lt;id|nome&gt; — ferma un bot',
  '/chiuditutto — chiude tutte le posizioni aperte',
  '/proposte — proposte AI in attesa',
  '/approva &lt;id&gt; — approva una proposta AI',
  '/rifiuta &lt;id&gt; — rifiuta una proposta AI',
  '/help — questo messaggio'
].join('\n');

class TelegramControl {
  constructor() {
    this.offset = 0;
    this.running = false;
    this.token = null;
    this.chatId = null;
    this._aborter = null;
  }

  /** Indirizzo master e rete dedotti dai bot esistenti (fallback ENV). */
  _context() {
    const bots = [...botManager.bots.values()];
    return {
      masterAddress: bots[0]?.masterAddress || process.env.WALLET_ADDRESS || null,
      network: bots[0]?.network || client.network
    };
  }

  status() {
    return { running: this.running, configured: !!(this.token && this.chatId) };
  }

  /** Avvia/riavvia il polling in base alla config Telegram corrente. */
  refresh() {
    const cfg = notifier.getConfig();
    const shouldRun = cfg.enabled && cfg.token && cfg.chatId;
    if (shouldRun && (!this.running || this.token !== cfg.token || this.chatId !== cfg.chatId)) {
      this.stop();
      this.token = cfg.token;
      this.chatId = String(cfg.chatId);
      this.running = true;
      logger.info('📡 Telegram control: polling avviato');
      this._loop();
    } else if (!shouldRun && this.running) {
      this.stop();
    }
  }

  stop() {
    this.running = false;
    if (this._aborter) { try { this._aborter.abort(); } catch { /* noop */ } this._aborter = null; }
  }

  async _loop() {
    while (this.running) {
      try {
        this._aborter = new AbortController();
        const res = await axios.get(`https://api.telegram.org/bot${this.token}/getUpdates`, {
          params: { offset: this.offset, timeout: 25 },
          timeout: 30000,
          signal: this._aborter.signal
        });
        for (const upd of res.data.result || []) {
          this.offset = upd.update_id + 1;
          const msg = upd.message;
          if (!msg || !msg.text) continue;
          if (String(msg.chat.id) !== this.chatId) {
            logger.warn('Telegram: comando da chat non autorizzata ignorato', { chat: msg.chat.id });
            continue;
          }
          await this._handle(msg.text.trim());
        }
      } catch (e) {
        if (!this.running) break;
        const desc = e.response?.data?.description || e.message;
        // 409: un altro getUpdates è attivo; backoff più lungo
        logger.warn('Telegram polling: errore', desc);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  async _send(text) {
    try {
      await axios.post(`https://api.telegram.org/bot${this.token}/sendMessage`,
        { chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }, { timeout: 8000 });
    } catch (e) {
      logger.warn('Telegram: invio risposta fallito', e.response?.data?.description || e.message);
    }
  }

  _findBot(query) {
    const bots = [...botManager.bots.values()];
    const q = (query || '').toLowerCase();
    return bots.find(b => b.id === query) || bots.find(b => b.name.toLowerCase() === q)
      || bots.find(b => b.name.toLowerCase().includes(q));
  }

  async _handle(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    try {
      switch (cmd.toLowerCase()) {
        case '/start':
        case '/help':
          return this._send(HELP);
        case '/status':
          return this._cmdStatus();
        case '/saldo':
          return this._cmdBalance();
        case '/posizioni':
          return this._cmdPositions();
        case '/bot':
        case '/bots':
          return this._cmdBots();
        case '/avvia':
          return this._cmdToggleBot(arg, true);
        case '/ferma':
          return this._cmdToggleBot(arg, false);
        case '/chiuditutto':
          return this._cmdCloseAll();
        case '/proposte':
          return this._cmdProposals();
        case '/approva':
          return this._cmdDecide(arg, true);
        case '/rifiuta':
          return this._cmdDecide(arg, false);
        default:
          return this._send('Comando non riconosciuto. Usa /help.');
      }
    } catch (e) {
      logger.warn('Telegram: errore comando', e.message);
      return this._send(`⚠️ Errore: ${e.message}`);
    }
  }

  async _cmdStatus() {
    const { masterAddress, network } = this._context();
    const states = botManager.listStates();
    const active = states.filter(s => s.status === 'running').length;
    let equity = '—';
    if (masterAddress) {
      try { const acc = await client.getAccount(masterAddress, network); equity = `$${acc.equity.toFixed(2)}`; } catch { /* noop */ }
    }
    return this._send(`📊 <b>Stato</b>\nRete: ${network}\nBot: ${states.length} (${active} attivi)\nEquity: ${equity}`);
  }

  async _cmdBalance() {
    const { masterAddress, network } = this._context();
    if (!masterAddress) return this._send('Nessun wallet collegato (crea prima un bot).');
    const acc = await client.getAccount(masterAddress, network);
    return this._send([
      '💰 <b>Saldo</b>',
      `Equity: $${acc.equity.toFixed(2)}`,
      `Valore account: $${acc.accountValue.toFixed(2)}`,
      `Margine usato: $${acc.totalMarginUsed.toFixed(2)}`,
      `Spot USDC: $${acc.spotUsdc.toFixed(2)}`
    ].join('\n'));
  }

  async _cmdPositions() {
    const { masterAddress, network } = this._context();
    if (!masterAddress) return this._send('Nessun wallet collegato.');
    const acc = await client.getAccount(masterAddress, network);
    if (!acc.positions.length) return this._send('Nessuna posizione aperta.');
    const lines = acc.positions.map(p =>
      `${p.side === 'long' ? '🟢' : '🔴'} <b>${p.coin}</b> ${p.side} ${p.size} @ ${p.entryPx} · PnL ${p.unrealizedPnl >= 0 ? '+' : ''}$${p.unrealizedPnl.toFixed(2)}`);
    return this._send(`📈 <b>Posizioni aperte</b>\n${lines.join('\n')}`);
  }

  async _cmdBots() {
    const states = botManager.listStates();
    if (!states.length) return this._send('Nessun bot configurato.');
    const lines = states.map(s => {
      const wr = s.stats && s.stats.trades ? ` · WR ${(s.stats.winRate * 100).toFixed(0)}% (${s.stats.trades})` : '';
      return `${s.status === 'running' ? '▶️' : '⏸️'} <b>${s.name}</b> [${s.coin}]${wr}`;
    });
    return this._send(`🤖 <b>Bot</b>\n${lines.join('\n')}`);
  }

  async _cmdToggleBot(arg, start) {
    if (!arg) return this._send(`Specifica il bot: /${start ? 'avvia' : 'ferma'} &lt;id|nome&gt;`);
    const bot = this._findBot(arg);
    if (!bot) return this._send(`Bot "${arg}" non trovato. Usa /bot per l'elenco.`);
    if (start) botManager.startBot(bot.id); else botManager.stopBot(bot.id);
    return this._send(`${start ? '▶️ Avviato' : '⏸️ Fermato'}: <b>${bot.name}</b>`);
  }

  async _cmdProposals() {
    const pending = proposals.list({ status: 'pending' });
    if (!pending.length) return this._send('Nessuna proposta AI in attesa.');
    const lines = pending.map(p =>
      `🧠 <code>${p.id.slice(0, 8)}</code> [${p.type}] ${p.coin || ''} · conf ${p.confidence != null ? Math.round(p.confidence * 100) + '%' : '—'}\n   ${p.rationale || ''}`);
    return this._send(`<b>Proposte AI in attesa</b>\n${lines.join('\n')}\n\n/approva &lt;id&gt; · /rifiuta &lt;id&gt;`);
  }

  async _cmdDecide(arg, approve) {
    if (!arg) return this._send(`Specifica l'id: /${approve ? 'approva' : 'rifiuta'} &lt;id&gt;`);
    const p = proposals.findByPrefix(arg);
    if (!p) return this._send(`Proposta "${arg}" non trovata. Usa /proposte.`);
    if (approve) {
      const r = await proposals.approve(p.id);
      return this._send(r.ok ? `✅ Approvata ed eseguita [${p.type}] ${p.coin || ''}` : `⚠️ Non eseguita: ${r.reason}`);
    }
    const r = proposals.reject(p.id);
    return this._send(r.ok ? `🚫 Proposta rifiutata` : `⚠️ ${r.reason}`);
  }

  async _cmdCloseAll() {
    const { masterAddress, network } = this._context();
    if (!masterAddress) return this._send('Nessun wallet collegato.');
    const acc = await client.getAccount(masterAddress, network);
    if (!acc.positions.length) return this._send('Nessuna posizione da chiudere.');
    const results = [];
    for (const p of acc.positions) {
      try {
        const r = await client.closePosition({ masterAddress, coin: p.coin }, network);
        results.push(`${r.error ? '⚠️' : '✅'} ${p.coin}${r.error ? ` (${r.error})` : ''}`);
      } catch (e) {
        results.push(`⚠️ ${p.coin} (${e.message})`);
      }
    }
    return this._send(`🧹 <b>Chiusura posizioni</b>\n${results.join('\n')}`);
  }
}

export default new TelegramControl();
