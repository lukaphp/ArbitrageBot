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
import notifier from './notifier.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import db from '../db/database.js';
import logger from '../utils/logger.js';

class BotManager {
  constructor() {
    this.bots = new Map(); // id -> PerpsBot
    this.io = null;
    this.watchdogTimer = null;
    this.lastWatchdogAlert = new Map(); // botId -> ts (throttle alert)
  }

  setIo(io) {
    this.io = io;
  }

  _onUpdate = (state) => {
    if (this.io) {
      this.io.emit('perps:botUpdate', state);
      // Emette dashboardRefresh istantaneo se l'azione di trading è operativa (open_long/open_short/close)
      if (state.lastEval && (state.lastEval.action === 'open_long' || state.lastEval.action === 'open_short' || state.lastEval.action === 'close')) {
        this.io.emit('perps:dashboardRefresh', {
          reason: 'strategy_signal',
          botId: state.id,
          action: state.lastEval.action
        });
      }
    }
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

  /**
   * CRIT-03-EXTRA — bot IN ESECUZIONE che operano già sulla stessa coppia
   * (masterAddress, coin).
   *
   * Il lock di CRIT-03 impedisce a due bot sullo stesso mercato di firmare
   * entrambi un'apertura nello stesso istante; questo risponde alla domanda a
   * monte, cioè che quel secondo bot esista. È già capitato in produzione (due bot
   * short su NEAR-PERP a un minuto di distanza con parametri quasi identici, vedi
   * `docs/KB/business-analysis-2026-08-11.md`): non diversificazione voluta, un
   * doppione. Il rischio è di esposizione, perché i limiti di portafoglio contano
   * le POSIZIONI aperte, non le strategie che le generano — due bot sullo stesso
   * mercato sono una scommessa doppia sullo stesso rischio.
   *
   * Solo i bot `running`: due bot fermi non aprono nulla e non producono
   * esposizione, avvisare su quelli sarebbe un falso positivo. L'indirizzo si
   * confronta in minuscolo, come per il lock di apertura (`execQueue`): è lo
   * stesso wallet scritto in modo diverso.
   *
   * Sola lettura, nessun effetto collaterale: si può chiamare per chiedere senza
   * cambiare nulla (la lezione di QUAL-01 item 2 su `canOpen`).
   *
   * @returns {Array<{id, name, coin}>} bot sovrapposti, vuoto se nessuno.
   */
  findMarketOverlap({ masterAddress, coin, excludeId = null }) {
    const master = String(masterAddress || '').toLowerCase();
    if (!master || !coin) return [];
    return [...this.bots.values()]
      .filter(b => b.id !== excludeId
        && b.status === 'running'
        && b.coin === coin
        && String(b.masterAddress || '').toLowerCase() === master)
      .map(b => ({ id: b.id, name: b.name, coin: b.coin }));
  }

  /**
   * Crea un bot. Non lo avvia: un bot nasce fermo.
   *
   * CRIT-03-EXTRA — se sul mercato c'è già un altro bot in esecuzione, la
   * creazione AVVIENE COMUNQUE e la risposta porta un `warning`. Non è un blocco
   * per scelta: due strategie diverse sullo stesso asset (timeframe diversi, una
   * long e una short) sono una configurazione legittima, e trasformare un avviso in
   * un divieto renderebbe impossibile una cosa che a volte si vuole fare davvero.
   *
   * Nessuna notifica Telegram: chi crea il bot è la persona che sta guardando la
   * risposta in quel momento. Un messaggio in chat per un'azione appena compiuta a
   * mano sarebbe rumore, ed è la stessa disciplina delle notifiche-per-episodio.
   * Nei log resta traccia, perché il caso interessa anche a posteriori.
   *
   * `warning` è ADDITIVO sullo stato restituito (`null` quando non c'è nulla da
   * dire): la forma di `getState()` non cambia per nessun altro consumatore —
   * `listStates()`, le metriche e gli eventi socket non lo vedono nemmeno, perché
   * quelli ricostruiscono lo stato per conto loro.
   *
   * AGENT-AWARE:
   *  - `linked_agent_id` : chi controlla il bot ('user_manual' | 'hermes' | ...)
   *  - `max_allocation_usd` : Budget Ceiling — null = nessun limite aggiuntivo
   */
  createBot({ name, coin, network, masterAddress, config, linked_agent_id, max_allocation_usd, actor_label, actor_id, is_managed_by_agent }) {
    if (!name || !coin || !masterAddress) {
      throw new Error('name, coin e masterAddress sono obbligatori');
    }
    const overlap = this.findMarketOverlap({ masterAddress, coin });
    const id = crypto.randomUUID();
    const record = {
      id, name, coin, network: network || 'testnet',
      masterAddress, config: config || {}, status: 'stopped',
      linked_agent_id: linked_agent_id || actor_id || 'user_manual',
      max_allocation_usd: max_allocation_usd != null ? Number(max_allocation_usd) : null,
      actor_label: actor_label || null,
      actor_id: actor_id || linked_agent_id || null,
      is_managed_by_agent: Boolean(is_managed_by_agent || (linked_agent_id && linked_agent_id.toLowerCase().includes('hermes')))
    };
    db.insertBot(record);
    const bot = new PerpsBot(db.getBot(id), this._onUpdate);
    this.bots.set(id, bot);
    logger.info(`➕ Bot creato: ${name} (${coin}) [agent: ${record.linked_agent_id}]`, { id });

    let warning = null;
    if (overlap.length) {
      const others = overlap.map(o => o.name).join(', ');
      warning = `Su ${coin} è già in esecuzione ${overlap.length === 1 ? 'un altro bot' : `${overlap.length} altri bot`} (${others}) sullo stesso wallet. `
        + 'Non è un errore, ma i limiti di portafoglio contano le posizioni aperte, non le strategie: '
        + 'due bot sullo stesso mercato possono raddoppiare l\'esposizione sullo stesso rischio. '
        + 'Verifica che sia una diversificazione voluta e non un doppione.';
      logger.warn(`Bot creato su un mercato già coperto: ${name} (${coin}) — già in esecuzione: ${others}`);
    }

    return { ...bot.getState(), warning };
  }

  /**
   * DEBT-01 — la sostituzione dell'istanza ATTENDE il tick in volo.
   *
   * `bot.stop()` ferma il timer, ma non un tick già partito: quello continua
   * fino in fondo (snapshot mercato → riconciliazione → gestione posizione).
   * Costruire e avviare subito la nuova istanza significava avere, per tutta la
   * durata di quel tick, DUE istanze dello stesso bot attive sullo stesso
   * mercato e sulla stessa riga `positions` — la vecchia con la sua posizione in
   * memoria, la nuova che nasce con `position = null` e ricostruisce lo stato da
   * zero. È il meccanismo concreto dietro la race di SEC-08: quel fix ha reso
   * innocuo lo stato prodotto (`insertPositionIfNoneOpen` + `_hydratePosition`),
   * qui si rimuove la sovrapposizione che lo produceva.
   *
   * Asincrono di conseguenza: chi chiama (`PATCH /api/perps/bots/:id`) deve
   * attendere, altrimenti risponderebbe con lo stato della vecchia istanza.
   *
   * AGENT-AWARE: accetta anche `linked_agent_id` e `max_allocation_usd`.
   */
  async updateBot(id, { name, coin, config, linked_agent_id, max_allocation_usd, actor_label, actor_id, is_managed_by_agent }) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error('Bot non trovato');
    const wasRunning = bot.status === 'running';
    if (wasRunning) bot.stop();
    await bot.whenIdle();

    db.updateBot(id, { name, coin, config, linked_agent_id, max_allocation_usd, actor_label, actor_id, is_managed_by_agent });
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

  /**
   * Lista stati di tutti i bot, con filtro opzionale per agent_id.
   * Agente non specificato = tutti i bot.
   */
  listStates(agentId = null) {
    const all = [...this.bots.values()].map(b => b.getState());
    if (!agentId) return all;
    return all.filter(s => (s.linked_agent_id || 'user_manual') === agentId);
  }

  /**
   * WATCHDOG: controlla periodicamente che i bot in esecuzione stiano "ticcando".
   * Se un bot running non aggiorna lastTickAt da oltre la soglia (3× il suo loop,
   * minimo 60s):
   *  1. Notifica Telegram (throttle 10 min/bot)
   *  2. Emette `perps:botCrash` via Socket.IO → banner rosso UI
   *  3. Emette `perps:botUpdate` con status 'crashed' → aggiorna card bot
   *  4. Emette `perps:dashboardRefresh` → UI ricarica bots/posizioni
   *
   * Il flag `bot._crashed` è in-memory: resettato automaticamente al riavvio server.
   */
  startWatchdog() {
    if (this.watchdogTimer) return;
    const CHECK_MS = 30000;
    const ALERT_THROTTLE_MS = 10 * 60 * 1000;
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const bot of this.bots.values()) {
        if (bot.status !== 'running' || !bot.lastTickAt) continue;
        const loop = bot.config.loopInterval || HYPERLIQUID_CONFIG.botLoopInterval;
        const staleMs = Math.max(3 * loop, 60000);
        const isStale = now - bot.lastTickAt > staleMs;

        if (isStale) {
          const last = this.lastWatchdogAlert.get(bot.id) || 0;
          if (now - last > ALERT_THROTTLE_MS) {
            this.lastWatchdogAlert.set(bot.id, now);
            const secs = Math.round((now - bot.lastTickAt) / 1000);
            logger.warn(`🐕 Watchdog: bot ${bot.name} fermo da ${secs}s`);

            // Telegram
            notifier.notify(
              `🐕 <b>Watchdog</b>: il bot <b>${bot.name}</b> (${bot.coin}) ` +
              `non aggiorna da ${secs}s. Controlla connettività/API.`
            );

            // Segna il bot come crashed in-memory (status rimane 'running' nel DB
            // per permettere il resume automatico al prossimo riavvio)
            bot._crashed = true;

            // Socket.IO — alert UI immediato
            if (this.io) {
              const crashState = {
                ...bot.getState(),
                status: 'crashed',
                _crashedSinceMs: secs * 1000,
                crashReason: `Nessun tick da ${secs}s (soglia: ${Math.round(staleMs / 1000)}s)`
              };

              // 1. Alert dedicato per il banner rosso
              this.io.emit('perps:botCrash', {
                botId: bot.id,
                botName: bot.name,
                coin: bot.coin,
                linked_agent_id: bot.linked_agent_id || 'user_manual',
                silentSinceMs: secs * 1000,
                threshold: staleMs
              });

              // 2. Aggiorna la card del bot
              this.io.emit('perps:botUpdate', crashState);

              // 3. Refresh generale dashboard
              this.io.emit('perps:dashboardRefresh', { reason: 'watchdog_crash', botId: bot.id });
            }
          }
        } else if (bot._crashed) {
          // Il bot ha ripreso a ticcolare → rimuovi il flag crashed e notifica recovery
          bot._crashed = false;
          logger.info(`🐕 Watchdog: bot ${bot.name} ha ripreso l'attività`);
          if (this.io) {
            this.io.emit('perps:botUpdate', bot.getState());
            this.io.emit('perps:dashboardRefresh', { reason: 'watchdog_recovery', botId: bot.id });
          }
        }
      }
    }, CHECK_MS);
    this.watchdogTimer.unref?.();
    logger.info('🐕 Watchdog bot avviato');
  }


  /** Shutdown del server: ferma i timer senza cambiare lo stato persistito. */
  stopAll() {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    for (const bot of this.bots.values()) bot.shutdown();
  }
}

export default new BotManager();
