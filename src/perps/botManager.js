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
import { postInternal } from '../utils/internalLoopback.js';
import { mergeStrategyConfig, extractBotConfig } from './strategySchema.js';

class BotManager {
  constructor() {
    this.bots = new Map(); // id -> PerpsBot
    this.io = null;
    this.watchdogTimer = null;
    this.lastWatchdogAlert = new Map(); // botId -> ts (throttle alert)
    this._forwardInFlight = new Set(); // botId con una POST loopback ancora in volo
    this._forwardFailures = 0;         // consecutive: serve al log per episodio, non per tentativo
  }

  setIo(io) {
    this.io = io;
  }

  /**
   * Push verso i browser di UN aggiornamento di bot. È l'unico posto che decide
   * COSA viene emesso: `_onUpdate` (processo Express) e la rotta interna
   * `/internal/mcp/bot-update` (stato arrivato dal processo MCP) passano
   * entrambi di qui, così i due percorsi non possono divergere.
   *
   * @returns {boolean} true se c'era davvero un `io` su cui emettere.
   */
  emitBotUpdate(state) {
    if (!this.io || !state) return false;
    this.io.emit('perps:botUpdate', state);
    // Emette dashboardRefresh istantaneo se l'azione di trading è operativa (open_long/open_short/close)
    if (state.lastEval && (state.lastEval.action === 'open_long' || state.lastEval.action === 'open_short' || state.lastEval.action === 'close')) {
      this.io.emit('perps:dashboardRefresh', {
        reason: 'strategy_signal',
        botId: state.id,
        action: state.lastEval.action
      });
    }
    return true;
  }

  /**
   * Callback di fine tick di ogni `PerpsBot` (`bot._emit()`).
   *
   * MCP-SYNC-02 — quando il bot gira nel processo MCP Stdio, `this.io` è `null`
   * (lì non c'è nessun client Socket.IO) e questo callback era un no-op
   * SILENZIOSO: nessun evento raggiungeva mai il browser, e l'unico
   * aggiornamento che l'utente vedeva era quello provocato da un tool MCP
   * esplicito via `notifyExpressReload()`. Tutto ciò che il bot decide da solo
   * dentro il tick — nuova valutazione, apertura/chiusura da segnale di
   * strategia, TP/SL scattato, errore — spariva.
   *
   * Il ramo `else` inoltra quindi lo stato al processo Express via loopback.
   * Deliberatamente NON tocca il ramo con `io` presente: dove l'emit diretto
   * funziona già, il comportamento resta identico a prima (nessun doppio push).
   * Il fix è indipendente da CHI esegue il tick loop: se un domani il loop
   * tornasse a girare solo in Express, questo ramo semplicemente non si attiva.
   */
  _onUpdate = (state) => {
    if (this.emitBotUpdate(state)) return;
    this._forwardUpdateToExpress(state);
  };

  /**
   * Inoltro loopback dello stato al processo Express, fire-and-forget.
   *
   * FREQUENZA: si inoltra OGNI tick, senza debounce. `perps:botUpdate` alimenta
   * prezzo, ultima valutazione e stato posizione nella UI: filtrarlo come si fa
   * con `dashboardRefresh` (solo open/close) lascerebbe la card ferma tra
   * un'operazione e l'altra, che è esattamente il sintomo da correggere. Il
   * costo è una POST su 127.0.0.1 ogni `loopInterval` per bot — default 10s
   * (`HYPERLIQUID_CONFIG.botLoopInterval`), quindi ordine di 0,1 req/s per bot:
   * irrilevante rispetto al tick stesso, che fa già più chiamate HTTP verso
   * Hyperliquid. Se un giorno la cadenza scendesse sotto il secondo, il posto
   * dove mettere un debounce è questo, non `bot._emit()`.
   *
   * MAI bloccante: nessun `await` qui e nessuno in `_onUpdate` — il tick non
   * aspetta né Express né il timeout. Se una POST è ancora in volo per lo stesso
   * bot si SALTA quella nuova invece di accodarla: ogni payload è uno snapshot
   * completo, quindi l'ultimo vince e accodare significherebbe solo consegnare
   * stati già vecchi (e far crescere la coda se Express è lento).
   *
   * Fallire in silenzio qui rimetterebbe in piedi lo stesso problema invisibile
   * che si sta chiudendo, quindi si logga — ma UNA VOLTA PER EPISODIO, non per
   * tentativo: un warn quando il ponte si rompe, un info quando torna a
   * funzionare. Nessuna notifica Telegram: è freschezza della UI, non un money
   * path.
   *
   * `PERPS_LOOPBACK_PUSH=0` disattiva l'inoltro. Serve UNICAMENTE alla suite di
   * test (`npm test` lo imposta): lì i bot si creano con `io` null, quindi ogni
   * `_emit()` è indistinguibile da quello del processo MCP e farebbe partire
   * POST vere verso la porta 3000 — su una macchina con l'app in esecuzione,
   * stati di bot di test comparirebbero nella dashboard reale, e in questo
   * periodo (indagine sulla duplicazione bot) sarebbero indizi falsi presi per
   * veri. In produzione la variabile non va impostata: chi la mette a 0 spegne
   * il ponte e torna al bug che questo metodo chiude.
   */
  _forwardUpdateToExpress(state) {
    if (process.env.PERPS_LOOPBACK_PUSH === '0') return;
    if (!state || !state.id) return;
    if (this._forwardInFlight.has(state.id)) return;
    this._forwardInFlight.add(state.id);
    postInternal('/internal/mcp/bot-update', { state }, { timeoutMs: 1500 })
      .then((delivered) => {
        if (delivered) {
          if (this._forwardFailures > 0) {
            logger.info(`🔗 Ponte UI ripristinato: gli aggiornamenti dei bot tornano a raggiungere la dashboard (dopo ${this._forwardFailures} tentativi falliti)`);
          }
          this._forwardFailures = 0;
          return;
        }
        this._forwardFailures++;
        if (this._forwardFailures === 1) {
          logger.warn('🔗 Ponte UI interrotto: lo stato dei bot non raggiunge il processo Express (POST /internal/mcp/bot-update). La dashboard resterà ferma finché non si ripristina.');
        }
      })
      .catch(() => { /* postInternal non rigetta mai: ramo difensivo */ })
      .finally(() => this._forwardInFlight.delete(state.id));
  }

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

  /**
   * Applica una PATCH PARZIALE alla configurazione di un bot e ricarica
   * l'istanza runtime.
   *
   * È il punto unico in cui una modifica parziale di config diventa effettiva.
   * Esisteva già, ma sparso dentro `handleUpdateStrategyParams` (leggi la riga →
   * fondi → `updateBot` ripassando TUTTI gli altri campi della riga → emetti);
   * con l'arrivo di un secondo chiamante (`executionAgent`, proposte
   * `tune_params` approvate a mano) quelle venti righe sarebbero diventate due
   * copie. Due copie di questa sequenza non sono un problema estetico: chi
   * dimentica di ripassare `max_allocation_usd` o `actor_id` a `updateBot` li
   * azzera in silenzio, cioè toglie a un bot il suo tetto di allocazione senza
   * che nessuno lo veda — la stessa classe di problema che `mergeStrategyConfig`
   * risolve un livello più sotto.
   *
   * NON valida la patch: la validazione è responsabilità del chiamante, perché è
   * diversa per ciascuno (i guardrail a due stadi per l'MCP, la whitelist delle
   * chiavi tunabili per le proposte). Qui si fonde e si applica.
   *
   * @param botId id del bot
   * @param patch oggetto di chiavi di config da fondere (non sostituisce il resto)
   * @param reason etichetta per il `dashboardRefresh` verso la UI
   * @returns { state, previousConfig, config } — `previousConfig` serve al
   *          chiamante per raccontare nell'audit cosa è cambiato davvero.
   */
  async applyConfigPatch(botId, patch, { reason = 'config_patch' } = {}) {
    db.ensure();
    const botRow = db.getBot(botId);
    if (!botRow) throw new Error(`Bot non trovato (id: ${botId})`);

    const previousConfig = extractBotConfig(botRow);
    const config = mergeStrategyConfig(previousConfig, patch);

    const state = await this.updateBot(botId, {
      name: botRow.name,
      coin: botRow.coin,
      config,
      linked_agent_id: botRow.linked_agent_id,
      max_allocation_usd: botRow.max_allocation_usd,
      actor_label: botRow.actor_label,
      actor_id: botRow.actor_id,
      is_managed_by_agent: botRow.is_managed_by_agent
    });

    if (this.io) {
      this.io.emit('perps:botUpdate', state);
      this.io.emit('perps:dashboardRefresh', { reason, botId });
    }

    return { state, previousConfig, config };
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
