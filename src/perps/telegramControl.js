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
 * 🔒 SICUREZZA: risponde SOLO al chatId configurato — l'allowlist è un singolo
 * chat id (quello delle notifiche), verificata in `_dispatchUpdate` prima di
 * qualunque dispatch; i messaggi da altre chat vengono scartati e loggati, senza
 * nemmeno una risposta (chi scrive non deve sapere che il bot esiste). È il
 * prerequisito di TG-01: `/killswitch off` SBLOCCA le aperture, quindi senza
 * questo controllo sarebbe un interruttore in mano a chiunque scriva al bot.
 * I comandi distruttivi (chiusura posizioni) confermano l'esito via messaggio.
 */

import axios from 'axios';
import botManager from './botManager.js';
import client from './hyperliquidClient.js';
import notifier from './notifier.js';
import proposals from '../agents/proposals.js';
import riskAgent from '../agents/riskAgent.js';
import advisor from '../agents/advisor/advisor.js';
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
  '/killswitch — stato del kill-switch',
  '/killswitch on — ferma i bot e blocca ogni nuova apertura',
  '/killswitch off — sblocca le aperture (i bot fermati NON ripartono)',
  '/proposte — proposte AI in attesa',
  '/approva &lt;id&gt; — approva una proposta AI',
  '/rifiuta &lt;id&gt; — rifiuta una proposta AI',
  '/advisorbudget — budget mensile del consulente AI e speso corrente',
  '/advisorbudget &lt;importo&gt; — proponi un nuovo budget (poi conferma)',
  '/advisorbudget confirm — applica il budget proposto',
  '/help — questo messaggio'
].join('\n');

/**
 * ADV-03 — finestra di validità della conferma del budget advisor.
 * Una conferma che resta valida per sempre non è una conferma: se il messaggio
 * "confirm" arriva mezz'ora dopo, chi lo manda potrebbe non ricordare più a
 * quale importo si riferisce.
 */
const BUDGET_CONFIRM_TTL_MS = 5 * 60 * 1000;

/**
 * ADV-03 — forma ammessa per un importo di budget, applicata alla stringa
 * GREZZA digitata dall'operatore:
 *   simbolo di valuta opzionale · cifre · separatore decimale opzionale
 *   (punto o virgola) con 1-2 decimali · simbolo di valuta opzionale.
 *
 * Nessun segno, nessun esponente, nessun prefisso di base, nessun testo
 * attaccato, nessuno spazio interno: sono tutte cose che `parseFloat` accetta o
 * che una "pulizia" preventiva trasformerebbe in un numero diverso da quello
 * digitato. `\d` in JavaScript è ASCII 0-9, quindi non passano nemmeno le cifre
 * di altri alfabeti.
 */
const BUDGET_AMOUNT_RE = /^[$€]?\d+(?:[.,]\d{1,2})?[$€]?$/;

/**
 * Interpreta un importo di budget. Ritorna il numero, oppure `null` se la
 * stringa non ha la forma ammessa — mai un numero "recuperato" da un input non
 * riconosciuto. Funzione pura: è la parte che vale la pena verificare in
 * isolamento, e il chiamante si limita a rispondere.
 */
function parseBudgetAmount(text) {
  const raw = String(text ?? '').trim();
  if (!BUDGET_AMOUNT_RE.test(raw)) return null;
  const amount = parseFloat(raw.replace(/[$€]/g, '').replace(',', '.'));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

class TelegramControl {
  constructor() {
    this.offset = 0;
    this.running = false;
    this.token = null;
    this.chatId = null;
    this._aborter = null;
    // ADV-03: modifica di budget proposta e in attesa di conferma esplicita.
    // In memoria di proposito: una conferma che sopravvive a un riavvio del
    // processo non è più contestuale alla conversazione che l'ha proposta.
    this._pendingBudget = null;
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
          await this._dispatchUpdate(upd);
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

  /**
   * Avanza l'offset e smista UN update, applicando l'allowlist.
   *
   * Estratto dal loop di polling per essere esercitabile in test senza HTTP:
   * l'autorizzazione è la parte che non può essere verificata "a occhio" da
   * quando esiste `/killswitch off` (TG-01), che sblocca le aperture.
   * Un messaggio da una chat non autorizzata è scartato e loggato, e NON riceve
   * risposta; l'offset avanza comunque, altrimenti lo stesso update verrebbe
   * riproposto a ogni giro di polling.
   */
  async _dispatchUpdate(upd) {
    this.offset = upd.update_id + 1;
    const msg = upd.message;
    if (!msg || !msg.text) return;
    if (String(msg.chat?.id) !== this.chatId) {
      logger.warn('Telegram: comando da chat non autorizzata ignorato', { chat: msg.chat?.id });
      return;
    }
    return this._handle(msg.text.trim());
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
        case '/killswitch':
          return this._cmdKillSwitch(arg);
        case '/proposte':
          return this._cmdProposals();
        case '/approva':
          return this._cmdDecide(arg, true);
        case '/rifiuta':
          return this._cmdDecide(arg, false);
        case '/advisorbudget':
          return this._cmdAdvisorBudget(arg);
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

  /**
   * TG-01 — kill-switch da Telegram: `/killswitch`, `/killswitch on|off`.
   *
   * Simmetrico ai due controlli web, e con le STESSE due asimmetrie volute:
   *  - `on` (come `POST /api/perps/killswitch`): alza il flag persistito e ferma
   *    i bot in esecuzione, ma NON chiude le posizioni — per quello c'è
   *    `/chiuditutto`, che resta un'azione separata e dichiarata;
   *  - `off` (come `POST /api/agents/killswitch {on:false}`): rimuove SOLO il
   *    blocco sulle aperture. I bot fermati NON ripartono, e la risposta lo dice
   *    esplicitamente invece di lasciar credere il contrario (stesso vincolo di
   *    UI-01): dopo un arresto d'emergenza si riprende a operare
   *    deliberatamente, non per effetto collaterale di un comando.
   *
   * Senza argomento è una lettura di stato: un comando che *sblocca* le aperture
   * non deve poter partire per errore di battitura, quindi qualunque argomento
   * non riconosciuto mostra l'uso e non cambia nulla.
   */
  async _cmdKillSwitch(arg) {
    const mode = (arg || '').trim().toLowerCase();
    const isOn = riskAgent.isKillSwitchOn();
    const stateLine = `Stato attuale: ${isOn ? '🛑 <b>ATTIVO</b> (aperture bloccate)' : '✅ spento (aperture consentite)'}`;

    if (!mode) {
      return this._send([`🛑 <b>Kill-switch</b>`, stateLine, '', 'Usa /killswitch on oppure /killswitch off.'].join('\n'));
    }
    if (mode !== 'on' && mode !== 'off') {
      return this._send([`⚠️ Argomento "${arg}" non valido.`, stateLine, '', 'Usa /killswitch on oppure /killswitch off.'].join('\n'));
    }

    if (mode === 'on') {
      if (isOn) return this._send(`🛑 Il kill-switch è <b>già attivo</b>. Le nuove aperture restano bloccate.`);
      riskAgent.setKillSwitch(true);
      // Ferma i bot in esecuzione, come fa il pulsante del pannello Risk.
      const running = botManager.listStates().filter(s => s.status === 'running');
      const stopped = [];
      for (const s of running) {
        try { botManager.stopBot(s.id); stopped.push(s.name); }
        catch (e) { logger.error(`Telegram /killswitch on: stop del bot ${s.name} fallito`, e.message); }
      }
      const failed = running.length - stopped.length;
      logger.warn(`🛑 Kill-switch attivato da Telegram: ${stopped.length}/${running.length} bot fermati`);
      // Notifica anche sul canale principale: un kill-switch non è un'azione
      // "privata" di chi l'ha digitata, deve risultare nello storico delle notifiche.
      notifier.notify(`🛑 <b>KILL-SWITCH</b> attivato da Telegram: ${stopped.length} bot fermati, nuove aperture bloccate.`);
      return this._send([
        '🛑 <b>Kill-switch ATTIVATO</b>',
        `Bot fermati: ${stopped.length}${stopped.length ? ` (${stopped.join(', ')})` : ''}`,
        failed ? `⚠️ Non fermati: ${failed} — verifica dal pannello.` : null,
        'Le nuove aperture sono bloccate. Le posizioni aperte NON sono state chiuse: usa /chiuditutto se vuoi chiuderle.'
      ].filter(Boolean).join('\n'));
    }

    if (!isOn) return this._send('✅ Il kill-switch è <b>già spento</b>. Le aperture sono consentite.');
    riskAgent.setKillSwitch(false);
    logger.warn('✅ Kill-switch disattivato da Telegram: aperture di nuovo consentite');
    notifier.notify('✅ <b>Kill-switch disattivato</b> da Telegram: nuove aperture di nuovo consentite. I bot fermati non sono stati riavviati.');
    return this._send([
      '✅ <b>Kill-switch disattivato</b>',
      'Le nuove aperture sono di nuovo consentite.',
      'I bot fermati <b>non</b> ripartono da soli: riavviali con /avvia &lt;id|nome&gt; (o dalla tab System).'
    ].join('\n'));
  }

  /**
   * ADV-03 — budget mensile del consulente AI, modificabile SOLO da qui.
   *
   * Perché non dalla web UI: approvazione fuori banda. Chi compromette la
   * sessione web (cookie rubato, browser lasciato aperto) non deve poter alzare
   * da solo il tetto di spesa verso un servizio a pagamento. È la stessa
   * filosofia del kill-switch su Telegram (TG-01) e vale anche al contrario —
   * `GET /api/advisor/budget` è di sola lettura, per costruzione.
   *
   * Conferma a DUE PASSI, non una sola battuta:
   *  1. `/advisorbudget 25` → il bot risponde col riepilogo (da $X a $Y, speso
   *     corrente) e NON applica nulla;
   *  2. `/advisorbudget confirm` → applica, registra in audit e lo dice.
   * Una proposta non confermata scade dopo 5 minuti, e ogni nuova proposta
   * sostituisce la precedente. Senza argomento è una lettura di stato: un comando
   * che alza una soglia di spesa non deve poter partire per un errore di
   * battitura (stesso criterio di `/killswitch`).
   */
  async _cmdAdvisorBudget(arg) {
    const mode = (arg || '').trim().toLowerCase();
    const b = advisor.budget();
    const stateLines = [
      `Budget mensile: <b>$${b.monthlyLimitUsd.toFixed(2)}</b>`,
      `Speso questo mese: $${b.spentUsd.toFixed(2)} · residuo $${b.remainingUsd.toFixed(2)}`,
      `Azzeramento: ${new Date(b.resetsAt).toLocaleDateString('it-IT')}`
    ];

    if (!mode) {
      return this._send([
        '💬 <b>Budget consulente AI</b>', ...stateLines, '',
        'Per cambiarlo: /advisorbudget &lt;importo&gt; poi /advisorbudget confirm.'
      ].join('\n'));
    }

    if (mode === 'confirm') {
      const pending = this._pendingBudget;
      if (!pending) {
        return this._send(['⚠️ Nessuna modifica di budget da confermare.', ...stateLines, '',
          'Proponi prima un importo: /advisorbudget &lt;importo&gt;.'].join('\n'));
      }
      if (Date.now() - pending.at > BUDGET_CONFIRM_TTL_MS) {
        this._pendingBudget = null;
        return this._send(['⚠️ La conferma è scaduta (oltre 5 minuti): nulla è stato modificato.', ...stateLines, '',
          'Riproponi l\'importo con /advisorbudget &lt;importo&gt;.'].join('\n'));
      }
      this._pendingBudget = null;
      const { from, to } = advisor.setMonthlyBudget(pending.amount, { via: 'telegram' });
      const after = advisor.budget();
      notifier.notify(`💬 <b>Budget consulente AI</b> modificato da Telegram: da $${from.toFixed(2)} a $${to.toFixed(2)}/mese.`);
      return this._send([
        '✅ <b>Budget consulente aggiornato</b>',
        `Da $${from.toFixed(2)} a <b>$${to.toFixed(2)}</b>/mese.`,
        `Speso questo mese: $${after.spentUsd.toFixed(2)} · residuo $${after.remainingUsd.toFixed(2)}`,
        after.exceeded ? '⚠️ Il nuovo tetto è già stato superato dalla spesa del mese: la chat resta bloccata.' : null
      ].filter(Boolean).join('\n'));
    }

    if (mode === 'cancel' || mode === 'annulla') {
      const had = !!this._pendingBudget;
      this._pendingBudget = null;
      return this._send(had ? '🚫 Modifica di budget annullata: nulla è stato cambiato.' : 'Nessuna modifica in sospeso.');
    }

    // Da qui: proposta di un nuovo importo.
    //
    // La validazione avviene sulla stringa GREZZA, prima di qualunque pulizia, e
    // l'ordine è tutto il punto. La versione precedente rimuoveva i caratteri non
    // numerici e validava DOPO: così "1e10" diventava "110", "50abc" diventava
    // "50", "0x10" diventava "010" e "-5" diventava "5" — tutti importi validi,
    // tutti diversi da quello digitato, tutti applicati a una soglia di SPESA.
    // Ripulire un input non è capirlo.
    //
    // Ciò che si normalizza è solo ciò che un umano scrive davvero per un
    // importo — simbolo di valuta e virgola come separatore decimale — e lo si
    // fa esplicitamente, DOPO aver riconosciuto la forma. Tutto il resto non è
    // sporcizia: è un input che non si è capito, e su un tetto di spesa la
    // risposta giusta è far ripetere il comando.
    const amount = parseBudgetAmount(mode);
    if (amount == null) {
      return this._send([`⚠️ Importo "${arg}" non valido.`, ...stateLines, '',
        'Uso: /advisorbudget 25 (poi /advisorbudget confirm).'].join('\n'));
    }
    if (amount > 1000) {
      return this._send(['⚠️ Importo oltre il massimo consentito ($1000/mese). Nulla è stato modificato.', ...stateLines].join('\n'));
    }

    this._pendingBudget = { amount, at: Date.now() };
    return this._send([
      '❓ <b>Conferma richiesta</b>',
      `Vuoi impostare il budget advisor a <b>$${amount.toFixed(2)}/mese</b>?`,
      `Attuale: $${b.monthlyLimitUsd.toFixed(2)}/mese · speso questo mese $${b.spentUsd.toFixed(2)}`,
      '',
      'Conferma con <code>/advisorbudget confirm</code> (entro 5 minuti) oppure annulla con <code>/advisorbudget cancel</code>.',
      '<i>Nulla è stato modificato per ora.</i>'
    ].join('\n'));
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
