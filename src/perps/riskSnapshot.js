/**
 * DERIVAZIONE STATO RISCHIO (Perps)
 * =================================
 *
 * Funzioni pure per trasformare gli snapshot account/sistema in alert
 * deterministici consumabili dalla UI cockpit.
 */

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

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
