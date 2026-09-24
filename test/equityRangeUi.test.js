/**
 * Preset 1G/7G/30G/90G/1A/Tutto collegati al server (BUG-EQUITYRANGE-01, lato UI)
 * ==============================================================================
 *
 * I bottoni sopra "Portfolio Performance" (dashboard) e "Performance" (tab) non
 * hanno mai avuto effetto visibile. Il filtro client-side
 * (`_filterEquityPointsByRange`, corretto, qui non toccato) lavorava su una
 * curva che il server aveva già troncato alle ultime righe: restringere si
 * poteva, ALLARGARE no, perché i punti più vecchi non erano mai arrivati al
 * browser. Bruno ha aggiunto `?range=` alle due rotte; questi casi verificano
 * la metà mancante, cioè che la UI il parametro lo chieda davvero.
 *
 * Il finto server qui sotto riproduce proprio quella asimmetria: **senza**
 * `range` risponde con gli ultimi tre campioni (il comportamento che generava
 * il bug), **con** `range` con la finestra vera. Un test che rispondesse sempre
 * con tutto lo storico passerebbe anche sul codice di prima.
 *
 * Tre cose sono verificate con particolare attenzione:
 *  1. la query effettivamente chiamata contiene `range`, e resta valida quando
 *     c'è anche `address` (comporre `?` e `&` a mano è il punto in cui ci si
 *     sbaglia);
 *  2. cambiare finestra fa ripartire la RICHIESTA, non solo un re-filtro dei
 *     dati già in cache — la differenza si vede solo allargando;
 *  3. il percorso di errore resta quello di prima: la rete che cade dichiara i
 *     dati non disponibili e non blocca il pannello.
 *
 * Come gli altri test di `public/*.js`: `node:vm` con DOM finto e uno stub di
 * Lightweight Charts, zero dipendenze aggiunte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EQUITY_RANGE_SECONDS } from '../src/perps/riskSnapshot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');
const INDEX_HTML = path.join(HERE, '..', 'public', 'index.html');

const DAY = 86400;
const NOW_SEC = 1_770_000_000;
/** 400 campioni giornalieri: più di un anno, così ogni preset è distinguibile. */
const FULL_HISTORY = Array.from({ length: 400 }, (_, i) => ({
  time: NOW_SEC - (399 - i) * DAY,
  value: 1000 + i
}));

/** Il server di Bruno, ridotto all'osso: la finestra dipende da `range`. */
function serveEquity(url) {
  const match = /[?&]range=([^&]*)/.exec(url);
  const key = match ? decodeURIComponent(match[1]).trim().toLowerCase() : null;
  // Senza `range` (o con un codice sconosciuto) la rotta resta com'era: ultime
  // righe, qualunque bottone sia acceso. È la condizione che il bug produceva.
  if (!key) return FULL_HISTORY.slice(-3);
  if (key === 'all') return FULL_HISTORY;
  const seconds = EQUITY_RANGE_SECONDS[key];
  if (!seconds) return FULL_HISTORY.slice(-3);
  return FULL_HISTORY.filter(p => p.time >= NOW_SEC - seconds);
}

const SNAPSHOT_BASE = {
  generatedAt: NOW_SEC * 1000,
  account: { equity: 1500, totalMarginUsed: 300, positions: [] },
  limits: { maxTotalExposureUsd: 5000 },
  orders: { open: 0, pending: 0, trigger: 0 },
  bots: { total: 1, running: 1, errors: 0, stale: 0 },
  system: { wsConnected: true, wsFresh: true },
  killSwitch: false,
  summary: { status: 'ok', actionable: 0 },
  alerts: [],
  execution: { windowMin: 5, fills: 0, pendingProposals: 0, queueDepth: 0, queueThreshold: 10, queueState: 'idle', mode: 'live' },
  sourceErrors: []
};

function fakeElement(id, children = []) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', className: '', title: '', value: '', dataset: {},
    hidden: false, disabled: false, clientWidth: 640, clientHeight: 220, style: {}, listeners: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn({})); },
    querySelector: () => null,
    querySelectorAll: () => children,
    hasClass: (c) => classes.has(c)
  };
}

/** Un bottone di preset, con `dataset.range` come nel markup. */
function rangeButton(range) {
  const btn = fakeElement(`btn-${range}`);
  btn.dataset.range = range;
  return btn;
}

const IDS = [
  'cockpitChart', 'dashboardEquityNote', 'walletStatus', 'view-perps',
  'cockpitExecMode', 'cockpitFills', 'cockpitFillsLabel', 'cockpitPending',
  'cockpitQueueDepth', 'cockpitQueueHealth', 'cockpitAlerts', 'cockpitRiskAlerts',
  'cockpitAttentionCount', 'cockpitHeaderAlertBadge', 'cockpitRiskBadge', 'cockpitRiskLiveCount',
  'cockpitPositionsSummary', 'cockpitOpenPositionsCount', 'cockpitHealthSummary', 'cockpitHealthFeed',
  'cockpitHealthFeedDot', 'cockpitHealthBots', 'cockpitHealthBotsDot', 'cockpitHealthOrders',
  'cockpitHealthOrdersDot', 'cockpitHealthApi', 'cockpitHealthApiDot', 'cockpitEquity',
  'cockpitHeaderEquity', 'cockpitEquityEur', 'cockpitHeaderEquityEur', 'cockpitNetPnl',
  'cockpitNetPnlEur', 'cockpitUpdatedAt', 'cockpitMarginUsed', 'cockpitMarginFree', 'cockpitMarginBar',
  'cockpitDrawdown', 'cockpitRiskUpdated', 'cockpitRiskStatus', 'cockpitRiskChecks', 'cockpitFxNote',
  'cockpitRiskEquity', 'cockpitRiskMargin', 'cockpitRiskExposure', 'cockpitMarginLimit',
  'cockpitRiskOpenPositions', 'cockpitRiskDrawdown', 'cockpitDrawdownStatus', 'cockpitRiskFeed',
  'cockpitRealized', 'cockpitUnrealized', 'killswitchBtn', 'killswitchState',
  'perfUpdatedAt', 'perfRefresh', 'perfNotice', 'perfEquityChart', 'perfEquityEmpty',
  'perfEquityRange', 'perfCloseReasons', 'perfMlCoin', 'perfMlChart', 'perfMlEmpty', 'perfBotsBody',
  'cockpit-panel-dashboard', 'cockpit-panel-execution', 'cockpit-panel-positions',
  'cockpit-panel-performance', 'cockpit-panel-risk', 'cockpit-panel-system'
];

const PRESETS = ['1d', '7d', '30d', '90d', '365d', 'all'];

function chartStub(record) {
  const series = () => {
    const s = { data: [], setCount: 0 };
    record.series.push(s);
    return { setData: (d) => { s.data = d; s.setCount++; } };
  };
  return {
    createChart: () => ({
      addAreaSeries: series, addLineSeries: series,
      // `applyOptions` sul timeScale è nell'API reale di Lightweight Charts
      // (usato da `_equityChartTimeVisible` per tenere l'asse coerente col
      // range): lo stub deve rispecchiarla, non solo `fitContent`.
      timeScale: () => ({ fitContent: () => {}, applyOptions: () => {} }), resize: () => {}
    }),
    CrosshairMode: { Normal: 0 }
  };
}

/**
 * `manual: true` trattiene le risposte finché il test non chiama `release()`:
 * serve a mettersi nell'attimo fra il click e l'arrivo dei dati, che è dove
 * vive il caso "l'utente cambia finestra mentre una richiesta è in volo".
 */
function loadUi({ manual = false, riskFails = false, perfFails = false } = {}) {
  const elements = Object.fromEntries(IDS.map(id => [id, fakeElement(id)]));
  elements.dashboardEquityRanges = fakeElement('dashboardEquityRanges', PRESETS.map(rangeButton));
  elements.perfEquityRanges = fakeElement('perfEquityRanges', PRESETS.map(rangeButton));
  const requests = [];
  const waiting = [];
  const record = { series: [] };

  const respond = (url) => {
    if (url.startsWith('/api/perps/risk')) {
      if (riskFails) return { ok: false, status: 503, json: async () => ({ success: false, error: 'snapshot non disponibile' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: { ...SNAPSHOT_BASE, equityHistory: serveEquity(url) } }) };
    }
    if (url.startsWith('/api/perps/performance')) {
      if (perfFails) return { ok: false, status: 500, json: async () => ({ success: false, error: 'aggregazioni non disponibili' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: { bots: [], mlHistory: [], equityHistory: serveEquity(url) } }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
  };

  const sandbox = {
    console, BigInt, Map, Set, Date, JSON, Math, Number, String, Array, Object, Error, Promise,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '🤖 ArbitrageBot Perps',
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => ({ tagName: String(tag).toUpperCase(), textContent: '', className: '', children: [], appendChild(c) { this.children.push(c); return c; }, get outerHTML() { return ''; } }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method || 'GET' });
      if (!manual) return respond(url);
      return new Promise((resolve) => waiting.push(() => resolve(respond(url))));
    },
    alert: () => {}, confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    location: { hash: '' },
    history: { replaceState: () => {} }
  };
  sandbox.window.LightweightCharts = chartStub(record);
  sandbox.LightweightCharts = sandbox.window.LightweightCharts;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const urls = (prefix) => requests.filter(r => r.url.startsWith(prefix)).map(r => r.url);
  return {
    perps: sandbox.window.perps, elements, requests, record,
    riskUrls: () => urls('/api/perps/risk'),
    perfUrls: () => urls('/api/perps/performance'),
    lastRisk: () => urls('/api/perps/risk').at(-1),
    lastPerf: () => urls('/api/perps/performance').at(-1),
    /** Sblocca le risposte trattenute e lascia girare le microtask. */
    release: async () => {
      while (waiting.length) waiting.shift()();
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
    },
    settle: () => new Promise(r => setImmediate(r)),
    dashboardData: () => Array.from(record.series[0]?.data || [], p => ({ time: p.time, value: p.value }))
  };
}

// --------------------------------------------------- dashboard: la query

test('refreshRiskSnapshot chiede `range` anche senza wallet connesso (default: all)', async () => {
  const ui = loadUi();
  await ui.perps.refreshRiskSnapshot();
  assert.equal(ui.riskUrls().length, 1);
  assert.equal(ui.lastRisk(), '/api/perps/risk?range=all');
});

test('con wallet connesso la query porta address E range, con i separatori giusti', async () => {
  const ui = loadUi();
  // `connected` e `address` sono getter (su `isConnected` e `walletAddress`):
  // lo stato del wallet si imposta alla fonte, assegnarli direttamente lancia.
  ui.perps.isConnected = true;
  ui.perps.walletAddress = '0xAbCd000000000000000000000000000000001234';
  ui.perps.dashboardEquityRange = '30d';
  await ui.perps.refreshRiskSnapshot();
  const url = ui.lastRisk();
  // Un solo '?', address ancora codificato, range presente: è il punto in cui
  // una concatenazione sbagliata produrrebbe `?address=...?range=...`.
  assert.equal(url.split('?').length, 2, `query malformata: ${url}`);
  assert.match(url, /^\/api\/perps\/risk\?address=0xAbCd000000000000000000000000000000001234&range=30d$/);
});

test('un range non standard viene codificato, non concatenato grezzo', async () => {
  const ui = loadUi();
  ui.perps.dashboardEquityRange = '7d&admin=1';
  await ui.perps.refreshRiskSnapshot();
  assert.equal(ui.lastRisk().includes('&admin=1'), false, 'il valore deve restare un solo parametro');
  assert.match(ui.lastRisk(), /range=7d%26admin%3D1$/);
});

// ------------------------------------- dashboard: il bottone ricarica davvero

test('cambiare preset rifà la richiesta con il nuovo range', async () => {
  const ui = loadUi();
  ui.perps._initCockpitDashboard();
  await ui.perps.refreshRiskSnapshot();
  const before = ui.riskUrls().length;

  ui.perps.setDashboardEquityRange('7d');
  await ui.settle();

  assert.equal(ui.riskUrls().length, before + 1, 'il click deve parlare col server, non solo rifiltrare');
  assert.match(ui.lastRisk(), /range=7d/);
  assert.equal(ui.perps.dashboardEquityRange, '7d');
});

test('ALLARGARE la finestra riporta i punti vecchi: è il bug che questo fix chiude', async () => {
  const ui = loadUi();
  ui.perps._initCockpitDashboard();

  ui.perps.setDashboardEquityRange('1d');
  await ui.settle();
  const narrow = ui.dashboardData();
  assert.ok(narrow.length <= 2 && narrow.length >= 1, `1G deve mostrare pochi punti, non ${narrow.length}`);

  ui.perps.setDashboardEquityRange('all');
  await ui.settle();
  const wide = ui.dashboardData();
  // Prima del fix la curva restava quella stretta: i 400 campioni non erano mai
  // stati scaricati, e il filtro locale su 'all' non poteva inventarli.
  assert.equal(wide.length, FULL_HISTORY.length, 'tutto lo storico deve tornare a schermo');
  assert.equal(wide[0].time, FULL_HISTORY[0].time);
});

test('il preset stretto riduce la curva subito, prima che la risposta arrivi', async () => {
  const ui = loadUi({ manual: true });
  ui.perps._initCockpitDashboard();
  ui.perps.setDashboardEquityRange('all');
  await ui.release();
  assert.equal(ui.dashboardData().length, FULL_HISTORY.length, 'precondizione: storico intero a schermo');

  ui.perps.setDashboardEquityRange('7d');
  // Nessun await: siamo nell'attimo fra il click e la risposta.
  const optimistic = ui.dashboardData();
  assert.ok(optimistic.length <= 8, `il filtro locale deve dare riscontro immediato, non ${optimistic.length} punti`);
  await ui.release();
  assert.equal(ui.dashboardData().length, 8, '7 giorni di campioni giornalieri + quello di oggi');
});

test('cambiare preset mentre una richiesta è in volo non perde il secondo click', async () => {
  const ui = loadUi({ manual: true });
  ui.perps._initCockpitDashboard();

  ui.perps.setDashboardEquityRange('7d');   // parte la richiesta a 7d
  ui.perps.setDashboardEquityRange('90d');  // l'utente cambia idea subito
  assert.equal(ui.riskUrls().length, 1, 'la seconda richiesta non può partire in parallelo');

  await ui.release();
  // Senza il recupero, a schermo resterebbe la finestra a 7 giorni sotto un
  // bottone acceso su 90G: il pannello direbbe una cosa e ne mostrerebbe un'altra.
  assert.equal(ui.riskUrls().length, 2, 'la finestra chiesta per ultima va richiesta davvero');
  await ui.release(); // la seconda risposta, quella con la finestra giusta
  assert.match(ui.lastRisk(), /range=90d/);
  assert.equal(ui.dashboardData().length, 91);
});

test('un refresh concorrente con lo STESSO range resta scartato (nessun raddoppio di traffico)', async () => {
  const ui = loadUi({ manual: true });
  ui.perps.refreshRiskSnapshot();
  ui.perps.refreshRiskSnapshot();
  ui.perps.refreshRiskSnapshot();
  assert.equal(ui.riskUrls().length, 1);
  await ui.release();
  assert.equal(ui.riskUrls().length, 1, 'polling ed eventi socket non devono accodare chiamate');
});

test('se il fetch con range fallisce, il pannello lo dichiara e resta utilizzabile', async () => {
  const ui = loadUi({ riskFails: true });
  ui.perps._initCockpitDashboard();
  await ui.perps.setDashboardEquityRange('30d');
  await ui.settle();

  assert.match(ui.elements.cockpitRiskUpdated.textContent, /Aggiornamento fallito/);
  assert.equal(ui.elements.cockpitRiskStatus.textContent, 'DATI NON DISPONIBILI');
  // Il flag di "richiesta in volo" deve essere stato liberato anche sull'errore,
  // altrimenti il grafico resterebbe muto per il resto della sessione.
  assert.equal(ui.perps.riskRefreshInFlight, false);
  const before = ui.riskUrls().length;
  ui.perps.setDashboardEquityRange('7d');
  await ui.settle();
  assert.equal(ui.riskUrls().length, before + 1, 'dopo un errore i bottoni devono funzionare ancora');
});

// ------------------------------------------------------ tab Performance

test('loadPerformance chiede la finestra corrente insieme a limit', async () => {
  const ui = loadUi();
  await ui.perps.loadPerformance();
  assert.match(ui.lastPerf(), /^\/api\/perps\/performance\?limit=5000&range=all$/);
});

test('setPerfEquityRange fa ripartire il caricamento, non solo il re-filtro', async () => {
  const ui = loadUi();
  await ui.perps.loadPerformance();
  const before = ui.perfUrls().length;

  ui.perps.setPerfEquityRange('30d');
  await ui.settle();

  assert.equal(ui.perfUrls().length, before + 1, '_renderPerformanceEquity() da solo rifiltra dati già troncati');
  assert.match(ui.lastPerf(), /range=30d/);
  assert.match(ui.elements.perfEquityRange.textContent, /31 campioni · ultimi 30gg/);
});

test('Performance: da 1G a Tutto la curva si riallarga (stesso bug, altra card)', async () => {
  const ui = loadUi();
  ui.perps.setPerfEquityRange('1d');
  await ui.settle();
  assert.ok(ui.perps.perfData.equityHistory.length <= 2);

  ui.perps.setPerfEquityRange('all');
  await ui.settle();
  assert.equal(ui.perps.perfData.equityHistory.length, FULL_HISTORY.length);
  assert.match(ui.elements.perfEquityRange.textContent, /400 campioni · tutto lo storico/);
});

test('Performance: il preset scelto durante un caricamento in corso non si perde', async () => {
  const ui = loadUi({ manual: true });
  ui.perps.setPerfEquityRange('7d');
  ui.perps.setPerfEquityRange('365d');
  assert.equal(ui.perfUrls().length, 1);

  await ui.release();
  await ui.release();
  assert.equal(ui.perfUrls().length, 2);
  assert.match(ui.lastPerf(), /range=365d/);
  assert.equal(ui.perps.perfData.equityHistory.length, 366);
});

test('Performance: un errore di rete resta raccontato come prima', async () => {
  const ui = loadUi({ perfFails: true });
  await ui.perps.setPerfEquityRange('90d');
  await ui.settle();
  assert.match(ui.elements.perfNotice.textContent, /Dati storici non disponibili/);
  assert.equal(ui.elements.perfNotice.hidden, false);
  assert.equal(ui.perps.perfLoading, false, 'il flag va liberato anche sull\'errore');
});

// ------------------------------------------------------------- contratto

test('i codici dei bottoni in index.html sono quelli che il server sa risolvere', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const codes = [...html.matchAll(/class="cockpit-range-btn[^"]*" data-range="([^"]+)"/g)].map(m => m[1]);
  assert.ok(codes.length >= 12, `preset non individuati nel markup (trovati ${codes.length})`);
  const accepted = new Set([...Object.keys(EQUITY_RANGE_SECONDS), 'all']);
  for (const code of new Set(codes)) {
    // Un codice che il server non riconosce non dà errore: restituisce la
    // finestra di default, cioè esattamente il bug silenzioso di partenza.
    assert.ok(accepted.has(code), `data-range="${code}" non è risolto da resolveEquityRange`);
  }
});

test('i preset passano dal bottone alla query senza traduzioni intermedie', async () => {
  for (const code of PRESETS) {
    const ui = loadUi();
    ui.perps.setDashboardEquityRange(code);
    await ui.settle();
    assert.match(ui.lastRisk(), new RegExp(`range=${code}$`), `dashboard: ${code}`);

    ui.perps.setPerfEquityRange(code);
    await ui.settle();
    assert.match(ui.lastPerf(), new RegExp(`range=${code}$`), `performance: ${code}`);
  }
});

test('il filtro client-side è rimasto intatto: su dati già finestrati non toglie nulla', () => {
  const ui = loadUi();
  const week = FULL_HISTORY.filter(p => p.time >= NOW_SEC - 7 * DAY);
  const filtered = ui.perps._filterEquityPointsByRange(week, '7d');
  assert.equal(filtered.length, week.length, 'sul risultato del server deve essere un passaggio a vuoto');
  // E continua a fare il suo mestiere quando i dati sono più larghi della finestra.
  assert.equal(ui.perps._filterEquityPointsByRange(FULL_HISTORY, '7d').length, 8);
});
