/**
 * DERIVAZIONE STATO RISCHIO (Perps)
 * =================================
 *
 * Funzioni pure per trasformare gli snapshot account/sistema in alert
 * deterministici consumabili dalla UI cockpit.
 */

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * Soglie di allerta non derivabili dai limiti di portafoglio (margine e
 * drawdown). Esportate perché ADV-01 aggiunge un secondo lettore dello stato di
 * rischio (lo strumento `get_risk_snapshot` del consulente AI) oltre alla rotta
 * `/api/perps/risk`: se ognuno si portasse le proprie costanti, la chat
 * potrebbe dire "margine ok" mentre la cockpit segna un warning. Il rischio si
 * legge da un posto solo — non si ricalcola (spike §11 rischio S5).
 */
export const RISK_ALERT_THRESHOLDS = {
  marginWarningPct: 60,
  marginCriticalPct: 80,
  drawdownWarningPct: 5,
  drawdownCriticalPct: 10
};

/**
 * Adatta uno stato bot (`botManager.listStates()`) a ciò che `deriveRiskAlerts`
 * consuma: include il calcolo di "stantio" (running ma senza tick da oltre 3×
 * il suo loop, minimo 60s) usato dal watchdog. Pura e condivisa per lo stesso
 * motivo delle soglie qui sopra.
 */
export function toRiskBotView(bot, {
  now = Date.now(), defaultLoopInterval = 15000, defaultMaxDailyLossUsd = 1000
} = {}) {
  const loopInterval = bot.config?.loopInterval || defaultLoopInterval;
  const stale = bot.status === 'running' && bot.lastTickAt > 0
    && now - bot.lastTickAt > Math.max(3 * loopInterval, 60000);
  return {
    id: bot.id,
    name: bot.name,
    coin: bot.coin,
    status: bot.status,
    dailyPnl: number(bot.dailyPnl),
    lastError: bot.lastError || null,
    tickErrors: number(bot.tickErrors),
    lastTickAt: bot.lastTickAt || null,
    stale,
    staleSeconds: stale ? Math.round((now - bot.lastTickAt) / 1000) : 0,
    inPosition: !!bot.inPosition,
    maxDailyLossUsd: number(bot.config?.risk?.maxDailyLossUsd ?? defaultMaxDailyLossUsd)
  };
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function usd(value) {
  return `$${number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function timeMeta(now, suffix = '') {
  const time = new Date(now).toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  return suffix ? `${time} · ${suffix}` : time;
}

/** Calcola il drawdown massimo e quello corrente sulla curva sessione. */
export function calculateDrawdown(history = []) {
  let peak = null;
  let maxUsd = 0;
  let currentUsd = 0;

  for (const point of history) {
    const value = number(point.value, NaN);
    if (!Number.isFinite(value)) continue;
    if (peak == null || value > peak) peak = value;
    const drawdown = Math.max(0, peak - value);
    maxUsd = Math.max(maxUsd, drawdown);
    currentUsd = drawdown;
  }

  const currentValue = history.length ? number(history[history.length - 1].value, NaN) : null;
  const maxPct = peak ? (maxUsd / peak) * 100 : 0;
  const currentPct = peak ? (currentUsd / peak) * 100 : 0;
  return {
    peak,
    current: Number.isFinite(currentValue) ? currentValue : null,
    maxUsd,
    maxPct,
    currentUsd,
    currentPct,
    scope: 'session'
  };
}

/**
 * Mantiene il drawdown massimo quando la curva esposta è limitata agli ultimi
 * campioni, usando lo stato monotono persistito in SQLite.
 */
export function mergeDrawdownState(current = {}, persisted = null) {
  if (!persisted) return { ...current, scope: 'session' };
  const finite = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const peaks = [finite(current.peak), finite(persisted.peakEquity)]
    .filter(value => value != null);
  const peak = peaks.length ? Math.max(...peaks) : null;
  const currentValue = finite(current.current) ?? finite(persisted.currentEquity);
  const currentUsd = peak != null && currentValue != null
    ? Math.max(0, peak - currentValue)
    : Math.max(0, number(persisted.currentDrawdownUsd));
  const maxUsd = Math.max(
    number(current.maxUsd),
    number(persisted.maxDrawdownUsd),
    currentUsd
  );
  return {
    peak,
    current: currentValue,
    maxUsd,
    maxPct: Math.max(
      number(current.maxPct),
      number(persisted.maxDrawdownPct),
      peak ? (maxUsd / peak) * 100 : 0
    ),
    currentUsd,
    currentPct: peak ? (currentUsd / peak) * 100 : 0,
    scope: 'session'
  };
}

/** Deriva gli alert live dai dati già verificati dal backend. */
export function deriveRiskAlerts({
  now = Date.now(),
  address = null,
  account = null,
  orders = [],
  limits = {},
  bots = [],
  marketStatus = {},
  agent = null,
  killSwitch = false,
  drawdown = {},
  sourceErrors = [],
  defaultMaxDailyLossUsd = 1000
} = {}) {
  const alerts = [];
  const add = (severity, id, title, body, action, suffix) => {
    alerts.push({
      id, severity, title, body, action,
      meta: timeMeta(now, suffix)
    });
  };

  if (sourceErrors.length) {
    add(
      'critical',
      'risk-source-unavailable',
      'Dati rischio incompleti',
      `Impossibile verificare: ${sourceErrors.join(', ')}. Evita nuove aperture finché il dato non torna disponibile.`,
      'risk',
      'fonte non disponibile'
    );
  }

  if (killSwitch) {
    add(
      'critical',
      'killswitch-active',
      'Kill-switch attivo',
      'Le nuove aperture sono bloccate e i bot automatici risultano fermati.',
      'risk',
      'aperture bloccate'
    );
  }

  const hasAccount = !!account;
  if (hasAccount) {
    const equity = number(account.equity ?? account.accountValue);
    const positions = Array.isArray(account.positions) ? account.positions : [];
    const exposure = number(account.totalNtlPos, positions.reduce((sum, p) => sum + number(p.positionValue), 0));
    const margin = number(account.totalMarginUsed);
    const marginPct = equity > 0 ? (margin / equity) * 100 : 0;
    const maxExposure = number(limits.maxTotalExposureUsd, 0);
    const maxPositions = number(limits.maxConcurrentPositions, 0);
    const marginWarning = number(limits.marginWarningPct, 60);
    const marginCritical = number(limits.marginCriticalPct, 80);

    if (equity <= 0) {
      add('critical', 'equity-insufficient', 'Equity insufficiente', 'L’equity disponibile è nulla o non valida: le aperture non sono sicure.', 'risk', 'account');
    }
    if (maxExposure > 0 && exposure > maxExposure) {
      add(
        'critical', 'exposure-limit', 'Esposizione oltre il limite',
        `Esposizione ${usd(exposure)} su un limite di ${usd(maxExposure)}. Le nuove aperture devono restare bloccate.`,
        'risk', `${Math.round(exposure / maxExposure * 100)}% del cap`
      );
    }
    if (maxPositions > 0 && positions.length >= maxPositions) {
      add(
        'critical', 'positions-limit', 'Numero massimo di posizioni raggiunto',
        `${positions.length} posizioni aperte su un massimo di ${maxPositions}. Verifica concentrazione e correlazione prima di operare.`,
        'positions', `${positions.length}/${maxPositions} posizioni`
      );
    }
    if (marginPct >= marginCritical) {
      add(
        'critical', 'margin-critical', 'Margine vicino al limite critico',
        `Margine utilizzato ${marginPct.toFixed(1)}%. Riduci l’esposizione per conservare buffer operativo.`,
        'risk', `${marginPct.toFixed(1)}% utilizzato`
      );
    } else if (marginPct >= marginWarning) {
      add(
        'warning', 'margin-warning', 'Margine utilizzato elevato',
        `Margine utilizzato ${marginPct.toFixed(1)}%: il buffer libero si sta riducendo.`,
        'risk', `${marginPct.toFixed(1)}% utilizzato`
      );
    }
  } else if (address && !sourceErrors.some(error => /account/i.test(error))) {
    add('warning', 'account-not-loaded', 'Account non disponibile', 'Collega un wallet Perps per verificare equity, margine ed esposizione reali.', 'system', 'wallet non collegato');
  }

  const pendingOrders = orders.filter(order => !order.isTrigger);
  if (pendingOrders.length) {
    add(
      'warning', 'pending-orders', `${pendingOrders.length} ordini pendenti`,
      'Sono presenti ordini limite non eseguiti. Verifica che siano ancora coerenti con il piano di rischio.',
      'execution', `${pendingOrders.length} da verificare`
    );
  }

  if (drawdown.maxPct >= number(limits.drawdownCriticalPct, 10)) {
    add(
      'critical', 'drawdown-critical', 'Drawdown sessione elevato',
      `Il drawdown massimo osservato è ${drawdown.maxPct.toFixed(2)}% (${usd(drawdown.maxUsd)}).`,
      'risk', 'sessione'
    );
  } else if (drawdown.maxPct >= number(limits.drawdownWarningPct, 5)) {
    add(
      'warning', 'drawdown-warning', 'Drawdown sessione da verificare',
      `Il drawdown massimo osservato è ${drawdown.maxPct.toFixed(2)}% (${usd(drawdown.maxUsd)}).`,
      'risk', 'sessione'
    );
  }

  const runningBots = bots.filter(bot => bot.status === 'running');
  for (const bot of bots) {
    if (bot.lastError) {
      add('critical', `bot-error-${bot.id}`, `Errore bot ${bot.name}`, bot.lastError, 'system', `${bot.coin} · errore tick`);
    }
    if (number(bot.tickErrors) > 0 && !bot.lastError) {
      add('warning', `bot-ticks-${bot.id}`, `Errori di aggiornamento: ${bot.name}`, `${bot.tickErrors} errori di tick registrati dal bot. Controlla feed e API.`, 'system', `${bot.coin} · ${bot.tickErrors} errori`);
    }
    if (bot.stale) {
      add('critical', `bot-stale-${bot.id}`, `Bot senza aggiornamenti: ${bot.name}`, `Il bot è running ma non aggiorna da ${bot.staleSeconds}s. Verifica connettività e processo.`, 'system', `${bot.coin} · watchdog`);
    }
    const maxDailyLoss = number(bot.maxDailyLossUsd, defaultMaxDailyLossUsd);
    if (number(bot.dailyPnl) <= -Math.abs(maxDailyLoss)) {
      add('critical', `bot-loss-${bot.id}`, `Limite perdita raggiunto: ${bot.name}`, `PnL giornaliero ${usd(bot.dailyPnl)} su un limite di -${usd(maxDailyLoss)}.`, 'risk', `${bot.coin} · bot fermato o da verificare`);
    }
  }

  if (runningBots.length && agent && !agent.approved) {
    add('critical', 'agent-not-approved', 'Auto-trading non autorizzato', 'Ci sono bot running ma l’agent wallet non risulta approvato per questo account.', 'system', 'agent');
  }

  if (marketStatus.isRunning === false) {
    add('critical', 'market-data-stopped', 'Market data fermo', 'Il servizio di market data non risulta attivo: sospendi nuove aperture.', 'system', 'market data');
  } else if (marketStatus.wsState === 'degraded') {
    // WARN-05 — distinto da `market-ws-disconnected`: quello è "è caduto adesso e
    // sto ritentando", questo è "è giù da abbastanza tempo da non aspettarsi che
    // si risolva da solo". Resta `warning` e non `critical` perché il fallback
    // REST è un percorso previsto e funzionante: i prezzi sono validi, solo meno
    // freschi. Un `critical` bloccherebbe la board per un degrado gestito.
    const downFor = number(marketStatus.wsDownSeconds) > 0
      ? ` da ~${Math.round(number(marketStatus.wsDownSeconds) / 60)} min`
      : '';
    add(
      'warning', 'market-ws-degraded', 'Feed live in guasto persistente',
      `Il WebSocket Hyperliquid non si ristabilisce${downFor}: i prezzi arrivano dal fallback REST (validi, meno freschi). Verifica rete e stato di Hyperliquid prima di operare in scalping.`,
      'system', 'fallback REST persistente'
    );
  } else if (marketStatus.ws === false) {
    add('warning', 'market-ws-disconnected', 'Feed live disconnesso', 'Il WebSocket Hyperliquid non è connesso. Il sistema può usare il polling REST come fallback.', 'system', 'fallback REST');
  } else if (marketStatus.wsFresh === false) {
    add('warning', 'market-ws-stale', 'Feed live non aggiornato', 'Il WebSocket è connesso ma non sta consegnando dati freschi. Verifica la latenza prima di eseguire.', 'system', 'feed stale');
  }

  return alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function summarizeRisk(alerts = [], { killSwitch = false } = {}) {
  const critical = alerts.filter(alert => alert.severity === 'critical').length;
  const warning = alerts.filter(alert => alert.severity === 'warning').length;
  const info = alerts.filter(alert => alert.severity === 'info').length;
  return {
    status: killSwitch || critical ? 'blocked' : (warning ? 'review' : 'ok'),
    critical,
    warning,
    info,
    actionable: critical + warning,
    total: alerts.length
  };
}

/** Finestra su cui si contano i fill recenti nella card EXECUTION STATUS. */
export const EXECUTION_FILL_WINDOW_MIN = 5;

/**
 * DERIVAZIONE DELLA CARD "EXECUTION STATUS" (DEBT-03)
 * ---------------------------------------------------
 * La card mostrava quattro valori scritti a mano nel markup: tre `—` che nessuno
 * ha mai scritto e un "Queue health: Stable" fisso. Questa funzione produce
 * l'unica versione derivata da dati veri, e — punto centrale della storia —
 * distingue **tre** stati per ogni campo, non due: `null` significa "non lo so"
 * (la fonte non ha risposto), un numero significa "l'ho misurato". Zero è una
 * misura, non un ripiego: `fills: 0` afferma "ho letto lo storico e in questi
 * cinque minuti non è stato eseguito nulla", cosa che non si può dire se la
 * lettura dei fill è fallita.
 *
 * `fillsAvailable`/`proposalsAvailable` sono passati dal chiamante perché
 * `[]` non distingue "nessun fill" da "non ho potuto leggere i fill": nella
 * rotta le due letture stanno in `try/catch` separati e il catch produce un
 * array vuoto.
 *
 * NON c'è nessun campo per il "reject rate": vedi il commento in
 * `_renderExecutionStatus()` in `public/perps.js`. Nessuna fonte in questo
 * sistema conta gli ordini rifiutati, e inventare un denominatore per farne una
 * percentuale sarebbe esattamente il difetto che DEBT-03 chiude.
 *
 * Pura per lo stesso motivo delle altre funzioni di questo file: la coda e il DB
 * sono singleton, e volerli in un test costringerebbe a toccare `data/perps.db`.
 */
export function deriveExecutionStatus({
  now = Date.now(),
  fills = [],
  fillsAvailable = true,
  pendingProposals = null,
  proposalsAvailable = true,
  queue = null,
  killSwitch = false,
  botsRunning = null,
  windowMin = EXECUTION_FILL_WINDOW_MIN
} = {}) {
  /**
   * Numero misurato, oppure `null` per "non lo so".
   *
   * ATTENZIONE, ed è il punto per cui questa funzione esiste: `Number(null)` vale
   * **0** e `Number.isFinite(0)` è **true**, quindi il controllo ovvio
   * (`isFinite(Number(x)) ? Number(x) : null`) trasforma proprio l'assenza di dato
   * nello zero che tutta la storia serve a evitare. Il caso nullo va escluso
   * prima, esplicitamente.
   */
  const measured = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const since = now - windowMin * 60 * 1000;
  const recentFills = fillsAvailable
    ? fills.filter(fill => Number(fill?.time) >= since).length
    : null;

  // Profondità della coda di esecuzione: `execQueue.depthSnapshot()` (WARN-02).
  // `max` è la coda del wallet PIÙ CARICO, non necessariamente quello richiesto:
  // è la stessa semantica di `perps_execqueue_depth`, e con più master address
  // configurati il numero mostrato può venire da un altro wallet. Si accetta
  // perché la coda è un vincolo di macchina (le firme sono serializzate per
  // wallet e condividono lo stesso processo), non un dato per-conto. `byKey` —
  // che conterrebbe gli indirizzi — non viene ripropagato di proposito.
  const depth = measured(queue?.max);
  const threshold = measured(queue?.threshold);
  const queueState = depth === null ? 'unknown'
    : (threshold !== null && depth > threshold) ? 'warning'
      : depth > 0 ? 'busy' : 'idle';

  // Lo stato della card è "com'è l'esecuzione adesso", non "il server è vivo":
  // con il kill-switch inserito nessuna apertura parte, e dirlo LIVE sarebbe
  // falso. Senza informazione sui bot non si afferma niente.
  const running = measured(botsRunning);
  const mode = killSwitch ? 'blocked'
    : running === null ? 'unknown'
      : running > 0 ? 'live' : 'idle';

  return {
    windowMin,
    fills: recentFills,
    pendingProposals: proposalsAvailable ? measured(pendingProposals) : null,
    queueDepth: depth,
    queueThreshold: threshold,
    queueState,
    mode
  };
}
