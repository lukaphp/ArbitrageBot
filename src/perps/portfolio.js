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

/**
 * #79 — dominio di ogni limite di portafoglio: le SOLE chiavi accettate, e per
 * ciascuna un numero finito, > 0, intero dove è un conteggio, entro un tetto.
 *
 * Prima `setLimits` scriveva qualunque cosa arrivasse da `POST
 * /api/perps/portfolio`: con `maxTotalExposureUsd: 'abc'` il confronto
 * `totale > 'abc'` è falso per ogni totale, cioè il tetto di esposizione
 * spariva, e lo stesso per posizioni concorrenti e perdite consecutive. Un
 * NaN non ferma niente: attraversa ogni guardia come un via libera.
 *
 * I tetti superiori non sono limiti di rischio ma di PLAUSIBILITÀ: fermano un
 * refuso (uno zero di troppo) che di fatto spegnerebbe il cap pur restando un
 * numero "valido".
 *  - maxConcurrentPositions ≤ 50: ben oltre i mercati che la flotta segue;
 *  - maxTotalExposureUsd ≤ 10.000.000$: ordini di grandezza sopra ogni conto reale;
 *  - maxConsecutiveLosses ≤ 100: oltre, il cooldown non scatterebbe mai;
 *  - cooldownMinutes ≤ 10.080 (7 giorni): oltre è un blocco, non un cooldown.
 */
export const LIMIT_SPECS = {
  maxConcurrentPositions: { integer: true, max: 50 },
  maxTotalExposureUsd: { integer: false, max: 10_000_000 },
  maxConsecutiveLosses: { integer: true, max: 100 },
  cooldownMinutes: { integer: false, max: 10_080 }
};

/**
 * Valore di un limite, normalizzato a numero, oppure il motivo per cui non lo è.
 *
 * Le stringhe NUMERICHE sono accettate (`"5"` → 5): un form HTML produce stringhe,
 * e rifiutare `"5"` non protegge nulla. Tutto il resto no: `""`, `null` e `false`
 * diventerebbero 0 con `Number()`, cioè un valore che sembra valido e non è
 * quello scritto — e 0 posizioni concorrenti bloccherebbe tutto per un campo
 * lasciato vuoto.
 *
 * Funzione PURA.
 * @returns {{ value?: number, error?: string }}
 */
export function parseLimitValue(key, raw) {
  const spec = LIMIT_SPECS[key];
  if (!spec) return { error: `${key}: chiave sconosciuta (ammesse: ${Object.keys(LIMIT_SPECS).join(', ')})` };
  const mostra = typeof raw === 'string' ? JSON.stringify(raw) : String(raw);
  const n = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return { error: `${key}: ${mostra} non è un numero` };
  if (n <= 0) return { error: `${key}: deve essere maggiore di zero (ricevuto ${mostra})` };
  if (spec.integer && !Number.isInteger(n)) return { error: `${key}: deve essere un numero intero (ricevuto ${mostra})` };
  if (n > spec.max) return { error: `${key}: oltre il massimo ammesso (${spec.max}, ricevuto ${mostra})` };
  return { value: n };
}

/**
 * #71 — il solo controllo di ESPOSIZIONE totale, estratto da `canOpen()` perché
 * serve anche all'aggiunta DCA. `canOpen()` conta pure le posizioni
 * concorrenti e il cooldown da perdite consecutive: due domande che per una
 * DCA non hanno senso (la posizione è già contata fra le concorrenti, e il
 * cooldown riguarda il RIENTRO a mercato, non la gestione di una posizione
 * aperta). L'esposizione invece sì: un'aggiunta impegna capitale nuovo
 * esattamente come un'apertura. Una sola implementazione, due chiamanti.
 *
 * `positions` contiene già la posizione che si sta mediando (con il suo
 * `positionValue`): il chiamante DCA passa come `plannedNotional` la sola
 * AGGIUNTA, mai il totale post-DCA, altrimenti la conterebbe due volte.
 *
 * FAIL-CLOSED su un totale non finito: prima un `plannedNotional` NaN rendeva
 * falso il confronto `>` e il controllo passava.
 *
 * Funzione PURA.
 * @returns {{ ok: boolean, reason?: string, totalNotional: number }}
 */
export function checkExposure({ positions, plannedNotional = 0, maxTotalExposureUsd }) {
  const list = Array.isArray(positions) ? positions : [];
  const totalNotional = list.reduce((s, p) => s + (p.positionValue || 0), 0) + plannedNotional;
  if (!Number.isFinite(totalNotional)) {
    return { ok: false, totalNotional, reason: `Esposizione totale non calcolabile (${totalNotional}), apertura negata per prudenza` };
  }
  // #79 — speculare: un TETTO non numerico rendeva falso il `>` qui sotto per
  // qualunque totale, cioè il limite spariva. Anche questo blocca.
  if (typeof maxTotalExposureUsd !== 'number' || !Number.isFinite(maxTotalExposureUsd)) {
    return { ok: false, totalNotional, reason: `Limite di esposizione totale non valido (${maxTotalExposureUsd}), apertura negata per prudenza` };
  }
  if (totalNotional > maxTotalExposureUsd) {
    return { ok: false, totalNotional, reason: `Esposizione totale ${totalNotional.toFixed(0)}$ oltre il limite (${maxTotalExposureUsd}$)` };
  }
  return { ok: true, totalNotional };
}

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
   *
   * #79 — e chiave per chiave: un valore già PERSISTITO e non valido (scritto
   * prima che `setLimits` validasse, es. `"abc"`) non deve spegnere il cap che
   * rappresenta. Per quella chiave vale il default, con un warn una volta sola
   * (`getLimits` gira a ogni tick di ogni bot). Le chiavi sconosciute non
   * escono: nessuno le legge, e restituirle le farebbe riscrivere a `setLimits`.
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
      const limits = { ...DEFAULTS };
      for (const [key, valore] of Object.entries(parsed)) {
        const { value, error } = parseLimitValue(key, valore);
        if (error) {
          const fallback = key in DEFAULTS ? `uso il default (${DEFAULTS[key]})` : 'ignorata';
          this._warnOnce(`Limite di portafoglio salvato non valido — ${error}: ${fallback}`);
          continue;
        }
        limits[key] = value;
      }
      return limits;
    } catch (error) {
      logger.warn('Limiti di portafoglio non leggibili, uso i default', error.message);
      return { ...DEFAULTS };
    }
  }

  /** Warn una volta per testo: chi legge i limiti a ogni tick non deve ripeterlo. */
  _warnOnce(riga) {
    if (!this._avvisiDati) this._avvisiDati = new Set();
    if (this._avvisiDati.has(riga)) return;
    this._avvisiDati.add(riga);
    logger.warn(riga);
  }

  /**
   * ASIMMETRIA VOLUTA rispetto a `getLimits()`: qui un errore di scrittura NON
   * viene ingoiato. Salvare i limiti è un'azione esplicita dell'utente, e
   * rispondere "salvato" a un salvataggio mai avvenuto lo farebbe operare convinto
   * di avere cap che non esistono. Un errore visibile è meglio.
   *
   * #79 — e per la stessa ragione si VALIDA prima di scrivere (vedi
   * `LIMIT_SPECS`): chiavi sconosciute o valori non validi → eccezione con
   * TUTTI i problemi in un solo messaggio (la rotta la traduce in 400), e
   * niente viene scritto — nemmeno i campi validi della stessa richiesta.
   * Un salvataggio a metà lascerebbe in vigore una combinazione di limiti che
   * nessuno ha scelto.
   */
  setLimits(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('Limiti di portafoglio non validi: serve un oggetto { chiave: valore }');
    }
    const problemi = [];
    const valori = {};
    for (const [key, raw] of Object.entries(obj)) {
      const { value, error } = parseLimitValue(key, raw);
      if (error) problemi.push(error);
      else valori[key] = value;
    }
    if (problemi.length) {
      throw new Error(`Limiti di portafoglio non validi, nessuna modifica salvata: ${problemi.join('; ')}`);
    }
    const merged = { ...this.getLimits(), ...valori };
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
   * CRIT-LOSSLOCK-25 — ma quel ramo deve avere una FINE. Deciso solo sul
   * conteggio, si azzerava unicamente con una chiusura non in perdita: e per
   * chiudere bisogna aprire, cosa che il ramo stesso impedisce. La condizione
   * di uscita era irraggiungibile dall'interno, cioè non un cooldown ma un
   * blocco definitivo con l'etichetta di un cooldown (BTC/BNB/AVAX in
   * produzione, fermi 4+ ore con `"3 perdite consecutive → cooldown 60 min"`
   * ripetuto ogni 10 secondi). La durata è quella già dichiarata,
   * `cooldownMinutes`, contata dall'ULTIMA perdita — `lastLossAt`.
   *
   * `lastLossAt` non noto resta bloccante: non sapere QUANDO si è perso non è
   * sapere che la finestra è passata. Chi non può fornirlo (il backtester, una
   * diagnostica) vede il comportamento storico, invariato.
   *
   * `reservedSlots` sono le aperture dello stesso wallet già impegnate ma non
   * ancora presenti in `account.positions` (lo snapshot è letto a inizio tick e
   * non vede le aperture in volo degli altri bot). Contarle qui è ciò che rende
   * `maxConcurrentPositions` un limite di WALLET e non di singolo mercato: senza,
   * due bot su coin diverse leggono entrambi "2 su 3" e arrivano a 4. Resta un
   * parametro del chiamante — chi non ha aperture in volo da dichiarare (il
   * backtester, il gate advisory) passa 0 e la funzione resta pura e
   * deterministica.
   *
   * @param {object} p { account, plannedNotional, botId, consecutiveLosses, reservedSlots, lastLossAt, now }
   * @returns { ok, reason, cooldownUntil? }
   */
  canOpen({ account, plannedNotional = 0, botId, consecutiveLosses = 0, reservedSlots = 0, lastLossAt = null, now = Date.now() }) {
    const L = this.getLimits();

    // #79 — FAIL-CLOSED su un limite non numerico: ogni confronto con NaN è
    // falso, quindi il limite sparirebbe invece di bloccare. `getLimits` già
    // ripiega sui default; questa è la difesa per chi arriva qui per altre vie.
    for (const key of Object.keys(LIMIT_SPECS)) {
      if (typeof L[key] !== 'number' || !Number.isFinite(L[key])) {
        return { ok: false, reason: `Limite di portafoglio ${key} non valido (${L[key]}), apertura negata per prudenza` };
      }
    }

    const until = this.cooldownInfo(botId);
    if (until) {
      // cooldownUntil (il timestamp grezzo, non la stringa formattata) è quello
      // che il chiamante usa per capire se è ancora lo STESSO episodio di cooldown
      // o uno nuovo — senza, un tick ogni 10s per un'ora intera manda la stessa
      // notifica centinaia di volte (successo davvero, vedi bot.js).
      return { ok: false, reason: `In cooldown fino alle ${new Date(until).toLocaleTimeString('it-IT')}`, cooldownUntil: until };
    }

    const positions = account.positions || [];
    const pending = Math.max(0, reservedSlots);
    if (positions.length + pending >= L.maxConcurrentPositions) {
      // La ragione distingue i due addendi: "3 su 3" con una posizione ancora in
      // volo non è lo stesso caso di "3 su 3" già a book, e in diagnosi la
      // differenza conta.
      const detail = pending > 0 ? ` — ${positions.length} aperte + ${pending} in apertura` : '';
      return { ok: false, reason: `Max posizioni concorrenti (${L.maxConcurrentPositions}) raggiunto${detail}` };
    }

    const exposure = checkExposure({ positions, plannedNotional, maxTotalExposureUsd: L.maxTotalExposureUsd });
    if (!exposure.ok) return { ok: false, reason: exposure.reason };

    if (consecutiveLosses >= L.maxConsecutiveLosses) {
      // Nessuna scrittura qui: l'attivazione è di `recordLoss()`.
      const ultima = Number(lastLossAt);
      const scadenza = Number.isFinite(ultima) && ultima > 0
        ? ultima + L.cooldownMinutes * 60000
        : null;
      if (scadenza != null && now >= scadenza) {
        // Finestra esaurita: la serie di perdite resta, ma il bot deve poter
        // rientrare a mercato — è l'unico modo che ha di spezzarla.
        return { ok: true };
      }
      return {
        ok: false,
        reason: scadenza != null
          ? `${consecutiveLosses} perdite consecutive → cooldown ${L.cooldownMinutes} min (fino alle ${new Date(scadenza).toLocaleTimeString('it-IT')})`
          : `${consecutiveLosses} perdite consecutive → cooldown ${L.cooldownMinutes} min (istante dell'ultima perdita ignoto, blocco prudenziale)`,
        // Presente solo quando c'è una scadenza vera: è il discriminante con
        // cui il chiamante notifica una volta per episodio invece che a ogni
        // tick. Senza scadenza non c'è episodio da chiudere, e inventarne una
        // farebbe tacere un blocco che invece va guardato.
        cooldownUntil: scadenza ?? undefined
      };
    }

    return { ok: true };
  }
}

export default new Portfolio();
