if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

/**
 * PERPS TRADING UI (Hyperliquid)
 * ==============================
 * Gestisce la vista "Perps": account/agent, ordini manuali, posizioni e bot
 * auto-pilot, più la connessione MetaMask che serve a firmare l'approvazione
 * dell'agent e i trasferimenti Spot→Perp.
 *
 * La connessione MetaMask è arrivata qui con EVM-01 (Sprint 3): prima viveva in
 * `public/app.js` insieme alla demo di arbitraggio EVM, e i due mondi si
 * scambiavano stato (`perps.connected` era un getter su `app.isConnected`).
 * Quell'accoppiamento ha già prodotto due bug reali durante il primo deploy —
 * MetaMask forzato su reti EVM che a Hyperliquid non servono, e il pulsante di
 * connessione nascosto senza alternative. Ora il wallet è di chi lo usa.
 *
 * Toast e modali stanno in `public/shell.js` (`window.shell`).
 */

// Strategie pronte per la modalità semplificata: il "consulente" le traduce
// in regole tecniche (RSI/EMA/MACD/Bollinger).
const BOT_STRATEGIES = {
  rsi_reversal: {
    name: 'Rimbalzo ipervenduto', emoji: '🔄', tag: 'Conservativa',
    desc: 'Compra quando il mercato è ipervenduto (RSI sotto 30) e vende quando è ipercomprato (RSI sopra 70).',
    when: 'Funziona meglio nei mercati laterali, senza trend forti.',
    build: () => ({
      direction: 'both', candleInterval: '15m', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' },
        { type: 'indicator', indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'short' }
      ],
      exitRules: []
    })
  },
  ema_trend: {
    name: 'Segui il trend', emoji: '📈', tag: 'Moderata',
    desc: 'Va Long quando il prezzo è sopra la media mobile EMA50, Short quando è sotto.',
    when: 'Ideale nei mercati direzionali, con trend chiari al rialzo o al ribasso.',
    build: () => ({
      direction: 'both', candleInterval: '1h', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'ema', period: 50, compareToPrice: true, op: '>', signal: 'long' },
        { type: 'indicator', indicator: 'ema', period: 50, compareToPrice: true, op: '<', signal: 'short' }
      ],
      exitRules: []
    })
  },
  macd_momentum: {
    name: 'Momentum (MACD)', emoji: '⚡', tag: 'Moderata',
    desc: 'Entra Long quando il MACD diventa positivo, Short quando diventa negativo.',
    when: 'Buona per cavalcare movimenti decisi e veloci.',
    build: () => ({
      direction: 'both', candleInterval: '15m', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'macd', cond: 'bullish', signal: 'long' },
        { type: 'indicator', indicator: 'macd', cond: 'bearish', signal: 'short' }
      ],
      exitRules: []
    })
  },
  bollinger: {
    name: 'Bande di Bollinger', emoji: '🎯', tag: 'Conservativa',
    desc: 'Compra quando il prezzo tocca la banda inferiore, vende quando tocca la superiore.',
    when: 'Reversione alla media: meglio nei mercati laterali e volatili.',
    build: () => ({
      direction: 'both', candleInterval: '15m', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'bollinger', cond: 'below_lower', signal: 'long' },
        { type: 'indicator', indicator: 'bollinger', cond: 'above_upper', signal: 'short' }
      ],
      exitRules: []
    })
  }
};

/**
 * Visualizzazione EUR (CUR-01) — solo presentazione.
 * `FX_TTL_MS`: dopo quanto si ricontrolla il tasso, agganciandosi a un tick che
 * esiste già (nessun timer nuovo: il tasso ECB si muove una volta al giorno).
 * `FX_MAX_AGE_MS`: oltre questa età il tasso non si usa più nemmeno se il server
 * l'aveva dichiarato fresco al momento della lettura — una pagina lasciata
 * aperta per ore non deve continuare a mostrare EUR su un tasso di ieri.
 */
const FX_TTL_MS = 30 * 60 * 1000;
const FX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const RISK_PROFILES = {
  conservativo: { name: 'Conservativo', emoji: '🟢', leverage: 2, sizingPercent: 5, tp: 1.5, sl: 1, trailing: 0, maxDailyLoss: 50, maxPosition: 500,
    desc: 'Leva bassa, posizioni piccole, stop stretti. Priorità alla protezione del capitale.' },
  moderato: { name: 'Moderato', emoji: '🟡', leverage: 3, sizingPercent: 10, tp: 3, sl: 1.5, trailing: 1, maxDailyLoss: 100, maxPosition: 1000,
    desc: 'Equilibrio tra rischio e rendimento, con trailing stop attivo.' },
  aggressivo: { name: 'Aggressivo', emoji: '🔴', leverage: 5, sizingPercent: 20, tp: 6, sl: 3, trailing: 2, maxDailyLoss: 300, maxPosition: 3000,
    desc: 'Leva e size elevate, obiettivi di profitto ampi. Rischio maggiore.' }
};

/**
 * Nomi in italiano dei parametri che una proposta `tune_params` può cambiare.
 *
 * La whitelist vera è `TUNABLE_KEYS` in `src/agents/tunePatch.js`, ed è lei a
 * decidere cosa è ammesso: qui c'è solo come si chiama la chiave in una frase
 * leggibile. Deliberatamente NON è una mappa esaustiva con fallback a "nascondi":
 * se domani la whitelist cresce e questa riga resta indietro, la chiave viene
 * mostrata com'è (`maxLeverage → 5`) invece di sparire. Su una modifica che sta
 * per essere scritta nella config di un bot con un click, un nome tecnico è molto
 * meno grave di un cambiamento invisibile.
 */
const TUNE_PARAM_LABELS = {
  candleInterval: 'intervallo candele'
};

class PerpsApp {
  constructor() {
    this.markets = [];
    this.mids = {};
    this.bots = [];
    this.account = null;
    this.network = 'testnet';
    this.socket = null;
    this.shown = false;
    this.accountTimer = null;
    this.botMode = 'simple';
    this.selStrategy = null;
    this.selRisk = 'moderato';
    this.posTab = 'open';
    this.cockpitTab = 'dashboard';
    this.dashboardChart = null;
    this.dashboardSeries = null;
    this.dashboardResizeObserver = null;
    this.dashboardInitialized = false;
    this.riskSnapshot = null;
    this.riskRefreshInFlight = false;
    // BUG-EQUITYRANGE-01: la finestra chiesta al server dalla richiesta in volo,
    // e il flag che ricorda che l'utente ne ha scelta un'altra nel frattempo.
    this.riskRangeInFlight = null;
    this.riskRangeDirty = false;
    this.riskTimer = null;
    // Tasso EUR/USD per il secondo valore di comodo (CUR-01). `null` = niente EUR.
    this.fx = null;
    this.fxFetchedAt = 0;
    this.fxInFlight = false;
    // Performance storica (ANA-01): caricata all'apertura della sezione, mai in polling.
    // `perfData` e non `performance`: quest'ultimo è un globale del browser.
    this.perfData = null;
    this.perfLoading = false;
    // BUG-EQUITYRANGE-01, come per il rischio: finestra della richiesta in volo
    // e promemoria che l'utente ne ha chiesta un'altra prima che tornasse.
    this.perfRangeInFlight = null;
    this.perfRangeDirty = false;
    this.perfChart = null;
    this.perfEquitySeries = null;
    this.perfMlChart = null;
    this.perfMlAccuracySeries = null;
    this.perfMlBaselineSeries = null;
    this.perfMlCoin = null;
    this.dashboardEquityRange = 'all';
    this.perfEquityRange = 'all';
    // Osservatore Jev (JEV-OBS-01). `null` = mai caricato, `[]` = caricato e
    // vuoto: sono due stati diversi e il pannello li racconta in modo diverso.
    this.jevEvaluations = null;
    this.jevError = null;
    this.jevInFlight = false;
    this.jevTimer = null;
    this._jevLastHtml = null;
    // Stato del wallet MetaMask (ex app.isConnected / app.walletAddress)
    this.walletAddress = null;
    this.isConnected = false;
  }

  // ---- Helpers ----
  get address() { return this.walletAddress || '0x0000000000000000000000000000000000000000'; }
  get connected() { return this.isConnected; }
  toast(msg, type = 'info') {
    if (window.shell?.showToast) window.shell.showToast(msg, type);
    else alert(msg);
  }
  _showModal(id) { window.shell?.showModal(id); }
  _closeModal(id) { window.shell?.closeModal(id); }

  async api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const err = new Error(data.error || `Errore ${res.status}`);
      // Codice applicativo opzionale: permette a chi chiama di distinguere gli
      // errori senza dover interpretare il testo del messaggio.
      if (data.code) err.code = data.code;
      throw err;
    }
    return data.data ?? data;
  }

  /**
   * Importo in USD. Il segno sta PRIMA del simbolo di valuta — `-$12.34`, non
   * `$-12.34` — e questo è responsabilità della funzione, non di chi la chiama
   * (DEBT-04): prima due chiamanti rimediavano con `.replace('$-', '-$')` copiato
   * a mano, quindi ogni altro punto della cockpit che stampa un valore
   * potenzialmente negativo lo mostrava nella forma sbagliata senza che nessuno
   * lo notasse. Stessa forma di `fmtEur()`, che il segno lo metteva già al posto
   * giusto: le due funzioni sorelle non devono formattare in modo diverso.
   */
  fmtUsd(n) {
    if (n == null || isNaN(n)) return '—';
    const value = Number(n);
    const abs = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return (value < 0 ? '-$' : '$') + abs;
  }
  fmtNum(n, d = 4) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  }
  /** Formatta un costo in USD (più decimali per importi piccoli). */
  _fmtCost(n) {
    if (n == null || isNaN(n)) return '—';
    const v = Number(n);
    if (v === 0) return '$0';
    return '$' + v.toFixed(v < 1 ? 4 : 2);
  }

  // ---- Visualizzazione EUR (CUR-01) ----
  // Solo presentazione: nessun limite di rischio viene convertito. `maxDailyLossUsd`,
  // `maxPositionUsd` e `maxTotalExposureUsd` restano in USD, e `riskManager`/`portfolio`
  // non sanno nemmeno che questo codice esista. `fmtUsd` resta la fonte primaria: l'EUR
  // è un secondo numero indicativo, mostrato dopo, mai al posto del dollaro.

  /**
   * Legge il tasso EUR/USD da `GET /api/fx/eurusd`.
   * Regola non negoziabile della storia: `stale: true` o chiamata fallita ⇒
   * `this.fx = null` ⇒ si mostra solo USD. Un EUR calcolato su un tasso vecchio è
   * peggio di nessun EUR, perché è indistinguibile da uno giusto.
   */
  async loadFxRate() {
    if (this.fxInFlight) return this.fx;
    this.fxInFlight = true;
    try {
      const data = await this.api('/api/fx/eurusd');
      const rate = Number(data?.rate);
      const usable = Number.isFinite(rate) && rate > 0 && data?.stale !== true;
      // `asOf` è la data di riferimento BCE del tasso (`YYYY-MM-DD`), non
      // l'istante della nostra lettura; `ageMs` è l'età che il server ha già
      // calcolato su quella data — si usa quella quando c'è.
      this.fx = usable ? { rate, asOf: data?.asOf ?? null, ageMs: Number(data?.ageMs) } : null;
      this.fxFetchedAt = Date.now();
    } catch (_) {
      // Nessun fallback su un tasso precedente: se la fonte non risponde, l'EUR
      // sparisce del tutto.
      this.fx = null;
      this.fxFetchedAt = Date.now();
    } finally {
      this.fxInFlight = false;
    }
    this._applyFxNote();
    this._refreshCockpitDashboard();
    return this.fx;
  }

  /** Ricontrolla il tasso solo se è passato il TTL (nessun timer dedicato). */
  _maybeRefreshFxRate() {
    if (Date.now() - this.fxFetchedAt >= FX_TTL_MS) this.loadFxRate();
  }

  /** Il tasso in memoria è ancora utilizzabile? */
  _fxUsable() {
    const rate = Number(this.fx?.rate);
    if (!Number.isFinite(rate) || rate <= 0) return false;
    return Date.now() - this.fxFetchedAt < FX_MAX_AGE_MS;
  }

  /** Converte USD in EUR, o `null` se il tasso non è utilizzabile. */
  _eur(usd) {
    if (!this._fxUsable()) return null;
    const value = Number(usd);
    if (!Number.isFinite(value)) return null;
    // `rate` è EURUSD: quanti dollari vale un euro.
    return value / Number(this.fx.rate);
  }

  /**
   * Importo in EUR, o stringa vuota quando non c'è nulla da mostrare.
   * La stringa vuota è deliberata: chi chiama la usa per decidere se stampare o
   * no il secondo valore, senza dover ripetere il controllo sul tasso.
   */
  fmtEur(n) {
    const value = this._eur(n);
    if (value === null) return '';
    const abs = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return (value < 0 ? '-€' : '€') + abs;
  }

  /** Scrive (o svuota e nasconde) l'elemento che porta il secondo valore in EUR. */
  _setEurText(id, usdValue) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = this.fmtEur(usdValue);
    el.textContent = text ? `≈ ${text}` : '';
    el.hidden = !text;
  }

  /** Nota su tasso ed età: senza di essa l'EUR sembrerebbe una conversione ufficiale. */
  _applyFxNote() {
    const note = document.getElementById('cockpitFxNote');
    if (!note) return;
    if (!this._fxUsable()) {
      note.textContent = '';
      note.hidden = true;
      return;
    }
    const age = this._fxAgeLabel();
    note.textContent = `EUR indicativo · EURUSD ${Number(this.fx.rate).toFixed(4)}${age ? ` · ${age}` : ''}`;
    note.hidden = false;
  }

  /**
   * Etichetta dell'età del tasso.
   * Il tasso BCE è una fissazione giornaliera, quindi `asOf` arriva come data
   * (`YYYY-MM-DD`): in quel caso si dichiara il *giorno* del tasso, non i minuti
   * — "aggiornato 12 min fa" su una fissazione di ieri sarebbe una mezza bugia.
   * `ageMs`, quando c'è, è l'età già calcolata dal server sulla stessa data.
   */
  _fxAgeLabel() {
    const raw = this.fx?.asOf;
    if (raw == null || raw === '') return '';
    const dateOnly = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
    let ms = null;
    if (typeof raw === 'number' && Number.isFinite(raw)) ms = raw > 1e11 ? raw : raw * 1000;
    else {
      const parsed = Date.parse(String(raw));
      if (Number.isFinite(parsed)) ms = parsed;
    }
    if (ms == null) return '';
    if (dateOnly) return `tasso BCE del ${new Date(ms).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })}`;
    const ageMs = Number.isFinite(Number(this.fx?.ageMs)) ? Number(this.fx.ageMs) : Date.now() - ms;
    const minutes = Math.floor(ageMs / 60000);
    if (minutes < 1) return 'aggiornato ora';
    if (minutes < 90) return `aggiornato ${minutes} min fa`;
    return `aggiornato il ${new Date(ms).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`;
  }

  // ---- Lifecycle ----
  async onShow() {
    if (!this.socket) this._initSocket();
    await this.initWallet();
    this._initCockpitDashboard();
    // Ripristina l'ultimo tab dal hash dell'URL (primo), poi da localStorage (fallback)
    const hashTab = location.hash?.replace('#tab-', '').replace('#', '') || '';
    const savedTab = hashTab || localStorage.getItem('perps_active_tab') || 'dashboard';
    this.switchCockpitTab(savedTab);
    await this.loadNetwork();
    await this.loadFxRate();
    await this.loadMarkets();
    await this.refreshAccount();
    await this.loadBots();
    await this.loadPortfolio();
    await this.loadNotifications();
    await this.loadAgents();
    await this.refreshRiskSnapshot();
    await this.loadFills();
    // Dopo `loadBots()`: così le righe portano subito il nome del bot invece
    // dell'id corto.
    await this.loadJevEvaluations();
    if (!this.accountTimer) {
      this.accountTimer = setInterval(() => {
        if (!document.getElementById('view-perps').classList.contains('hidden')) {
          this.refreshAccount();
          // Nessun timer nuovo per il tasso di cambio: ci si aggancia a un tick
          // che c'è già e si ricontrolla al massimo ogni FX_TTL_MS (CUR-01).
          this._maybeRefreshFxRate();
        }
      }, 8000);
    }
    if (!this.riskTimer) {
      this.riskTimer = setInterval(() => {
        if (!document.getElementById('view-perps').classList.contains('hidden')) this.refreshRiskSnapshot();
      }, 15000);
    }
    if (!this.jevTimer) {
      // 5s, ma solo con il pannello davvero a schermo: fuori dal tab SYSTEM
      // nessuno guarda il log, e una rotta che legge dal DB non va interrogata
      // ogni 5s per niente. Il rientro nel tab ricarica subito
      // (`switchCockpitTab`), quindi non si vede mai un pannello fermo.
      this.jevTimer = setInterval(() => {
        if (document.getElementById('view-perps')?.classList.contains('hidden')) return;
        if (this.cockpitTab !== 'system') return;
        this.loadJevEvaluations();
      }, 5000);
    }
    this.shown = true;
  }

  _initSocket() {
    this.socket = window.shell?.getSocket?.() || (window.io ? window.io() : null);
    if (!this.socket) return;
    this.socket.on('perps:price', (d) => { this.mids = d.mids || {}; this._updateMid(); });
    this.socket.on('perps:botUpdate', (state) => { this._updateBotCard(state); this.refreshRiskSnapshot(); });
    this.socket.on('perps:agentStatus', () => { this.refreshAccount(); this.refreshRiskSnapshot(); });
    this.socket.on('perps:position', () => { this.refreshAccount(); this.refreshRiskSnapshot(); if (this.posTab === 'history') this.loadFills(); });
    this.socket.on('perps:fill', () => { this.refreshAccount(); this.refreshRiskSnapshot(); if (this.posTab === 'history') this.loadFills(); });

    // --- Live bot sync da sessioni esterne (MCP, altri browser, API) ---
    // Aggiunge una card istantaneamente quando un bot viene creato altrove.
    this.socket.on('perps:botCreate', (state) => {
      if (!this.bots) this.bots = [];
      if (!this.bots.find(b => b.id === state.id)) {
        this.bots.push(state);
        this._renderBots();
        this._refreshCockpitDashboard();
      }
    });
    // Rimuove la card istantaneamente quando un bot viene eliminato altrove.
    this.socket.on('perps:botDelete', ({ id }) => {
      if (!this.bots) return;
      this.bots = this.bots.filter(b => b.id !== id);
      const el = document.getElementById('bot-' + id);
      if (el) el.remove();
      if (!this.bots.length) document.getElementById('noBots')?.classList.remove('hidden');
      this._refreshCockpitDashboard();
    });

    // --- Feature 1: Live Dashboard Refresh ---
    // Il server emette questo evento dopo ogni operazione che cambia lo stato
    // (fill, chiusura posizione, kill switch, watchdog crash/recovery, MCP reload).
    // Si aggiorna SEMPRE, qualunque tab sia attivo, per ricevere aggiornamenti
    // da sessioni esterne (altri browser, Hermes MCP, API).
    // Throttle 150ms: risposta rapida ma protetta da burst multipli.
    // Se un secondo evento arriva durante il cooldown, viene comunque schedulato
    // (queued) anziché scartato silenziosamente.
    let _refreshTimer = null;
    let _refreshQueued = false;
    const _doRefresh = async () => {
      _refreshTimer = null;
      _refreshQueued = false;
      await this.loadBots();
      this.refreshAccount();
      this.refreshRiskSnapshot();
    };
    this.socket.on('perps:dashboardRefresh', () => {
      if (_refreshTimer) {
        // Timer già in corso: segna che va rifatto dopo
        _refreshQueued = true;
        return;
      }
      _refreshTimer = setTimeout(async () => {
        await _doRefresh();
        if (_refreshQueued) {
          // Esegui il refresh in coda
          _refreshTimer = setTimeout(_doRefresh, 150);
        }
      }, 150);
    });

    // --- Kill-switch e rete cambiati da un'altra sessione ---
    // Il server emetteva questi due eventi e nessuno li ascoltava: lo stato mostrato
    // restava quello del caricamento finché l'utente non ricaricava la pagina. Il caso
    // che conta è il kill-switch alzato altrove (Hermes via MCP, un altro browser) con
    // questa scheda che continua a presentare le aperture come consentite.
    //
    // I due emit di `perps:killSwitch` NON hanno lo stesso payload, e la differenza è
    // sostanziale:
    //   • `emergency_shutdown` (MCP) manda `{on:true, actor, reason}` e ha davvero
    //     chiamato `riskAgent.setKillSwitch(true)` → lo stato è nel messaggio;
    //   • `POST /api/perps/kill-switch` (Safe-Exit) manda l'esito dell'operazione
    //     (`stopped`, `closedPositions`, `skippedPositions`, `errors`) e **non** tocca
    //     il flag → lì `on` non c'è, e dedurlo sarebbe inventare uno stato.
    // Quindi: si applica `on` solo se è davvero un booleano, altrimenti si rilegge la
    // fonte autorevole (`/api/perps/risk`, che in `_renderRiskSnapshot` richiama
    // `_setKillSwitchUi`). Uno stato ignoto non è uno stato spento: mostrare
    // "aperture consentite" perché il dato manca è peggio che non mostrare nulla.
    this.socket.on('perps:killSwitch', (data) => {
      if (typeof data?.on === 'boolean') this._setKillSwitchUi(data.on);
      // In entrambi i casi dei bot sono stati fermati e delle posizioni possono
      // essere state chiuse: card, conto e snapshot vanno riletti.
      this.loadBots();
      this.refreshAccount();
      this.refreshRiskSnapshot();

      if (data?.on === true) {
        // `{on:true}` arriva solo dal percorso MCP: non può essere l'eco di un'azione
        // partita da questo browser, quindi dire "da un'altra sessione" è esatto.
        // `reason` finisce in un toast: `showToast` usa textContent (niente markup
        // iniettabile), resta solo da non far esplodere la larghezza del toast.
        const reason = data.reason ? ` (${String(data.reason).slice(0, 60)})` : '';
        this.toast(`🛑 Kill-switch attivato da un'altra sessione${reason}: nuove aperture bloccate`, 'warning');
      } else if (Array.isArray(data?.stopped)) {
        // Safe-Exit: può essere anche la nostra stessa azione tornata indietro, quindi
        // il messaggio riporta i fatti senza attribuirne l'origine. Il toast si mostra
        // solo se il payload è davvero quello del Safe-Exit — su una forma inattesa si
        // resta zitti invece di annunciare "0 bot fermati", che sarebbe un'affermazione.
        const stopped = data.stopped.length;
        const closed = Array.isArray(data.closedPositions) ? data.closedPositions.length : 0;
        const skipped = Array.isArray(data.skippedPositions) ? data.skippedPositions.length : 0;
        let msg = `🛑 Kill Switch Safe-Exit: ${stopped} bot fermat${stopped === 1 ? 'o' : 'i'}`;
        if (closed) msg += `, ${closed} posizion${closed === 1 ? 'e chiusa' : 'i chiuse'}`;
        if (skipped) msg += ` · ${skipped} lasciat${skipped === 1 ? 'a aperta' : 'e aperte'} per gestione manuale`;
        this.toast(msg, 'warning');
      }
    });

    // Cambio di rete Hyperliquid fatto da un'altra sessione. Non basta aggiornare il
    // branding: mercati, mid e conto appartengono alla rete precedente e sarebbero
    // rimasti a schermo come se fossero ancora validi. Si ripete la stessa sequenza di
    // `setNetwork()` senza il POST, e si rilegge la rete da `/api/perps/network`
    // (`loadNetwork`) invece di fidarsi del payload: unica fonte, nessuna logica di
    // pill/faucet/branding duplicata qui.
    this.socket.on('perps:network', async (data) => {
      const net = data?.network;
      if (net !== 'testnet' && net !== 'mainnet') return; // payload inatteso: meglio non toccare nulla
      if (net === this.network) return;                   // eco del nostro stesso cambio rete
      this.toast(`Rete Perps cambiata da un'altra sessione: ${net.toUpperCase()}`, 'warning');
      await this.loadNetwork();
      await this.loadMarkets();
      await this.refreshAccount();
      await this.loadBots();
    });

    // --- Feature 3: Watchdog Crash Alert ---
    // Il Watchdog server emette questo quando un bot non trocka da troppo tempo.
    // Mostra un banner rosso sticky sopra la lista bot con possibilità di dismiss.
    this.socket.on('perps:botCrash', (data) => {
      this._showCrashBanner(data);
    });

    // Naviga al tab corretto quando l'utente usa Back/Forward del browser
    window.addEventListener('popstate', () => {
      const hashTab = location.hash?.replace('#tab-', '').replace('#', '') || '';
      if (hashTab) this.switchCockpitTab(hashTab);
    });
  }

  /**
   * WATCHDOG UI: mostra un banner rosso nella sezione bot quando il server
   * rileva che un bot in 'running' non ha aggiornato lastTickAt da oltre soglia.
   * Auto-dismiss dopo 5 minuti. Max 1 banner per botId (sostituisce il precedente).
   */
  _showCrashBanner(data) {
    const containerId = 'perps-crash-banners';
    let container = document.getElementById(containerId);
    if (!container) {
      // Inserisce il container banner prima della lista bot
      const botsSection = document.getElementById('bots-list') || document.querySelector('.bots-section');
      if (!botsSection) return;
      container = document.createElement('div');
      container.id = containerId;
      botsSection.parentNode.insertBefore(container, botsSection);
    }

    // Rimuove il banner precedente per questo bot (se esiste)
    const existing = document.getElementById(`crash-banner-${data.botId}`);
    if (existing) existing.remove();

    const secs = Math.round((data.silentSinceMs || 0) / 1000);
    const agentLabel = data.linked_agent_id === 'hermes' ? '🤖 Hermes' : '👤 Manuale';
    const banner = document.createElement('div');
    banner.id = `crash-banner-${data.botId}`;
    banner.className = 'crash-alert-banner';
    banner.innerHTML = `
      <span class="crash-alert-icon">⚠️</span>
      <span class="crash-alert-body">
        <strong>Bot in crash rilevato:</strong> <b>${data.botName}</b> (${data.coin}) 
        [${agentLabel}] — nessun tick da <b>${secs}s</b>. 
        Verifica connettività o riavvia il bot.
      </span>
      <button class="crash-alert-dismiss" onclick="this.parentElement.remove()" title="Chiudi">✕</button>
    `;
    container.appendChild(banner);

    // Auto-dismiss dopo 5 minuti
    setTimeout(() => banner.remove(), 5 * 60 * 1000);
  }



  // ---- Cockpit dashboard ----
  _initCockpitDashboard() {
    if (this.dashboardInitialized) {
      this._refreshCockpitDashboard();
      return;
    }
    const chartEl = document.getElementById('cockpitChart');
    if (chartEl && window.LightweightCharts) {
      this.dashboardChart = LightweightCharts.createChart(chartEl, {
        width: chartEl.clientWidth || 640,
        height: Math.max(chartEl.clientHeight, 214),
        layout: { background: { color: 'transparent' }, textColor: '#8b97a8', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
        grid: { vertLines: { color: '#1b2538' }, horzLines: { color: '#1b2538' } },
        rightPriceScale: { borderColor: '#1b2538', minimumWidth: 64 },
        timeScale: { borderColor: '#1b2538', timeVisible: true, secondsVisible: false },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
      });
      this.dashboardSeries = this.dashboardChart.addAreaSeries({
        lineColor: '#26d07c', topColor: 'rgba(38, 208, 124, 0.24)', bottomColor: 'rgba(38, 208, 124, 0.02)',
        lineWidth: 2, priceLineVisible: false, lastValueVisible: true
      });
      this.dashboardSeries.setData(this._dashboardEquityData());
      this.dashboardChart.timeScale().fitContent();
      if (window.ResizeObserver) {
        this.dashboardResizeObserver = new ResizeObserver(() => {
          if (!this.dashboardChart || !chartEl.clientWidth) return;
          this.dashboardChart.resize(chartEl.clientWidth, Math.max(chartEl.clientHeight, 214));
        });
        this.dashboardResizeObserver.observe(chartEl);
      }
    }
    this._bindCockpitDashboardEvents();
    this.dashboardInitialized = true;
    this._refreshCockpitDashboard();
  }

  _bindCockpitDashboardEvents() {
    const headerAlerts = document.getElementById('cockpitHeaderAlerts');
    if (headerAlerts) headerAlerts.addEventListener('click', () => this.switchCockpitTab('risk'));
    const riskRefresh = document.getElementById('cockpitRiskRefresh');
    if (riskRefresh) riskRefresh.addEventListener('click', () => this.refreshRiskSnapshot());
    const riskAlerts = document.getElementById('cockpitRiskAlerts');
    if (riskAlerts) riskAlerts.addEventListener('click', (event) => {
      const button = event.target.closest('[data-alert-action]');
      if (button) this.switchCockpitTab(button.dataset.alertAction || 'risk');
    });

    const dashboardAlerts = document.getElementById('cockpitAlerts');
    if (dashboardAlerts) dashboardAlerts.addEventListener('click', (event) => {
      const button = event.target.closest('[data-alert-action]');
      if (button) this.switchCockpitTab(button.dataset.alertAction || 'risk');
    });

    // ANA-01: ricarica solo su richiesta esplicita, nessun timer.
    const perfRefresh = document.getElementById('perfRefresh');
    if (perfRefresh) perfRefresh.addEventListener('click', () => this.loadPerformance(true));
    const perfMlCoin = document.getElementById('perfMlCoin');
    if (perfMlCoin) perfMlCoin.addEventListener('change', () => {
      this.perfMlCoin = perfMlCoin.value || null;
      this._renderMlQuality();
    });

    document.querySelectorAll('.cockpit-tab').forEach((tab) => {
      tab.addEventListener('click', () => this.switchCockpitTab(tab.id.replace('cockpit-tab-', '')));
      tab.addEventListener('keydown', (event) => {
        const tabs = [...document.querySelectorAll('.cockpit-tab')];
        const index = tabs.indexOf(tab);
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          tabs[(index + 1) % tabs.length].focus();
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          tabs[(index - 1 + tabs.length) % tabs.length].focus();
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.switchCockpitTab(tab.id.replace('cockpit-tab-', ''));
        }
      });
    });
  }

  switchCockpitTab(tab) {
    const validTabs = ['dashboard', 'execution', 'positions', 'performance', 'risk', 'system'];
    const nextTab = validTabs.includes(tab) ? tab : 'dashboard';
    this.cockpitTab = nextTab;

    // Persiste il tab nell'URL (hash) e in localStorage per sopravvivere al refresh
    const newHash = `#tab-${nextTab}`;
    if (location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
    try { localStorage.setItem('perps_active_tab', nextTab); } catch {}

    document.querySelectorAll('.cockpit-tab').forEach((button) => {
      const isActive = button.id === `cockpit-tab-${nextTab}`;
      button.setAttribute('aria-selected', String(isActive));
      button.tabIndex = isActive ? 0 : -1;
    });
    validTabs.forEach((name) => {
      const panel = document.getElementById(`cockpit-panel-${name}`);
      if (panel) panel.hidden = name !== nextTab;
    });
    if (nextTab === 'dashboard') this._refreshCockpitDashboard();
    if (nextTab === 'positions') this.refreshPositionsTab();
    // Unico momento in cui la Performance si carica da sola: l'apertura della
    // sezione. Nessun timer la richiama (ANA-01).
    if (nextTab === 'performance') this.loadPerformance();
    if (nextTab === 'risk') this.refreshRiskSnapshot();
    // Il log dell'osservatore si aggiorna in polling solo mentre è a schermo:
    // all'apertura del tab va riletto subito, altrimenti si mostrerebbe per
    // qualche secondo ciò che era vero l'ultima volta che si è guardato.
    if (nextTab === 'system') this.loadJevEvaluations();
  }

  /**
   * Rilegge lo snapshot di rischio, CHIEDENDO ESPLICITAMENTE la finestra
   * temporale scelta sul grafico (BUG-EQUITYRANGE-01). Senza `range` la rotta
   * restituisce gli ultimi campioni a prescindere dal bottone premuto: i
   * preset 1G/7G/30G/90G/1A filtravano dati che il server aveva già troncato,
   * quindi non avevano effetto visibile. Il parametro è lo stesso codice usato
   * da `_filterEquityPointsByRange`, che resta al suo posto: su una risposta
   * già finestrata dal server è un passaggio a vuoto innocuo, e copre l'attimo
   * fra il click e l'arrivo della risposta.
   */
  async refreshRiskSnapshot() {
    const range = this.dashboardEquityRange || 'all';
    // Una richiesta già in volo porta con sé il range con cui è partita. Se
    // l'utente ha cambiato finestra nel frattempo, scartare il click non basta:
    // la risposta in arrivo ridisegnerebbe la finestra VECCHIA sotto un bottone
    // acceso su un'altra. Si annota il cambio e si rifà la chiamata appena la
    // prima è chiusa; se invece il range è lo stesso (polling, eventi socket)
    // vale la regola di prima e la chiamata in più si scarta.
    if (this.riskRefreshInFlight) {
      if (this.riskRangeInFlight !== range) this.riskRangeDirty = true;
      return;
    }
    this.riskRefreshInFlight = true;
    this.riskRangeInFlight = range;
    try {
      const addressParam = this.connected && this.address ? `address=${encodeURIComponent(this.address)}&` : '';
      this.riskSnapshot = await this.api(`/api/perps/risk?${addressParam}range=${encodeURIComponent(range)}`);
      if (this.riskSnapshot.account) this.account = this.riskSnapshot.account;
      this._renderRiskSnapshot(this.riskSnapshot);
      this._refreshCockpitDashboard();
    } catch (error) {
      const updated = document.getElementById('cockpitRiskUpdated');
      if (updated) updated.textContent = `Aggiornamento fallito: ${error.message}`;
      const status = document.getElementById('cockpitRiskStatus');
      if (status) { status.textContent = 'DATI NON DISPONIBILI'; status.className = 'cockpit-risk-status blocked'; }
      // Finché questo ramo non svuotava i pannelli, quello che restava a schermo
      // erano gli alert precedenti — e al primo caricamento erano i tre alert di
      // esempio del mockup scritti in index.html. Un pannello che non si è potuto
      // aggiornare deve dirlo, non continuare a mostrare l'ultima cosa che aveva.
      this._renderRiskUnavailable(error.message);
    } finally {
      this.riskRefreshInFlight = false;
      this.riskRangeInFlight = null;
      if (this.riskRangeDirty) {
        this.riskRangeDirty = false;
        this.refreshRiskSnapshot();
      }
    }
  }

  /**
   * Dichiara che lo snapshot di rischio non è disponibile, al posto dei dati.
   * Azzera anche i contatori a '—': un badge che dice "0" afferma "nessuna
   * condizione da verificare", cioè esattamente ciò che non sappiamo.
   */
  _renderRiskUnavailable(message) {
    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    ['cockpitHeaderAlertBadge', 'cockpitRiskBadge', 'cockpitAttentionCount', 'cockpitRiskLiveCount']
      .forEach((id) => setText(id, '—'));
    // Il messaggio arriva dal server: escapato, non interpretato.
    const html = `<div class="cockpit-risk-empty">Alert non disponibili: ${this._escapeHtml(message)}</div>`;
    for (const id of ['cockpitAlerts', 'cockpitRiskAlerts']) {
      const target = document.getElementById(id);
      if (target) target.innerHTML = html;
    }
    this._renderSystemHealth(null);
    // Stessa ragione della riga sopra: senza snapshot la card EXECUTION STATUS
    // non sa nulla, e lasciarla sull'ultimo valore letto la farebbe affermare
    // qualcosa che nessuno ha più verificato.
    this._renderExecutionStatus(null);
  }

  _escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  _renderRiskSnapshot(snapshot) {
    if (!snapshot) return;
    const account = snapshot.account || {};
    const limits = snapshot.limits || {};
    const alerts = snapshot.alerts || [];
    const summary = snapshot.summary || {};
    const equity = Number(account.equity ?? account.accountValue);
    const margin = Number(account.totalMarginUsed);
    const exposure = Number(account.totalNtlPos ?? (account.positions || []).reduce((sum, p) => sum + Number(p.positionValue || 0), 0));
    const marginPct = Number.isFinite(equity) && equity > 0 ? (margin / equity) * 100 : null;
    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const statusText = summary.status === 'blocked' ? 'BLOCKED' : summary.status === 'review' ? `${summary.actionable || summary.warning} DA VERIFICARE` : 'OK';
    const statusClass = summary.status === 'blocked' ? 'blocked' : summary.status === 'review' ? 'review' : 'ok';
    const statusEl = document.getElementById('cockpitRiskStatus');
    if (statusEl) { statusEl.textContent = statusText; statusEl.className = `cockpit-risk-status ${statusClass}`; }
    setText('cockpitRiskUpdated', `Ultimo controllo ${new Date(snapshot.generatedAt).toLocaleTimeString('it-IT', { hour12: false })}`);
    setText('cockpitRiskEquity', Number.isFinite(equity) ? this.fmtUsd(equity) : '—');
    setText('cockpitRiskMargin', marginPct == null ? '—' : `${marginPct.toFixed(1)}%`);
    setText('cockpitRiskExposure', Number.isFinite(exposure) ? `${this.fmtUsd(exposure)} / ${this.fmtUsd(limits.maxTotalExposureUsd)}` : '—');
    setText('cockpitMarginLimit', `Limit ${limits.marginWarningPct ?? 60}%`);
    setText('cockpitRiskOpenPositions', `${(account.positions || []).length} / ${limits.maxConcurrentPositions ?? '—'}`);
    const drawdownPct = Number(snapshot.drawdown?.maxPct);
    setText('cockpitRiskDrawdown', Number.isFinite(drawdownPct) ? `-${drawdownPct.toFixed(2)}%` : '—');
    const drawdownStatus = document.getElementById('cockpitDrawdownStatus');
    if (drawdownStatus) {
      const limit = Number(limits.drawdownWarningPct ?? 5);
      const critical = Number(limits.drawdownCriticalPct ?? 10);
      drawdownStatus.textContent = Number.isFinite(drawdownPct) && drawdownPct >= critical ? 'Review now' : Number.isFinite(drawdownPct) && drawdownPct >= limit ? 'Review' : 'Within limit';
      drawdownStatus.className = drawdownPct >= critical ? 'cockpit-negative' : drawdownPct >= limit ? 'cockpit-warning' : 'cockpit-positive';
    }
    const feed = snapshot.system?.wsFresh ? 'LIVE' : snapshot.system?.wsConnected ? 'STALE' : 'POLLING';
    setText('cockpitRiskFeed', feed);

    ['cockpitHeaderAlertBadge', 'cockpitRiskBadge', 'cockpitAttentionCount', 'cockpitRiskLiveCount'].forEach((id) => setText(id, String(summary.actionable ?? alerts.length)));
    const renderAlerts = (targetId) => {
      const target = document.getElementById(targetId);
      if (!target) return;
      if (!alerts.length) {
        target.innerHTML = '<div class="cockpit-risk-empty"><span class="cockpit-positive">●</span> Nessuna condizione da verificare</div>';
        return;
      }
      target.innerHTML = alerts.map((alert) => `
        <article class="cockpit-alert ${this._escapeHtml(alert.severity)}">
          <div class="cockpit-alert-head"><span class="cockpit-alert-title">${this._escapeHtml(alert.title)}</span><span class="cockpit-${alert.severity === 'critical' ? 'negative' : alert.severity === 'warning' ? 'warning' : 'info'}">${this._escapeHtml(alert.severity.toUpperCase())}</span></div>
          <p class="cockpit-alert-body">${this._escapeHtml(alert.body)}</p>
          <div class="cockpit-alert-meta"><span>${this._escapeHtml(alert.meta)}</span><button class="cockpit-review-link" type="button" data-alert-action="${this._escapeHtml(alert.action)}">Review</button></div>
        </article>`).join('');
    };
    renderAlerts('cockpitAlerts');
    renderAlerts('cockpitRiskAlerts');

    const checks = [
      { label: 'Kill-switch', value: snapshot.killSwitch ? 'ATTIVO' : 'spento', state: snapshot.killSwitch ? 'critical' : 'ok' },
      { label: 'Feed Hyperliquid', value: snapshot.system?.wsFresh ? 'live · fresco' : snapshot.system?.wsConnected ? 'connesso · stale' : 'polling REST', state: snapshot.system?.wsFresh ? 'ok' : 'warning' },
      { label: 'Bot watchdog', value: snapshot.bots?.stale ? `${snapshot.bots.stale} stale` : 'nessun bot stale', state: snapshot.bots?.stale ? 'critical' : 'ok' },
      { label: 'Ordini trigger', value: `${snapshot.orders?.trigger ?? 0} protettivi`, state: 'ok' },
      { label: 'Agent wallet', value: snapshot.agent?.approved ? 'approvato' : snapshot.account ? 'da autorizzare' : 'wallet non collegato', state: snapshot.agent?.approved || !snapshot.account ? 'ok' : 'critical' }
    ];
    const checksEl = document.getElementById('cockpitRiskChecks');
    if (checksEl) checksEl.innerHTML = checks.map((check) => `
      <div class="cockpit-risk-check"><span><i class="cockpit-risk-check-dot ${check.state}"></i>${this._escapeHtml(check.label)}</span><strong class="cockpit-${check.state === 'critical' ? 'negative' : check.state === 'warning' ? 'warning' : 'positive'}">${this._escapeHtml(check.value)}</strong></div>`).join('');
    this._renderSystemHealth(snapshot);
    this._renderExecutionStatus(snapshot);
    // Lo snapshot di rischio è la fonte che si aggiorna più spesso: allinea anche il
    // bottone di riattivazione, così non dipende dal solo refresh del pannello agenti.
    this._setKillSwitchUi(snapshot.killSwitch);
  }

  /**
   * Card SYSTEM HEALTH della dashboard.
   *
   * Prima elencava CME, ICE e COMEX a 28ms/31ms con un "3/3 ONLINE": tre borse
   * di future estranee a Hyperliquid e quattro numeri che non venivano da
   * nessuna fonte, scritti nel markup e quindi visibili finché — e solo se —
   * arrivava un dato vero. Le righe di adesso sono le stesse quattro cose che il
   * pannello Risk già verifica sullo snapshot, quindi non c'è una seconda fonte
   * di verità: cambia solo dove sono mostrate.
   *
   * Con `snapshot` nullo si torna a '—' e pallino grigio: "ignoto" è
   * un'affermazione onesta, "online" e "offline" no.
   */
  _renderSystemHealth(snapshot) {
    const set = (key, value, state) => {
      const el = document.getElementById(`cockpitHealth${key}`);
      if (el) el.textContent = value;
      const dot = document.getElementById(`cockpitHealth${key}Dot`);
      if (dot) dot.className = `cockpit-health-dot ${state}`;
    };
    const summary = document.getElementById('cockpitHealthSummary');
    if (!snapshot) {
      ['Feed', 'Bots', 'Orders', 'Api'].forEach((key) => set(key, '—', 'unknown'));
      if (summary) { summary.textContent = '—'; summary.className = 'cockpit-surface-note'; }
      return;
    }

    const system = snapshot.system || {};
    const bots = snapshot.bots || {};
    const orders = snapshot.orders || {};
    const sourceErrors = snapshot.sourceErrors || [];

    const feedOk = !!system.wsFresh;
    set('Feed', feedOk ? 'live · fresco' : system.wsConnected ? 'connesso · stale' : 'polling REST', feedOk ? 'ok' : 'warning');

    const stale = Number(bots.stale || 0);
    const total = Number(bots.total || 0);
    set('Bots', total ? `${Number(bots.running || 0)}/${total} attivi${stale ? ` · ${stale} stale` : ''}` : 'nessun bot',
      stale ? 'offline' : 'ok');

    set('Orders', `${orders.trigger ?? 0} protettivi`, 'ok');
    set('Api', sourceErrors.length ? `${sourceErrors.length} fonti non disponibili` : 'ok',
      sourceErrors.length ? 'warning' : 'ok');

    // Il conteggio riassuntivo si calcola, non si scrive nel markup: prima
    // diceva "3/3 ONLINE" anche a server spento.
    const ok = [feedOk || !!system.wsConnected, !stale, !sourceErrors.length].filter(Boolean).length;
    if (summary) {
      summary.textContent = `${ok}/3 OK`;
      summary.className = `cockpit-surface-note ${ok === 3 ? 'cockpit-positive' : 'cockpit-warning'}`;
    }
  }

  /**
   * Card EXECUTION STATUS della dashboard (DEBT-03).
   *
   * Prima non conteneva un solo valore misurato: tre id che nessuno scriveva mai
   * (`#cockpitFills`, `#cockpitPending`, `#cockpitRejectRate`, fissi a '—'), un
   * badge "LIVE" verde e "Queue health: Stable" scritti nel markup. Su un
   * pannello di trading "Stable" è un'affermazione: diceva che la coda di
   * esecuzione era in salute anche a server spento.
   *
   * Ora tutto viene da `execution` dello snapshot di rischio, che è già la fonte
   * unica di Risk & Alerts e SYSTEM HEALTH — nessuna seconda verità.
   *
   * TRE STATI, NON DUE. `null` = "non lo so" (fonte non interrogata o in
   * errore) e si stampa '—' in colore neutro; un numero = "l'ho misurato", zero
   * compreso. Distinguerli è tutto il punto della storia: `Fills / 5m: 0`
   * significa "ho letto lo storico e in cinque minuti non è stato eseguito
   * niente", che è un'informazione utile e diversa da "non ho potuto leggere lo
   * storico".
   *
   * PERCHÉ "REJECT RATE" NON C'È PIÙ, invece di essere alimentato. Nessuna fonte
   * di questo sistema conta gli ordini rifiutati: `metrics.js` ha
   * `orders_placed_total` ma nessun contatore dei rifiuti, la tabella `trades`
   * registra solo le esecuzioni riuscite e `tickErrors` conta gli errori di
   * ciclo, che non sono rifiuti dell'exchange. Un tasso ha bisogno di numeratore
   * *e* denominatore: senza il numeratore, qualunque percentuale mostrata lì
   * sarebbe inventata — e "0%" sarebbe la peggiore, perché afferma che nessun
   * ordine è stato rifiutato. La riga è rimossa e l'aggiunta del contatore è
   * segnalata come candidato di refinement (sta sul percorso di invio ordini,
   * non in questo file).
   */
  _renderExecutionStatus(snapshot) {
    const setText = (id, value, state = '') => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = value;
      el.className = state;
    };
    const mode = document.getElementById('cockpitExecMode');
    const exec = snapshot?.execution;
    if (!exec) {
      setText('cockpitFills', '—');
      setText('cockpitPending', '—');
      setText('cockpitQueueDepth', '—');
      setText('cockpitQueueHealth', '—');
      if (mode) { mode.textContent = '—'; mode.className = 'cockpit-surface-note'; }
      return;
    }

    // L'etichetta segue la finestra che il server dichiara (`windowMin`) invece
    // di restare "5m" scritto a mano: due posti che dicono la stessa cosa
    // divergono al primo cambio di costante, e il numero accanto sarebbe
    // riferito a una finestra diversa da quella annunciata.
    const windowMin = Number(exec.windowMin) || 5;
    setText('cockpitFillsLabel', `Fills / ${windowMin}m`);
    setText('cockpitFills', exec.fills === null || exec.fills === undefined ? '—' : String(exec.fills));

    // Le proposte da decidere sono giallo solo se ce n'è almeno una: prima la
    // riga era `class="cockpit-warning"` fissa nel markup, quindi anche uno zero
    // — o un '—' — veniva mostrato come una cosa da guardare.
    const pending = exec.pendingProposals;
    setText('cockpitPending', pending === null || pending === undefined ? '—' : String(pending),
      Number(pending) > 0 ? 'cockpit-warning' : '');

    const depth = exec.queueDepth;
    const threshold = exec.queueThreshold;
    setText('cockpitQueueDepth', depth === null || depth === undefined ? '—'
      : `${depth} azioni${threshold === null || threshold === undefined ? '' : ` / soglia ${threshold}`}`);

    const QUEUE_HEALTH = {
      idle: ['nessuna coda', 'cockpit-positive'],
      busy: ['in smaltimento', 'cockpit-info'],
      warning: ['oltre soglia', 'cockpit-warning'],
      unknown: ['—', '']
    };
    const [healthText, healthClass] = QUEUE_HEALTH[exec.queueState] || QUEUE_HEALTH.unknown;
    setText('cockpitQueueHealth', healthText, healthClass);

    const MODES = {
      live: ['LIVE', 'cockpit-positive'],
      idle: ['FERMA · nessun bot in marcia', 'cockpit-warning'],
      blocked: ['BLOCCATA · kill-switch', 'cockpit-negative'],
      unknown: ['—', '']
    };
    const [modeText, modeClass] = MODES[exec.mode] || MODES.unknown;
    if (mode) {
      mode.textContent = modeText;
      mode.className = `cockpit-surface-note ${modeClass}`.trim();
    }
  }

  _filterEquityPointsByRange(points, range = 'all') {
    if (!Array.isArray(points) || !points.length) return [];
    if (!range || range === 'all') return points;
    const rangeSeconds = {
      '1d': 86400,
      '7d': 7 * 86400,
      '30d': 30 * 86400,
      '90d': 90 * 86400,
      '365d': 365 * 86400,
      '1y': 365 * 86400
    }[range];
    if (!rangeSeconds) return points;
    const latestTime = points[points.length - 1]?.time || Math.floor(Date.now() / 1000);
    const cutoff = latestTime - rangeSeconds;
    const filtered = points.filter(p => p.time >= cutoff);
    return filtered.length > 0 ? filtered : [points[points.length - 1]];
  }

  setDashboardEquityRange(range = 'all') {
    this.dashboardEquityRange = range;
    const container = document.getElementById('dashboardEquityRanges');
    if (container) {
      container.querySelectorAll('.cockpit-range-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.range === range);
      });
    }
    const note = document.getElementById('dashboardEquityNote');
    if (note) {
      const labels = {
        '1d': '1D · 24 ORE',
        '7d': '7D · 1 SETTIMANA',
        '30d': '30D · 1 MESE',
        '90d': '90D · 3 MESI',
        '365d': '1A · 1 ANNO',
        'all': 'TUTTO · STORICO'
      };
      note.textContent = `${labels[range] || range.toUpperCase()} · EQUITY CURVE`;
    }
    // Due passaggi, in quest'ordine. (1) Filtro locale sui dati già in memoria:
    // è immediato e restringe subito la curva quando la nuova finestra è più
    // stretta della precedente. (2) Richiesta al server con `range`: è l'unico
    // modo di ALLARGARE la finestra, perché i punti più vecchi la UI non li ha
    // mai ricevuti — è esattamente il motivo per cui questi bottoni sembravano
    // non fare niente (BUG-EQUITYRANGE-01). Nessun `await`: il click non deve
    // aspettare la rete, e un fallimento del fetch è già gestito dentro
    // `refreshRiskSnapshot` (che dichiara i dati non disponibili) senza toccare
    // quanto disegnato al punto 1.
    if (this.dashboardSeries) {
      const data = this._dashboardEquityData();
      this.dashboardSeries.setData(data);
      if (data.length) this.dashboardChart?.timeScale().fitContent();
    }
    this.refreshRiskSnapshot();
  }

  _dashboardEquityData() {
    let points = [];
    const liveHistory = this.riskSnapshot?.equityHistory || [];
    if (liveHistory.length) {
      points = liveHistory.map((point) => ({
        time: this._toChartTime(point?.time ?? point?.ts),
        value: Number(point?.value ?? point?.equity)
      }));
    } else if (this.riskSnapshot?.account) {
      const value = Number(this.riskSnapshot.account.equity ?? this.riskSnapshot.account.accountValue);
      if (Number.isFinite(value)) points = [{ time: Math.floor((this.riskSnapshot.generatedAt || Date.now()) / 1000), value }];
    } else {
      const value = Number(this.account?.equity ?? this.account?.accountValue);
      if (Number.isFinite(value)) {
        points = [{ time: Math.floor(Date.now() / 1000), value }];
      }
    }
    const sanitized = this._chartSeries(points);
    return this._filterEquityPointsByRange(sanitized, this.dashboardEquityRange || 'all');
  }

  _refreshCockpitDashboard() {
    const account = this.account || {};
    const risk = this.riskSnapshot || {};
    const liveAccount = risk.account || account;
    const positions = liveAccount.positions || [];
    const equity = Number(liveAccount.equity ?? liveAccount.accountValue);
    const margin = Number(liveAccount.totalMarginUsed);
    // Nessun valore di ripiego inventato: su un pannello di trading un numero
    // plausibile ma finto è peggio di un dato assente, perché è indistinguibile
    // da uno reale. Quando il dato manca si mostra '—'.
    const hasEquity = Number.isFinite(equity) && equity >= 0;
    const equityValue = hasEquity ? equity : null;
    const marginPct = (Number.isFinite(margin) && hasEquity && equity > 0)
      ? Math.min(100, Math.max(0, (margin / equity) * 100))
      : null;
    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const now = new Date();
    const timestamp = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' EST';

    setText('cockpitEquity', equityValue === null ? '—' : this.fmtUsd(equityValue));
    setText('cockpitHeaderEquity', equityValue === null ? '—' : this.fmtUsd(equityValue));
    // Secondo valore in EUR (CUR-01): compare solo se il tasso è fresco, sparisce
    // da sé quando non lo è — `_setEurText` svuota e nasconde l'elemento.
    this._setEurText('cockpitEquityEur', equityValue);
    this._setEurText('cockpitHeaderEquityEur', equityValue);
    setText('cockpitUpdatedAt', timestamp);
    setText('cockpitMarginUsed', marginPct === null ? '—' : `${Math.round(marginPct)}%`);
    setText('cockpitMarginFree', marginPct === null ? '' : `${Math.max(0, 100 - Math.round(marginPct))}% free`);
    const marginBar = document.getElementById('cockpitMarginBar');
    if (marginBar) marginBar.style.width = `${marginPct ?? 0}%`;

    if (risk.account && risk.pnl) {
      const net = Number(risk.pnl.net);
      const realized = Number(risk.pnl.realized);
      const unrealized = Number(risk.pnl.unrealized);
      if (Number.isFinite(net)) {
        setText('cockpitNetPnl', `${net >= 0 ? '+' : '-'}${this.fmtUsd(Math.abs(net))}`);
        const netEl = document.getElementById('cockpitNetPnl');
        if (netEl) netEl.className = `cockpit-kpi-value ${net >= 0 ? 'cockpit-positive' : 'cockpit-negative'}`;
        this._setEurText('cockpitNetPnlEur', net);
      }
      if (Number.isFinite(realized)) setText('cockpitRealized', `Realized ${realized >= 0 ? '+' : '-'}${this.fmtUsd(Math.abs(realized))}`);
      if (Number.isFinite(unrealized)) setText('cockpitUnrealized', `Unrealized ${unrealized >= 0 ? '+' : '-'}${this.fmtUsd(Math.abs(unrealized))}`);
    }
    if (risk.drawdown && Number.isFinite(Number(risk.drawdown.maxPct))) {
      setText('cockpitDrawdown', `-${Number(risk.drawdown.maxPct).toFixed(2)}%`);
    }

    if (this.dashboardSeries) {
      this.dashboardSeries.setData(this._dashboardEquityData());
      this.dashboardChart?.timeScale().fitContent();
    }
    // Ripetuto qui e non solo in _renderRiskSnapshot: così lo stato onesto della
    // card viene affermato dal codice al primo render, e non dipende dal fatto
    // che qualcuno non rimetta valori fissi nel markup.
    this._renderSystemHealth(this.riskSnapshot || null);
    this._renderExecutionStatus(this.riskSnapshot || null);
    // `hasAccountData` distingue "il conto non ha ancora risposto" da "il conto
    // ha risposto e non ci sono posizioni": senza questa distinzione la tabella
    // affermava "Nessuna posizione aperta" già al primo render, prima di sapere.
    this._renderCockpitPositions(positions, !!(risk.account || this.account));
  }

  _renderCockpitPositions(positions, hasAccountData = true) {
    const tbody = document.getElementById('cockpitPositionsSummary');
    const count = document.getElementById('cockpitOpenPositionsCount');
    if (count) count.textContent = hasAccountData ? `[${positions.length}]` : '—';
    if (!tbody) return;
    if (!hasAccountData) {
      tbody.innerHTML = '<tr><td class="cockpit-empty" colspan="5">In attesa dei dati del conto…</td></tr>';
      return;
    }
    if (!positions.length) {
      tbody.innerHTML = '<tr><td class="cockpit-empty" colspan="5">Nessuna posizione aperta</td></tr>';
      return;
    }
    tbody.innerHTML = positions.slice(0, 6).map((position) => {
      const side = String(position.side || '').toLowerCase();
      const pnl = Number(position.unrealizedPnl || 0);
      const row = document.createElement('tr');
      const values = [
        { text: position.coin || '—', className: 'cockpit-symbol' },
        { text: String(position.side || '—').toUpperCase(), className: side === 'long' ? 'cockpit-positive' : 'cockpit-negative' },
        { text: this.fmtNum(position.size), className: '' },
        { text: this.fmtUsd(position.entryPx), className: '' },
        // PnL: USD primario, EUR indicativo sotto (CUR-01) e solo a tasso fresco.
        { text: `${pnl >= 0 ? '+' : '-'}${this.fmtUsd(Math.abs(pnl))}`, className: pnl >= 0 ? 'cockpit-positive' : 'cockpit-negative', eur: this.fmtEur(pnl) }
      ];
      values.forEach(({ text, className, eur }) => {
        const cell = document.createElement('td');
        cell.textContent = text;
        if (className) cell.className = className;
        if (eur) {
          const secondary = document.createElement('small');
          secondary.className = 'cockpit-eur';
          secondary.textContent = `≈ ${eur}`;
          cell.appendChild(secondary);
        }
        row.appendChild(cell);
      });
      return row.outerHTML;
    }).join('');
  }

  // ---- Performance storica (ANA-01) ----
  // Ispirata a Freqtrade, ma nessun dato nuovo: posizioni chiuse con `close_reason`,
  // `risk_equity_history` e `ml_history` esistono da sprint e non erano mostrate da
  // nessuna parte. La serie ML in particolare viene raccolta a ogni retraining e non
  // ha mai avuto una UI.
  //
  // Vincolo esplicito della storia: NESSUN polling. Il caricamento avviene
  // all'apertura della sezione (switchCockpitTab) e sul pulsante Aggiorna.

  /**
   * Carica le aggregazioni da `GET /api/perps/performance`.
   * `force` distingue il click su Aggiorna dall'apertura della sezione: senza
   * `force` un secondo passaggio sulla tab non rifà la chiamata se una è già in volo.
   */
  async loadPerformance(force = false) {
    // `range` chiede la curva per FINESTRA TEMPORALE invece degli ultimi N
    // campioni (BUG-EQUITYRANGE-01): senza, `limit=5000` restituisce sempre le
    // stesse ultime righe e i preset 1G/7G/… non hanno niente da mostrare.
    const range = this.perfEquityRange || 'all';
    // Come in `refreshRiskSnapshot`: una chiamata già in volo è partita con la
    // finestra di prima, quindi un cambio di range durante l'attesa non si
    // scarta — si rifà appena la prima è chiusa.
    if (this.perfLoading) {
      if (this.perfRangeInFlight !== range) this.perfRangeDirty = true;
      return this.perfData;
    }
    this.perfLoading = true;
    this.perfRangeInFlight = range;
    this._setPerfNotice(this.perfData && !force ? null : 'Caricamento dati storici…', 'info');
    try {
      const data = await this.api(`/api/perps/performance?limit=5000&range=${encodeURIComponent(range)}`);
      this.perfData = {
        bots: Array.isArray(data?.bots) ? data.bots : [],
        equityHistory: Array.isArray(data?.equityHistory) ? data.equityHistory : [],
        mlHistory: Array.isArray(data?.mlHistory) ? data.mlHistory : []
      };
      this._setPerfNotice(null);
      const updated = document.getElementById('perfUpdatedAt');
      if (updated) updated.textContent = new Date().toLocaleTimeString('it-IT', { hour12: false });
    } catch (error) {
      // Nessun numero inventato: la sezione dichiara che i dati non sono arrivati.
      this.perfData = null;
      this._setPerfNotice(`Dati storici non disponibili: ${error.message}`, 'error');
    } finally {
      this.perfLoading = false;
      this.perfRangeInFlight = null;
    }
    this._renderPerformance();
    if (this.perfRangeDirty) {
      this.perfRangeDirty = false;
      return this.loadPerformance(true);
    }
    return this.perfData;
  }

  _setPerfNotice(text, kind = 'info') {
    const el = document.getElementById('perfNotice');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
    el.className = `cockpit-perf-notice cockpit-perf-notice-${kind}`;
  }

  setPerfEquityRange(range = 'all') {
    this.perfEquityRange = range;
    const container = document.getElementById('perfEquityRanges');
    if (container) {
      container.querySelectorAll('.cockpit-range-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.range === range);
      });
    }
    // Stessa coppia della dashboard: ridisegno immediato su ciò che c'è già in
    // `perfData` (restringe subito), poi la richiesta al server con `range`, che
    // è l'unico modo di riavere i punti più vecchi — `_renderPerformanceEquity()`
    // da solo rifiltrerebbe per sempre gli stessi dati in cache
    // (BUG-EQUITYRANGE-01). Un errore di rete lo racconta già `loadPerformance`.
    this._renderPerformanceEquity();
    this.loadPerformance(true);
  }

  /**
   * Normalizza un timestamp per Lightweight Charts, che vuole secondi.
   * Serve perché le due fonti non concordano: `risk_equity_history.ts` è in
   * secondi (vedi il chiamante in server.js) mentre `ml_history.ts` è in
   * millisecondi (`Date.now()` nell'insert). Senza questa conversione una delle
   * due curve finirebbe nel 1970.
   */
  _toChartTime(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e11 ? n / 1000 : n);
  }

  /** Ordina per tempo e scarta i duplicati: Lightweight Charts pretende una serie crescente. */
  _chartSeries(points) {
    const byTime = new Map();
    for (const point of points) {
      if (point && point.time !== null && Number.isFinite(point.value)) byTime.set(point.time, point.value);
    }
    return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  }

  _renderPerformance() {
    this._renderPerformanceEquity();
    this._renderCloseReasons();
    this._renderMlCoinOptions();
    this._renderMlQuality();
    this._renderPerformanceBots();
  }

  _renderPerformanceEquity() {
    const empty = document.getElementById('perfEquityEmpty');
    const rangeEl = document.getElementById('perfEquityRange');
    const rawPoints = this._chartSeries((this.perfData?.equityHistory || []).map((p) => ({
      time: this._toChartTime(p?.time ?? p?.ts), value: Number(p?.value ?? p?.equity)
    })));
    const points = this._filterEquityPointsByRange(rawPoints, this.perfEquityRange || 'all');

    if (empty) empty.hidden = points.length > 0;
    if (rangeEl) {
      const rangeLabels = {
        '1d': 'ultime 24h',
        '7d': 'ultimi 7gg',
        '30d': 'ultimi 30gg',
        '90d': 'ultimi 90gg',
        '365d': 'ultimo anno',
        'all': 'tutto lo storico'
      };
      const currentRange = rangeLabels[this.perfEquityRange] || this.perfEquityRange || 'tutto lo storico';
      rangeEl.textContent = points.length
        ? `${points.length} campioni · ${currentRange} (dal ${new Date(points[0].time * 1000).toLocaleDateString('it-IT')})`
        : '—';
    }
    const el = document.getElementById('perfEquityChart');
    if (!el || !window.LightweightCharts) return;
    if (!this.perfChart) {
      this.perfChart = LightweightCharts.createChart(el, {
        width: el.clientWidth || 640,
        height: Math.max(el.clientHeight || 0, 214),
        layout: { background: { color: 'transparent' }, textColor: '#8b97a8', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
        grid: { vertLines: { color: '#1b2538' }, horzLines: { color: '#1b2538' } },
        rightPriceScale: { borderColor: '#1b2538', minimumWidth: 64 },
        timeScale: { borderColor: '#1b2538', timeVisible: true, secondsVisible: false }
      });
      this.perfEquitySeries = this.perfChart.addAreaSeries({
        lineColor: '#26d07c', topColor: 'rgba(38, 208, 124, 0.24)', bottomColor: 'rgba(38, 208, 124, 0.02)',
        lineWidth: 2, priceLineVisible: false
      });
      if (window.ResizeObserver) {
        this.perfResizeObserver = new ResizeObserver(() => {
          if (!this.perfChart || !el.clientWidth) return;
          this.perfChart.resize(el.clientWidth, Math.max(el.clientHeight, 214));
        });
        this.perfResizeObserver.observe(el);
      }
    }
    this.perfEquitySeries?.setData(points);
    if (points.length) this.perfChart?.timeScale?.().fitContent();
  }

  /**
   * Breakdown dei motivi di chiusura. Le chiavi sconosciute vengono mostrate come
   * arrivano (escapate): meglio una etichetta grezza che nascondere trade veri
   * perché il backend ha aggiunto un motivo che questa mappa non conosce.
   *
   * Due bucket sono però trattati diversamente dagli altri, perché non sono
   * esiti di trading come TP o SL ma segnali di un difetto, e vanno letti come
   * avvisi invece che come righe di statistica:
   *
   *  - le posizioni chiuse dalla riconciliazione DB↔Hyperliquid (bot fermo,
   *    posizione sparita dall'exchange senza che nessun trigger l'abbia chiusa);
   *  - le righe DUPLICATE, cioè una sola posizione reale adottata da più bot
   *    sullo stesso wallet e mercato, ognuno con la propria riga. Qui il rischio
   *    di lettura è più insidioso dell'altro: senza distinguerle, N copie dello
   *    stesso trade sembrano N trade e gonfiano ogni conteggio.
   *
   * Entrambi ricevono lo stesso trattamento visivo del badge `⚠️ CRASH` sulla
   * card del bot (`.bot-status-crashed-badge`), unico avviso già presente qui.
   *
   * Il nome del bucket lo decide il backend (`closeReasonBucket()` in
   * `src/db/database.js`): sta in una costante sola perché rinominarlo resti una
   * riga da cambiare, non una caccia nel file.
   */
  _renderCloseReasons() {
    const target = document.getElementById('perfCloseReasons');
    if (!target) return;
    const RECONCILIATION_BUCKET = 'reconciliation_mismatch';
    const DUPLICATE_BUCKET = 'duplicate_adoption';
    // Bucket che NON sono esiti di trading ma segnali di difetto: stesso
    // trattamento visivo, tooltip diverso perché il difetto è diverso (e si
    // corregge in modo diverso). La classe CSS resta una sola, quella già
    // esistente: il significato per chi guarda è identico — «questa riga è un
    // avviso, non una statistica» — e inventarne una seconda identica
    // aggiungerebbe CSS senza aggiungere informazione.
    const WARNING_HINTS = {
      [RECONCILIATION_BUCKET]: 'Posizione chiusa dalla riconciliazione: risultava aperta nel database ma non su Hyperliquid. Nessun trigger del bot l\'ha chiusa.',
      [DUPLICATE_BUCKET]: 'Riga duplicata: una sola posizione reale è stata adottata da più bot sullo stesso wallet e mercato, e ognuno ne ha registrata una copia. Il risultato vero è contato una volta sola, sulla riga originale.'
    };
    const labels = {
      tp: 'Take profit', sl: 'Stop loss', manual: 'Chiusura manuale', dca: 'DCA',
      trailing: 'Trailing stop', liquidation: 'Liquidazione', signal: 'Segnale di uscita',
      killswitch: 'Kill-switch', unknown: 'Non registrato', other: 'Altro',
      [RECONCILIATION_BUCKET]: '⚠️ Disallineato con Hyperliquid',
      [DUPLICATE_BUCKET]: '⚠️ Riga duplicata (non è un trade)'
    };
    const totals = new Map();
    for (const bot of this.perfData?.bots || []) {
      for (const [reason, count] of Object.entries(bot?.closeReasons || {})) {
        const n = Number(count);
        if (!Number.isFinite(n) || n <= 0) continue;
        totals.set(reason, (totals.get(reason) || 0) + n);
      }
    }
    const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    if (!rows.length) {
      target.innerHTML = '<div class="cockpit-empty">Nessun trade chiuso ancora registrato: il breakdown si popola dalla prima chiusura.</div>';
      return;
    }
    const total = rows.reduce((sum, [, n]) => sum + n, 0);
    target.innerHTML = rows.map(([reason, count]) => {
      const label = labels[reason] || reason;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const warningHint = WARNING_HINTS[reason];
      const rowClass = warningHint ? 'cockpit-metric-row close-reason-mismatch' : 'cockpit-metric-row';
      const hint = warningHint ? ` title="${this._escapeHtml(warningHint)}"` : '';
      return `<div class="${rowClass}"${hint}><span>${this._escapeHtml(label)}</span><strong>${count} · ${pct}%</strong></div>`;
    }).join('');
  }

  /** Popola il selettore dei mercati presenti nello storico ML. */
  _renderMlCoinOptions() {
    const select = document.getElementById('perfMlCoin');
    if (!select) return;
    const coins = [...new Set((this.perfData?.mlHistory || []).map((r) => r?.coin).filter(Boolean))].sort();
    if (!coins.includes(this.perfMlCoin)) this.perfMlCoin = coins[0] || null;
    select.innerHTML = coins.length
      ? coins.map((coin) => `<option value="${this._escapeHtml(coin)}"${coin === this.perfMlCoin ? ' selected' : ''}>${this._escapeHtml(coin)}</option>`).join('')
      : '<option value="">Nessun mercato</option>';
    select.disabled = !coins.length;
    if (this.perfMlCoin) select.value = this.perfMlCoin;
  }

  /**
   * Andamento della qualità del modello ML: accuracy contro baseline.
   * È il dato con più valore percepito di questa sezione perché è l'unico che
   * finora non era visibile da nessuna parte pur essendo raccolto a ogni
   * retraining. La baseline è la percentuale della classe maggioritaria: una
   * accuracy sotto la baseline vuol dire modello inutile, e va vista.
   */
  _renderMlQuality() {
    const rows = (this.perfData?.mlHistory || []).filter((r) => !this.perfMlCoin || r?.coin === this.perfMlCoin);
    const accuracy = this._chartSeries(rows.map((r) => ({ time: this._toChartTime(r?.ts ?? r?.time), value: Number(r?.accuracy) })));
    const baseline = this._chartSeries(rows.map((r) => ({ time: this._toChartTime(r?.ts ?? r?.time), value: Number(r?.baseline) })));
    const empty = document.getElementById('perfMlEmpty');
    if (empty) empty.hidden = accuracy.length > 0 || baseline.length > 0;

    const el = document.getElementById('perfMlChart');
    if (!el || !window.LightweightCharts) return;
    if (!this.perfMlChart) {
      this.perfMlChart = LightweightCharts.createChart(el, {
        width: el.clientWidth || 640,
        height: Math.max(el.clientHeight || 0, 214),
        layout: { background: { color: 'transparent' }, textColor: '#8b97a8', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
        grid: { vertLines: { color: '#1b2538' }, horzLines: { color: '#1b2538' } },
        rightPriceScale: { borderColor: '#1b2538', minimumWidth: 64 },
        timeScale: { borderColor: '#1b2538', timeVisible: true, secondsVisible: false }
      });
      this.perfMlAccuracySeries = this.perfMlChart.addLineSeries({ color: '#6fa9ff', lineWidth: 2, priceLineVisible: false });
      this.perfMlBaselineSeries = this.perfMlChart.addLineSeries({ color: '#8b97a8', lineWidth: 1, lineStyle: 2, priceLineVisible: false });
    }
    this.perfMlAccuracySeries?.setData(accuracy);
    this.perfMlBaselineSeries?.setData(baseline);
    if (accuracy.length || baseline.length) this.perfMlChart?.timeScale?.().fitContent();
  }

  _renderPerformanceBots() {
    const tbody = document.getElementById('perfBotsBody');
    if (!tbody) return;
    const bots = this.perfData?.bots || [];
    if (!bots.length) {
      tbody.innerHTML = `<tr><td class="cockpit-empty" colspan="7">${this.perfData
        ? 'Nessun bot con trade chiusi: le colonne si popolano dalla prima chiusura.'
        : 'Dati non disponibili.'}</td></tr>`;
      return;
    }
    const pct = (v) => (Number.isFinite(Number(v)) ? `${(Number(v) * (Number(v) <= 1 ? 100 : 1)).toFixed(1)}%` : '—');
    const signed = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      return `${n >= 0 ? '+' : '-'}${this.fmtUsd(Math.abs(n))}`;
    };
    tbody.innerHTML = bots.map((bot) => {
      const pnl = Number(bot?.totalPnl ?? bot?.pnl);
      const expectancy = Number(bot?.expectancy);
      const pnlClass = Number.isFinite(pnl) ? (pnl >= 0 ? 'cockpit-positive' : 'cockpit-negative') : '';
      const expClass = Number.isFinite(expectancy) ? (expectancy >= 0 ? 'cockpit-positive' : 'cockpit-negative') : '';
      return `<tr>
        <td class="cockpit-symbol">${this._escapeHtml(bot?.name || bot?.botId || '—')}</td>
        <td>${Number.isFinite(Number(bot?.trades)) ? Number(bot.trades) : '—'}</td>
        <td>${pct(bot?.winRate)}</td>
        <td class="${pnlClass}">${signed(pnl)}</td>
        <td class="${expClass}">${signed(expectancy)}</td>
        <td>${signed(bot?.avgWin)}</td>
        <td>${signed(bot?.avgLoss)}</td>
      </tr>`;
    }).join('');
  }

  // ---- Wallet MetaMask ----
  // Hyperliquid non usa nessuna rete EVM per operare: il chainId che finisce nel
  // dominio EIP-712 (approveAgent, transfer Spot→Perp) arriva dal payload del
  // server e viene letto da MetaMask al momento della firma. Qui NON si verifica
  // né si cambia la rete di MetaMask: forzarla era il primo dei due bug che
  // EVM-01 chiude. Da non confondere con `setNetwork()` più sotto, che è la rete
  // di Hyperliquid (testnet/mainnet) — cosa diversa, stessa parola.

  /**
   * Aggancia la UI del wallet e tenta una riconnessione silenziosa.
   * `eth_accounts` non apre popup: risponde solo se l'utente ha già autorizzato
   * il sito in una sessione precedente.
   */
  async initWallet(retries = 3) {
    // Il pill in header è l'unico punto di ingresso alla connessione da quando
    // la card `.wallet-section` (stile demo EVM) è stata ritirata: se questo
    // listener non c'è, non resta nulla da premere.
    const pill = document.getElementById('walletStatus');
    if (pill && !pill.dataset.bound) {
      pill.dataset.bound = '1';
      pill.addEventListener('click', () => {
        if (this.isConnected) this.disconnectWallet();
        else this.connectWallet();
      });
      pill.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pill.click(); }
      });
    }
    this._updateWalletUi();

    if (typeof window.ethereum === 'undefined') {
      // L'estensione può iniettare `window.ethereum` dopo il primo paint.
      if (retries > 0) return void setTimeout(() => this.initWallet(retries - 1), 1000);
      return;
    }
    if (!this._walletEventsBound) {
      this._walletEventsBound = true;
      window.ethereum.on?.('accountsChanged', (accounts) => {
        if (!accounts || accounts.length === 0) this.disconnectWallet();
        else if (accounts[0] !== this.walletAddress) this._setWallet(accounts[0]);
      });
      // Nessun handler su `chainChanged`: prima ricaricava la pagina, ma la vista
      // Perps non ha stato che dipenda dalla rete di MetaMask (vedi sopra).
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accounts?.length) this._setWallet(accounts[0]);
    } catch (e) {
      console.warn('Verifica account MetaMask fallita', e);
    }
  }

  async connectWallet() {
    if (typeof window.ethereum === 'undefined') {
      return this.toast('MetaMask non disponibile: installa l\'estensione per collegare il wallet', 'error');
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts?.length) return this.toast('Nessun account selezionato in MetaMask', 'warning');
      this._setWallet(accounts[0]);
      this.toast('Wallet connesso', 'success');
    } catch (e) {
      // 4001 = l'utente ha rifiutato la richiesta: non è un errore da segnalare come tale.
      if (e?.code === 4001) return this.toast('Connessione annullata', 'info');
      this.toast('Errore connessione wallet: ' + (e?.message || e), 'error');
    }
  }

  disconnectWallet() {
    if (!this.isConnected) return;
    this.walletAddress = null;
    this.isConnected = false;
    this._updateWalletUi();
    // MetaMask non offre una vera "disconnessione" lato estensione: qui si
    // dimentica l'indirizzo, così la UI Perps torna allo stato non connesso.
    this.toast('Wallet disconnesso', 'info');
    this.refreshAccount();
  }

  _setWallet(address) {
    this.walletAddress = address;
    this.isConnected = !!address;
    this._updateWalletUi();
    this.refreshAccount();
  }

  _updateWalletUi() {
    const pill = document.getElementById('walletStatus');
    if (!pill) return;
    pill.classList.toggle('online', this.isConnected);
    pill.classList.toggle('offline', !this.isConnected);
    const label = pill.querySelector('.text');
    if (label) {
      label.textContent = this.isConnected
        ? `${this.walletAddress.slice(0, 6)}…${this.walletAddress.slice(-4)}`
        : 'MetaMask';
    }
    pill.title = this.isConnected
      ? `Wallet ${this.walletAddress} — clicca per disconnettere`
      : 'Clicca per collegare MetaMask';
  }

  // ---- Network ----
  async loadNetwork() {
    try {
      const d = await this.api('/api/perps/network');
      this.network = d.network;
      document.querySelectorAll('.net-pill').forEach(p =>
        p.classList.toggle('active', p.dataset.net === this.network));
      this._updateFaucetVisibility();
      this._applyNetworkBranding();
    } catch (e) { /* ignore */ }
  }

  /**
   * Allinea titolo, badge e avvertenze alla rete Hyperliquid effettiva (BRAND-01).
   *
   * Prima erano fissi: `<title>… Testnet Only</title>`, badge "TESTNET ONLY",
   * footer "Non utilizzare su mainnet". Affermazioni false appena
   * `HYPERLIQUID_NETWORK=mainnet` (che `validateConfig()` ammette solo con
   * `ALLOW_MAINNET=true`): chi guardava la tab del browser concludeva che mainnet
   * non fosse nemmeno un'opzione.
   *
   * La fonte è `GET /api/perps/network`, cioè la rete su cui il server sta
   * davvero operando — non la configurazione desiderata. In mainnet il badge è
   * rosso e dichiara i fondi reali: qui l'enfasi va sul caso che può costare,
   * non su quello innocuo.
   */
  _applyNetworkBranding() {
    const mainnet = this.network === 'mainnet';
    const label = mainnet ? 'MAINNET' : 'TESTNET';

    document.title = `🤖 ArbitrageBot Perps · ${label}`;

    const badge = document.getElementById('networkBadge');
    if (badge) {
      badge.textContent = mainnet ? 'MAINNET · FONDI REALI' : 'TESTNET';
      badge.classList.toggle('is-mainnet', mainnet);
      badge.title = mainnet
        ? 'Hyperliquid mainnet: ogni ordine muove denaro reale.'
        : 'Hyperliquid testnet: fondi simulati, nessun rischio di capitale.';
    }

    const notice = document.getElementById('footerNetworkNotice');
    if (notice) {
      notice.textContent = mainnet
        ? '⚠️ Mainnet: operazioni con fondi reali'
        : '🧪 Testnet: fondi simulati';
    }

    const eyebrow = document.getElementById('cockpitNetworkEyebrow');
    if (eyebrow) eyebrow.textContent = `OPERATING OVERVIEW · ${label}`;

    const orderNotice = document.getElementById('cockpitOrderNotice');
    if (orderNotice) {
      orderNotice.textContent = mainnet
        ? 'Fondi reali · verifica prima di inviare'
        : 'Testnet · verifica prima di inviare';
    }
  }

  async setNetwork(net) {
    if (net === this.network) return;
    let confirmMainnet = false;
    if (net === 'mainnet') {
      if (!confirm('⚠️ Passare a MAINNET significa operare con FONDI REALI. Confermi?')) return;
      confirmMainnet = true;
    }
    try {
      await this.api('/api/perps/network', {
        method: 'POST',
        body: JSON.stringify({ network: net, confirm: confirmMainnet })
      });
      this.network = net;
      this.toast(`Rete Perps: ${net.toUpperCase()}`, 'info');
      await this.loadNetwork();
      await this.loadMarkets();
      await this.refreshAccount();
      await this.loadBots();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---- Markets ----
  async loadMarkets() {
    try {
      this.markets = await this.api('/api/perps/markets');
      const opts = this.markets.map(m =>
        `<option value="${m.coin}">${m.name} · max ${m.maxLeverage}x</option>`).join('');
      const sel1 = document.getElementById('orderMarket');
      const sel2 = document.getElementById('botMarket');
      if (sel1) sel1.innerHTML = opts;
      if (sel2) sel2.innerHTML = opts;
      this.mids = {};
      this.markets.forEach(m => { if (m.mid) this.mids[m.coin] = m.mid; });
      this._updateMid();
    } catch (e) { this.toast('Mercati Perps: ' + e.message, 'error'); }
  }

  _updateMid() {
    const sel = document.getElementById('orderMarket');
    const el = document.getElementById('orderMid');
    if (!sel || !el) return;
    const px = this.mids[sel.value] ?? this.mids[sel.value?.replace('-PERP', '')];
    el.textContent = px ? this.fmtUsd(parseFloat(px)) : '—';
  }

  // ---- Account & Agent ----
  async refreshAccount() {
    const notConn = document.getElementById('perpsNotConnected');
    const body = document.getElementById('perpsAccountBody');
    if (!this.connected) {
      notConn?.classList.remove('hidden');
      body?.classList.add('hidden');
      this._refreshCockpitDashboard();
      return;
    }
    notConn?.classList.add('hidden');
    body?.classList.remove('hidden');

    try {
      const acc = await this.api('/api/perps/account?address=' + this.address);
      this.account = acc;
      // Mostra l'equity utilizzabile (Perp + Spot, account unificati)
      document.getElementById('perpsEquity').textContent = this.fmtUsd(acc.equity ?? acc.accountValue);
      document.getElementById('perpsMargin').textContent = this.fmtUsd(acc.totalMarginUsed);
      document.getElementById('perpsWithdrawable').textContent = this.fmtUsd(acc.withdrawable);
      document.getElementById('perpsPosCount').textContent = acc.positions.length;
      this._updateFaucetBadge(acc.accountValue);
      this._updateSpotTransfer(acc.spotUsdc || 0);
      this._allPositions = acc.positions;
      this._populatePosBotFilter();
      this.applyPosFilter();
      this._refreshCockpitDashboard();
    } catch (e) {
      // Account inesistente su HL = equity 0 (non un errore bloccante)
      this._updateFaucetBadge(0);
      this._updateSpotTransfer(0);
      this._renderPositions([]);
    }
    await this._refreshAgentStatus();
  }

  _updateSpotTransfer(spotUsdc) {
    this._spotUsdc = spotUsdc;
    const box = document.getElementById('spotTransfer');
    const bal = document.getElementById('spotBalance');
    if (bal) bal.textContent = this.fmtUsd(spotUsdc);
    if (box) box.classList.toggle('hidden', !(spotUsdc > 0.01) || this.network !== 'testnet');
  }

  fillTransferMax() {
    const inp = document.getElementById('transferAmount');
    if (inp && this._spotUsdc) inp.value = Math.floor(this._spotUsdc * 100) / 100;
  }

  async transferToPerp() {
    if (!this.connected) return this.toast('Connetti MetaMask', 'warning');
    const amount = parseFloat(document.getElementById('transferAmount').value);
    if (!amount || amount <= 0) return this.toast('Inserisci un importo valido', 'warning');
    try {
      this.toast('Preparazione trasferimento...', 'info');
      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      const prep = await this.api('/api/perps/transfer/prepare', {
        method: 'POST',
        body: JSON.stringify({ address: this.address, amount, toPerp: true, signatureChainId: chainId })
      });
      const { domain, types, message, primaryType } = prep.typedData;
      const fullTypedData = {
        domain, primaryType,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }
          ],
          ...types
        },
        message
      };
      const signature = await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [this.address, JSON.stringify(fullTypedData)]
      });
      await this.api('/api/perps/transfer/submit', {
        method: 'POST',
        body: JSON.stringify({ address: this.address, action: prep.action, signature })
      });
      this.toast(`✅ Trasferiti ${this.fmtUsd(amount)} a Perps!`, 'success');
      await this.refreshAccount();
    } catch (e) {
      const msg = e.message || String(e);
      if (/unified account/i.test(msg)) {
        // Account unificato: lo Spot è già collaterale, nessun trasferimento necessario
        this.toast('ℹ️ Account unificato: i tuoi USDC Spot sono già utilizzabili come collaterale. Puoi fare trading direttamente.', 'info');
        document.getElementById('spotTransfer')?.classList.add('hidden');
        await this.refreshAccount();
      } else {
        this.toast('Trasferimento fallito: ' + msg, 'error');
      }
    }
  }

  // ---- Faucet testnet ----
  _updateFaucetVisibility() {
    const card = document.getElementById('faucetCard');
    if (card) card.classList.toggle('hidden', this.network !== 'testnet');
  }

  _updateFaucetBadge(equity) {
    const b = document.getElementById('faucetEquityBadge');
    if (!b) return;
    b.textContent = 'Equity: ' + this.fmtUsd(equity);
    b.classList.toggle('funded', equity > 0);
  }

  openFaucet(which) {
    const urls = {
      hyperliquid: 'https://app.hyperliquid-testnet.xyz/drip',
      circle: 'https://faucet.circle.com',
      gas: 'https://faucets.chain.link/arbitrum-sepolia',
      deposit: 'https://app.hyperliquid-testnet.xyz/'
    };
    window.open(urls[which], '_blank', 'noopener');
    // Per i faucet/deposit che alimentano Hyperliquid, avvia il rilevamento fondi
    if (which === 'hyperliquid' || which === 'deposit') {
      if (this.connected) this._watchEquity();
      else this.toast('Connetti MetaMask per rilevare i fondi', 'warning');
    }
  }

  async _watchEquity() {
    if (this._watching) return;
    this._watching = true;
    const watch = document.getElementById('faucetWatch');
    const text = document.getElementById('faucetWatchText');
    watch?.classList.remove('hidden');
    const baseline = this.account?.accountValue || 0;
    let attempts = 0;
    const maxAttempts = 36; // ~3 minuti a 5s
    const tick = async () => {
      attempts++;
      try {
        const acc = await this.api('/api/perps/account?address=' + this.address);
        this.account = acc;
        this._updateFaucetBadge(acc.accountValue);
        if (acc.accountValue > baseline + 0.01) {
          this.toast(`✅ Fondi ricevuti! Equity: ${this.fmtUsd(acc.accountValue)}`, 'success');
          watch?.classList.add('hidden');
          this._watching = false;
          await this.refreshAccount();
          return;
        }
      } catch (e) { /* l'account potrebbe non esistere ancora */ }
      if (attempts >= maxAttempts) {
        if (text) text.textContent = 'Nessun fondo rilevato. Quando completi il faucet, premi "Aggiorna".';
        setTimeout(() => watch?.classList.add('hidden'), 6000);
        this._watching = false;
        return;
      }
      if (text) text.textContent = `In attesa dell'arrivo dei fondi… (${attempts}/${maxAttempts})`;
      setTimeout(tick, 5000);
    };
    setTimeout(tick, 5000);
  }

  async _refreshAgentStatus() {
    try {
      const s = await this.api('/api/perps/agent/status?address=' + this.address);
      const dot = document.querySelector('#agentStatus .agent-dot');
      const text = document.getElementById('agentStatusText');
      const btn = document.getElementById('enableAgentBtn');
      if (s.approved) {
        dot?.classList.remove('offline'); dot?.classList.add('online');
        if (text) text.textContent = 'Auto-trading attivo ✅';
        if (btn) { btn.textContent = '🔄 Rinnova agent'; }
      } else {
        dot?.classList.add('offline'); dot?.classList.remove('online');
        if (text) text.textContent = 'Auto-trading non abilitato';
        if (btn) btn.textContent = '🔑 Abilita auto-trading';
      }
    } catch (e) { /* ignore */ }
  }

  async enableAgent() {
    if (this.network === 'mainnet' && !this.connected) return this.toast('Connetti MetaMask per abilitare l\'agent in Mainnet', 'warning');
    try {
      this.toast('Generazione agent...', 'info');
      // Firma sul chainId su cui MetaMask è attualmente connesso: MetaMask rifiuta
      // di firmare un dominio EIP-712 con chainId diverso dalla rete attiva.
      // Hyperliquid accetta qualsiasi signatureChainId (ricostruisce il dominio da esso).
      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      const prep = await this.api('/api/perps/agent/prepare', {
        method: 'POST',
        body: JSON.stringify({ address: this.address, signatureChainId: chainId })
      });
      const { domain, types, message, primaryType } = prep.typedData;
      // Firma EIP-712 direttamente con MetaMask (eth_signTypedData_v4).
      // NON usiamo ethers _signTypedData perché impone che il chainId del dominio
      // coincida con la rete attiva: Hyperliquid richiede invece chainId 421614/42161
      // (solo dominio di firma, non una transazione), indipendente dalla rete connessa.
      const fullTypedData = {
        domain,
        primaryType,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          ...types
        },
        message
      };
      const signature = await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [this.address, JSON.stringify(fullTypedData)]
      });
      this.toast('Invio approvazione a Hyperliquid...', 'info');
      await this.api('/api/perps/agent/submit', {
        method: 'POST',
        body: JSON.stringify({ address: this.address, action: prep.action, signature })
      });
      this.toast('✅ Auto-trading abilitato!', 'success');
      await this._refreshAgentStatus();
    } catch (e) {
      this.toast('Errore approvazione agent: ' + (e.message || e), 'error');
    }
  }

  _renderPositions(positions) {
    const tbody = document.getElementById('positionsList');
    const empty = document.getElementById('noPositions');
    if (!tbody) return;
    if (!positions.length) {
      tbody.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    tbody.innerHTML = positions.map(p => {
      const pnlClass = p.unrealizedPnl >= 0 ? 'profit-positive' : 'profit-negative';
      // Secondo valore EUR (CUR-01): stringa vuota quando il tasso non è fresco.
      // Deriva solo da numeri formattati, quindi non introduce markup di terzi.
      const pnlEur = this.fmtEur(p.unrealizedPnl);
      const coin = p.coin.includes('-PERP') ? p.coin : p.coin + '-PERP';
      const opened = p.openedAt ? new Date(p.openedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '<span class="muted">—</span>';
      const botCell = p.botName
        ? `<span class="hist-bot">${p.botName === 'Manuale' ? '✋ Manuale' : '🤖 ' + p.botName}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td>${opened}</td>
        <td>${botCell}</td>
        <td>${p.coin}</td>
        <td><span class="side-badge ${p.side}">${p.side.toUpperCase()}</span></td>
        <td>${this.fmtNum(p.size)}</td>
        <td>${this.fmtUsd(p.entryPx)}</td>
        <td class="${pnlClass}">${this.fmtUsd(p.unrealizedPnl)}${pnlEur ? `<small class="cockpit-eur">≈ ${pnlEur}</small>` : ''}</td>
        <td>${p.leverage ? p.leverage + 'x' : '—'}</td>
        <td>${p.liquidationPx ? this.fmtUsd(p.liquidationPx) : '—'}</td>
        <td class="pos-actions">
          <button class="btn btn-sm btn-outline" onclick="perps.openChart('${coin}')">📊</button>
          <button class="btn btn-sm btn-danger" onclick="perps.closePosition('${coin}')">Chiudi</button>
        </td>
      </tr>`;
    }).join('');
  }

  /** Popola il menu dei bot nel filtro delle posizioni aperte. */
  _populatePosBotFilter() {
    const sel = document.getElementById('posBot');
    if (!sel) return;
    const names = [...new Set((this._allPositions || []).map(p => p.botName).filter(Boolean))].sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">Tutti i bot</option>' + names.map(n => `<option value="${n}">${n}</option>`).join('');
    if (names.includes(cur)) sel.value = cur;
  }

  setPosRange(range) {
    this._posRange = range;
    document.querySelectorAll('.pos-preset').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    const f = document.getElementById('posFrom'); const t = document.getElementById('posTo');
    if (f) f.value = ''; if (t) t.value = '';
    this.applyPosFilter();
  }

  applyPosFilter(fromRange = false) {
    if (fromRange) {
      this._posRange = 'custom';
      document.querySelectorAll('.pos-preset').forEach(b => b.classList.remove('active'));
    }
    let fromTs = 0, toTs = Date.now(), hasDate = false;
    const f = document.getElementById('posFrom')?.value;
    const t = document.getElementById('posTo')?.value;
    if (f || t) { hasDate = true; if (f) fromTs = new Date(f + 'T00:00:00').getTime(); if (t) toTs = new Date(t + 'T23:59:59').getTime(); }
    else { const days = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 }[this._posRange]; if (days) { hasDate = true; fromTs = Date.now() - days * 86400000; } }
    const botFilter = document.getElementById('posBot')?.value || '';
    const filtered = (this._allPositions || []).filter(p => {
      if (botFilter && p.botName !== botFilter) return false;
      // Le posizioni senza data nota restano sempre visibili (non si nasconde una posizione live)
      if (hasDate && p.openedAt != null && !(p.openedAt >= fromTs && p.openedAt <= toTs)) return false;
      return true;
    });
    this._renderPositions(filtered);
  }

  async closePosition(coin) {
    if (!confirm(`Chiudere la posizione su ${coin}?`)) return;
    try {
      await this.api(`/api/perps/positions/${encodeURIComponent(coin)}/close`, {
        method: 'POST',
        body: JSON.stringify({ masterAddress: this.address })
      });
      this.toast('Posizione chiusa', 'success');
      await this.refreshAccount();
      if (this.posTab === 'history') this.loadFills();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---- Rischio portafoglio & notifiche ----
  async loadPortfolio() {
    try {
      const l = await this.api('/api/perps/portfolio');
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      set('pfMaxPositions', l.maxConcurrentPositions);
      set('pfMaxExposure', l.maxTotalExposureUsd);
      set('pfMaxLosses', l.maxConsecutiveLosses);
      set('pfCooldown', l.cooldownMinutes);
    } catch (e) { /* ignore */ }
  }

  async savePortfolio() {
    try {
      await this.api('/api/perps/portfolio', {
        method: 'POST',
        body: JSON.stringify({
          maxConcurrentPositions: parseInt(document.getElementById('pfMaxPositions').value),
          maxTotalExposureUsd: parseFloat(document.getElementById('pfMaxExposure').value),
          maxConsecutiveLosses: parseInt(document.getElementById('pfMaxLosses').value),
          cooldownMinutes: parseInt(document.getElementById('pfCooldown').value)
        })
      });
      this.toast('Limiti di portafoglio salvati', 'success');
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async loadNotifications() {
    try {
      const s = await this.api('/api/perps/notifications');
      const en = document.getElementById('tgEnabled');
      const st = document.getElementById('tgStatus');
      if (en) en.checked = !!s.enabled;
      if (st) st.textContent = s.configured ? '(configurato)' : '(non configurato)';
      this._refreshTgControlStatus();
    } catch (e) { /* ignore */ }
  }

  async _refreshTgControlStatus() {
    const el = document.getElementById('tgControlStatus');
    if (!el) return;
    try {
      const s = await this.api('/api/perps/telegram/status');
      el.textContent = s.running ? '🟢 attivo' : (s.configured ? '⏸️ in pausa' : '⚪ non configurato');
    } catch { /* ignore */ }
  }

  // ---- Agente AI ----
  async loadAgents() {
    try {
      const [status, props] = await Promise.all([
        this.api('/api/agents/status'),
        this.api('/api/agents/proposals?status=pending')
      ]);
      const a = status.analyst || {};
      const st = document.getElementById('aiAgentStatus');
      if (st) {
        let base;
        if (!a.hasApiKey) base = '⚪ chiave AI non configurata';
        else if (!a.enabled) base = '⏸️ disattivato (AGENTS_ENABLED)';
        else if (a.paused) base = a.busy ? '⏸️ in pausa (run in corso in chiusura)' : '⏸️ in pausa';
        else if (a.busy) base = '🟢 analisi in corso…';
        else base = `🟢 attivo · ${a.runsThisHour}/${a.maxCallsPerHour} run/h`;
        const cost = a.costTotal ? ` · 💸 speso ${this._fmtCost(a.costTotal)}` : '';
        st.textContent = base + cost;
        if (st.title !== undefined) st.title = a.model ? `Modello: ${a.model}` : '';
      }
      // Pausa/Riprendi si scambiano in base allo stato; Stop resta sempre visibile
      // (utile anche mentre è in pausa, per azzerare il contatore).
      document.getElementById('aiAgentPauseBtn')?.classList.toggle('hidden', !!a.paused);
      document.getElementById('aiAgentResumeBtn')?.classList.toggle('hidden', !a.paused);
      this._setKillSwitchUi(status.killSwitch);
      this._renderProposals(props || []);
      await this.loadStrategyHistory();
    } catch (e) { /* ignore */ }
  }

  /**
   * Allinea l'interfaccia allo stato del kill-switch: etichetta e visibilità del
   * bottone di riattivazione. Sta in un metodo unico perché lo stato arriva da due
   * fonti distinte (`/api/agents/status` in loadAgents e `/api/perps/risk` nello
   * snapshot del cockpit): duplicare la logica le farebbe divergere.
   */
  _setKillSwitchUi(on) {
    const active = on === true;
    const ks = document.getElementById('killswitchState');
    if (ks) ks.textContent = active ? '🔴 ATTIVO — aperture bloccate' : '';
    document.getElementById('killswitchResumeBtn')?.classList.toggle('hidden', !active);
  }

  /** Cambia la categoria dello storico strategie (approvate / rifiutate / scadute). */
  switchStrategyTab(tab) {
    this.strategyTab = tab;
    this._selectedStrategies = new Set(); // la selezione non attraversa le categorie
    document.querySelectorAll('.sh-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.shtab === tab));
    this._renderStrategyHistory();
  }

  /** Storico delle strategie AI, diviso per esito, con selezione ed eliminazione. */
  async loadStrategyHistory() {
    const box = document.getElementById('strategyHistory');
    if (!box) return;
    try {
      const r = await this.api('/api/agents/strategy-history');
      this._strategyHistory = r.items || [];
      this._strategyCounts = r.counts || null;
      this._renderStrategyHistory();
    } catch (e) { /* ignore */ }
  }

  _renderStrategyHistory() {
    const box = document.getElementById('strategyHistory');
    if (!box) return;
    const all = this._strategyHistory || [];
    const tab = this.strategyTab || 'approved';
    this._selectedStrategies = this._selectedStrategies || new Set();

    // Conteggi esatti dal server (indipendenti dal limite sulle righe); il
    // calcolo locale è solo un fallback se il server non li fornisce.
    let counts = this._strategyCounts;
    if (!counts) {
      counts = { approved: 0, rejected: 0, expired: 0 };
      for (const h of all) if (counts[h.status] !== undefined) counts[h.status]++;
    }
    for (const [k, v] of Object.entries(counts)) {
      const el = document.getElementById(`shCount${k[0].toUpperCase()}${k.slice(1)}`);
      if (el) el.textContent = v;
    }

    const hist = all.filter(h => h.status === tab);
    this._updateStrategySelectionUI(hist);

    // Il riciclo ha senso solo sulle scadute: le rifiutate non si ripropongono.
    document.getElementById('shRecycleBtn')?.classList.toggle('hidden', tab !== 'expired');

    if (!hist.length) {
      const empty = { approved: 'Nessuna strategia approvata.', rejected: 'Nessuna strategia rifiutata.', expired: 'Nessuna strategia scaduta.' }[tab];
      box.innerHTML = `<div class="agent-empty">${empty}</div>`;
      return;
    }

    box.innerHTML = hist.map(h => {
        const date = h.decidedAt ? new Date(h.decidedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const badge = h.status === 'approved' ? '<span class="sh-badge ok">approvata</span>'
          : h.status === 'rejected' ? '<span class="sh-badge no">rifiutata</span>'
          : '<span class="sh-badge exp">scaduta</span>';
        let outcome = '';
        if (h.status === 'approved') {
          if (!h.linkedBotId) outcome = '<span class="sh-outcome muted">— bot non ancora creato</span>';
          else if (!h.botExists) outcome = '<span class="sh-outcome muted">— bot eliminato</span>';
          else if (!h.outcome || !h.outcome.trades) outcome = `<span class="sh-outcome muted">▶️ ${h.botName} · in attesa di operazioni</span>`;
          else {
            const o = h.outcome;
            const pnlCls = o.totalPnl >= 0 ? 'profit-positive' : 'profit-negative';
            const pf = isFinite(o.profitFactor) ? o.profitFactor.toFixed(2) : '∞';
            outcome = `<span class="sh-outcome">📊 ${h.botName}: ${o.trades} op · WR ${(o.winRate * 100).toFixed(0)}% · PF ${pf} · PnL <span class="${pnlCls}">${this.fmtUsd(o.totalPnl)}</span></span>`;
          }
        }
        const costLine = h.model ? `<div class="sh-cost">🧠 ${h.model} · elaborazione ${this._fmtCost(h.costUsd)}</div>` : '';
        const checked = this._selectedStrategies.has(h.id) ? 'checked' : '';
        const recycle = h.status === 'expired'
          ? `<button class="sh-recycle" title="Rilancia il backtest ora e riproponila se ha ancora edge (gratis)" onclick="perps.recycleStrategies(['${h.id}'])">♻️</button>`
          : '';
        return `
        <div class="sh-row">
          <div class="sh-line1">
            <input type="checkbox" class="sh-check" ${checked} onchange="perps.toggleStrategySelection('${h.id}', this.checked)">
            ${badge} <b>${h.coin || ''}</b> <span class="muted">${date}</span>
            ${recycle}
            <button class="sh-export" title="Esporta questa strategia in un file JSON" onclick="perps.exportStrategies(['${h.id}'])">📤</button>
            <button class="sh-del" title="Elimina questa strategia" onclick="perps.deleteStrategy('${h.id}')">🗑️</button>
          </div>
          ${h.rationale ? `<div class="sh-rationale">${h.rationale}</div>` : ''}
          ${costLine}
          ${outcome ? `<div>${outcome}</div>` : ''}
        </div>`;
    }).join('');
  }

  toggleStrategySelection(id, on) {
    this._selectedStrategies = this._selectedStrategies || new Set();
    if (on) this._selectedStrategies.add(id); else this._selectedStrategies.delete(id);
    this._updateStrategySelectionUI();
  }

  toggleSelectAllStrategies(on) {
    const tab = this.strategyTab || 'approved';
    const visible = (this._strategyHistory || []).filter(h => h.status === tab);
    this._selectedStrategies = new Set(on ? visible.map(h => h.id) : []);
    this._renderStrategyHistory();
  }

  /** Tiene allineati contatore selezione e stato del "seleziona tutte". */
  _updateStrategySelectionUI(visibleList) {
    const tab = this.strategyTab || 'approved';
    const visible = visibleList || (this._strategyHistory || []).filter(h => h.status === tab);
    const sel = this._selectedStrategies || new Set();
    const n = visible.filter(h => sel.has(h.id)).length;
    const label = document.getElementById('shSelCount');
    if (label) label.textContent = n ? `${n} selezionate` : '';
    const all = document.getElementById('shSelectAll');
    if (all) {
      all.checked = n > 0 && n === visible.length;
      all.indeterminate = n > 0 && n < visible.length;
    }
  }

  async deleteStrategy(id) {
    if (!confirm('Eliminare questa strategia dallo storico?')) return;
    await this._deleteStrategies({ ids: [id] });
  }

  async deleteSelectedStrategies() {
    const ids = [...(this._selectedStrategies || [])];
    if (!ids.length) return this.toast('Nessuna strategia selezionata', 'warning');
    if (!confirm(`Eliminare ${ids.length} strategie dallo storico?`)) return;
    await this._deleteStrategies({ ids });
  }

  async recycleSelectedStrategies() {
    const ids = [...(this._selectedStrategies || [])];
    if (!ids.length) return this.toast('Nessuna strategia selezionata', 'warning');
    await this.recycleStrategies(ids);
  }

  /**
   * Ricicla strategie scadute: il server rilancia il backtest sui dati correnti
   * e ripropone solo quelle che hanno ancora edge. Non costa token.
   */
  async recycleStrategies(ids) {
    const box = document.getElementById('strategyHistory');
    box?.classList.add('is-recycling');
    this.toast(`Ribacktest di ${ids.length} strateg${ids.length === 1 ? 'ia' : 'ie'} in corso…`, 'info');
    try {
      const r = await this.api('/api/agents/strategy-history/recycle', {
        method: 'POST', body: JSON.stringify({ ids })
      });
      this._selectedStrategies = new Set();

      if (r.recycled) {
        this.toast(`♻️ ${r.recycled} di ${r.evaluated} riproposte: le trovi tra le proposte in attesa`, 'success');
      } else {
        // Nessun riciclo non è un errore: significa che l'edge non regge più.
        // Mostrare il motivo evita che sembri un malfunzionamento.
        const why = (r.results || []).find(x => !x.ok)?.reason;
        this.toast(`Nessuna strategia riproposta${why ? ` — ${why}` : ''}`, 'warning');
      }
      await this.loadStrategyHistory();
      this.loadAgents();
    } catch (e) {
      this.toast(`Riciclo fallito: ${e.message}`, 'error');
    } finally {
      box?.classList.remove('is-recycling');
    }
  }

  // ---- Esportazione / importazione dello storico strategie (STRAT-01) ----
  //
  // Formato del file: una busta autodescrittiva, non l'array nudo. Serve a
  // riconoscere subito un file che non c'entra nulla (o di una versione futura)
  // invece di scoprirlo campo per campo durante l'importazione.
  //
  //   { kind: "arbitragebot.strategies", version: 1, exportedAt, network, items: [...] }
  //
  // Ogni `item` porta la configurazione completa della strategia (`payload.config`,
  // lo stesso blob che finisce in `bots.config_json`) più i metadati che rendono
  // leggibile da cosa arriva: mercato, esito, motivazione, modello e costo.

  static get EXPORT_KIND() { return 'arbitragebot.strategies'; }
  static get EXPORT_VERSION() { return 1; }

  /** Riduce una voce dello storico ai campi che hanno senso fuori da questo DB. */
  _strategyExportItem(h) {
    return {
      coin: h.coin,
      status: h.status,
      rationale: h.rationale,
      confidence: h.confidence,
      createdAt: h.createdAt,
      decidedAt: h.decidedAt,
      model: h.model,
      costUsd: h.costUsd,
      // `payload` contiene { coin, interval, config }: `config` è la strategia vera
      // e propria (regole, leva, sizing, TP/SL) ed è il campo che rende il file
      // riutilizzabile. Senza di esso l'export sarebbe solo un promemoria.
      payload: h.payload
    };
  }

  exportSelectedStrategies() {
    const ids = [...(this._selectedStrategies || [])];
    if (!ids.length) return this.toast('Nessuna strategia selezionata', 'warning');
    this.exportStrategies(ids);
  }

  /**
   * Scarica le strategie indicate come file JSON. Non passa dal server: i dati
   * sono già quelli mostrati a schermo, quindi il file rispecchia esattamente
   * quello che l'utente sta guardando.
   */
  exportStrategies(ids) {
    const wanted = new Set(ids);
    const items = (this._strategyHistory || []).filter(h => wanted.has(h.id));
    if (!items.length) return this.toast('Strategie non trovate nello storico caricato', 'warning');

    const senzaConfig = items.filter(h => !h.payload?.config);
    if (senzaConfig.length) {
      // Meglio dirlo che esportare in silenzio un file che all'importazione
      // verrebbe scartato: è la stessa ragione per cui il riciclo rifiuta i
      // payload incompleti invece di ritentare un backtest impossibile.
      this.toast(`${senzaConfig.length} su ${items.length} senza configurazione: verranno esportate come sola cronologia, non riutilizzabili`, 'warning');
    }

    const envelope = {
      kind: PerpsApp.EXPORT_KIND,
      version: PerpsApp.EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      network: this.network,
      items: items.map(h => this._strategyExportItem(h))
    };

    const stamp = new Date().toISOString().slice(0, 10);
    const name = items.length === 1 && items[0].coin
      ? `strategia-${String(items[0].coin).toLowerCase()}-${stamp}.json`
      : `strategie-${items.length}-${stamp}.json`;
    this._downloadJson(envelope, name);
    this.toast(`📤 ${items.length} strateg${items.length === 1 ? 'ia' : 'ie'} esportate in ${name}`, 'success');
  }

  _downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // L'object URL trattiene il Blob in memoria finché non viene revocato.
    URL.revokeObjectURL(url);
  }

  pickStrategiesFile() {
    const input = document.getElementById('shImportFile');
    if (!input) return;
    input.value = ''; // permette di reimportare due volte lo stesso file
    input.click();
  }

  /**
   * Valida la busta di un file di strategie **prima** di inviare qualunque cosa
   * al server. Ritorna { items, errors }: `errors` non vuoto = niente scrittura.
   *
   * Questo è il primo dei due controlli, non l'unico che conta: la validazione
   * autorevole resta lato server, perché è lì che si scrive. Qui serve a dare un
   * messaggio comprensibile invece di un errore generico, e a non spedire al
   * server file che si sa già essere sbagliati.
   */
  _validateStrategiesFile(parsed) {
    const errors = [];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { items: [], errors: ['Il file non contiene un oggetto JSON.'] };
    }
    if (parsed.kind !== PerpsApp.EXPORT_KIND) {
      return { items: [], errors: [`Non è un export di strategie di ArbitrageBot (kind: ${parsed.kind ?? 'assente'}).`] };
    }
    if (parsed.version !== PerpsApp.EXPORT_VERSION) {
      return { items: [], errors: [`Versione del formato non supportata: ${parsed.version ?? 'assente'} (attesa ${PerpsApp.EXPORT_VERSION}).`] };
    }
    if (!Array.isArray(parsed.items) || !parsed.items.length) {
      return { items: [], errors: ['Il file non contiene strategie (items vuoto o assente).'] };
    }

    const items = [];
    parsed.items.forEach((it, i) => {
      const where = `voce ${i + 1}`;
      if (!it || typeof it !== 'object') return void errors.push(`${where}: non è un oggetto.`);
      if (!it.coin || typeof it.coin !== 'string') return void errors.push(`${where}: campo "coin" mancante.`);
      const cfg = it.payload?.config;
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        return void errors.push(`${where} (${it.coin}): manca payload.config, la configurazione della strategia.`);
      }
      // Una strategia senza regole d'ingresso non aprirebbe mai una posizione:
      // importarla creerebbe esattamente quel bot con configurazione a metà che
      // il criterio di accettazione vuole evitare.
      if (!Array.isArray(cfg.entryRules) || !cfg.entryRules.length) {
        return void errors.push(`${where} (${it.coin}): nessuna regola d'ingresso (config.entryRules vuoto).`);
      }
      if (!it.payload.interval && !cfg.candleInterval) {
        return void errors.push(`${where} (${it.coin}): intervallo delle candele non indicato.`);
      }
      items.push(it);
    });

    return { items, errors };
  }

  async importStrategiesFromFile(input) {
    const file = input?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { return this.toast(`File non importato: JSON non valido (${e.message})`, 'error'); }

      const { items, errors } = this._validateStrategiesFile(parsed);
      if (errors.length) {
        // Nessuna scrittura parziale: se una voce non passa, non si importa niente.
        // Un import "quasi riuscito" lascerebbe l'utente a indovinare cosa è entrato.
        const dettaglio = errors.slice(0, 3).join(' ');
        const altri = errors.length > 3 ? ` (+${errors.length - 3} altri problemi)` : '';
        return this.toast(`File non importato: ${dettaglio}${altri}`, 'error');
      }

      const r = await this.api('/api/agents/strategy-history/import', {
        method: 'POST', body: JSON.stringify({ items })
      });
      const importate = r.imported ?? 0;
      const scartate = r.skipped ?? 0;
      if (importate) {
        this.toast(`📥 ${importate} strateg${importate === 1 ? 'ia' : 'ie'} importate${scartate ? `, ${scartate} scartate dal server` : ''}`, 'success');
      } else {
        const perche = (r.errors || [])[0]?.reason;
        this.toast(`Nessuna strategia importata${perche ? ` — ${perche}` : ''}`, 'warning');
      }
      await this.loadStrategyHistory();
    } catch (e) {
      this.toast(`Importazione fallita: ${e.message}`, 'error');
    } finally {
      if (input) input.value = '';
    }
  }

  /** Svuota l'intera categoria attualmente visibile. */
  async clearStrategyTab() {
    const tab = this.strategyTab || 'approved';
    const labels = { approved: 'approvate', rejected: 'rifiutate', expired: 'scadute' };
    const n = (this._strategyHistory || []).filter(h => h.status === tab).length;
    if (!n) return this.toast('Categoria già vuota', 'warning');
    if (!confirm(`Eliminare TUTTE le ${n} strategie ${labels[tab]}?\n\nL'operazione non è reversibile.`)) return;
    await this._deleteStrategies({ status: tab });
  }

  async _deleteStrategies(body) {
    try {
      const r = await this.api('/api/agents/strategy-history', { method: 'DELETE', body: JSON.stringify(body) });
      this._selectedStrategies = new Set();
      this.toast(`${r.deleted} strategie eliminate`, 'success');
      await this.loadStrategyHistory();
    } catch (e) { this.toast(`Eliminazione fallita: ${e.message}`, 'error'); }
  }

  _renderProposals(list) {
    const box = document.getElementById('agentProposals');
    if (!box) return;
    this._proposalsById = {};
    if (!list.length) {
      box.innerHTML = '<div class="agent-empty">Nessuna proposta in attesa. L\'AI proporrà azioni quando rileva qualcosa di utile.</div>';
      return;
    }
    box.innerHTML = list.map(p => {
      this._proposalsById[p.id] = p;
      // Ogni valore che finisce nel markup passa da `_escapeHtml`: `rationale` e
      // `payload` contengono il NOME DEL BOT, che è testo scritto dall'utente (o
      // da un agente esterno) e salvato in DB. Senza escaping questa è la stessa
      // XSS stored della card bot (issue #9), su una superficie diversa.
      const id = this._escapeHtml(p.id);
      const isStrategy = p.type === 'new_strategy_candidate';
      const approveBtn = isStrategy
        ? `<button class="btn btn-sm btn-primary" onclick="perps.applyStrategyProposal('${id}')">⚙️ Approva e configura</button>`
        : `<button class="btn btn-sm btn-primary" onclick="perps.approveProposal('${id}')">✅ Approva</button>`;
      return `
      <div class="agent-proposal">
        <div class="ap-head">
          <span class="ap-type">${this._escapeHtml(p.type)}</span>
          ${p.coin ? `<span class="ap-coin">${this._escapeHtml(p.coin)}</span>` : ''}
          ${this._proposalConfidenceHtml(p)}
        </div>
        <div class="ap-rationale">${this._escapeHtml(p.rationale || '')}</div>
        ${this._proposalDetailHtml(p)}
        ${p.model ? `<div class="ap-cost">🧠 ${this._escapeHtml(p.model)} · costo elaborazione ${this._escapeHtml(this._fmtCost(p.costUsd))}</div>` : ''}
        <div class="ap-actions">
          ${approveBtn}
          <button class="btn btn-sm btn-outline" onclick="perps.rejectProposal('${id}')">🚫 Rifiuta</button>
        </div>
      </div>`;
    }).join('');
  }

  /**
   * Etichetta in alto a destra della proposta.
   *
   * Non tutte le proposte vengono da un modello: l'inactivity-watcher è una regola
   * deterministica e lascia `confidence` a null di proposito, perché un numero lì
   * sarebbe inventato. Mostrare "confidenza —" su una proposta che una confidenza
   * non ce l'ha per costruzione fa sembrare mancante un dato che invece non esiste:
   * chi legge deve poter distinguere "l'AI non si è espressa" da "qui non c'è nessuna
   * AI". Quando il modello c'è ma il numero manca, resta il vecchio "—" (ignoto).
   */
  _proposalConfidenceHtml(p) {
    if (p.confidence != null) return `<span class="ap-conf">confidenza ${Math.round(p.confidence * 100)}%</span>`;
    if (p.source && p.source !== 'analyst') {
      const src = this._escapeHtml(p.source);
      return `<span class="ap-conf" title="Proposta generata da una regola deterministica (${src}), non da un modello AI: non ha un punteggio di confidenza.">⚙️ regola automatica</span>`;
    }
    return '<span class="ap-conf">confidenza —</span>';
  }

  /**
   * Dettaglio sotto la motivazione. Per i tipi che la UI non conosce resta il
   * riassunto generico del payload (leggibile, mai nascosto in silenzio); per
   * `tune_params` c'è un trattamento dedicato, perché il generico mostrerebbe
   * l'unica cosa che conta — la modifica che il click sta per applicare — come
   * JSON grezzo in mezzo a un botId che non serve a nessuno.
   */
  _proposalDetailHtml(p) {
    if (p.type === 'tune_params') return this._tuneParamsDetailHtml(p);
    const payload = p.payload
      ? Object.entries(p.payload).filter(([k]) => k !== 'config')
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')
      : '';
    return payload ? `<div class="ap-payload">${this._escapeHtml(payload)}</div>` : '';
  }

  /**
   * Dettaglio di una proposta di tuning (`tune_params`, inactivity-watcher).
   *
   * Due esiti possibili, e la differenza è la cosa più importante da comunicare
   * PRIMA del click, non dopo:
   *  - con `patch`: approvare SCRIVE davvero nella config del bot. La riga dice
   *    quale parametro e con che valore, perché "approva" qui non è un promemoria;
   *  - senza `patch`: la proposta è diagnostica (bot senza regole d'ingresso, o
   *    intervallo già al minimo). Approvarla la archivia e basta. Lasciare credere
   *    il contrario significherebbe far aspettare a qualcuno un effetto che non
   *    arriverà mai — e poi dare la colpa al bot.
   *
   * `botId` non viene mostrato: è un UUID che non aiuta a decidere. Il nome del
   * bot sì, ed è testo utente, quindi escapato.
   */
  _tuneParamsDetailHtml(p) {
    const payload = p.payload || {};
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : null;

    const ctx = [];
    if (payload.botName) ctx.push(`bot «${payload.botName}»`);
    if (Number.isFinite(payload.idleMinutes)) ctx.push(`fermo da ${this._fmtIdleMinutes(payload.idleMinutes)}`);
    const ctxHtml = ctx.length ? `<div class="ap-payload">${this._escapeHtml(ctx.join(' · '))}</div>` : '';

    const changes = patch ? Object.entries(patch)
      .map(([k, v]) => `${TUNE_PARAM_LABELS[k] || k} → ${typeof v === 'object' ? JSON.stringify(v) : v}`) : [];

    if (!changes.length) {
      return ctxHtml + '<div class="ap-change ap-change-none">📝 Nessun parametro da applicare: è una diagnosi.'
        + ' Approvarla la archivia, <strong>non modifica il bot</strong>.</div>';
    }
    return ctxHtml + `<div class="ap-change">🎚️ Se approvi: <strong>${this._escapeHtml(changes.join(' · '))}</strong>`
      + ' — cambia solo ogni quanto il bot valuta le sue regole. Leva, size, TP/SL e tetti di rischio restano invariati.</div>';
  }

  /** Minuti in una durata leggibile: 42 → «42 min», 185 → «3h 05m». */
  _fmtIdleMinutes(min) {
    const n = Math.max(0, Math.round(min));
    if (n < 60) return `${n} min`;
    return `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, '0')}m`;
  }

  /** Approva una strategia suggerita e apre il creatore bot precompilato. */
  async applyStrategyProposal(id) {
    const p = this._proposalsById?.[id];
    try {
      await this.api(`/api/agents/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST' });
    } catch (e) {
      this.toast(`Errore: ${e.message}`, 'error');
      return;
    }
    const coin = p?.coin || this.markets[0]?.coin;
    const cfg = (p?.payload && p.payload.config) ? { ...p.payload.config } : {};
    if (p?.payload?.interval && !cfg.candleInterval) cfg.candleInterval = p.payload.interval;
    // Apre il creatore bot precompilato con la strategia suggerita (modalità avanzata)
    this.openBotModal({ name: `AI ${coin || ''}`.trim(), coin, config: cfg });
    this._pendingProposalId = id; // verrà collegato al bot al salvataggio
    this.toast('Strategia approvata: rivedi i parametri e salva il bot', 'info');
  }

  /**
   * Approva una proposta e RIFERISCE COSA È SUCCESSO DAVVERO.
   *
   * Il server distingue tre esiti che qui devono restare distinti:
   *  - esecuzione riuscita con una modifica misurabile (`result.tuned`, proposte
   *    `tune_params`): il toast dice il valore prima e dopo, così chi ha cliccato
   *    vede l'effetto senza andarlo a cercare nella card del bot;
   *  - `suggestion`: nulla è stato eseguito. Il messaggio arriva dal server perché
   *    il motivo cambia col tipo — «configura a mano nel creatore bot» è vero per
   *    `new_strategy_candidate`, ma su una proposta di tuning diagnostica sarebbe
   *    falso: lì non c'è nessun creatore bot da aprire;
   *  - errore (incluso il rifiuto del gate di rischio): `api()` lancia, e la
   *    proposta resta pendente sul server — il toast non deve dire "approvata".
   */
  async approveProposal(id) {
    try {
      const r = await this.api(`/api/agents/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST' });
      const tuned = r?.result?.tuned;
      if (tuned && typeof tuned === 'object') {
        const parts = Object.entries(tuned)
          .map(([k, v]) => `${TUNE_PARAM_LABELS[k] || k}: ${v?.da ?? '—'} → ${v?.a ?? '—'}`);
        this.toast(`🎚️ Applicato — ${parts.join(', ')}`, 'success');
      } else if (r?.suggestion) {
        this.toast(`📝 ${r?.result?.message || 'Suggerimento acquisito — configuralo a mano nel creatore bot'}`, 'info');
      } else {
        this.toast('Proposta approvata ed eseguita', 'success');
      }
    } catch (e) {
      this.toast(`Non eseguita: ${e.message}`, 'warning');
    }
    this.loadAgents();
  }

  async rejectProposal(id) {
    try { await this.api(`/api/agents/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST' }); this.toast('Proposta rifiutata', 'info'); }
    catch (e) { this.toast(e.message, 'error'); }
    this.loadAgents();
  }

  toggleAnalysisParams() {
    document.getElementById('analysisParams')?.classList.toggle('hidden');
  }

  _analysisParams() {
    const v = id => document.getElementById(id)?.value;
    return {
      model: v('anModel') || undefined,
      riskAppetite: v('anRisk') || undefined,
      maxProposals: parseInt(v('anMax')) || 5,
      exploration: document.getElementById('anExplore')?.checked !== false,
      focusMarkets: (v('anFocus') || '').split(',').map(s => s.trim()).filter(Boolean),
      notes: (v('anNotes') || '').trim() || undefined
    };
  }

  /** Chiede il preventivo e fa confermare prima di spendere. */
  async runAnalyst() {
    const st = document.getElementById('aiAgentStatus');
    const params = this._analysisParams();

    if (st) st.textContent = '⏳ calcolo preventivo…';
    let est = null;
    try {
      est = await this.api('/api/agents/analyst/estimate', { method: 'POST', body: JSON.stringify(params) });
    } catch (e) {
      // Un errore di autenticazione è definitivo: l'analisi usa la stessa
      // chiave, quindi non ha senso offrire di lanciarla comunque.
      if (e.code === 'auth_error') {
        if (st) st.textContent = '🔑 chiave API non valida';
        this.toast(e.message, 'error');
        return;
      }
      // Gli altri errori (rete, server) possono essere transitori: si chiede conferma.
      if (!confirm(`Impossibile calcolare il preventivo:\n${e.message}\n\nLanciare comunque l'analisi?`)) {
        if (st) st.textContent = '';
        return;
      }
    }

    if (est && !(await this._confirmEstimate(est))) {
      if (st) st.textContent = '';
      return;
    }

    return this._executeAnalyst(params);
  }

  /** Ferma le run future dell'Analyst. Una run già in corso finisce da sola. */
  async pauseAnalyst() {
    try {
      await this.api('/api/agents/analyst/pause', { method: 'POST' });
      this.toast('Analyst in pausa', 'info');
      await this.loadAgents();
    } catch (e) { this.toast('Errore: ' + e.message, 'error'); }
  }

  async resumeAnalyst() {
    try {
      await this.api('/api/agents/analyst/resume', { method: 'POST' });
      this.toast('Analyst ripreso', 'info');
      await this.loadAgents();
    } catch (e) { this.toast('Errore: ' + e.message, 'error'); }
  }

  /** Come pausa, ma annulla anche una run in corso e azzera il contatore run/h. */
  async stopAnalyst() {
    if (!confirm('Fermare l\'Analyst e annullare una run eventualmente in corso?\n\nIl contatore run/h torna a 0. Il costo già speso e le proposte esistenti restano.')) return;
    try {
      await this.api('/api/agents/analyst/stop', { method: 'POST' });
      this.toast('Analyst fermato, contatore azzerato', 'info');
      await this.loadAgents();
    } catch (e) { this.toast('Errore: ' + e.message, 'error'); }
  }

  /** Mostra il preventivo nel modale e risolve true/false alla scelta dell'utente. */
  _confirmEstimate(est) {
    // Se un preventivo precedente fosse rimasto appeso, lo annulla.
    this.resolveEstimate(false);

    const s = est.scenarios || {};
    const labels = { min: 'Minimo', typical: 'Tipico', max: 'Tetto stimato' };
    const tok = n => n.toLocaleString('it-IT');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    set('estModel', est.model);
    set('estCache', est.cachingEnabled ? '⚡ prompt caching attivo' : '');
    set('estFirstInput', tok(est.firstInput));
    // LLM-04: dice se quel numero è un conteggio esatto o una stima. `countTokens`
    // esiste solo su Anthropic; sugli altri fornitori il primo input è un'euristica
    // locale e presentarla come misura sarebbe un dato disonesto proprio nel modale
    // in cui si decide se spendere. `firstInputExact === false` è il caso stimato;
    // se il campo manca (risposta di un server più vecchio) non si afferma nulla.
    set('estFirstInputKind', est.firstInputExact === false ? '(stimati: questo fornitore non offre un conteggio esatto)'
      : est.firstInputExact === true ? '(misurati esattamente)' : '');
    set('estMaxIter', est.maxIterations);
    set('estSpent', this._fmtCost(est.spentTotal));

    const rows = document.getElementById('estRows');
    if (rows) {
      rows.innerHTML = ['min', 'typical', 'max'].filter(k => s[k]).map(k => `
        <tr class="est-${k}">
          <td>${labels[k]}</td>
          <td>${s[k].iterations}</td>
          <td>${tok(s[k].promptTokens + s[k].tokensOut)}</td>
          <td class="est-cost">${this._fmtCost(s[k].cost)}</td>
        </tr>`).join('');
    }

    this._showModal('estimateModal');
    return new Promise(resolve => {
      this._estimateResolver = resolve;
      // Il modale si chiude anche da backdrop o Escape (gestiti in shell.js).
      // Senza intercettarli la Promise resterebbe pendente all'infinito.
      this._estimateDismiss = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        if (e.type === 'click' && e.target?.id !== 'estimateModal') return;
        this.resolveEstimate(false);
      };
      document.addEventListener('click', this._estimateDismiss);
      document.addEventListener('keydown', this._estimateDismiss);
    });
  }

  /** Chiude il modale del preventivo risolvendo la scelta. Idempotente. */
  resolveEstimate(ok) {
    if (this._estimateDismiss) {
      document.removeEventListener('click', this._estimateDismiss);
      document.removeEventListener('keydown', this._estimateDismiss);
      this._estimateDismiss = null;
    }
    const resolve = this._estimateResolver;
    this._estimateResolver = null;
    if (!resolve) return;
    this._closeModal('estimateModal');
    resolve(ok);
  }

  async _executeAnalyst(params) {
    const st = document.getElementById('aiAgentStatus');
    if (st) st.textContent = '⏳ analisi in corso… (può richiedere ~1 minuto)';
    try {
      // Riusa gli stessi parametri su cui è stato calcolato il preventivo:
      // rileggerli dal form rischierebbe di eseguire un'analisi diversa da
      // quella preventivata se l'utente li modifica durante la conferma.
      const r = await this.api('/api/agents/analyst/run', {
        method: 'POST',
        body: JSON.stringify(params)
      });
      const cost = r?.cost ? ` · ${this._fmtCost(r.cost)}` : '';
      this.toast(`Analyst (${r?.model || 'AI'}): ${r?.proposals ?? 0} proposte${cost}`, 'success');
    } catch (e) {
      this.toast(`Analyst: ${e.message}`, 'warning');
    }
    this.loadAgents();
  }

  async killSwitch() {
    if (!confirm('Attivare il KILL-SWITCH? Ferma tutti i bot e blocca ogni nuova apertura.')) return;
    try {
      await this.api('/api/perps/killswitch', { method: 'POST', body: JSON.stringify({ closePositions: false }) });
      this.toast('🛑 Kill-switch attivato: bot fermati, aperture bloccate', 'warning');
    } catch (e) { this.toast(e.message, 'error'); }
    this.loadAgents();
    this.loadBots();
  }

  /**
   * Disattiva il kill-switch (flag persistito sul DB): da qui in poi il RiskAgent
   * smette di respingere le aperture. NON riavvia i bot che il kill-switch aveva
   * fermato — `riskAgent.setKillSwitch(false)` scrive solo il setting e l'audit, e
   * questo è voluto: riprendere a operare resta una decisione esplicita dell'operatore.
   * Per questo il messaggio di conferma e il toast lo dicono, invece di lasciar
   * credere che il bot sia tornato attivo da solo.
   */
  async resumeFromKillSwitch() {
    if (!confirm('Disattivare il kill-switch e sbloccare le nuove aperture?\n\nI bot fermati NON ripartono da soli: dovrai riavviarli tu dalla tab System.')) return;
    try {
      await this.api('/api/agents/killswitch', { method: 'POST', body: JSON.stringify({ on: false }) });
      // Stato aggiornato subito, senza attendere il prossimo poll: il bottone deve
      // sparire nel momento in cui la chiamata è andata a buon fine.
      this._setKillSwitchUi(false);
      this.toast('✅ Kill-switch disattivato: aperture sbloccate. I bot fermati vanno riavviati a mano.', 'success');
    } catch (e) { this.toast(e.message, 'error'); }
    this.loadAgents();
    this.loadBots();
  }

  async saveNotifications() {
    try {
      const d = await this.api('/api/perps/notifications', {
        method: 'POST',
        body: JSON.stringify({
          token: document.getElementById('tgToken').value.trim(),
          chatId: document.getElementById('tgChatId').value.trim(),
          enabled: document.getElementById('tgEnabled').checked
        })
      });
      this.toast('Notifiche salvate', 'success');
      const st = document.getElementById('tgStatus');
      if (st) st.textContent = d.configured ? '(configurato)' : '(non configurato)';
      this._refreshTgControlStatus();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async testNotification() {
    try {
      const r = await this.api('/api/perps/notifications/test', { method: 'POST' });
      this.toast(r.sent ? '✅ Messaggio di test inviato' : 'Non inviato: controlla token/chat id e che sia abilitato', r.sent ? 'success' : 'warning');
    } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---- Grafico posizione (Lightweight Charts) ----
  openChart(coin) {
    if (!window.LightweightCharts) return this.toast('Libreria grafici non caricata', 'error');
    this.chartCoin = coin;
    document.getElementById('chartTitle').textContent = `📊 ${coin}`;
    const buttons = [...document.querySelectorAll('.chart-int')];
    // Vista attiva (default 15m); ogni pulsante porta intervallo + lookback in giorni
    const activeBtn = buttons.find(b => b.classList.contains('active')) || buttons[1];
    this.chartInterval = activeBtn.dataset.int;
    this.chartLookbackDays = parseInt(activeBtn.dataset.days) || 3;
    buttons.forEach(btn => {
      btn.onclick = () => {
        this.chartInterval = btn.dataset.int;
        this.chartLookbackDays = parseInt(btn.dataset.days) || 3;
        buttons.forEach(b => b.classList.toggle('active', b === btn));
        this._destroyChart();
        this._renderChart();
      };
    });
    this._showModal('chartModal');
    setTimeout(() => this._renderChart(), 60); // attendi il layout del modal
    if (this.chartTimer) clearInterval(this.chartTimer);
    this.chartTimer = setInterval(() => {
      // Il modale si può chiudere anche da sfondo o Escape (shell.js), che non
      // passa da closeChart(): senza questo controllo il timer resta vivo
      // all'infinito, continuando a interrogare /api/perps/candles ogni 6s
      // anche a modale nascosto.
      const modal = document.getElementById('chartModal');
      if (!modal || !modal.classList.contains('show')) {
        clearInterval(this.chartTimer);
        this.chartTimer = null;
        this._destroyChart();
        return;
      }
      this._renderChart(true);
    }, 6000);
  }

  closeChart() {
    if (this.chartTimer) { clearInterval(this.chartTimer); this.chartTimer = null; }
    this._destroyChart();
    this._closeModal('chartModal');
  }

  // ---- Monitor bot (cosa sta facendo, anche da fermo) ----
  async openBotMonitor(id) {
    this.monitorBotId = id;
    document.getElementById('monitorBody').innerHTML = '<div class="backtest-loading"><span class="spinner-sm"></span> Lettura stato del bot…</div>';
    this._showModal('botMonitorModal');
    await this._refreshMonitor();
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = setInterval(() => this._refreshMonitor(), 5000); // aggiornamento live
  }

  closeBotMonitor() {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    this.monitorBotId = null;
    this._closeModal('botMonitorModal');
  }

  async _refreshMonitor() {
    if (!this.monitorBotId) return;
    try {
      const m = await this.api(`/api/perps/bots/${this.monitorBotId}/monitor`);
      document.getElementById('monitorTitle').textContent = `📡 ${m.name} · ${m.coin}`;
      document.getElementById('monitorBody').innerHTML = this._renderMonitor(m);
    } catch (e) {
      document.getElementById('monitorBody').innerHTML = `<div class="backtest-empty">Monitor non disponibile: ${e.message}</div>`;
    }
  }

  _renderMonitor(m) {
    const dirIt = { both: 'Long & Short', long: 'solo Long', short: 'solo Short' }[m.direction] || m.direction;
    const statusDot = m.status === 'running' ? '🟢 attivo' : '⏸️ fermo';
    const le = m.lastEval || {};
    const leTime = le.ts ? new Date(le.ts).toLocaleTimeString('it-IT') : '—';

    const ruleRow = (r) => `
      <div class="mon-rule ${r.met ? 'met' : ''}">
        <div class="mon-rule-top">
          <span class="mon-dot">${r.met ? '🟢' : '⚪'}</span>
          <span class="mon-rule-label">${r.label}</span>
          <span class="mon-rule-sig side-badge ${r.signal === 'short' ? 'short' : 'long'}">${(r.signal || '').toUpperCase()}</span>
          <span class="mon-rule-target">${r.target}</span>
        </div>
        <div class="mon-rule-hint">${r.met ? '✅ condizione soddisfatta' : '⏳ ' + (r.hint || '')} <span class="muted">· ora: ${r.current}</span></div>
      </div>`;

    const logic = m.logic === 'all' ? 'tutte le regole insieme (AND)' : 'una qualsiasi regola (OR)';

    let posBlock;
    if (m.inPosition && m.position) {
      const p = m.position;
      posBlock = `<div class="mon-pos in"><b>${p.side.toUpperCase()} ${this.fmtNum(p.size)} ${m.coin}</b> @ ${this.fmtUsd(p.entryPx)} · TP ${p.tpPx ? this.fmtUsd(p.tpPx) : '—'} · SL ${p.slPx ? this.fmtUsd(p.slPx) : '—'}</div>`;
    } else {
      posBlock = `<div class="mon-pos flat">Nessuna posizione aperta — il bot sta cercando un punto d'ingresso.</div>`;
    }

    const gates = [];
    if (m.gates.mtf) gates.push(`Conferma multi-timeframe (EMA${m.gates.mtf.period} su ${m.gates.mtf.interval})`);
    if (m.gates.ml) gates.push(`Filtro ML (prob ≥ ${Math.round(m.gates.ml.minProb * 100)}% su ${m.gates.ml.interval})`);
    if (m.gates.partialTp) gates.push('Take profit parziale');
    if (m.gates.dca) gates.push('DCA');

    return `
      <div class="mon-head">
        <span>${statusDot}</span>
        <span class="muted">·</span><span>Prezzo ${this.fmtUsd(m.price)}</span>
        <span class="muted">·</span><span>${dirIt}</span>
        <span class="muted">·</span><span>TF ${m.interval}</span>
      </div>
      ${posBlock}
      <div class="mon-section-title">Ultima valutazione <span class="muted">(${leTime})</span></div>
      <div class="mon-lasteval"><b>${le.action || '—'}</b> — ${le.reason || '—'}</div>
      <div class="mon-section-title">Condizioni d'ingresso <span class="muted">— serve ${logic}</span></div>
      <div class="mon-rules">${m.entryRules.length ? m.entryRules.map(ruleRow).join('') : '<div class="muted">Nessuna regola d\'ingresso.</div>'}</div>
      ${m.inPosition && m.exitRules.length ? `<div class="mon-section-title">Condizioni d'uscita</div><div class="mon-rules">${m.exitRules.map(ruleRow).join('')}</div>` : ''}
      ${gates.length ? `<div class="mon-section-title">Filtri aggiuntivi</div><div class="mon-gates">${gates.map(g => `<span class="mon-gate">🔒 ${g}</span>`).join('')}</div>` : ''}
      ${m.lastError ? `<div class="bot-error">⚠️ ${m.lastError}</div>` : ''}
      <div class="mon-foot muted">Aggiornamento automatico ogni 5s · il bot rivaluta ogni ${Math.round((m.loopIntervalMs || 10000) / 1000)}s</div>`;
  }

  _destroyChart() {
    if (this.chart) { try { this.chart.remove(); } catch {} this.chart = null; this.candleSeries = null; this.emaSeries = null; }
    this._priceLines = [];
  }

  _ema(values, period) {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const out = [];
    let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period - 1; i < values.length; i++) {
      prev = i === period - 1 ? prev : values[i] * k + prev * (1 - k);
      out.push({ i, value: prev });
    }
    return out;
  }

  async _renderChart(isUpdate = false) {
    const coin = this.chartCoin;
    const container = document.getElementById('chartContainer');
    if (!container) return;
    try {
      const lookbackMs = (this.chartLookbackDays || 3) * 86400000;
      const [candlesRaw, orders] = await Promise.all([
        this.api(`/api/perps/candles?coin=${encodeURIComponent(coin)}&interval=${this.chartInterval}&lookback=${lookbackMs}`),
        this.connected ? this.api('/api/perps/orders?address=' + this.address).catch(() => []) : Promise.resolve([])
      ]);
      const candles = (candlesRaw || []).map(k => ({
        time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c
      })).filter(c => !isNaN(c.close));
      if (!candles.length) return;

      // setData() sostituisce tutto il dataset e, di suo, azzera lo zoom/pan
      // impostato dall'utente. Sugli aggiornamenti periodici (isUpdate) lo
      // salviamo prima e lo ripristiniamo dopo, così il grafico non "salta"
      // da solo ogni 6 secondi mentre lo si sta guardando.
      const savedRange = (isUpdate && this.chart) ? this.chart.timeScale().getVisibleLogicalRange() : null;

      if (!this.chart) {
        this.chart = LightweightCharts.createChart(container, {
          width: container.clientWidth, height: 420,
          layout: { background: { color: '#fff' }, textColor: '#2d3748' },
          grid: { vertLines: { color: '#edf2f7' }, horzLines: { color: '#edf2f7' } },
          timeScale: { timeVisible: true, borderColor: '#e2e8f0' },
          rightPriceScale: { borderColor: '#e2e8f0' },
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
        });
        this.candleSeries = this.chart.addCandlestickSeries({
          upColor: '#38a169', downColor: '#e53e3e', borderVisible: false,
          wickUpColor: '#38a169', wickDownColor: '#e53e3e'
        });
        this.emaSeries = this.chart.addLineSeries({ color: '#805ad5', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        this._priceLines = [];
        new ResizeObserver(() => { if (this.chart) this.chart.resize(container.clientWidth, 420); }).observe(container);
      }

      this.candleSeries.setData(candles);
      // EMA 20 overlay
      const closes = candles.map(c => c.close);
      const ema = this._ema(closes, 20).map(e => ({ time: candles[e.i].time, value: +e.value.toFixed(4) }));
      this.emaSeries.setData(ema);

      // Rimuovi vecchie linee e ridisegna i livelli della posizione
      (this._priceLines || []).forEach(pl => { try { this.candleSeries.removePriceLine(pl); } catch {} });
      this._priceLines = [];
      const addLine = (price, color, title) => {
        if (!price || isNaN(price)) return;
        this._priceLines.push(this.candleSeries.createPriceLine({
          price, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true, title
        }));
      };
      const pos = (this.account?.positions || []).find(p => p.coin === coin || `${p.coin}-PERP` === coin);
      const legend = [];
      if (pos) {
        addLine(pos.entryPx, '#3182ce', 'Entry');
        addLine(pos.liquidationPx, '#dd6b20', 'Liq.');
        legend.push(`<span class="lg-entry">● Entry ${this.fmtUsd(pos.entryPx)}</span>`);
        if (pos.liquidationPx) legend.push(`<span class="lg-liq">● Liq ${this.fmtUsd(pos.liquidationPx)}</span>`);
      }
      // TP/SL dai trigger order aperti su questo coin
      (orders || []).filter(o => (o.coin === coin || `${o.coin}-PERP` === coin) && o.isTrigger && o.triggerPx)
        .forEach(o => {
          const isTp = /tp|take/i.test(o.orderType || '');
          addLine(o.triggerPx, isTp ? '#38a169' : '#e53e3e', isTp ? 'TP' : 'SL');
          legend.push(`<span class="${isTp ? 'lg-tp' : 'lg-sl'}">● ${isTp ? 'TP' : 'SL'} ${this.fmtUsd(o.triggerPx)}</span>`);
        });

      // Marker dei fill su questo mercato
      const fills = this.connected ? await this.api('/api/perps/fills?address=' + this.address).catch(() => []) : [];
      const markers = (fills || [])
        .filter(f => f.coin === coin || `${f.coin}-PERP` === coin)
        .map(f => {
          const isBuy = f.side === 'buy' || /Long/i.test(f.dir);
          return {
            time: Math.floor(f.time / 1000),
            position: isBuy ? 'belowBar' : 'aboveBar',
            color: isBuy ? '#38a169' : '#e53e3e',
            shape: isBuy ? 'arrowUp' : 'arrowDown',
            text: f.dir || (isBuy ? 'Buy' : 'Sell')
          };
        }).sort((a, b) => a.time - b.time);
      this.candleSeries.setMarkers(markers);

      legend.push(`<span class="lg-ema">● EMA20</span>`);
      document.getElementById('chartLegend').innerHTML = legend.join(' ');
      if (!isUpdate) this.chart.timeScale().fitContent();
      else if (savedRange) this.chart.timeScale().setVisibleLogicalRange(savedRange);
    } catch (e) {
      if (!isUpdate) this.toast('Errore caricamento grafico: ' + e.message, 'error');
    }
  }

  // ---- Tab posizioni: Aperte / Storico ----
  switchPosTab(tab) {
    this.posTab = tab;
    document.getElementById('posOpen')?.classList.toggle('hidden', tab !== 'open');
    document.getElementById('posHistory')?.classList.toggle('hidden', tab !== 'history');
    document.querySelectorAll('.pos-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'history') this.loadFills();
  }

  refreshPositionsTab() {
    if (this.posTab === 'history') this.loadFills();
    else this.refreshAccount();
  }

  async loadFills() {
    try {
      const url = this.address ? `/api/perps/fills?address=${encodeURIComponent(this.address)}` : '/api/perps/fills';
      const fills = await this.api(url);
      this._allFills = fills || [];
      this._populateHistBotFilter();
      this.applyHistoryFilter();
    } catch {
      this._allFills = [];
      this._renderFills([]);
    }
  }

  /** Popola il menu dei bot nel filtro storico (dai nomi presenti nei fill). */
  _populateHistBotFilter() {
    const sel = document.getElementById('histBot');
    if (!sel) return;
    const names = [...new Set((this._allFills || []).map(f => f.botName).filter(Boolean))].sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">Tutti i bot</option>' +
      names.map(n => `<option value="${n}">${n}</option>`).join('');
    if (names.includes(cur)) sel.value = cur;
  }

  /** Imposta un preset temporale (oggi/settimana/mese/anno/tutto). */
  setHistoryRange(range) {
    this._histRange = range;
    document.querySelectorAll('.hist-preset').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    // svuota i campi da/a quando si usa un preset
    const from = document.getElementById('histFrom'); const to = document.getElementById('histTo');
    if (from) from.value = ''; if (to) to.value = '';
    this.applyHistoryFilter();
  }

  /** Applica i filtri (preset o range da/a + bot) e rende lo storico. */
  applyHistoryFilter(fromRange = false) {
    if (fromRange) { // l'utente ha scelto una data → disattiva i preset
      this._histRange = 'custom';
      document.querySelectorAll('.hist-preset').forEach(b => b.classList.remove('active'));
    }
    let fromTs = 0, toTs = Date.now();
    const fromEl = document.getElementById('histFrom')?.value;
    const toEl = document.getElementById('histTo')?.value;
    if (fromEl || toEl) {
      if (fromEl) fromTs = new Date(fromEl + 'T00:00:00').getTime();
      if (toEl) toTs = new Date(toEl + 'T23:59:59').getTime();
    } else {
      const days = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 }[this._histRange];
      if (days) fromTs = Date.now() - days * 86400000;
    }
    const botFilter = document.getElementById('histBot')?.value || '';
    const filtered = (this._allFills || []).filter(f =>
      f.time >= fromTs && f.time <= toTs && (!botFilter || f.botName === botFilter));
    this._renderFills(filtered);
  }

  _explorerTxUrl(hash) {
    const host = this.network === 'mainnet' ? 'app.hyperliquid.xyz' : 'app.hyperliquid-testnet.xyz';
    return `https://${host}/explorer/tx/${hash}`;
  }

  _renderFills(fills) {
    const tbody = document.getElementById('fillsList');
    const empty = document.getElementById('noFills');
    if (!tbody) return;
    if (!fills || !fills.length) {
      tbody.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    tbody.innerHTML = fills.map(f => {
      const date = new Date(f.time).toLocaleString('it-IT');
      const isLong = /Long/i.test(f.dir) || f.side === 'B' || f.side === 'buy';
      const dirClass = isLong ? 'side-badge long' : 'side-badge short';
      const pnl = f.closedPnl;
      const pnlCell = pnl != null ? `<span class="${pnl >= 0 ? 'profit-positive' : 'profit-negative'}">${this.fmtUsd(pnl)}</span>` : '—';
      const txLink = f.hash && f.hash !== '0x0000000000000000000000000000000000000000000000000000000000000000'
        ? `<a href="${this._explorerTxUrl(f.hash)}" target="_blank" rel="noopener">🔗</a>` : '—';
      const botCell = f.botName
        ? `<span class="hist-bot">${f.botName === 'Manuale' ? '✋ Manuale' : '🤖 ' + f.botName}</span>`
        : (f.botId ? `<span class="hist-bot">🤖 Bot #${String(f.botId).slice(0, 4)}</span>` : '<span class="muted">—</span>');
      const paperBadge = f.isPaper ? ' <span class="testnet-badge" style="font-size:.6em;padding:1px 4px;vertical-align:middle">PAPER</span>' : '';
      return `<tr>
        <td>${date}</td>
        <td>${botCell}</td>
        <td>${f.coin}${paperBadge}</td>
        <td><span class="${dirClass}">${f.dir || (isLong ? 'Buy' : 'Sell')}</span></td>
        <td>${this.fmtNum(f.sz)}</td>
        <td>${this.fmtUsd(f.px)}</td>
        <td>${pnlCell}</td>
        <td class="muted">${this.fmtUsd(f.fee || 0)}</td>
        <td>${txLink}</td>
      </tr>`;
    }).join('');
  }

  // ==== Osservatore Jev (JEV-OBS-01) ====
  //
  // Pannello di SOLA LETTURA su `GET /api/perps/jev-evaluations`. Quando un bot
  // produce un segnale vero (apertura/chiusura) il backend chiede un giudizio
  // tipizzato a un modello esterno e lo registra; qui si mostra cosa ne pensava.
  //
  // ⚠️ Il vincolo di disegno che governa OGNI scelta di resa qui sotto: Jev non
  // decide niente. Non blocca, non ritarda e non raccomanda un'operazione — i
  // limiti operativi sono e restano `riskManager.js`/`portfolio.js`. Da questo
  // discendono tre regole di presentazione che non vanno "migliorate":
  //   • niente verde/rosso sui numeri e nessuna soglia evidenziata: un semaforo
  //     si legge come un ordine operativo ("entra"/"non entrare"), e le domande
  //     poste a Jev non sono nemmeno direttive (chiedono la coerenza col
  //     contesto, non la convenienza dell'operazione);
  //   • il pannello sta nel tab SYSTEM, non in RISK & ALERTS;
  //   • ogni riga è al passato: racconta un segnale già eseguito, non uno da
  //     valutare.
  //
  // Perché POLLING e non un aggancio a `perps:fill`/`perps:position`: la riga di
  // audit viene scritta DOPO il segnale, in modo asincrono (fino al tetto di
  // attesa di Jev, ~2,5s, più la scrittura su DB). Un refresh innescato dal fill
  // arriverebbe quindi sistematicamente PRIMA che la riga esista: non
  // anticiperebbe niente e mostrerebbe un istante in cui il segnale c'è e
  // l'osservazione "manca", che è la lettura sbagliata. I 5s del timer la
  // raccolgono comunque.

  async loadJevEvaluations() {
    if (this.jevInFlight) return;
    this.jevInFlight = true;
    try {
      const data = await this.api('/api/perps/jev-evaluations?limit=50');
      this.jevEvaluations = Array.isArray(data) ? data : [];
      this.jevError = null;
    } catch (e) {
      // Un elenco NON LETTO non è un elenco vuoto: il primo dice "non lo so", il
      // secondo dice "nessuna osservazione". Tenerli separati è tutto il punto di
      // questo pannello, che esiste per raccontare uno stato incerto senza mentire.
      this.jevError = e.message;
    } finally {
      this.jevInFlight = false;
    }
    this._renderJevEvaluations();
  }

  _renderJevEvaluations() {
    const box = document.getElementById('jevLog');
    if (!box) return;
    const updated = document.getElementById('jevUpdated');
    const setNote = (text) => { if (updated) updated.textContent = text; };
    const now = new Date().toLocaleTimeString('it-IT', { hour12: false });
    let html;
    if (this.jevError != null) {
      html = `<div class="jev-empty jev-empty-error">Elenco non disponibile: ${this._escapeHtml(this.jevError)}</div>`;
      setNote('lettura fallita');
    } else if (!Array.isArray(this.jevEvaluations)) {
      html = '<div class="jev-empty">Caricamento…</div>';
      setNote('—');
    } else if (!this.jevEvaluations.length) {
      html = this._jevEmptyHtml();
      setNote(`nessuna osservazione · ${now}`);
    } else {
      html = this.jevEvaluations.map((row) => this._jevEntryHtml(row)).join('');
      setNote(`${this.jevEvaluations.length} osservazioni · ${now}`);
    }
    // Riscrivere `innerHTML` a ogni tick azzererebbe lo scroll del log e
    // richiuderebbe gli "Stato inviato a Jev" che l'utente ha aperto. Con un
    // polling a 5s e un evento raro, il markup è quasi sempre identico: se non è
    // cambiato niente non si tocca il DOM.
    if (html === this._jevLastHtml) return;
    this._jevLastHtml = html;
    box.innerHTML = html;
  }

  /**
   * Stato vuoto — la condizione normale oggi, e va detta per quello che è.
   *
   * Un elenco vuoto ha DUE cause che da qui non si distinguono: l'osservatore è
   * spento (nessuna chiave API configurata: in quel caso nessun giudizio viene
   * mai chiesto e nessuna riga viene scritta), oppure è acceso e nessun bot ha
   * ancora prodotto un segnale vero. Il server la differenza la conosce
   * (`jevStatus()` in `src/agents/jev.js`) ma non la espone su nessuna rotta:
   * finché non lo fa, questo pannello dichiara entrambe le ipotesi invece di
   * sceglierne una a caso. Scrivere "osservatore spento" sarebbe un'affermazione
   * che nessuno ha verificato.
   */
  _jevEmptyHtml() {
    return `<div class="jev-empty">
      <strong>Nessuna osservazione Jev ancora registrata.</strong>
      <span>Può voler dire due cose, e da qui non si distinguono: l'osservatore è spento (nessuna chiave API configurata) oppure è acceso e nessun bot ha ancora prodotto un segnale vero.</span>
      <span>In entrambi i casi i bot lavorano esattamente come sempre: Jev non fa parte del percorso di trading.</span>
    </div>`;
  }

  _jevEntryHtml(row) {
    const ts = this._jevNumber(row?.ts);
    const when = ts != null && ts > 0
      ? new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : '—';
    const failed = row?.error != null && String(row.error).trim() !== '';
    const head = `<div class="jev-entry-head">
        <span class="jev-time">${this._escapeHtml(when)}</span>
        <span class="jev-coin">${this._escapeHtml(row?.coin || '—')}</span>
        <span class="jev-action">${this._escapeHtml(this._jevActionLabel(row?.action))}</span>
        <span class="jev-bot">${this._escapeHtml(this._jevBotLabel(row?.botId))}</span>
        <span class="jev-model">${this._escapeHtml(row?.model || '—')}</span>
      </div>`;
    const body = `${failed ? this._jevFailedHtml(row) : ''}${this._jevAnswersHtml(row)}`;
    return `<article class="jev-entry${failed ? ' jev-entry-failed' : ''}">${head}${body}${this._jevStateHtml(row)}${this._jevMetaHtml(row)}</article>`;
  }

  /**
   * `error` non-null è un DATO, non un guasto della dashboard: l'osservatore ha
   * provato e non ha risposto (timeout, HTTP, risposta illeggibile). Mostrarlo
   * come una riga rotta nasconderebbe l'informazione più interessante che questa
   * tabella possa dare — quanto spesso il giudizio esterno non arriva.
   */
  _jevFailedHtml(row) {
    return `<div class="jev-failed">
      <span class="jev-failed-tag">nessun giudizio</span>
      <span class="jev-failed-reason">${this._escapeHtml(row.error)}</span>
      <span class="jev-failed-note">L'osservatore ha provato e non ha risposto. Il segnale è stato eseguito secondo le regole del bot: Jev non fa parte del percorso di trading.</span>
    </div>`;
  }

  /**
   * Le tre domande hanno id fissi (`_jevPrompt` in `src/perps/bot.js`) e per
   * ognuna c'è una resa dedicata. Due cautele deliberate:
   *  - se la resa dedicata non sa decodificare la risposta (campo assente, tipo
   *    diverso da quello atteso), si ripiega sul riassunto grezzo invece di
   *    saltare il blocco: un giudizio chiesto e pagato non deve sparire dalla
   *    dashboard perché la forma è cambiata;
   *  - le domande che questa UI non conosce (versione futura del prompt) escono
   *    comunque, con la loro chiave come etichetta.
   */
  _jevAnswersHtml(row) {
    const answers = row?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      // Né risposte né (eventualmente) errore: la riga esiste ma l'audit non
      // contiene un JSON di risposte leggibile. È diverso da "Jev non ha
      // risposto" e va detto in modo diverso.
      return row?.error != null && String(row.error).trim() !== ''
        ? ''
        : '<div class="jev-note">Nessuna risposta leggibile in questa riga di audit.</div>';
    }
    const questions = (row?.questions && typeof row.questions === 'object' && !Array.isArray(row.questions))
      ? row.questions : {};
    const known = ['coerenza_segnale', 'contesto_sfavorevole', 'fattore_dominante'];
    const blocks = [];
    const add = (id, renderer) => {
      const answer = answers[id];
      if (answer == null) return;
      blocks.push(renderer.call(this, answer, questions[id]) || this._jevGenericAnswerHtml(id, answer));
    };
    add('coerenza_segnale', this._jevNoulHtml);
    add('contesto_sfavorevole', this._jevScoreHtml);
    add('fattore_dominante', this._jevChoiceHtml);
    for (const [id, answer] of Object.entries(answers)) {
      if (known.includes(id)) continue;
      blocks.push(this._jevGenericAnswerHtml(id, answer));
    }
    if (!blocks.length) return '<div class="jev-note">Nessuna risposta leggibile in questa riga di audit.</div>';
    return `<div class="jev-answers">${blocks.join('')}</div>`;
  }

  /**
   * `coerenza_segnale` — probabilità calibrata (tipo `noul`), il numero
   * principale. La barra è monocroma di proposito: vedi il vincolo in testa alla
   * sezione. `noul` non porta una `confidence` perché la probabilità È il
   * giudizio.
   */
  _jevNoulHtml(answer) {
    const ratio = this._jevRatio(answer?.noul);
    const pct = this._jevPct(answer?.noul);
    if (pct == null) return '';
    const bar = ratio == null ? ''
      : `<span class="jev-bar"><span class="jev-bar-fill" style="width:${Math.round(ratio * 100)}%"></span></span>`;
    return `<div class="jev-judgement">
      <span class="jev-j-label">coerenza col contesto</span>
      <span class="jev-j-value">${this._escapeHtml(pct)}</span>
      ${bar}
    </div>`;
  }

  /** `contesto_sfavorevole` — livello su una scala ordinata (tipo `score`). */
  _jevScoreHtml(answer, question) {
    const level = this._jevScoreLevel(answer, question);
    if (!level) return '';
    const value = level.ratio != null ? `${Math.round(level.ratio * 100)}%` : this.fmtNum(level.score, 2);
    return `<div class="jev-judgement">
      <span class="jev-j-label">contesto sfavorevole</span>
      <span class="jev-j-value">${this._escapeHtml(value)}</span>
      ${level.label ? `<span class="jev-j-level">${this._escapeHtml(level.label)}</span>` : ''}
      ${this._jevConfidenceHtml(answer)}
    </div>`;
  }

  /**
   * Etichetta del livello per una risposta `score`.
   *
   * ⚠️ La forma esatta di `legend` non è verificabile da qui: nessuna risposta di
   * tipo `score` esiste oggi in questo repo (l'osservatore è spento e le fixture
   * dei test coprono solo `noul`). Quindi si prova a decodificarla, e se non
   * torna NON si inventa un'etichetta: si ripiega sui `criteria` della domanda —
   * che sono l'unica fonte certa, perché li scrive `_jevPrompt` in bot.js — e in
   * ultima istanza si mostra il solo numero.
   *
   * Due convenzioni possibili per `score`, entrambe gestite: valore normalizzato
   * in 0..1 (si mostra come percentuale) oppure indice del livello sulla lista
   * dei criteri (> 1: si mostra il numero grezzo, mai una percentuale > 100%).
   */
  _jevScoreLevel(answer, question) {
    const score = this._jevNumber(answer?.score);
    if (score == null) return null;
    const ratio = score >= 0 && score <= 1 ? score : null;
    let label = null;

    const legend = answer?.legend;
    if (legend && typeof legend === 'object' && !Array.isArray(legend)) {
      const levels = Object.entries(legend)
        .map(([key, text]) => [Number(key), text])
        .filter(([key, text]) => Number.isFinite(key) && typeof text === 'string' && text.trim())
        .sort((a, b) => a[0] - b[0]);
      if (levels.length) {
        let best = levels[0];
        for (const entry of levels) { if (entry[0] <= score + 1e-9) best = entry; }
        label = best[1];
      }
    }

    if (label == null && Array.isArray(question?.criteria) && question.criteria.length) {
      const n = question.criteria.length;
      const idx = ratio != null ? Math.round(ratio * (n - 1)) : Math.round(score);
      const pick = question.criteria[Math.min(n - 1, Math.max(0, idx))];
      if (typeof pick === 'string' && pick.trim()) label = pick;
    }
    return { score, ratio, label };
  }

  /** `fattore_dominante` — categoria (tipo `choice`). */
  _jevChoiceHtml(answer, question) {
    const choice = answer?.choice;
    if (typeof choice !== 'string' || !choice.trim()) return '';
    // La descrizione dell'opzione la conosce la domanda (`criteria` è una mappa
    // opzione → descrizione): se c'è finisce nel tooltip, così l'etichetta resta
    // corta senza perdere il significato.
    const criteria = question?.criteria;
    const desc = (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) ? criteria[choice] : null;
    const title = typeof desc === 'string' && desc.trim() ? ` title="${this._escapeHtml(desc)}"` : '';
    return `<div class="jev-judgement">
      <span class="jev-j-label">fattore dominante</span>
      <span class="jev-choice"${title}>${this._escapeHtml(this._jevHumanize(choice))}</span>
      ${this._jevConfidenceHtml(answer)}
    </div>`;
  }

  /**
   * Confidenza, solo se dichiarata. Assente ⇒ si tace: un "confidenza —" farebbe
   * sembrare mancante un dato che questa risposta non promette (stesso criterio
   * di `_proposalConfidenceHtml`).
   */
  _jevConfidenceHtml(answer) {
    const pct = this._jevPct(answer?.confidence);
    return pct == null ? '' : `<span class="jev-j-conf">confidenza ${this._escapeHtml(pct)}</span>`;
  }

  /**
   * Risposta che questa UI non sa rendere in modo specifico: riassunto leggibile
   * di tutti i campi, `type` escluso (è già implicito nella forma). Mai nascosta.
   */
  _jevGenericAnswerHtml(id, answer) {
    let summary;
    if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
      summary = Object.entries(answer)
        .filter(([key]) => key !== 'type')
        .map(([key, value]) => `${key}: ${value !== null && typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join(' · ');
    } else {
      summary = String(answer ?? '');
    }
    return `<div class="jev-judgement jev-judgement-raw">
      <span class="jev-j-label">${this._escapeHtml(this._jevHumanize(id))}</span>
      <span class="jev-j-value">${this._escapeHtml(summary || '—')}</span>
    </div>`;
  }

  /**
   * Lo stato giudicato, in un blocco richiudibile perché è lungo (fino a 4000
   * caratteri) e serve solo a chi vuole capire *su cosa* Jev si è espresso.
   *
   * Escaping non negoziabile: lo compone `bot.js` e la prima riga contiene il
   * NOME DEL BOT, cioè testo scritto dall'utente (o da un agente esterno) e
   * salvato in DB. È la stessa XSS stored della card bot (issue #9), che arriva
   * qui di rimbalzo da una feature backend.
   */
  _jevStateHtml(row) {
    const state = row?.state;
    if (typeof state !== 'string' || !state.trim()) return '';
    return `<details class="jev-state"><summary>Stato inviato a Jev</summary><pre>${this._escapeHtml(state)}</pre></details>`;
  }

  _jevMetaHtml(row) {
    const bits = [];
    const latency = this._jevNumber(row?.latencyMs);
    if (latency != null) bits.push(`${Math.round(latency)} ms`);
    const tokensIn = this._jevNumber(row?.tokensIn);
    const tokensOut = this._jevNumber(row?.tokensOut);
    if (tokensIn != null || tokensOut != null) {
      bits.push(`${tokensIn ?? '—'}→${tokensOut ?? '—'} token`);
    }
    const cost = this._jevCost(row?.costUsd);
    if (cost) bits.push(cost);
    if (!bits.length) return '';
    return `<div class="jev-meta">${this._escapeHtml(bits.join(' · '))}</div>`;
  }

  /**
   * Costo di una singola osservazione. Non usa `_fmtCost`, che tronca a 4
   * decimali: un'osservazione costa nell'ordine di $0,000015 e uscirebbe come
   * "$0.0000", cioè un costo reale mostrato come zero. `_fmtCost` resta com'è
   * per le proposte dell'analyst, dove gli importi sono di un altro ordine.
   */
  _jevCost(n) {
    const v = this._jevNumber(n);
    if (v == null) return null;
    if (v === 0) return '$0';
    return v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(2)}`;
  }

  /**
   * Numero finito, oppure `null` se il campo non c'è.
   *
   * ⚠️ Non è pignoleria: `Number(null)` e `Number('')` valgono **0** e
   * `Number(true)` vale **1**. Con un `Number()` nudo uno `score` assente
   * diventerebbe uno score di 0, cioè l'etichetta "contesto favorevole" — un
   * giudizio che nessuno ha espresso, stampato con la stessa faccia di uno vero.
   * Un dato ignoto non è un dato pari a zero.
   */
  _jevNumber(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  _jevRatio(value) {
    const n = this._jevNumber(value);
    if (n == null) return null;
    return Math.min(1, Math.max(0, n));
  }

  _jevPct(value) {
    const n = this._jevNumber(value);
    if (n == null) return null;
    return `${Math.round(n * 100)}%`;
  }

  /** Chiave tecnica → etichetta leggibile, senza mappa esaustiva: una chiave che
   *  questa UI non conosce deve comparire col suo nome tecnico, mai sparire. */
  _jevHumanize(key) {
    return String(key ?? '').replace(/_/g, ' ');
  }

  _jevActionLabel(action) {
    if (typeof action !== 'string' || !action.trim()) return '—';
    const labels = { open_long: 'apertura long', open_short: 'apertura short', close: 'chiusura' };
    return labels[action] || this._jevHumanize(action);
  }

  /** Il nome del bot se è ancora in elenco, altrimenti l'id corto: stessa forma
   *  dello storico fill, così la stessa operazione si riconosce nei due pannelli. */
  _jevBotLabel(botId) {
    if (!botId) return '—';
    const bot = (this.bots || []).find((b) => b.id === botId);
    return bot?.name || `Bot #${String(botId).slice(0, 4)}`;
  }

  // ---- Manual order ----
  async submitOrder(side) {
    if (this.network === 'mainnet' && !this.connected) return this.toast('Connetti MetaMask per operare in Mainnet', 'warning');
    const coin = document.getElementById('orderMarket').value;
    const leverage = parseFloat(document.getElementById('orderLeverage').value);
    const sizeUsd = parseFloat(document.getElementById('orderSizeUsd').value);
    const tpv = parseFloat(document.getElementById('orderTp').value);
    const slv = parseFloat(document.getElementById('orderSl').value);
    const body = {
      masterAddress: this.address, coin, side, sizeUsd, leverage,
      tp: !isNaN(tpv) ? { mode: 'percent', value: tpv } : undefined,
      sl: !isNaN(slv) ? { mode: 'percent', value: slv } : undefined
    };
    try {
      this.toast(`Invio ordine ${side.toUpperCase()}...`, 'info');
      const r = await this.api('/api/perps/order', { method: 'POST', body: JSON.stringify(body) });
      this.toast(`✅ Ordine ${side.toUpperCase()} ${coin} eseguito @ ${this.fmtUsd(r.entryPx)}`, 'success');
      await this.refreshAccount();
      if (this.posTab === 'history') this.loadFills();
    } catch (e) { this.toast('Ordine fallito: ' + e.message, 'error'); }
  }

  // ---- Bots ----
  async loadBots() {
    try {
      // AGENT-AWARE: applica il filtro per agent_id se selezionato
      const agentFilter = this._agentFilter || '';
      const url = agentFilter ? `/api/perps/bots?agent_id=${encodeURIComponent(agentFilter)}` : '/api/perps/bots';
      this.bots = await this.api(url);
      // Mappa bot -> strategia AI d'origine (per mostrare da quale proposta nasce)
      try {
        const hist = await this.api('/api/agents/strategy-history');
        this._botStrategy = {};
        for (const h of hist) if (h.linkedBotId) this._botStrategy[h.linkedBotId] = h;
      } catch { this._botStrategy = this._botStrategy || {}; }
      this._renderBots();
    } catch (e) { /* ignore */ }
  }

  /** Cambia il filtro agent e ricarica la lista bot. */
  setAgentFilter(value) {
    this._agentFilter = value || '';
    this.loadBots();
  }

  _renderBots() {
    const list = document.getElementById('botsList');
    const empty = document.getElementById('noBots');
    if (!list) return;
    if (!this.bots.length) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    list.innerHTML = this.bots.map(b => this._botCardHtml(b)).join('');
  }

  /**
   * Traduce una singola entryRule JSON grezza in una stringa descrittiva.
   * Supporta: indicator (rsi, bollinger, ema, sma, price), funding, price_action.
   * Usato dalla card per mostrare la strategia configurata senza dover chiamare
   * l'endpoint /monitor (che richiede candele live).
   */
  _describeRule(r) {
    if (!r || !r.type) return '?';
    const ind = (r.indicator || '').toLowerCase();
    const p   = r.period || r.params?.period || '';
    const op  = r.op || '';
    const val = r.value != null ? r.value : '';
    const sig = r.signal ? `[${r.signal.toUpperCase()}]` : '';

    if (r.type === 'indicator') {
      switch (ind) {
        case 'rsi': {
          const threshold = val !== '' ? val : (r.signal === 'long' ? 30 : 70);
          return `RSI(${p || 14}) ${op || (r.signal === 'long' ? '<' : '>')} ${threshold} ${sig}`;
        }
        case 'bollinger': {
          const condMap = {
            below_lower: 'sotto banda inf',
            above_upper: 'sopra banda sup',
            cross_lower: 'incrocio banda inf',
            cross_upper: 'incrocio banda sup',
          };
          const cond = condMap[r.cond] || r.cond || '';
          return `Bollinger ${cond} ${sig}`;
        }
        case 'ema':
        case 'sma': {
          const fn = ind.toUpperCase();
          if (op && val !== '') return `Prezzo ${op} ${fn}(${p || 20}) ${sig}`;
          return `${fn}(${p || 20}) ${op} ${val} ${sig}`;
        }
        case 'price':
          return `Prezzo ${op} ${val} ${sig}`;
        default:
          if (op && val !== '') return `${ind.toUpperCase()}(${p}) ${op} ${val} ${sig}`;
          return `${ind.toUpperCase()}(${p}) ${sig}`;
      }
    }
    if (r.type === 'funding') {
      return `Funding ${r.op || '>'} ${r.value ?? 0} ${sig}`;
    }
    if (r.type === 'price_action') {
      return `Price action: ${r.pattern || '—'} ${sig}`;
    }
    return `${r.type} ${sig}`;
  }

  /**
   * Costruisce la riga "Strategia" della card: pill per ogni regola configurata.
   * Se non ci sono regole restituisce una stringa muted.
   */
  _describeEntryRules(b) {
    const cfg = b.config || {};
    const rules = cfg.entryRules || [];
    if (!rules.length) return '<span class="muted">Nessuna regola configurata</span>';
    const logic = cfg.logic === 'all' ? '&amp;' : '|';
    const pills = rules.map(r => {
      const sig = (r.signal || '').toLowerCase();
      const cls = sig === 'short' ? 'short' : (sig === 'long' ? 'long' : '');
      return `<span class="rule-pill ${cls}" title="${JSON.stringify(r).replace(/"/g,'&quot;')}">${this._describeRule(r)}</span>`;
    });
    const dir = cfg.direction ? `<span class="muted" style="font-size:.75em">${{ both:'↕', long:'↑', short:'↓' }[cfg.direction] || cfg.direction}</span>` : '';
    const tf  = cfg.candleInterval ? `<span class="muted rule-pill">${cfg.candleInterval}</span>` : '';
    return `${pills.join(`<span class="rule-logic">${logic}</span>`)} ${tf}${dir}`;
  }

  /**
   * Il freno di overtrading sta bloccando le aperture PROPRIO ORA?
   *
   * Nello stato del bot non esiste un booleano dedicato: l'ho cercato prima di
   * scrivere questo match. Il gate si riconosce dall'ultima valutazione, perché
   * `_overtradingBlock()` (src/perps/bot.js) scrive il proprio motivo in
   * `lastEval` con `action: 'hold'`, e TUTTE le sue stringhe — sia il blocco per
   * frequenza sia il guasto di lettura del conteggio — nascono con il prefisso
   * `Overtrading:` (src/perps/riskManager.js, `checkOvertrading`). Gli altri rami
   * che scrivono `lastEval` usano prefissi diversi (`Bloccato:`, `Sizing:`,
   * `Portafoglio:`, `Cooldown post-perdite:`), quindi il match è esclusivo.
   *
   * Due cautele volute:
   *  - `startsWith` e non `includes`: il resto del motivo può citare testo
   *    scritto dall'utente (nome del bot, parametri), e con un `includes` il
   *    badge rosso diventerebbe attivabile chiamando un bot "Overtrading: ...".
   *  - `action === 'hold'` in AND: il gate blocca sempre in hold, e la coppia
   *    rende il riconoscimento indipendente dal solo confronto testuale.
   *
   * Se un domani il backend esporrà un campo diretto (es. `openRate.blocked`),
   * questo è l'unico punto da cambiare.
   */
  _overtradingGateActive(b) {
    const le = b && b.lastEval;
    if (!le || le.action !== 'hold') return false;
    return typeof le.reason === 'string' && le.reason.startsWith('Overtrading:');
  }

  /**
   * Badge "Trade Velocity": quanto spesso il bot sta entrando a mercato, e se il
   * freno di overtrading lo ha già fermato (OVERTRADE-01).
   *
   * Quattro esiti, in ordine di severità decrescente:
   *   🚦 rosso  — il gate è attivo ADESSO: nuove aperture sospese.
   *   ❔ grigio — il conteggio non è leggibile: ignoto, che non è zero.
   *   ⚡ giallo — il ritmo si avvicina alla soglia, ma non la tocca ancora.
   *   (niente) — freno disattivato, oppure ritmo normale: un bot a posto non ha
   *              bisogno di dirlo, e un badge in più su ogni card rende invisibili
   *              i due che contano.
   *
   * Soglia e finestra NON sono replicate qui: arrivano dal payload
   * (`maxOpensPerWindow`/`windowMinutes`) apposta, perché un bot può
   * sovrascriverle in config e una copia dei default lato UI divergerebbe al
   * primo che lo fa. Se mancano, il badge dichiara "sconosciuta" invece di
   * indovinarle.
   *
   * Sul testo del giallo: il confronto con la soglia usa `inWindow` — il
   * conteggio nella STESSA finestra del freno (`_overtradingBlock` in
   * `bot.js`), non `lastHour`/`last4h` che vivono su finestre fisse di 60/240
   * minuti. Scrivere "3/4 aperture/30min" partendo da `lastHour` affermerebbe
   * che quelle 3 aperture stanno dentro la mezz'ora, cosa che il dato non
   * direbbe. Con `inWindow` il badge mostra "N/soglia in Xmin" — esattamente
   * il numero che decide il blocco — e `lastHour`/`last4h` restano solo come
   * contesto supplementare nel `title`.
   */
  _tradeVelocityBadge(b) {
    const ignoto = (motivo) =>
      `<span class="bot-alert-badge bot-velocity-badge is-unknown" title="${this._escapeHtml(motivo)}">❔ velocità sconosciuta</span>`;

    // 1) Gate attivo ora: vince su tutto il resto, anche se il conteggio non si
    //    legge — è un fatto già deciso dal backend, non una stima della UI.
    if (this._overtradingGateActive(b)) {
      // `lastEval.reason` è testo non fidato (cita nome del bot e parametri) e
      // finisce in un attributo: stesso trattamento di `crashBadge`.
      return `<span class="bot-alert-badge bot-velocity-badge is-paused" title="${this._escapeHtml(b.lastEval.reason)}">🚦 IN PAUSA — troppe aperture</span>`;
    }

    // 2) `openRate` assente o null: il backend non ha potuto contare (o non lo
    //    ha detto). Non è "nessuna apertura".
    const rate = b && b.openRate;
    if (!rate || typeof rate !== 'object') {
      return ignoto('Conteggio delle aperture recenti non disponibile — non vuol dire "nessuna apertura".');
    }

    // 3) Freno disattivato per questo bot: non c'è nessuna soglia da avvicinare.
    if (rate.enabled === false) return '';

    // `_jevNumber` e non `Number()`: `Number(null)` vale 0, cioè trasformerebbe
    // proprio il dato mancante nel "zero aperture" che stiamo evitando.
    //
    // Il confronto con la soglia usa `inWindow` — il conteggio nella STESSA
    // finestra del freno (`windowMinutes`) — non `lastHour`/`last4h`: quelle
    // vivono su finestre fisse di 60/240 minuti, diverse da `windowMinutes`
    // (default 30), e non possono dire "quanto manca al blocco". `lastHour`/
    // `last4h` restano solo come contesto supplementare nel `title`.
    const inWindow = this._jevNumber(rate.inWindow);
    const max = this._jevNumber(rate.maxOpensPerWindow);
    const win = this._jevNumber(rate.windowMinutes);
    if (inWindow == null || max == null || win == null) {
      return ignoto('Ritmo di apertura non confrontabile con la soglia: uno dei valori non è leggibile.');
    }

    // 4) Ritmo elevato. Il minimo a 1 evita che un bot con soglia 1 risulti
    //    "elevato" con zero aperture (`max - 1` varrebbe 0).
    const allerta = Math.max(1, max - 1);
    if (inWindow < allerta) return '';

    const apr = (n) => `${n} apertur${n === 1 ? 'a' : 'e'}`;
    const lastHour = this._jevNumber(rate.lastHour);
    const last4h = this._jevNumber(rate.last4h);
    const extra = [];
    if (lastHour != null) extra.push(`${apr(lastHour)} nell'ultima ora`);
    if (last4h != null) extra.push(`${last4h} nelle ultime 4 ore`);
    const coda = extra.length ? ` (${extra.join(', ')})` : '';
    const title = `Ritmo di apertura vicino al freno: ${apr(inWindow)} negli ultimi ${win} min${coda}. Le nuove aperture si fermano a ${max}.`;
    return `<span class="bot-alert-badge bot-velocity-badge is-elevated" title="${this._escapeHtml(title)}">⚡ ${inWindow}/${max} in ${win}min</span>`;
  }

  /**
   * Markup di una card bot.
   *
   * Regola di questo metodo: ogni campo che arriva dal DB o da un agente esterno
   * (`name`, `lastError`, `crashReason`, `lastEval.reason`, `coin`) passa da
   * `_escapeHtml` prima di entrare nel template. Il nome del bot è testo scritto
   * dall'utente nel modale di creazione — e scrivibile anche via agenti come Hermes —
   * quindi senza escaping un nome con del markup verrebbe eseguito nel browser di
   * chiunque apra la dashboard (XSS stored, issue #9). Vale sia nel testo sia negli
   * attributi: `_escapeHtml` copre anche `"` e `'`.
   */
  _botCardHtml(b) {
    const running = b.status === 'running';
    const crashed = b.status === 'crashed';
    const pos = b.position
      ? `<span class="side-badge ${b.position.side}">${b.position.side.toUpperCase()} ${this.fmtNum(b.position.size)}</span>`
      : '<span class="muted">flat</span>';

    // Traduzione action → icona + testo, evita di mostrare messaggi tecnici come
    // "Nessuna regola d'ingresso configurata" (emesso durante il warmup iniziale).
    const le = b.lastEval || {};
    const actionIcon = { open_long: '📈', open_short: '📉', close: '🔒', hold: '⏳' }[le.action] || '—';
    const evalReason = (() => {
      if (!le.action) return '—';
      // Se il motivo è il messaggio di warmup/placeholder, mostriamo solo l'azione
      if (!le.reason || le.reason === "Nessuna regola d'ingresso configurata") {
        return le.action === 'hold' ? '⏳ In attesa candele warmup' : actionIcon;
      }
      // `le.reason` è l'unico valore non fidato qui dentro (può citare il nome del bot,
      // testo scritto dall'utente): va escapato subito, così `evalReason` è già markup
      // sicuro per chi la interpola più sotto. `actionIcon` e il testo di warmup sono
      // costanti del file, non passano da qui.
      return `${actionIcon} ${this._escapeHtml(le.reason)}`;
    })();

    const pnlClass = (b.dailyPnl || 0) >= 0 ? 'profit-positive' : 'profit-negative';
    let statsLine = '';
    if (b.stats && b.stats.trades > 0) {
      const pf = isFinite(b.stats.profitFactor) ? b.stats.profitFactor.toFixed(2) : '∞';
      const wrClass = b.stats.winRate >= 0.5 ? 'profit-positive' : '';
      statsLine = `<div class="bot-meta"><span class="label">Storico reale</span>
        <span class="bot-stats"><span class="${wrClass}">${(b.stats.winRate * 100).toFixed(0)}% win</span> · ${b.stats.trades} trade · PF ${pf} · <span class="${b.stats.totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}">${this.fmtUsd(b.stats.totalPnl)}</span></span></div>`;
    }
    const strat = this._botStrategy?.[b.id];
    const stratBadge = strat
      ? `<div class="bot-strategy-badge" title="${(strat.rationale || '').replace(/"/g, '&quot;')}">🧠 da strategia AI${strat.decidedAt ? ' · ' + new Date(strat.decidedAt).toLocaleDateString('it-IT') : ''}</div>`
      : '';

    // AGENT-AWARE: badge actor — usa i campi arricchiti dall'API admin view se disponibili
    const agentId = b.actor_id || b.linked_agent_id || 'user_manual';
    const isHermes = b.actor === 'hermes' || String(agentId).toLowerCase().includes('hermes') || Boolean(b.is_managed_by_agent);
    const actorIcon = b.actorIcon || (isHermes ? '🤖' : '👤');
    const actorLabel = b.actorLabel || (isHermes ? 'Hermes' : 'Manuale');
    const agentBadgeClass = b.actorColor || (isHermes ? 'agent-badge-hermes' : 'agent-badge-manual');
    const agentBadge = `<span class="agent-badge ${agentBadgeClass}" title="Controllato da: ${actorLabel} (${agentId})">${actorIcon} ${actorLabel}</span>`;

    // Budget Ceiling info. Il separatore " · " iniziale è sparito con lo
    // spostamento nella riga di contesto: lì la spaziatura la fa il `gap` del
    // flex, e un puntino appeso davanti al primo elemento sembrava un refuso.
    const budgetInfo = b.max_allocation_usd != null
      ? `<span class="muted bot-budget-info" title="Budget Ceiling">max ${this.fmtUsd(b.max_allocation_usd)}</span>`
      : '';

    // Badge del mercato scambiato. Prima era testo `.muted` accanto al nome
    // ("· BTC"): scorrendo una lista lunga la coin è la prima cosa che si cerca
    // e finiva per essere l'ultima che si vedeva. Stessa grammatica pill degli
    // altri badge della card, contrasto più alto. `_escapeHtml` perché il valore
    // finisce sia nel testo sia in un attributo.
    const coin = this._escapeHtml(b.coin);
    const coinBadge = `<span class="coin-badge" title="Mercato: ${coin} perp">${coin}</span>`;

    // Watchdog Crash badge. `crashReason` può contenere il messaggio di un errore che
    // riporta dati scritti dall'utente (nome del bot, parametri): qui finisce dentro un
    // attributo, quindi l'escaping deve coprire anche apici e virgolette — `_escapeHtml`
    // lo fa (`"` → `&quot;`, `'` → `&#39;`). Il fallback resta intatto: si escapa il
    // valore finale, non si sostituisce la logica.
    const crashBadge = crashed
      ? `<span class="bot-alert-badge bot-status-crashed-badge" title="${this._escapeHtml(b.crashReason || 'Nessun tick rilevato')}">⚠️ CRASH</span>`
      : '';

    // Velocità di trading (OVERTRADE-01): condivide con CRASH lo slot alert e lo
    // stesso trattamento visivo. Se ci sono entrambi si vedono entrambi — un bot
    // crashato può essere anche stato fermato dal freno, e nascondere l'uno
    // dietro l'altro toglierebbe metà della diagnosi.
    const velocityBadge = this._tradeVelocityBadge(b);
    const alertSlot = (crashBadge || velocityBadge)
      ? `<div class="bot-alert-slot">${crashBadge}${velocityBadge}</div>`
      : '';

    // Riga di contesto: chi controlla il bot, se è forward-test, quanto può
    // allocare. Sono informazioni che si leggono UNA volta e poi non cambiano —
    // in riga primaria pesavano quanto un CRASH.
    const paperBadge = b.paper
      ? '<span class="testnet-badge" style="font-size:.62rem;vertical-align:middle" title="Forward-test: esecuzione simulata su prezzi reali">PAPER</span>'
      : '';
    const contextBadges = `${agentBadge}${paperBadge}${budgetInfo}`;
    const contextRow = contextBadges ? `<div class="bot-card-context">${contextBadges}</div>` : '';

    // Stato dot: verde = running, rosso-pulse = crashed, grigio = stopped
    const dotClass = crashed ? 'crashed' : (running ? 'online' : 'offline');

    // Azione principale: se crashed → "↩️ Riavvia", se running → "⏹️ Stop", else → "▶️ Avvia"
    const mainAction = crashed || !running
      ? `<button class="btn btn-sm btn-long" onclick="perps.startBot('${b.id}')">${crashed ? '↩️ Riavvia' : '▶️ Avvia'}</button>`
      : `<button class="btn btn-sm btn-secondary" onclick="perps.stopBot('${b.id}')">⏹️ Stop</button>`;

    // Sicurezza: se il bot è gestito da agente, mostra l'icona lock sul pulsante edit
    const isManaged = Boolean(b.is_managed_by_agent || isHermes);
    const editBtn = isManaged
      ? `<button class="btn btn-sm btn-outline" onclick="perps.editBot('${b.id}')" title="Bot gestito da Agente (${actorLabel}): richiede sblocco">🔒 ✏️</button>`
      : `<button class="btn btn-sm btn-outline" onclick="perps.editBot('${b.id}')" title="Modifica bot">✏️</button>`;

    // Riga strategia: traduzione human-readable delle entryRules dal config
    const stratRules = this._describeEntryRules(b);

    // Intestazione su due livelli. Prima era una riga sola con sei elementi in
    // fila e lo stesso peso visivo: il badge CRASH stava in mezzo ai badge di
    // contesto e si leggeva come uno di loro. Ora:
    //   riga 1  identità (stato · nome · mercato) + PnL + slot alert
    //   riga 2  contesto (agente · PAPER · budget), più piccolo e attenuato
    // Lo slot alert è il primo posto dove guardare per "c'è un problema": sta
    // sotto il PnL, nell'angolo in alto a destra, e contiene solo allarmi.
    return `<div class="bot-card ${running ? 'running' : ''} ${crashed ? 'bot-crashed' : ''}" id="bot-${b.id}">
      <div class="bot-card-head">
        <div class="bot-card-ident">
          <span class="bot-status-dot ${dotClass}"></span>
          <strong>${this._escapeHtml(b.name)}</strong> ${coinBadge}
        </div>
        <div class="bot-card-alerts">
          <span class="bot-pnl ${pnlClass}">${this.fmtUsd(b.dailyPnl || 0)}</span>
          ${alertSlot}
        </div>
      </div>
      ${contextRow}
      <div class="bot-card-body">
        ${stratBadge}
        <div class="bot-meta"><span class="label">Strategia</span> <span class="rule-pills">${stratRules}</span></div>
        <div class="bot-meta"><span class="label">Posizione</span> ${pos}</div>
        <div class="bot-meta"><span class="label">Valutazione</span> <span class="eval">${evalReason}</span></div>
        ${statsLine}
        ${crashed ? `<div class="bot-error bot-crash-reason">🐕 Watchdog: ${this._escapeHtml(b.crashReason || 'nessun tick rilevato')}</div>` : ''}
        ${!crashed && b.lastError ? `<div class="bot-error">⚠️ ${this._escapeHtml(b.lastError)}</div>` : ''}
      </div>
      <div class="bot-card-actions">
        ${mainAction}
        <button class="btn btn-sm btn-outline" onclick="perps.openBotMonitor('${b.id}')">📡 Monitor</button>
        ${editBtn}
        <button class="btn btn-sm btn-danger" onclick="perps.deleteBot('${b.id}')">🗑️</button>
      </div>
    </div>`;
  }


  _updateBotCard(state) {
    // Merge con il bot già in cache per non perdere i campi arricchiti
    // (actorLabel, actorIcon, actorColor, stats, ecc.) che arrivano dall'API HTTP
    // ma non dai WebSocket events grezzi del botManager.
    const idx = this.bots ? this.bots.findIndex(b => b.id === state.id) : -1;
    const merged = idx >= 0 ? { ...this.bots[idx], ...state } : state;
    if (!this.bots) this.bots = [];
    if (idx >= 0) this.bots[idx] = merged; else this.bots.push(merged);
    const el = document.getElementById('bot-' + state.id);
    if (el) el.outerHTML = this._botCardHtml(merged);
    else this._renderBots();
    // Aggiorna anche il cockpit dashboard (metriche aggregate)
    this._refreshCockpitDashboard();
  }

  async startBot(id) {
    try {
      const bot = this.bots.find(b => b.id === id);
      if (bot && !bot.config?.paper && this.network === 'mainnet') {
        if (!this.connected) return this.toast('Connetti MetaMask per operare in Mainnet', 'warning');
        const s = await this.api(`/api/perps/agent/status?address=${this.address}`);
        if (!s.approved) return this.toast('Abilita prima l\'auto-trading (agent)', 'warning');
      }
      await this.api(`/api/perps/bots/${id}/start`, { method: 'POST' });
      this.toast('Bot avviato', 'success');
      await this.loadBots();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async stopBot(id) {
    try {
      await this.api(`/api/perps/bots/${id}/stop`, { method: 'POST' });
      this.toast('Bot fermato', 'info');
      await this.loadBots();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  /** AGENT-AWARE: Kill Switch — ferma tutti i bot dell'agente selezionato nel filtro. */
  /**
   * AGENT-AWARE: Kill Switch "Safe-Exit"
   *
   * Ferma SEMPRE tutti i bot dell'agente (nessuna nuova apertura).
   * Chiude le posizioni via market order SOLO se il loro notional supera la soglia.
   * Le posizioni piccole restano aperte per gestione manuale ponderata.
   */
  async killSwitchAgent() {
    const agentFilter = this._agentFilter || '';
    const agentLabel = agentFilter === 'hermes' ? 'Hermes'
      : agentFilter === 'user_manual' ? 'Manuali'
      : 'tutti gli agenti';

    // Step 1 — Conferma azione
    const confirmed = confirm(
      `🛑 Kill Switch Safe-Exit [${agentLabel}]\n\n` +
      `• I bot${agentFilter ? ` di "${agentLabel}"` : ''} verranno FERMATI immediatamente.\n` +
      `• Le posizioni con notional > soglia verranno chiuse via market order.\n` +
      `• Le posizioni piccole (sotto soglia) rimarranno aperte per gestione manuale.\n\n` +
      `Continuare?`
    );
    if (!confirmed) return;

    // Step 2 — Soglia size (prompt con default 500 USD)
    const thresholdInput = window.prompt(
      '💰 Soglia Safe-Exit (USD)\n\n' +
      'Le posizioni con notional SUPERIORE a questa soglia verranno chiuse con market order.\n' +
      'Le posizioni inferiori rimarranno aperte per gestione manuale.\n\n' +
      'Inserisci la soglia in USD (es. 500):\n' +
      '(Inserisci 0 per chiudere TUTTE le posizioni indipendentemente dalla size)',
      '500'
    );
    if (thresholdInput === null) return; // annullato
    const threshold = parseFloat(thresholdInput);
    if (isNaN(threshold) || threshold < 0) {
      this.toast('Soglia non valida', 'error');
      return;
    }

    // Step 3 — Conferma finale con riepilogo
    const thresholdLabel = threshold === 0
      ? 'TUTTE le posizioni verranno chiuse'
      : `Solo posizioni > $${threshold.toFixed(0)} USD verranno chiuse`;
    const finalOk = confirm(
      `⚠️ Conferma Kill Switch Safe-Exit\n\n` +
      `Agente: ${agentLabel}\n` +
      `Soglia: ${thresholdLabel}\n\n` +
      `Questa azione è irreversibile. Procedere?`
    );
    if (!finalOk) return;

    try {
      // Se filtro = '' (tutti), iteriamo per ogni agente noto
      const agentIds = agentFilter ? [agentFilter] : ['user_manual', 'hermes'];
      let totalStopped = 0;
      let totalClosed = 0;
      let totalSkipped = 0;

      for (const aid of agentIds) {
        const result = await this.api('/api/perps/kill-switch', {
          method: 'POST',
          body: JSON.stringify({ agent_id: aid, size_threshold_usd: threshold })
        });
        if (result) {
          totalStopped += (result.stopped || []).length;
          totalClosed += (result.closedPositions || []).length;
          totalSkipped += (result.skippedPositions || []).length;
        }
      }

      let msg = `🛑 Kill Switch: ${totalStopped} bot fermat${totalStopped === 1 ? 'o' : 'i'}`;
      if (totalClosed) msg += `, ${totalClosed} posizion${totalClosed === 1 ? 'e chiusa' : 'i chiuse'} (> $${threshold})`;
      if (totalSkipped) msg += ` · ${totalSkipped} lasciat${totalSkipped === 1 ? 'a aperta' : 'e aperte'} per gestione manuale`;
      this.toast(msg, 'warning');
      await this.loadBots();
    } catch (e) { this.toast('Kill Switch fallito: ' + e.message, 'error'); }
  }


  async deleteBot(id) {
    if (!confirm('Eliminare questo bot?')) return;
    try {
      await this.api(`/api/perps/bots/${id}`, { method: 'DELETE' });
      this.toast('Bot eliminato', 'info');
      await this.loadBots();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---- Bot modal & rule builder ----
  openBotModal(bot = null) {
    this._pendingProposalId = null; // reset; applyStrategyProposal lo reimposta dopo
    document.getElementById('botModalTitle').textContent = bot ? '✏️ Modifica Bot' : '🤖 Nuovo Bot';
    document.getElementById('botEditId').value = bot?.id || '';
    document.getElementById('botName').value = bot?.name || '';
    document.getElementById('botMarket').value = bot?.coin || (this.markets[0]?.coin || '');
    const c = bot?.config || {};
    const paperEl = document.getElementById('botPaper');
    if (paperEl) paperEl.checked = !!c.paper;
    document.getElementById('botDirection').value = c.direction || 'both';
    document.getElementById('botLeverage').value = c.leverage || 3;
    document.getElementById('botSizingMode').value = c.sizing?.mode || 'percent';
    document.getElementById('botSizingValue').value = c.sizing?.value ?? 10;
    document.getElementById('botInterval').value = c.candleInterval || '15m';
    document.getElementById('botLogic').value = c.logic || 'any';
    document.getElementById('botTpEnabled').checked = c.tp?.enabled ?? true;
    document.getElementById('botTpValue').value = c.tp?.value ?? 2;
    document.getElementById('botSlEnabled').checked = c.sl?.enabled ?? true;
    document.getElementById('botSlValue').value = c.sl?.value ?? 1;
    document.getElementById('botTrailEnabled').checked = c.trailing?.enabled ?? false;
    document.getElementById('botTrailValue').value = c.trailing?.value ?? 1;
    document.getElementById('botMaxDailyLoss').value = c.risk?.maxDailyLossUsd ?? 100;
    document.getElementById('botMaxPosition').value = c.risk?.maxPositionUsd ?? 1000;
    // Automazione avanzata
    document.getElementById('botMtfEnabled').checked = !!c.mtfConfirm;
    document.getElementById('botMtfInterval').value = c.mtfConfirm?.interval || '1h';
    document.getElementById('botMtfPeriod').value = c.mtfConfirm?.period ?? 50;
    document.getElementById('botPtpEnabled').checked = !!(c.partialTp && c.partialTp.length);
    document.getElementById('botPtp1').value = c.partialTp?.[0]?.atPercent ?? 2;
    document.getElementById('botPtp2').value = c.partialTp?.[1]?.atPercent ?? 5;
    document.getElementById('botDcaEnabled').checked = !!c.dca;
    document.getElementById('botDcaSteps').value = c.dca?.steps ?? 2;
    document.getElementById('botDcaStep').value = c.dca?.stepPercent ?? 2;
    document.getElementById('botDcaMult').value = c.dca?.sizeMultiplier ?? 1;
    document.getElementById('botMlEnabled').checked = !!c.mlGate?.enabled;
    document.getElementById('botMlInterval').value = c.mlGate?.interval || '1h';
    document.getElementById('botMlMinProb').value = c.mlGate?.minProb ? Math.round(c.mlGate.minProb * 100) : 55;

    document.getElementById('entryRules').innerHTML = '';
    document.getElementById('exitRules').innerHTML = '';
    (c.entryRules || [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }])
      .forEach(r => this.addRule('entry', r));
    (c.exitRules || []).forEach(r => this.addRule('exit', r));

    // Modalità semplificata: ripristina selezioni se il bot è stato creato così
    this.selStrategy = c.preset?.strategy || 'rsi_reversal';
    this.selRisk = c.preset?.risk || 'moderato';
    this._renderStrategyCards();
    this._renderRiskProfiles();
    this._updateConsultant();
    // Un bot con preset → semplificata; un bot avanzato (o nuovo) → default semplificata,
    // ma se in modifica e senza preset apri direttamente l'avanzata.
    this.setBotMode(bot && !c.preset ? 'advanced' : 'simple');

    const btBox = document.getElementById('backtestResult');
    if (btBox) btBox.innerHTML = '';
    const optBox = document.getElementById('optimizeResult');
    if (optBox) optBox.innerHTML = '';
    this._lastOpt = null;

    this._showModal('botModal');
  }

  editBot(id) {
    const bot = this.bots.find(b => b.id === id);
    if (!bot) return;
    const agentId = bot.actor_id || bot.linked_agent_id || 'user_manual';
    const isManaged = Boolean(bot.is_managed_by_agent || bot.actor === 'hermes' || String(agentId).toLowerCase().includes('hermes'));
    if (isManaged) {
      const actorName = bot.actorLabel || 'Hermes';
      const unlock = confirm(
        `🤖 Sblocco Modifica Manuale [${actorName}]\n\n` +
        `Questo bot è gestito autonomamente dall'Agente ${actorName} per i test in tempo reale.\n` +
        `Modificare manualmente i parametri potrebbe interferire con i calcoli attivi dell'Agente.\n\n` +
        `Vuoi sbloccare temporaneamente la modifica manuale e procedere?`
      );
      if (!unlock) return;
    }
    this.openBotModal(bot);
  }

  // ---- Modalità bot (semplificata / avanzata) ----
  setBotMode(mode) {
    this.botMode = mode;
    document.getElementById('botSimple')?.classList.toggle('hidden', mode !== 'simple');
    document.getElementById('botAdvanced')?.classList.toggle('hidden', mode !== 'advanced');
    document.querySelectorAll('.bot-mode').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode));
  }

  _renderStrategyCards() {
    const box = document.getElementById('strategyCards');
    if (!box) return;
    box.innerHTML = Object.entries(BOT_STRATEGIES).map(([key, s]) => `
      <div class="strategy-card ${this.selStrategy === key ? 'selected' : ''}" onclick="perps.selectStrategy('${key}')">
        <div class="strategy-card-head"><span class="strategy-emoji">${s.emoji}</span><strong>${s.name}</strong><span class="strategy-tag">${s.tag}</span></div>
        <p class="strategy-desc">${s.desc}</p>
        <p class="strategy-when">💡 ${s.when}</p>
      </div>`).join('');
  }

  _renderRiskProfiles() {
    const box = document.getElementById('riskProfiles');
    if (!box) return;
    box.innerHTML = Object.entries(RISK_PROFILES).map(([key, r]) => `
      <div class="risk-profile ${this.selRisk === key ? 'selected' : ''}" onclick="perps.selectRisk('${key}')">
        <div class="risk-profile-head">${r.emoji} <strong>${r.name}</strong></div>
        <div class="risk-profile-params">Leva ${r.leverage}x · ${r.sizingPercent}% equity · TP ${r.tp}% · SL ${r.sl}%</div>
        <p class="risk-profile-desc">${r.desc}</p>
      </div>`).join('');
  }

  selectStrategy(key) {
    this.selStrategy = key;
    this._renderStrategyCards();
    this._updateConsultant();
  }

  selectRisk(key) {
    this.selRisk = key;
    this._renderRiskProfiles();
    this._updateConsultant();
  }

  _updateConsultant(backtestStats = null) {
    const box = document.getElementById('consultantBox');
    const txt = document.getElementById('consultantText');
    if (!box || !txt) return;
    if (!this.selStrategy) { box.classList.add('hidden'); return; }
    const s = BOT_STRATEGIES[this.selStrategy];
    const r = RISK_PROFILES[this.selRisk];
    const coin = document.getElementById('botMarket')?.value || 'il mercato scelto';
    const cfg = s.build();
    const dir = cfg.direction === 'both' ? 'Long e Short' : (cfg.direction === 'long' ? 'solo Long' : 'solo Short');
    let bt = '';
    if (backtestStats) {
      const pf = isFinite(backtestStats.profitFactor) ? backtestStats.profitFactor.toFixed(2) : '∞';
      const edge = backtestStats.expectancy > 0 ? 'un edge positivo ✅' : 'un edge negativo ⚠️ — valuta di cambiare strategia o parametri';
      bt = `<br><span class="consultant-bt">📊 Backtest: win rate ${(backtestStats.winRate * 100).toFixed(0)}%, profit factor ${pf} → ${edge}</span>`;
    }
    box.classList.remove('hidden');
    txt.innerHTML = `
      Per <strong>${coin}</strong> ti consiglio la strategia <strong>"${s.name}"</strong> (${s.tag.toLowerCase()}) con profilo <strong>${r.name}</strong>.<br>
      Il bot opererà <strong>${dir}</strong> sul timeframe <strong>${cfg.candleInterval}</strong>: ${s.desc}<br>
      Gestione: leva <strong>${r.leverage}x</strong>, <strong>${r.sizingPercent}%</strong> dell'equity per operazione,
      take profit <strong>+${r.tp}%</strong>, stop loss <strong>-${r.sl}%</strong>${r.trailing ? `, trailing stop <strong>${r.trailing}%</strong>` : ''}.
      Stop automatico a <strong>-${this.fmtUsd(r.maxDailyLoss)}</strong> di perdita giornaliera.
      <br><span class="consultant-note">💡 ${s.when}</span>${bt}`;
    // Stima ML per il mercato/timeframe della strategia (asincrona)
    this.loadMlEstimate(cfg.candleInterval);
  }

  _buildSimpleConfig() {
    const s = BOT_STRATEGIES[this.selStrategy];
    const r = RISK_PROFILES[this.selRisk];
    const strat = s.build();
    return {
      ...strat,
      leverage: r.leverage,
      sizing: { mode: 'percent', value: r.sizingPercent },
      tp: { enabled: true, mode: 'percent', value: r.tp },
      sl: { enabled: true, mode: 'percent', value: r.sl },
      trailing: { enabled: r.trailing > 0, mode: 'percent', value: r.trailing || 1 },
      risk: { maxDailyLossUsd: r.maxDailyLoss, maxPositionUsd: r.maxPosition },
      preset: { strategy: this.selStrategy, risk: this.selRisk }
    };
  }

  addRule(kind, rule = {}) {
    const container = document.getElementById(kind === 'entry' ? 'entryRules' : 'exitRules');
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.dataset.kind = kind;
    row.innerHTML = `
      <select class="form-select form-select-sm rule-type">
        <option value="indicator">Indicatore</option>
        <option value="price">Prezzo</option>
        <option value="funding">Funding</option>
        <option value="external">Segnale esterno</option>
      </select>
      <span class="rule-fields"></span>
      ${kind === 'entry'
        ? `<select class="form-select form-select-sm rule-signal"><option value="long">→ Long</option><option value="short">→ Short</option></select>`
        : `<input type="hidden" class="rule-signal" value="close">`}
      <button class="btn btn-sm btn-danger rule-remove">×</button>`;
    container.appendChild(row);

    const typeSel = row.querySelector('.rule-type');
    typeSel.value = rule.type || 'indicator';
    typeSel.addEventListener('change', () => this._renderRuleFields(row, {}));
    row.querySelector('.rule-remove').addEventListener('click', () => row.remove());
    if (kind === 'entry' && rule.signal) row.querySelector('.rule-signal').value = rule.signal;
    this._renderRuleFields(row, rule);
  }

  _renderRuleFields(row, rule) {
    const type = row.querySelector('.rule-type').value;
    const f = row.querySelector('.rule-fields');
    const opSel = (val) => `<select class="form-select form-select-sm rf-op">
      ${['<', '>', '<=', '>='].map(o => `<option ${val === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;

    if (type === 'indicator') {
      const indicator = rule.indicator || 'rsi';
      f.innerHTML = `
        <select class="form-select form-select-sm rf-indicator">
          ${['rsi', 'ema', 'sma', 'macd', 'bollinger'].map(i =>
            `<option value="${i}" ${indicator === i ? 'selected' : ''}>${i.toUpperCase()}</option>`).join('')}
        </select>
        <span class="rf-params"></span>`;
      const indSel = f.querySelector('.rf-indicator');
      const renderParams = () => {
        const ind = indSel.value;
        const params = f.querySelector('.rf-params');
        if (ind === 'macd') {
          params.innerHTML = `<select class="form-select form-select-sm rf-cond">
            <option value="bullish" ${rule.cond === 'bullish' ? 'selected' : ''}>istogramma > 0 (rialzo)</option>
            <option value="bearish" ${rule.cond === 'bearish' ? 'selected' : ''}>istogramma < 0 (ribasso)</option></select>`;
        } else if (ind === 'bollinger') {
          params.innerHTML = `<select class="form-select form-select-sm rf-cond">
            <option value="below_lower" ${rule.cond === 'below_lower' ? 'selected' : ''}>prezzo < banda inf.</option>
            <option value="above_upper" ${rule.cond === 'above_upper' ? 'selected' : ''}>prezzo > banda sup.</option></select>`;
        } else {
          params.innerHTML = `
            <input type="number" class="form-input form-input-sm rf-period" placeholder="periodo" value="${rule.period ?? 14}" style="width:70px">
            ${opSel(rule.op)}
            <input type="number" class="form-input form-input-sm rf-value" placeholder="valore" value="${rule.value ?? 30}" style="width:80px">`;
        }
      };
      indSel.addEventListener('change', renderParams);
      renderParams();
    } else if (type === 'external') {
      f.innerHTML = `<span class="muted">attivato da webhook</span>`;
    } else {
      // price | funding
      const ph = type === 'funding' ? 'es. 0.0001' : 'prezzo';
      f.innerHTML = `${opSel(rule.op)}
        <input type="number" class="form-input form-input-sm rf-value" placeholder="${ph}" value="${rule.value ?? ''}" step="any" style="width:110px">`;
    }
  }

  /** Costruisce la config del bot dalla modalità attiva (simple/advanced). */
  _buildBotConfig() {
    let cfg;
    if (this.botMode === 'simple') {
      if (!this.selStrategy) { this.toast('Scegli una strategia', 'warning'); return null; }
      cfg = this._buildSimpleConfig();
    } else {
      cfg = this._buildAdvancedConfig();
    }
    // Paper-trading (forward-test): esecuzione simulata sui prezzi reali.
    if (cfg) cfg.paper = !!document.getElementById('botPaper')?.checked;
    return cfg;
  }

  _buildAdvancedConfig() {
    return {
      direction: document.getElementById('botDirection').value,
      leverage: parseFloat(document.getElementById('botLeverage').value),
      sizing: {
        mode: document.getElementById('botSizingMode').value,
        value: parseFloat(document.getElementById('botSizingValue').value)
      },
      candleInterval: document.getElementById('botInterval').value,
      logic: document.getElementById('botLogic').value,
      entryRules: this._collectRules('entry'),
      exitRules: this._collectRules('exit'),
      tp: { enabled: document.getElementById('botTpEnabled').checked, mode: 'percent', value: parseFloat(document.getElementById('botTpValue').value) },
      sl: { enabled: document.getElementById('botSlEnabled').checked, mode: 'percent', value: parseFloat(document.getElementById('botSlValue').value) },
      trailing: { enabled: document.getElementById('botTrailEnabled').checked, mode: 'percent', value: parseFloat(document.getElementById('botTrailValue').value) },
      risk: {
        maxDailyLossUsd: parseFloat(document.getElementById('botMaxDailyLoss').value),
        maxPositionUsd: parseFloat(document.getElementById('botMaxPosition').value)
      },
      ...this._collectAdvancedAutomation()
    };
  }

  /** Raccoglie i campi di automazione avanzata (MTF, partial TP, DCA). */
  _collectAdvancedAutomation() {
    const out = {};
    if (document.getElementById('botMtfEnabled')?.checked) {
      out.mtfConfirm = {
        interval: document.getElementById('botMtfInterval').value,
        period: parseInt(document.getElementById('botMtfPeriod').value) || 50
      };
    }
    if (document.getElementById('botPtpEnabled')?.checked) {
      const a1 = parseFloat(document.getElementById('botPtp1').value);
      const a2 = parseFloat(document.getElementById('botPtp2').value);
      out.partialTp = [
        { portion: 0.5, atPercent: a1 },
        { portion: 0.5, atPercent: a2 }
      ].filter(s => s.atPercent > 0);
    }
    if (document.getElementById('botDcaEnabled')?.checked) {
      out.dca = {
        steps: parseInt(document.getElementById('botDcaSteps').value) || 1,
        stepPercent: parseFloat(document.getElementById('botDcaStep').value) || 2,
        sizeMultiplier: parseFloat(document.getElementById('botDcaMult').value) || 1
      };
    }
    if (document.getElementById('botMlEnabled')?.checked) {
      out.mlGate = {
        enabled: true,
        interval: document.getElementById('botMlInterval').value,
        minProb: (parseFloat(document.getElementById('botMlMinProb').value) || 55) / 100
      };
    }
    return out;
  }

  // ---- Backtest ----
  async runBacktest() {
    const coin = document.getElementById('botMarket').value;
    const config = this._buildBotConfig();
    if (!config) return;
    const lookbackDays = parseInt(document.getElementById('backtestDays').value) || 30;
    const box = document.getElementById('backtestResult');
    box.innerHTML = '<div class="backtest-loading"><span class="spinner-sm"></span> Backtest in corso…</div>';
    try {
      const r = await this.api('/api/perps/backtest', {
        method: 'POST',
        body: JSON.stringify({ coin, config, interval: config.candleInterval, lookbackDays })
      });
      if (r.error) { box.innerHTML = `<div class="backtest-empty">⚠️ ${r.error}</div>`; return; }
      box.innerHTML = this._backtestHtml(r);
      // aggiorna anche il box consulente in modalità semplice
      if (this.botMode === 'simple') this._updateConsultant(r.stats);
    } catch (e) {
      box.innerHTML = `<div class="backtest-empty">Errore backtest: ${e.message}</div>`;
    }
  }

  _backtestHtml(r) {
    const s = r.stats;
    const pf = s.profitFactor === null || s.profitFactor === Infinity || !isFinite(s.profitFactor) ? '∞' : s.profitFactor.toFixed(2);
    const edge = s.expectancy > 0 ? 'positivo' : 'negativo';
    const edgeClass = s.expectancy > 0 ? 'profit-positive' : 'profit-negative';
    const wrClass = s.winRate >= 0.5 ? 'profit-positive' : '';
    return `
      <div class="backtest-grid">
        <div class="bt-metric"><span class="bt-label">Win rate</span><span class="bt-value ${wrClass}">${(s.winRate * 100).toFixed(1)}%</span></div>
        <div class="bt-metric"><span class="bt-label">Profit factor</span><span class="bt-value">${pf}</span></div>
        <div class="bt-metric"><span class="bt-label">Expectancy</span><span class="bt-value ${edgeClass}">${this.fmtUsd(s.expectancy)}/trade</span></div>
        <div class="bt-metric"><span class="bt-label">Operazioni</span><span class="bt-value">${s.trades}</span></div>
        <div class="bt-metric"><span class="bt-label">Return</span><span class="bt-value ${s.totalReturnPct >= 0 ? 'profit-positive' : 'profit-negative'}">${s.totalReturnPct.toFixed(1)}%</span></div>
        <div class="bt-metric"><span class="bt-label">Max drawdown</span><span class="bt-value profit-negative">-${s.maxDrawdownPct.toFixed(1)}%</span></div>
      </div>
      ${this._equitySparkline(r.equityCurve)}
      <div class="backtest-verdict ${edgeClass}">Edge ${edge} su ${r.period.days} giorni (${r.period.candles} candele, ${r.period.interval}).</div>
      <div class="backtest-disclaimer">⚠️ Risultati storici su un notional di ${this.fmtUsd(r.notionalUsd)}: NON garantiscono rendimenti futuri.</div>`;
  }

  /** Sparkline SVG della equity curve (nessuna dipendenza). */
  _equitySparkline(curve) {
    if (!curve || curve.length < 2) return '';
    const vals = curve.map(p => p.equity);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = (max - min) || 1;
    const W = 600, H = 80;
    const pts = curve.map((p, i) => {
      const x = (i / (curve.length - 1)) * W;
      const y = H - ((p.equity - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const last = vals[vals.length - 1];
    const stroke = last >= 0 ? '#38a169' : '#e53e3e';
    const zeroY = H - ((0 - min) / range) * H;
    return `<svg class="equity-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${(min < 0 && max > 0) ? `<line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e0" stroke-dasharray="4" />` : ''}
      <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2" />
    </svg>`;
  }

  // ---- Optimizer (Hyperopt + walk-forward) ----
  async runOptimize() {
    const coin = document.getElementById('botMarket').value;
    const config = this._buildBotConfig();
    if (!config) return;
    const method = document.getElementById('optMethod').value;
    const objective = document.getElementById('optObjective').value;
    const lookbackDays = parseInt(document.getElementById('optDays').value) || 60;
    const box = document.getElementById('optimizeResult');
    box.innerHTML = '<div class="backtest-loading"><span class="spinner-sm"></span> Ottimizzazione in corso… (può richiedere qualche secondo)</div>';
    try {
      const r = await this.api('/api/perps/optimize', {
        method: 'POST',
        body: JSON.stringify({ coin, config, interval: config.candleInterval, lookbackDays, method, objective })
      });
      if (r.error) { box.innerHTML = `<div class="backtest-empty">⚠️ ${r.error}</div>`; return; }
      this._lastOpt = r;
      box.innerHTML = this._optimizeHtml(r);
    } catch (e) {
      box.innerHTML = `<div class="backtest-empty">Errore ottimizzazione: ${e.message}</div>`;
    }
  }

  _fmtPf(pf) {
    return (pf === null || pf === Infinity || !isFinite(pf)) ? '∞' : pf.toFixed(2);
  }

  _optimizeHtml(r) {
    const b = r.best;
    const verdictMap = {
      robust: { cls: 'profit-positive', txt: '✅ L\'edge regge anche fuori campione: parametri più affidabili.' },
      weaker: { cls: '', txt: '⚠️ Fuori campione l\'edge si indebolisce: usa con cautela.' },
      overfit: { cls: 'profit-negative', txt: '⛔ Fuori campione l\'edge crolla: parametri sovra-ottimizzati, NON usare.' },
      unknown: { cls: '', txt: 'ℹ️ Validazione fuori campione non disponibile.' }
    };
    const v = verdictMap[b.verdict] || verdictMap.unknown;

    const cmpRow = (label, inS, outS, fmt) => `
      <tr><td>${label}</td><td>${fmt(inS)}</td><td>${outS != null ? fmt(outS) : '—'}</td></tr>`;
    const fmtPct = x => `${x.toFixed(1)}%`;
    const fmtWr = x => `${(x * 100).toFixed(0)}%`;
    const oos = b.outOfSample;
    const inS = b.inSample;

    const paramsTxt = Object.values(b.params).map(p => `<span class="opt-param">${p.label}: <b>${p.value}</b></span>`).join(' ');

    const lbHead = `<tr><th>#</th>${r.dims.map(d => `<th>${d.label}</th>`).join('')}<th>Win</th><th>PF</th><th>Exp</th><th>Trade</th></tr>`;
    const lbRows = r.leaderboard.map((e, i) => `
      <tr class="${i === 0 ? 'opt-best-row' : ''}">
        <td>${i + 1}</td>
        ${r.dims.map(d => `<td>${e.params[d.key]}</td>`).join('')}
        <td>${fmtWr(e.winRate)}</td><td>${this._fmtPf(e.profitFactor)}</td>
        <td class="${e.expectancy >= 0 ? 'profit-positive' : 'profit-negative'}">${this.fmtUsd(e.expectancy)}</td>
        <td>${e.trades}</td>
      </tr>`).join('');

    return `
      <div class="opt-best">
        <div class="opt-best-head">🏆 Migliore combinazione <span class="muted">(obiettivo: ${r.objective}, ${r.evals} valutazioni, ${r.method})</span></div>
        <div class="opt-params">${paramsTxt}</div>
        <table class="opt-cmp">
          <thead><tr><th>Metrica</th><th>In-sample</th><th>Out-of-sample</th></tr></thead>
          <tbody>
            ${cmpRow('Win rate', inS.winRate, oos?.winRate, fmtWr)}
            ${cmpRow('Profit factor', inS.profitFactor, oos?.profitFactor, x => this._fmtPf(x))}
            ${cmpRow('Expectancy', inS.expectancy, oos?.expectancy, x => this.fmtUsd(x))}
            ${cmpRow('Return', inS.totalReturnPct, oos?.totalReturnPct, fmtPct)}
            ${cmpRow('Operazioni', inS.trades, oos?.trades, x => x)}
          </tbody>
        </table>
        <div class="backtest-verdict ${v.cls}">${v.txt}</div>
        <button class="btn btn-sm btn-primary" onclick="perps.applyOptimized()">✨ Applica migliori parametri</button>
      </div>
      <details class="opt-leaderboard"><summary>📋 Classifica (top ${r.leaderboard.length})</summary>
        <div class="opt-table-wrap"><table class="opt-lb"><thead>${lbHead}</thead><tbody>${lbRows}</tbody></table></div>
      </details>
      <div class="backtest-disclaimer">⚠️ Periodo: ${r.period.days}g (${r.period.inSampleCandles} in-sample + ${r.period.outSampleCandles} out-of-sample, ${r.period.interval}). Parametri ottimizzati sui dati storici: performance passata ≠ futura.</div>`;
  }

  /** Applica al form (modalità avanzata) la configurazione migliore trovata. */
  applyOptimized() {
    const c = this._lastOpt?.best?.config;
    if (!c) return;
    this.setBotMode('advanced');
    document.getElementById('botDirection').value = c.direction || 'both';
    document.getElementById('botLeverage').value = c.leverage || 3;
    document.getElementById('botSizingMode').value = c.sizing?.mode || 'percent';
    document.getElementById('botSizingValue').value = c.sizing?.value ?? 10;
    document.getElementById('botInterval').value = c.candleInterval || '15m';
    document.getElementById('botLogic').value = c.logic || 'any';
    document.getElementById('botTpEnabled').checked = c.tp?.enabled ?? true;
    document.getElementById('botTpValue').value = c.tp?.value ?? 2;
    document.getElementById('botSlEnabled').checked = c.sl?.enabled ?? true;
    document.getElementById('botSlValue').value = c.sl?.value ?? 1;
    document.getElementById('botTrailEnabled').checked = c.trailing?.enabled ?? false;
    document.getElementById('botTrailValue').value = c.trailing?.value ?? 1;
    document.getElementById('entryRules').innerHTML = '';
    document.getElementById('exitRules').innerHTML = '';
    (c.entryRules || []).forEach(r => this.addRule('entry', r));
    (c.exitRules || []).forEach(r => this.addRule('exit', r));
    this.toast('Parametri ottimizzati applicati (modalità avanzata)', 'success');
  }

  // ---- Stima ML (FreqAI-lite) ----
  async loadMlEstimate(intervalArg) {
    const coin = document.getElementById('botMarket')?.value;
    const interval = intervalArg || document.getElementById('botInterval')?.value || '15m';
    const box = document.getElementById('mlEstimate');
    if (!coin || !box) return;
    box.innerHTML = '<span class="spinner-sm"></span> calcolo stima…';
    try {
      const r = await this.api(`/api/perps/predict?coin=${encodeURIComponent(coin)}&interval=${interval}`);
      if (r.error) { box.innerHTML = `<span class="muted">ML non disponibile: ${r.error}</span>`; return; }
      const prob = (r.probUp * 100).toFixed(0);
      const acc = (r.model.accuracy * 100).toFixed(0);
      const base = (r.model.baseline * 100).toFixed(0);
      const dir = r.probUp >= 0.55 ? '📈 rialzo' : r.probUp <= 0.45 ? '📉 ribasso' : '➖ neutro';
      const edgeWarn = r.hasEdge ? '' : ` <span class="ml-warn">⚠️ accuratezza ≈ baseline: il modello non ha edge, non usarlo da solo.</span>`;
      box.innerHTML = `🧠 <b>Stima ML:</b> prob. rialzo <b>${prob}%</b> (${dir}) · accuratezza ${acc}% vs baseline ${base}% (n=${r.model.samples})${edgeWarn}`;
    } catch (e) {
      box.innerHTML = `<span class="muted">ML non disponibile: ${e.message}</span>`;
    }
  }

  _collectRules(kind) {
    const rows = document.querySelectorAll(`#${kind}Rules .rule-row`);
    const rules = [];
    rows.forEach(row => {
      const type = row.querySelector('.rule-type').value;
      const signal = row.querySelector('.rule-signal').value;
      const rule = { type, signal };
      if (type === 'indicator') {
        rule.indicator = row.querySelector('.rf-indicator').value;
        const cond = row.querySelector('.rf-cond');
        if (cond) {
          rule.cond = cond.value;
        } else {
          rule.period = parseInt(row.querySelector('.rf-period')?.value) || undefined;
          rule.op = row.querySelector('.rf-op')?.value;
          rule.value = parseFloat(row.querySelector('.rf-value')?.value);
        }
      } else if (type === 'price' || type === 'funding') {
        rule.op = row.querySelector('.rf-op')?.value;
        rule.value = parseFloat(row.querySelector('.rf-value')?.value);
      }
      rules.push(rule);
    });
    return rules;
  }

  async saveBot() {
    const id = document.getElementById('botEditId').value;
    const name = document.getElementById('botName').value.trim();
    const coin = document.getElementById('botMarket').value;
    if (!name) return this.toast('Inserisci un nome', 'warning');

    const config = this._buildBotConfig();
    if (!config) return;

    try {
      let created = null;
      if (id) {
        await this.api(`/api/perps/bots/${id}`, { method: 'PATCH', body: JSON.stringify({ name, coin, config }) });
      } else {
        created = await this.api('/api/perps/bots', { method: 'POST', body: JSON.stringify({ name, coin, masterAddress: this.address, config }) });
        // CRIT-03-EXTRA — il bot è creato comunque (non è un errore): se sul
        // mercato c'è già un altro bot in esecuzione sullo stesso wallet, la
        // risposta porta `warning` e va mostrato, altrimenti un avviso che nessuno
        // vede non è un avviso. Il testo arriva dal server (botManager), qui non
        // si riscrive: due punti di verità direbbero due cose diverse.
        if (created?.warning) this.toast(created.warning, 'warning');
      }
      // Se il bot nasce da una strategia AI approvata, collegalo per seguirne l'esito
      if (!id && this._pendingProposalId && created?.id) {
        try {
          await this.api(`/api/agents/proposals/${encodeURIComponent(this._pendingProposalId)}/link`, { method: 'POST', body: JSON.stringify({ botId: created.id }) });
          this.toast('Bot collegato alla strategia AI: ne seguirai l\'esito nello storico', 'success');
        } catch (_) { /* il bot è creato comunque */ }
        this._pendingProposalId = null;
      } else {
        this.toast('Bot salvato', 'success');
      }
      this._closeModal('botModal');
      await this.loadBots();
      this.loadStrategyHistory?.();
    } catch (e) { this.toast('Errore salvataggio: ' + e.message, 'error'); }
  }
}

const perps = new PerpsApp();
window.perps = perps;

// Aggiorna il prezzo mostrato quando cambia il mercato selezionato e inizializza la vista Perps
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('orderMarket');
  if (sel) sel.addEventListener('change', () => perps._updateMid());
  const botSel = document.getElementById('botMarket');
  if (botSel) botSel.addEventListener('change', () => perps._updateConsultant());

  // Inizializza l'applicazione e registra gli eventi dei tab della cockpit se la vista attiva è Perps
  if (!document.getElementById('view-perps')?.classList.contains('hidden')) {
    perps.onShow();
  }
});
