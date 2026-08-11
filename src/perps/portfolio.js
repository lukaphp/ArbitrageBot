/**
 * PORTFOLIO RISK MANAGER (Perps)
 * ==============================
 *
 * Limiti di rischio GLOBALI applicati a tutti i bot prima di aprire una
 * posizione: max posizioni concorrenti, esposizione totale, e cooldown dopo
 * N perdite consecutive. I limiti sono persistiti in `settings`.
 *
 * Usa lo stato account Hyperliquid (che già contiene TUTTE le posizioni del
 * master) per contare posizioni ed esposizione: nessuna dipendenza circolare
 * con il botManager.
 *
 * COOLDOWN PERSISTITO (CRIT-02)
 * -----------------------------
 * I cooldown vivevano solo in memoria: un riavvio (deploy, crash, OOM) li
 * azzerava tutti, riaprendo la finestra di re-entry impulsivo che il cooldown
 * esiste per chiudere — e proprio nel momento peggiore, subito dopo una serie di
 * perdite. Ora stanno in `settings` (stessa tabella chiave-valore di
 * `portfolio_limits`: è un mapping botId → timestamp, la stessa forma di dato,
 * nessuna migrazione di schema) e vengono ricaricati al primo uso.
 *
 * La persistenza è un MIGLIORAMENTO, non un prerequisito: se il DB non è
 * leggibile o scrivibile si continua a operare con lo stato in memoria — un
 * cooldown non deve poter impedire l'avvio del server — ma l'anomalia viene
 * loggata, mai ingoiata.
 *
 * VERIFICA E SCRITTURA SEPARATE (QUAL-01 item 2)
 * ---------------------------------------------
 * `canOpen()` è PURA: stesse decisioni di prima, nessuna scrittura. Il cooldown
 * si attiva in `recordLoss()`, chiamato da `bot._registerClose()` quando la
 * perdita è confermata dai fill. Prima bastava CHIEDERE "questo bot potrebbe
 * aprire?" per far partire un'ora di blocco.
 */

import db from '../db/database.js';
import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

const DEFAULTS = {
  maxConcurrentPositions: 3,
  maxTotalExposureUsd: (HYPERLIQUID_CONFIG.risk.maxPositionUsd || 5000) * 2,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 60
};

const COOLDOWN_KEY = 'portfolio_cooldowns';

export class Portfolio {
  constructor() {
    this.cooldowns = new Map(); // botId -> timestamp di fine cooldown
    this._cooldownsLoaded = false;
  }

  /**
   * Ripristina i cooldown persistiti. LAZY, non nel costruttore: il singleton
   * viene creato all'import del modulo, quando il DB può non essere ancora
   * inizializzato (e forzarne l'init qui significherebbe aprire il file sbagliato
   * in qualunque contesto che lo configuri dopo, test compresi).
   *
   * I cooldown già scaduti non vengono ripristinati: un timestamp nel passato non
   * blocca nulla e riportarlo in memoria servirebbe solo ad accumulare voci morte.
   */
  _loadPersistedCooldowns() {
    if (this._cooldownsLoaded) return this.cooldowns;
    this._cooldownsLoaded = true;
    try {
      const raw = db.getSetting(COOLDOWN_KEY);
      if (!raw) return this.cooldowns;
      const now = Date.now();
      let restored = 0;
      let skipped = 0;
      for (const [botId, until] of Object.entries(JSON.parse(raw) || {})) {
        const ts = Number(until);
        if (Number.isFinite(ts) && ts > now) {
          // Lo stato in memoria vince se già presente (è più recente).
          if (!this.cooldowns.has(botId)) this.cooldowns.set(botId, ts);
          restored++;
        } else {
          skipped++;
        }
      }
      if (restored || skipped) {
        logger.info(`⏸️  Cooldown di portafoglio ripristinati: ${restored} attivi, ${skipped} già scaduti scartati`);
      }
    } catch (error) {
      // Degrado dichiarato: si parte senza cooldown pregressi. Non è silenzioso —
      // significa che per un po' i bot in cooldown potranno riaprire.
      logger.warn('Cooldown di portafoglio non ripristinabili, si parte senza quelli pregressi', error.message);
    }
    return this.cooldowns;
  }

  /**
   * Riscrive l'insieme dei cooldown ancora attivi (ripulendo i scaduti).
   * Un fallimento di scrittura non si propaga al chiamante: la protezione in
   * memoria resta valida, si perde solo la sopravvivenza al riavvio.
   */
  _persistCooldowns() {
    const now = Date.now();
    const out = {};
    for (const [botId, until] of [...this.cooldowns]) {
      if (until > now) out[botId] = until;
      else this.cooldowns.delete(botId);
    }
    try {
      db.setSetting(COOLDOWN_KEY, JSON.stringify(out));
    } catch (error) {
      logger.warn('Cooldown di portafoglio non persistito (resta valido in memoria)', error.message);
    }
  }

  /**
   * Registra una perdita CONFERMATA e attiva il cooldown se le perdite
   * consecutive hanno raggiunto il limite. È il lato con effetti collaterali,
   * separato da `canOpen()` (QUAL-01 item 2).
   *
   * Un episodio già in corso non viene rinnovato: altrimenti ogni nuova perdita
   * (impossibile, se il cooldown blocca davvero — ma la chiusura può arrivare da
   * fuori) allungherebbe il blocco senza che scada mai.
   *
   * @returns il timestamp di fine cooldown se attivato/già attivo, altrimenti null.
   */
  recordLoss(botId, consecutiveLosses = 0) {
    if (!botId) return null;
    this._loadPersistedCooldowns();
    const L = this.getLimits();
    if (consecutiveLosses < L.maxConsecutiveLosses) return null;

    const existing = this.cooldownInfo(botId);
    if (existing) return existing;

    const until = Date.now() + L.cooldownMinutes * 60000;
    this.cooldowns.set(botId, until);
    this._persistCooldowns();
    logger.warn(`Portafoglio: bot ${botId} in cooldown per ${L.cooldownMinutes} min dopo ${consecutiveLosses} perdite consecutive`);
    return until;
  }

  /**
   * CRIT-02-EXTRA — la lettura dei limiti non può far esplodere `canOpen()`.
   *
   * Prima, `db.getSetting` + `JSON.parse` erano senza rete: un DB non leggibile o
   * quella singola chiave corrotta non producevano un degrado ma un'eccezione che
   * risaliva a `canOpen()`, quindi a `bot._openPosition()` e a
   * `riskAgent.evaluate()` — il gate di rischio si sarebbe rotto invece di
   * rispondere. Stessa disciplina del caricamento dei cooldown: fallback ai
   * default, anomalia loggata, nessun crash che si propaga.
   *
   * I default sono un fallback CONSERVATIVO, non "nessun limite": con i limiti
   * illeggibili `canOpen()` continua a bloccare oltre 3 posizioni concorrenti.
   * Un guasto del DB non deve poter diventare un via libera.
   *
   * Il merge avviene solo se il JSON è un oggetto vero: `'42'`, `'"testo"'`,
   * `'null'` e `'[1,2]'` sono JSON validi che, spalmati sui default, produrrebbero
   * limiti con chiavi spurie invece di limiti.
   */
  getLimits() {
    try {
      const raw = db.getSetting('portfolio_limits');
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn(`Limiti di portafoglio in un formato inatteso (${typeof parsed}), uso i default`);
        return { ...DEFAULTS };
      }
      return { ...DEFAULTS, ...parsed };
    } catch (error) {
      logger.warn('Limiti di portafoglio non leggibili, uso i default', error.message);
      return { ...DEFAULTS };
    }
  }

  /**
   * ASIMMETRIA VOLUTA rispetto a `getLimits()`: qui un errore di scrittura NON
   * viene ingoiato. Salvare i limiti è un'azione esplicita dell'utente, e
   * rispondere "salvato" a un salvataggio mai avvenuto lo farebbe operare convinto
   * di avere cap che non esistono. Un errore visibile è meglio.
   */
  setLimits(obj) {
    const merged = { ...this.getLimits(), ...obj };
    db.setSetting('portfolio_limits', JSON.stringify(merged));
    return merged;
  }

  cooldownInfo(botId) {
    this._loadPersistedCooldowns();
    const until = this.cooldowns.get(botId);
    return until && Date.now() < until ? until : null;
  }

  /**
   * Verifica i limiti globali prima di aprire. FUNZIONE PURA (QUAL-01 item 2):
   * stesse decisioni di prima, nessuna scrittura di stato — chiamarla per sapere
   * "questo bot potrebbe aprire?" non cambia nulla.
   *
   * Il ramo delle perdite consecutive continua a BLOCCARE anche quando nessun
   * cooldown risulta attivo (posizioni chiuse prima di questo cambio, cooldown
   * scaduto ma serie di perdite ancora in corso): la protezione non si allenta,
   * si sposta solo il punto in cui viene scritta.
   *
   * @param {object} p { account, plannedNotional, botId, consecutiveLosses }
   * @returns { ok, reason, cooldownUntil? }
   */
  canOpen({ account, plannedNotional = 0, botId, consecutiveLosses = 0 }) {
    const L = this.getLimits();

    const until = this.cooldownInfo(botId);
    if (until) {
      // cooldownUntil (il timestamp grezzo, non la stringa formattata) è quello
      // che il chiamante usa per capire se è ancora lo STESSO episodio di cooldown
      // o uno nuovo — senza, un tick ogni 10s per un'ora intera manda la stessa
      // notifica centinaia di volte (successo davvero, vedi bot.js).
      return { ok: false, reason: `In cooldown fino alle ${new Date(until).toLocaleTimeString('it-IT')}`, cooldownUntil: until };
    }

    const positions = account.positions || [];
    if (positions.length >= L.maxConcurrentPositions) {
      return { ok: false, reason: `Max posizioni concorrenti (${L.maxConcurrentPositions}) raggiunto` };
    }

    const totalNotional = positions.reduce((s, p) => s + (p.positionValue || 0), 0) + plannedNotional;
    if (totalNotional > L.maxTotalExposureUsd) {
      return { ok: false, reason: `Esposizione totale ${totalNotional.toFixed(0)}$ oltre il limite (${L.maxTotalExposureUsd}$)` };
    }

    if (consecutiveLosses >= L.maxConsecutiveLosses) {
      // Nessuna scrittura qui: l'attivazione è di `recordLoss()`.
      return { ok: false, reason: `${consecutiveLosses} perdite consecutive → cooldown ${L.cooldownMinutes} min` };
    }

    return { ok: true };
  }
}

export default new Portfolio();
