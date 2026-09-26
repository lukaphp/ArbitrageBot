/**
 * PAPER BROKER (forward-test live)
 * ================================
 *
 * Esecuzione SIMULATA sui prezzi reali in tempo reale: stessa pipeline dei bot
 * live (segnali, gate, gestione posizione) ma NESSUN ordine reale parte. Riempe
 * gli ordini al mid corrente ± il COSTO di esecuzione simulato (`DEFAULT_SLIPPAGE`,
 * non la tolleranza dell'ordine — vedi `simulatedSlippage`) e applica le stesse
 * fee taker del backtester, così il forward-test riflette costi realistici.
 *
 * Espone il sottoinsieme dell'interfaccia di hyperliquidClient usato da PerpsBot,
 * così il bot può usarlo come "broker" trasparente quando config.paper === true.
 *
 * È il ponte mancante tra backtest e mainnet: valida la strategia su mercato
 * reale, in avanti, senza rischiare capitale.
 */

import client from './hyperliquidClient.js';
import db from '../db/database.js';
import logger from '../utils/logger.js';

const TAKER_FEE_PCT = 0.00035;
// Costo di esecuzione SIMULATO, per lato. È lo stesso valore del backtester
// (`DEFAULT_SLIPPAGE_PCT` in backtester.js): forward-test e backtest devono
// costare uguale, altrimenti non sono confrontabili.
const DEFAULT_SLIPPAGE = 0.0005;
const START_EQUITY = parseFloat(process.env.PAPER_START_EQUITY) || 10000;

// QUAL-01 item 3 — stato persistito in `settings`, chiave singola.
const STATE_KEY = 'paper_broker_state';
// I fill servono a `getRealizedPnl`, che guarda solo quelli dall'apertura della
// posizione in corso: oltre questa finestra sono storia già aggregata in
// `positions`/`trades`. Un forward-test lungo mesi non deve gonfiare senza limite
// una riga di `settings`.
const MAX_PERSISTED_FILLS = 500;

/**
 * Slippage REALIZZATO da simulare su un fill, dato il parametro `slippage` che
 * il chiamante passa a `placeMarketOrder`.
 *
 * CRIT #16 — sono due grandezze diverse e vanno tenute distinte:
 *  - il parametro del chiamante è una TOLLERANZA: `hyperliquidClient.placeMarketOrder`
 *    ci costruisce il limit IoC aggressivo (`mid ± slippage`), cioè il prezzo
 *    PEGGIORE accettabile. `bot._openPosition` e `bot._maybeDca` passano
 *    `config.slippage ?? 0.02`, cioè il 2%;
 *  - il COSTO di esecuzione atteso è un'altra cosa, dell'ordine dei punti base
 *    (`DEFAULT_SLIPPAGE`), ed è ciò che il fill simulato deve pagare — sul
 *    mercato vero il fill arriva dal book, non dal limit price.
 *
 * Usare la tolleranza come costo riempiva ogni ordine paper al 2% dal mid: con
 * uno SL all'1.5% la posizione nasceva GIÀ oltre il proprio stop e moriva alla
 * prima valutazione dei trigger, in entrambe le direzioni e a mercato fermo
 * (flotta OPS-FLEET-02 del 15/09: 18 trade su 18 in perdita, ~218 USD).
 *
 * Un IoC però non si riempie mai PEGGIO del proprio limit price: se il chiamante
 * indica una tolleranza più stretta del modello, è quella a valere.
 */
export function simulatedSlippage(tolerance) {
  const tol = Number(tolerance);
  if (!Number.isFinite(tol) || tol < 0) return DEFAULT_SLIPPAGE;
  return Math.min(tol, DEFAULT_SLIPPAGE);
}

/**
 * Margine con cui `getRealizedPnl` allarga all'indietro la finestra dei fill.
 *
 * NON è arbitrario e non va stretto per "sicurezza": `bot._registerClose` passa
 * `position.openedAt`, cioè il `Date.now()` scritto in DB DOPO che il fill di
 * apertura è già avvenuto. Senza margine il fill di apertura — e quindi la sua
 * FEE — cadrebbe fuori dalla finestra, e il `net` di ogni trade risulterebbe
 * migliore del vero. Il margine copre lo scarto fra il fill e la scrittura.
 */
const OPEN_FILL_MARGIN_MS = 1000;

/**
 * ISSUE #18 — quali fill, fra quelli nella finestra temporale, appartengono
 * davvero alla posizione CORRENTE.
 *
 * IL DIFETTO. La finestra è `openedAt - OPEN_FILL_MARGIN_MS` (vedi sopra: serve
 * a non perdere il fill di apertura). Il margine però è cieco su cosa lascia
 * entrare: se sulla STESSA coin una posizione riapre entro un secondo dalla
 * chiusura della precedente, dentro la finestra finisce anche il fill di
 * CHIUSURA di quella precedente e il suo `closedPnl` viene sommato al PnL della
 * posizione corrente. Misurato in produzione sulla flotta OPS-FLEET-02: `pnl
 * -22.95` su un trade che valeva `-11.6`, cioè due chiusure contate come una.
 *
 * PERCHÉ NON SI RISOLVE STRINGENDO IL MARGINE. Un margine più piccolo non
 * elimina la sovrapposizione, la rende solo più rara e più difficile da
 * riprodurre — e toglie la garanzia per cui il margine esiste. La finestra
 * temporale non è lo strumento giusto per separare due posizioni: la separazione
 * è STRUTTURALE.
 *
 * SERVONO DUE PASSAGGI, e nessuno dei due basta da solo. Li ho scoperti in
 * quest'ordine, e li lascio scritti perché il secondo sembra ridondante finché
 * non si guarda la forma vera dei dati.
 *
 * PASSO 1 — la CODA orfana in testa alla finestra. Il caso di produzione è
 * questo: la posizione precedente era aperta da molto (il suo `Open` è FUORI
 * finestra) e si è chiusa dentro. La finestra comincia quindi con una chiusura
 * senza apertura. Quei fill appartengono alla posizione precedente se, più
 * avanti, un `Open` comincia quella nuova — e in quel caso si scartano.
 * Se invece un `Open` non c'è affatto, quella coda è tutto ciò che si ha ed È la
 * posizione corrente: è il caso di una posizione ADOTTATA da `bot._reconcile`,
 * il cui `openedAt` è molto posteriore ai fill veri. Lì non si taglia niente —
 * tagliare butterebbe via un PnL misurato per sostituirlo con il fallback
 * dell'unrealized, cioè un numero inventato.
 *
 * PASSO 2 — la SIZE NETTA, per la posizione precedente contenuta INTERA nella
 * finestra (apertura compresa). Il passo 1 da solo non la vede: il primo `Open`
 * della finestra è il SUO, quindi non c'è nessuna coda orfana da tagliare e il
 * difetto sopravvive — verificato da test, era la mia prima versione del fix.
 * Si ripercorre allora la sequenza tenendo la size corrente (`Open …` somma,
 * `Close …` sottrae): ogni volta che torna a zero una posizione è finita e il
 * fill successivo ne apre un'altra. La posizione corrente è l'ULTIMO segmento.
 * Questo regge da solo tutti gli altri casi veri — il DCA (la size cresce, stesso
 * segmento), il TP parziale (la size scende ma non a zero, stesso segmento), la
 * chiusura piena (la size azzera, segmento chiuso).
 *
 * Non si confrontano timestamp: a pari millisecondo non sono ordinabili. Conta
 * l'ordine di inserimento in `acc.fills`, cronologico, che questa funzione
 * preserva.
 *
 * Funzione PURA (nessun I/O, nessuno stato): vive qui perché interpreta la
 * sequenza di fill, che è il dato di questo file, e non è matematica di rischio —
 * stessa scelta già fatta per `bot._classifyCloseFills`.
 *
 * @param {Array<{dir: string, sz: number}>} inWindow fill della coin già filtrati
 *   per finestra temporale, in ordine di inserimento
 * @returns {Array} l'ultimo segmento di `inWindow` (sottoinsieme, stesso ordine)
 */
export function fillsOfCurrentPosition(inWindow) {
  if (!Array.isArray(inWindow) || inWindow.length === 0) return [];

  const isOpen = (f) => /open/i.test(f?.dir || '');

  // PASSO 1 — nessuna apertura in finestra: è la coda di una posizione adottata,
  // non c'è confine da trovare e non si tocca niente.
  const firstOpen = inWindow.findIndex(isOpen);
  if (firstOpen < 0) return inWindow;
  // Scarta la coda orfana della posizione precedente.
  const fills = firstOpen > 0 ? inWindow.slice(firstOpen) : inWindow;

  // PASSO 2 — segmentazione sulla size netta. Da qui la sequenza comincia per
  // costruzione con un'apertura, quindi la size parte positiva e `peak > 0`
  // distingue una chiusura piena da una finestra malformata.
  const last = fills.length - 1;
  let start = 0;   // indice di inizio del segmento in corso
  let size = 0;    // size netta della posizione dentro il segmento
  let peak = 0;    // massimo raggiunto: serve alla tolleranza relativa

  for (let i = 0; i <= last; i++) {
    const f = fills[i];
    const sz = Number(f?.sz);
    // Una size illeggibile non sposta il confine e non propaga NaN: da sola non
    // può chiudere né aprire un segmento. Il chiamante la segnala.
    const delta = Number.isFinite(sz) ? Math.abs(sz) : 0;
    size += isOpen(f) ? delta : -delta;
    if (size > peak) peak = size;

    // Chiusura piena: la size torna a zero DOPO essere stata positiva.
    // La tolleranza è RELATIVA al massimo del segmento — un residuo così piccolo
    // non è una size scambiabile, è errore di arrotondamento sui float; una
    // soglia assoluta sarebbe sbagliata su coin con size dell'ordine di 1e-4.
    //
    // `peak > 0` è la guardia che distingue "posizione chiusa" da "size mai
    // salita": senza di essa una sequenza di size illeggibili (tutte 0) sarebbe
    // letta come una fila di posizioni chiuse e verrebbe tagliata via tutta.
    if (peak > 0 && size <= peak * 1e-6) {
      // Se il fill che chiude è l'ULTIMO della finestra, il segmento appena
      // concluso È la posizione corrente: `start` non si muove, altrimenti si
      // restituirebbe una lista vuota proprio nel caso che interessa
      // (`_registerClose` chiama subito dopo la chiusura).
      if (i < last) { start = i + 1; size = 0; peak = 0; }
    }
  }
  return start > 0 ? fills.slice(start) : fills;
}

/**
 * Unione di due liste di fill per IDENTITÀ del fill, non "l'ultima vince".
 *
 * I fill non si cancellano mai (cade solo la coda oltre `MAX_PERSISTED_FILLS`),
 * quindi l'unione non può resuscitare niente di eliminato apposta. Serve perché
 * `bot._registerClose` legge l'oid del fill di chiusura per sapere se ha chiuso
 * il TP o lo SL: un fill perso in una sovrascrittura è una chiusura attribuita
 * all'ordine sbagliato.
 */
function mergeFills(base, mine) {
  const a = Array.isArray(base) ? base : [];
  const b = Array.isArray(mine) ? mine : [];
  const idOf = (f) => `${f.time}|${f.oid}|${f.coin}|${f.dir}|${f.sz}`;
  const seen = new Set();
  const out = [];
  for (const f of [...a, ...b]) {
    const id = idOf(f);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(f);
  }
  out.sort((x, y) => (x.time || 0) - (y.time || 0));
  return out.slice(-MAX_PERSISTED_FILLS);
}

export class PaperBroker {
  constructor() {
    // master(lower) -> { equity, positions: Map<coin,{side,size,entryPx,leverage}>,
    //                    triggers: Map<coin,[{oid,tpsl,triggerPx,isBuy,size}]>,
    //                    leverage: Map<coin, number>,
    //                    fills: [{time,coin,dir,closedPnl,fee}], oidSeq }
    this.state = new Map();
    this._loaded = false;
    // CRIT #7 — DELTA di QUESTO processo dall'ultimo salvataggio riuscito:
    // key account -> { coins: Set<coin>|null (null = tutto l'account), equityDelta }.
    // È ciò che `_save()` applica sopra al blob riletto, invece di riscriverlo
    // intero con la propria fotografia (vedi `_save`).
    this._delta = new Map();
    // Account che questo processo ha toccato almeno una volta nella sua vita:
    // rete di sicurezza per un eventuale `_save()` senza chiave.
    this._touchedEver = new Set();
    // Ultima equity scritta da QUESTO processo, per account: serve a distinguere
    // «sul disco c'è quello che ho scritto io» da «qualcun altro l'ha cambiata».
    this._lastWrittenEquity = new Map();
    // Account su cui si è già segnalata una scrittura concorrente: il log serve
    // una volta per episodio, non a ogni salvataggio.
    this._concurrentWarned = new Set();
  }

  /**
   * QUAL-01 item 3 — ripristina lo stato simulato.
   *
   * Un riavvio azzerava il forward-test in corso: posizioni virtuali aperte,
   * trigger e PnL simulato spariti, equity di nuovo a `PAPER_START_EQUITY`. Il
   * paper mode serve a validare una strategia PRIMA di rischiare capitale reale,
   * e una serie di risultati che si azzera a ogni deploy non valida nulla.
   *
   * `oidSeq` è persistito con il resto e non è un dettaglio: gli oid dei trigger
   * sono ciò con cui `bot._classifyCloseFills` riconosce se ha chiuso il TP o lo
   * SL. Ripartendo da 1 dopo un riavvio, un oid nuovo potrebbe coincidere con uno
   * vecchio ancora tracciato in `trailing_json` e attribuire la chiusura
   * all'ordine sbagliato.
   *
   * Lazy come i cooldown di portafoglio (CRIT-02): il singleton nasce all'import,
   * quando il DB può non essere ancora inizializzato.
   */
  _load() {
    if (this._loaded) return this.state;
    this._loaded = true;
    try {
      const raw = db.getSetting(STATE_KEY);
      if (!raw) return this.state;
      const parsed = JSON.parse(raw) || {};
      for (const [key, acc] of Object.entries(parsed)) {
        this.state.set(key, {
          equity: Number.isFinite(Number(acc.equity)) ? Number(acc.equity) : START_EQUITY,
          positions: new Map(Object.entries(acc.positions || {})),
          triggers: new Map(Object.entries(acc.triggers || {})),
          // Assente negli stati salvati prima del fix sulla leva: si riparte da
          // vuoto, e le posizioni già aperte tengono la leva con cui sono nate.
          leverage: new Map(Object.entries(acc.leverage || {})),
          fills: Array.isArray(acc.fills) ? acc.fills : [],
          oidSeq: Number(acc.oidSeq) > 0 ? Number(acc.oidSeq) : 1
        });
        // Punto di riferimento per il merge: questa è l'equity che c'era sul
        // disco quando l'abbiamo letta. Se al prossimo salvataggio è diversa,
        // l'ha cambiata un altro processo e la nostra fotografia non vale.
        this._lastWrittenEquity.set(key, this.state.get(key).equity);
      }
      const positions = [...this.state.values()].reduce((n, a) => n + a.positions.size, 0);
      logger.info(`📝 Paper broker: stato ripristinato (${this.state.size} account, ${positions} posizioni simulate aperte)`);
    } catch (error) {
      // Degrado: si riparte da zero, ma detto — un forward-test che sembra
      // ricominciato da capo senza spiegazione è un dato che non si può leggere.
      logger.warn('Paper broker: stato simulato non ripristinabile, si riparte da zero', error.message);
    }
    return this.state;
  }

  /** Chiave di account: la stessa normalizzazione usata da `_acc`. */
  _key(master) {
    return (master || 'paper').toLowerCase();
  }

  /**
   * Registra che questo processo ha agito su (account, coin). È l'informazione
   * che permette a `_save()` di scrivere SOLO il proprio delta: senza, l'unica
   * cosa che il salvataggio sa è «ecco tutto quello che ho in memoria», e
   * quell'«tutto» comprende account e coin che un altro processo ha cambiato
   * dopo il nostro `_load()`.
   *
   * `coin` null = l'intero account è da riscrivere (percorso di compatibilità).
   */
  _touch(master, coin = null) {
    const key = this._key(master);
    this._touchedEver.add(key);
    let d = this._delta.get(key);
    if (!d) { d = { coins: new Set(), equityDelta: 0 }; this._delta.set(key, d); }
    if (coin == null) d.coins = null;
    else if (d.coins) d.coins.add(coin);
    return key;
  }

  /**
   * Unico punto in cui l'equity simulata cambia. Passa dal delta perché
   * sull'account CONDIVISO fra due processi l'equity non è ricostruibile
   * dall'ultima fotografia di uno dei due: è un contatore, e si compone
   * sommando le variazioni, non sovrascrivendo il totale.
   */
  _applyEquity(acc, master, amount) {
    acc.equity += amount;
    const key = this._touch(master);
    this._delta.get(key).equityDelta += amount;
  }

  /**
   * Assegna il prossimo oid CONTROLLANDO PRIMA il contatore persistito.
   *
   * Il merge di `_save()` tiene `oidSeq` monotono, ma arriverebbe troppo tardi:
   * l'oid viene coniato PRIMA del salvataggio, e se la memoria di questo
   * processo è indietro (un altro processo ha aperto/protetto posizioni dopo il
   * nostro `_load()`) l'oid appena assegnato è già vivo altrove. È il danno
   * concreto dell'incidente del 12/09: `oidSeq` tornato da 37 a 35 con due
   * trigger ancora citati in `trailing_json` a quei numeri — e l'oid è ciò con
   * cui `bot._classifyCloseFills` distingue una chiusura da TP da una da SL.
   *
   * Costa una lettura di `settings` per ORDINE (non per tick): il ciclo di vita
   * di una posizione ne fa una manciata.
   */
  _nextOid(acc, master) {
    const persisted = this._readPersisted();
    const diskSeq = Number(persisted?.[this._key(master)]?.oidSeq) || 0;
    if (diskSeq > acc.oidSeq) acc.oidSeq = diskSeq;
    return acc.oidSeq++;
  }

  /** Il blob persistito così com'è adesso. `null` = presente ma illeggibile. */
  _readPersisted() {
    try {
      const raw = db.getSetting(STATE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Fotografia serializzabile di un account in memoria. */
  _serialize(acc) {
    return {
      equity: acc.equity,
      positions: Object.fromEntries(acc.positions),
      triggers: Object.fromEntries(acc.triggers),
      leverage: Object.fromEntries(acc.leverage),
      fills: acc.fills.slice(-MAX_PERSISTED_FILLS),
      oidSeq: acc.oidSeq
    };
  }

  /**
   * Fonde lo stato in memoria di UN account con quello che c'è su disco,
   * applicando solo ciò che questo processo ha davvero cambiato.
   *
   *  - `positions`/`triggers`/`leverage`: per COIN. Le coin toccate prendono la
   *    versione in memoria (assente = rimossa davvero: una chiusura deve
   *    cancellare, non essere ripescata dal disco); le altre restano quelle
   *    persistite, che possono venire da un altro processo.
   *  - `oidSeq`: MONOTONO, si prende il massimo e lo si adotta anche in memoria.
   *    È il guasto più pericoloso dell'incidente: un contatore che retrocede
   *    riassegna oid ancora vivi, e l'oid è ciò con cui si riconosce se a
   *    chiudere è stato il TP o lo SL.
   *  - `equity`: se sul disco c'è ancora il valore che abbiamo scritto noi,
   *    vince la memoria (nessuna deriva numerica); se l'ha cambiato qualcun
   *    altro, si applica il nostro delta sopra al suo valore.
   *  - `fills`: unione per identità del fill. Un fill non si cancella mai (solo
   *    la finestra di ritenzione lo lascia cadere), quindi l'unione è sicura e
   *    preserva le chiusure registrate dall'altro processo.
   */
  _mergeAccount(key, acc, base) {
    const mem = this._serialize(acc);
    if (!base || typeof base !== 'object') return mem;

    const d = this._delta.get(key);
    const coins = d ? d.coins : null;
    const out = {
      positions: { ...(base.positions || {}) },
      triggers: { ...(base.triggers || {}) },
      leverage: { ...(base.leverage || {}) }
    };
    if (!coins) {
      out.positions = mem.positions;
      out.triggers = mem.triggers;
      out.leverage = mem.leverage;
    } else {
      for (const coin of coins) {
        for (const field of ['positions', 'triggers', 'leverage']) {
          if (mem[field][coin] !== undefined) out[field][coin] = mem[field][coin];
          else delete out[field][coin];
        }
      }
    }

    const oidSeq = Math.max(Number(mem.oidSeq) || 1, Number(base.oidSeq) || 1);
    acc.oidSeq = oidSeq;

    const baseEq = Number.isFinite(Number(base.equity)) ? Number(base.equity) : mem.equity;
    // `mine` = l'equity di questo account quando l'abbiamo letta o scritta noi
    // l'ultima volta (`_load` la registra, `_save` la aggiorna). Indefinita =
    // l'account è comparso sul disco dopo, cioè l'ha scritto qualcun altro.
    const mine = this._lastWrittenEquity.get(key);
    const changedUnderUs = mine !== undefined && Math.abs(baseEq - mine) > 1e-9;
    const foreign = mine === undefined || changedUnderUs;
    let equity = mem.equity;
    if (foreign) {
      equity = baseEq + (d ? d.equityDelta : 0);
      acc.equity = equity; // la memoria adotta il totale vero, non la sua metà
      if (changedUnderUs && !this._concurrentWarned.has(key)) {
        this._concurrentWarned.add(key);
        logger.warn(`Paper broker: l'account ${key} è scritto anche da un altro processo (equity cambiata sotto di noi). Lo stato viene fuso, ma posizioni e trigger della stessa coin restano last-writer-wins: l'esecuzione di quel bot dovrebbe stare in UN solo processo.`);
      }
    }

    return {
      equity,
      positions: out.positions,
      triggers: out.triggers,
      leverage: out.leverage,
      fills: mergeFills(base.fills, mem.fills),
      oidSeq
    };
  }

  /**
   * Salva lo stato simulato con RELOAD-AND-MERGE (CRIT #7).
   *
   * Prima riscriveva il blob intero con la memoria del processo chiamante: due
   * processi sullo stesso container (Express e MCP Stdio) si cancellavano a
   * vicenda le scritture, e il 12/09/2026 questo ha riportato i trigger TP/SL di
   * una posizione live ai livelli di un bot cancellato 12 minuti prima. Ora si
   * rilegge quello che c'è, si applica sopra SOLO il delta di questo processo e
   * si riscrive il risultato.
   *
   * È una rete di sicurezza allo STORAGE, non un lock: protegge anche scenari
   * futuri con più istanze. Quello che NON può fare è decidere chi ha ragione su
   * una coin che due processi stanno muovendo insieme — per quello serve un
   * esecutore unico (parte 1 della stessa issue).
   *
   * Un errore di scrittura non interrompe la simulazione, ma non è silenzioso.
   *
   * @param {string|null} touchedKey account su cui il chiamante ha appena agito.
   */
  _save(touchedKey = null) {
    try {
      const persisted = this._readPersisted();
      const keys = new Set(this._delta.keys());
      if (touchedKey) keys.add(touchedKey);
      // Chiamata senza chiave e senza delta (nessun chiamante interno oggi): si
      // riscrivono gli account che questo processo ha toccato nella sua vita —
      // mai quelli che non ha mai visto, e mai un no-op silenzioso.
      if (!keys.size) for (const k of this._touchedEver) keys.add(k);

      let out;
      if (persisted === null) {
        // Blob presente ma illeggibile: non c'è niente da preservare. Si riscrive
        // lo stato di questo processo — meglio di un blob che nessuno può leggere.
        logger.warn('Paper broker: stato persistito illeggibile, riscritto con lo stato di questo processo');
        out = {};
        for (const [k, acc] of this.state) out[k] = this._serialize(acc);
      } else {
        out = { ...persisted };
        for (const key of keys) {
          const acc = this.state.get(key);
          if (!acc) continue;
          out[key] = this._mergeAccount(key, acc, persisted[key]);
        }
      }

      db.setSetting(STATE_KEY, JSON.stringify(out));
      for (const [k, v] of Object.entries(out)) this._lastWrittenEquity.set(k, Number(v.equity));
      this._delta.clear();
      return true;
    } catch (error) {
      logger.warn('Paper broker: stato simulato non persistito', error.message);
      return false;
    }
  }

  _acc(master) {
    this._load();
    const key = this._key(master);
    if (!this.state.has(key)) {
      this.state.set(key, { equity: START_EQUITY, positions: new Map(), triggers: new Map(), leverage: new Map(), fills: [], oidSeq: 1 });
    }
    const acc = this.state.get(key);
    // Account ripristinato da uno stato salvato prima del fix sulla leva.
    if (!acc.leverage) acc.leverage = new Map();
    return acc;
  }

  roundPx(px) { return client.roundPx(px); }
  async getMid(coin, network) { return client.getMid(coin, network); }

  /**
   * Leva dell'account per coin. Non era un no-op innocuo: il valore ricevuto
   * veniva buttato e `placeMarketOrder` scriveva `leverage: 1` fisso, così
   * `marginUsed` in `getAccount()` risultava sbagliato di un fattore pari alla
   * leva reale (3x sulla flotta OPS-FLEET-02 → margine apparente 3 volte il
   * vero). Su Hyperliquid la leva è stato di account per coin, non un campo
   * dell'ordine: la si ricorda qui, come fa l'exchange, e la si applica al fill.
   * Stessa firma posizionale di `hyperliquidClient.setLeverage`.
   */
  async setLeverage(masterAddress, coin, leverage) {
    const acc = this._acc(masterAddress);
    const lev = Number(leverage);
    if (coin && Number.isFinite(lev) && lev > 0) {
      acc.leverage.set(coin, lev);
      this._save(this._touch(masterAddress, coin));
      return { ok: true, paper: true, leverage: lev };
    }
    // Valore non utilizzabile: non si inventa una leva e non si sporca lo stato.
    // Il fallback a 1 resta in `placeMarketOrder`, dove è visibile.
    logger.warn(`Paper broker: leva non valida per ${coin} (${leverage}), stato invariato`);
    return { ok: true, paper: true, leverage: acc.leverage.get(coin) ?? null };
  }

  /** Valuta i trigger (TP/SL) virtuali contro il mid corrente e chiude se colpiti. */
  async _evaluateTriggers(master, network) {
    const acc = this._acc(master);
    for (const [coin, pos] of [...acc.positions]) {
      const trigs = acc.triggers.get(coin) || [];
      const mid = await client.getMid(coin, network).catch(() => null);
      if (mid == null) continue;
      for (const t of trigs) {
        const hit = pos.side === 'long'
          ? (t.tpsl === 'sl' ? mid <= t.triggerPx : mid >= t.triggerPx)
          : (t.tpsl === 'sl' ? mid >= t.triggerPx : mid <= t.triggerPx);
        if (hit) {
          // L'oid del fill è quello del TRIGGER che è scattato, non uno nuovo:
          // è la semantica di Hyperliquid (un ordine trigger che si attiva
          // produce un fill che porta il suo stesso oid) ed è ciò che permette
          // a `bot._registerClose` di sapere se ha chiuso il TP o lo SL.
          // Prima quest'informazione veniva scartata qui dentro.
          //
          // ISSUE #17 — anche `t.size` va passata: con `config.partialTp` ogni
          // gradino della scala è un trigger dimensionato su una FRAZIONE della
          // posizione (`bot._placeTpSl`), e chiudere tutto ignorava la strategia
          // configurata. `_fillClose` la limita comunque al residuo.
          const res = this._fillClose(master, coin, t.triggerPx, `trigger ${t.tpsl}`,
            { oid: t.oid, size: t.size });
          // Un ordine eseguito non è più sul book: se restasse, al tick
          // successivo ri-scatterebbe allo stesso prezzo e mangerebbe un'altra
          // fetta del residuo, all'infinito. Su una chiusura totale
          // `_fillClose` ha già rimosso l'intera lista.
          if (res?.partial) this._removeTrigger(master, coin, t.oid);
          // Si ferma al primo trigger colpito anche quando la chiusura è
          // parziale: un eventuale secondo gradino già in-the-money scatta al
          // tick seguente e, visto che il fill avviene esattamente al suo
          // `triggerPx`, il PnL è identico — cambia solo di qualche secondo il
          // momento in cui viene registrato.
          break;
        }
      }
    }
  }

  /** Rimuove un trigger consumato senza toccare gli altri della stessa coin. */
  _removeTrigger(master, coin, oid) {
    const acc = this._acc(master);
    const list = (acc.triggers.get(coin) || []).filter(t => t.oid !== oid);
    if (list.length) acc.triggers.set(coin, list);
    else acc.triggers.delete(coin);
    this._save(this._touch(master, coin));
  }

  /**
   * Quanta size chiude davvero un ordine, data quella richiesta.
   *
   * Tutti gli ordini di chiusura del bot sono reduce-only: su Hyperliquid non
   * possono mai girare la posizione né aprirne una nuova, qualunque size
   * portino. Serve perché fra un TP parziale e il primo aggiornamento del
   * trailing lo SL sul book è ancora dimensionato sulla posizione PIENA
   * (`bot._placeTpSl` lo piazza all'apertura, `_manageOpen` lo ridimensiona solo
   * quando il trailing si muove): senza questo limite il paper chiuderebbe più
   * size di quanta ne esista, inventando uno short fantasma e un PnL che sul
   * mercato vero non si sarebbe realizzato.
   *
   * `size` assente o non utilizzabile = «chiudi tutto»: è il percorso storico
   * (chiusure a mercato, e i trigger salvati prima di questo fix, che non
   * avevano il campo).
   */
  _closableSize(pos, size) {
    const want = Number(size);
    if (!Number.isFinite(want) || want <= 0) return pos.size;
    return Math.min(want, pos.size);
  }

  /**
   * Registra la chiusura simulata e realizza il PnL (netto fee).
   *
   * ISSUE #17 — la chiusura può essere PARZIALE. Con `config.partialTp` il bot
   * piazza una scala di trigger, ognuno su una frazione della posizione: quando
   * uno scatta deve RIDURRE la posizione, non cancellarla. Il residuo conserva
   * il suo `entryPx` (una riduzione non media niente, a differenza del DCA) e i
   * suoi trigger rimanenti — in particolare lo stop, che resta la protezione del
   * resto della posizione.
   *
   * @param meta.oid oid dell'ordine che ha prodotto la chiusura (trigger scattato
   *        o ordine di mercato). Va nel fill, come su Hyperliquid.
   * @param meta.size size da chiudere; assente = l'intera posizione. Viene
   *        comunque limitata al residuo (vedi `_closableSize`).
   * @returns { closedPnl, fee, size, partial } — `partial` dice al chiamante se
   *        la posizione è ancora viva, cioè se i trigger superstiti vanno gestiti.
   */
  _fillClose(master, coin, px, reason, { oid = null, size = null } = {}) {
    const acc = this._acc(master);
    const pos = acc.positions.get(coin);
    if (!pos) return null;
    const closeSize = this._closableSize(pos, size);
    const remaining = pos.size - closeSize;
    // Il residuo che resta è polvere di arrotondamento (una scala di portion che
    // somma a 1 non torna mai esatta dopo `roundSize`): è una chiusura totale,
    // non una posizione aperta da 1e-15 che nessun trigger chiuderà mai.
    const partial = remaining > 0 && remaining > pos.size * 1e-9;

    const notional = closeSize * px;
    const fee = notional * TAKER_FEE_PCT;
    const gross = pos.side === 'long' ? (px - pos.entryPx) * closeSize : (pos.entryPx - px) * closeSize;
    const closedPnl = gross;
    this._applyEquity(acc, master, closedPnl - fee);
    acc.fills.push({ time: Date.now(), coin, dir: `Close ${pos.side === 'long' ? 'Long' : 'Short'}`, px, sz: closeSize, fee, closedPnl, oid });
    if (partial) {
      pos.size = remaining;
    } else {
      acc.positions.delete(coin);
      acc.triggers.delete(coin);
    }
    logger.debug(`📝 Paper close ${coin} @ ${px} (${reason}) sz=${closeSize}${partial ? `/${closeSize + remaining} (parziale, residuo ${remaining})` : ''} pnl=${closedPnl.toFixed(2)} fee=${fee.toFixed(2)}`);
    this._save(this._touch(master, coin));
    return { closedPnl, fee, size: closeSize, partial };
  }

  async getAccount(master, network) {
    await this._evaluateTriggers(master, network);
    return this._snapshot(this._acc(master), network);
  }

  /**
   * LETTURA PURA dello stato simulato: stessa forma di `getAccount()`, ma
   *
   *  - **non valuta i trigger**, quindi non esegue nessun fill;
   *  - **non crea l'account** se non esiste: torna `null`.
   *
   * Serve alle rotte HTTP aggregate (`/api/perps/account`, `/api/perps/risk`).
   * `getAccount()` non è una query: fa scattare TP/SL simulati come effetto
   * collaterale, ed è giusto così sul percorso del tick — è lì che
   * `bot._registerClose` raccoglie il fill, scrive il trade e chiude la riga
   * `positions`. Chiamarla da una rotta significherebbe invece eseguire chiusure
   * simulate al ritmo del refresh della dashboard, anche per un bot FERMO, che
   * di tick non ne ha: il fill resterebbe senza nessuno che lo registri.
   *
   * Il `null` su account sconosciuto non è un dettaglio: `_acc()` materializza
   * un conto nuovo da `PAPER_START_EQUITY` al primo accesso, e in lettura
   * significherebbe mostrare 10.000$ di equity simulata a qualunque wallet ci si
   * colleghi — un numero inventato, indistinguibile da uno misurato.
   */
  async peekAccount(master, network) {
    this._load();
    const acc = this.state.get(this._key(master));
    if (!acc) return null;
    return this._snapshot(acc, network);
  }

  /**
   * Fotografia marcata a mercato di un account simulato. Nessuna scrittura:
   * è la parte in comune fra `getAccount()` e `peekAccount()`.
   */
  async _snapshot(acc, network) {
    const positions = [];
    let unrealized = 0;
    for (const [coin, pos] of acc.positions) {
      const mid = await client.getMid(coin, network).catch(() => pos.entryPx);
      const upnl = pos.side === 'long' ? (mid - pos.entryPx) * pos.size : (pos.entryPx - mid) * pos.size;
      unrealized += upnl;
      positions.push({
        coin, side: pos.side, size: pos.size, entryPx: pos.entryPx,
        positionValue: pos.size * mid, unrealizedPnl: upnl, leverage: pos.leverage,
        liquidationPx: null, marginUsed: (pos.size * pos.entryPx) / (pos.leverage || 1)
      });
    }
    const equity = acc.equity + unrealized;
    return { accountValue: acc.equity, equity, totalMarginUsed: 0, totalNtlPos: 0, withdrawable: equity, spotUsdc: 0, positions };
  }

  async placeMarketOrder({ masterAddress, coin, isBuy, size, slippage = DEFAULT_SLIPPAGE, reduceOnly = false }, network) {
    const acc = this._acc(masterAddress);
    const mid = await client.getMid(coin, network);
    if (!mid) return { error: `Prezzo non disponibile per ${coin}` };
    // CRIT #16: il fill paga il costo di esecuzione simulato, NON la tolleranza
    // del chiamante (vedi `simulatedSlippage`).
    const slip = simulatedSlippage(slippage);
    const px = client.roundPx(isBuy ? mid * (1 + slip) : mid * (1 - slip));
    const oid = this._nextOid(acc, masterAddress);
    const existing = acc.positions.get(coin);

    if (reduceOnly || (existing && existing.side === (isBuy ? 'short' : 'long'))) {
      // Chiusura (riduzione totale: i bot chiudono l'intera size)
      this._fillClose(masterAddress, coin, px, 'market reduce', { oid });
    } else if (existing && existing.side === (isBuy ? 'long' : 'short')) {
      // DCA: media il prezzo d'ingresso
      const newSize = existing.size + size;
      existing.entryPx = (existing.entryPx * existing.size + px * size) / newSize;
      existing.size = newSize;
      // La leva è stato di account per coin: un'aggiunta non la cambia (il bot
      // non ripassa da `setLeverage` per il DCA). Si completa solo se manca del
      // tutto, cioè su posizioni aperte prima di questo fix.
      existing.leverage = existing.leverage || acc.leverage.get(coin) || 1;
      const fee = px * size * TAKER_FEE_PCT;
      this._applyEquity(acc, masterAddress, -fee);
      acc.fills.push({ time: Date.now(), coin, dir: `Open ${existing.side === 'long' ? 'Long' : 'Short'}`, px, sz: size, fee, closedPnl: 0, oid });
    } else {
      // Apertura nuova
      const side = isBuy ? 'long' : 'short';
      // Leva reale impostata dal bot prima dell'apertura (`setLeverage`); 1 solo
      // se nessuno l'ha mai impostata per questa coin.
      acc.positions.set(coin, { side, size, entryPx: px, leverage: acc.leverage.get(coin) || 1 });
      const fee = px * size * TAKER_FEE_PCT;
      this._applyEquity(acc, masterAddress, -fee);
      acc.fills.push({ time: Date.now(), coin, dir: `Open ${side === 'long' ? 'Long' : 'Short'}`, px, sz: size, fee, closedPnl: 0, oid });
    }
    this._save(this._touch(masterAddress, coin));
    return { oid, avgPx: px, totalSz: size, error: null, paper: true };
  }

  async placeTriggerOrder({ masterAddress, coin, isBuy, size, triggerPx, tpsl }, network) {
    const acc = this._acc(masterAddress);
    const px = client.roundPx(triggerPx);
    const oid = this._nextOid(acc, masterAddress);
    const list = acc.triggers.get(coin) || [];
    list.push({ oid, tpsl, triggerPx: px, isBuy, size });
    acc.triggers.set(coin, list);
    this._save(this._touch(masterAddress, coin));
    return { oid, avgPx: null, error: null, paper: true };
  }

  async cancelOrder({ masterAddress, coin, oid }) {
    const acc = this._acc(masterAddress);
    const list = (acc.triggers.get(coin) || []).filter(t => t.oid !== oid);
    acc.triggers.set(coin, list);
    this._save(this._touch(masterAddress, coin));
    return { ok: true, paper: true };
  }

  async closePosition({ masterAddress, coin }, network) {
    const acc = this._acc(masterAddress);
    const pos = acc.positions.get(coin);
    if (!pos) throw new Error(`Nessuna posizione aperta su ${coin}`);
    const mid = await client.getMid(coin, network);
    const px = client.roundPx(pos.side === 'long' ? mid * (1 - DEFAULT_SLIPPAGE) : mid * (1 + DEFAULT_SLIPPAGE));
    // L'oid si genera PRIMA del fill: deve finirci dentro, così una chiusura
    // esterna al bot resta distinguibile da un trigger scattato.
    const oid = this._nextOid(acc, masterAddress);
    const requestedSz = pos.size;
    this._fillClose(masterAddress, coin, px, 'closePosition', { oid });
    // ISSUE #55 — stessa chiave di `hyperliquidClient.closePosition`: i chiamanti
    // interpretano l'esito con `interpretCloseResult` senza sapere quale dei due
    // broker hanno davanti. `totalSz` resta assente di proposito (il paper riempie
    // sempre tutto): è il caso `sizeKnown: false` già gestito.
    return { oid, avgPx: px, error: null, paper: true, requestedSz };
  }

  /** Ordini trigger "aperti" nel formato del frontend (per _ensureStopLoss). */
  async getFrontendOpenOrders(masterAddress) {
    const acc = this._acc(masterAddress);
    const out = [];
    for (const [coin, list] of acc.triggers) {
      for (const t of list) {
        out.push({ coin, side: t.isBuy ? 'buy' : 'sell', sz: t.size, limitPx: t.triggerPx,
          isTrigger: true, triggerPx: t.triggerPx, orderType: t.tpsl === 'sl' ? 'Stop Market' : 'Take Profit Market',
          isPositionTpsl: true, oid: t.oid });
      }
    }
    return out;
  }

  /**
   * PnL realizzato simulato dai fill di chiusura dal timestamp indicato.
   * `closingFills` espone i fill veri e propri (con il loro `oid`): serve a
   * `bot._registerClose` per capire QUALE ordine ha chiuso la posizione senza
   * fare una seconda lettura. Stessa forma di `hyperliquidClient.getRealizedPnl`.
   *
   * ISSUE #18 — il margine di `OPEN_FILL_MARGIN_MS` sulla finestra non basta da
   * solo: vedi `fillsOfCurrentPosition`, che lo corregge sulla forma della
   * sequenza invece di stringerlo.
   */
  async getRealizedPnl(masterAddress, coin, sinceTs) {
    const acc = this._acc(masterAddress);
    const since = sinceTs ? sinceTs - OPEN_FILL_MARGIN_MS : 0;
    const matchCoin = f => f.coin === coin || `${f.coin}-PERP` === coin || f.coin === coin.replace('-PERP', '');
    const inWindow = acc.fills.filter(f => matchCoin(f) && f.time >= since);
    // `sinceTs` falsy = «tutta la storia di questa coin»: è il senso letterale
    // del parametro e l'uso dei test aggregati, e lì i segmenti NON si separano.
    // Con un `sinceTs` vero il chiamante sta chiedendo UNA posizione (è come lo
    // usa `bot._registerClose`, l'unico chiamante di produzione), e il confine
    // fra posizioni va rispettato — vedi `fillsOfCurrentPosition`.
    const rel = sinceTs ? fillsOfCurrentPosition(inWindow) : inWindow;
    // Il confine si calcola sulle size: una size illeggibile lo renderebbe
    // inaffidabile, e su un percorso che produce il PnL scritto in DB non può
    // restare una cosa che nessuno viene a sapere.
    const badSize = inWindow.filter(f => !Number.isFinite(Number(f?.sz)));
    if (badSize.length) {
      logger.warn(`Paper broker: ${badSize.length} fill su ${coin} senza size leggibile — il confine fra posizioni in getRealizedPnl potrebbe essere sbagliato`);
    }
    const closing = rel.filter(f => /close/i.test(f.dir || ''));
    if (!closing.length) return null;
    const closedPnl = closing.reduce((s, f) => s + (f.closedPnl || 0), 0);
    const fee = rel.reduce((s, f) => s + (f.fee || 0), 0);
    return { closedPnl, fee, net: closedPnl - fee, fills: rel.length, closingFills: closing };
  }
}

export default new PaperBroker();
