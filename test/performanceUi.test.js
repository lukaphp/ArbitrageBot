/**
 * Sezione Performance (public/perps.js, public/index.html) — ANA-01
 * ================================================================
 *
 * Restituisce dati che il bot raccoglie da sprint e non ha mai mostrato:
 * `risk_equity_history`, il `close_reason` delle posizioni chiuse (mai aggregato)
 * e soprattutto `ml_history` — la qualità del modello a ogni retraining, che ha
 * una route API e **zero consumer nella UI**.
 *
 * Tre cose vengono verificate con particolare attenzione:
 *
 *  1. **Nessun polling.** La sezione si carica all'apertura del tab e sul
 *     pulsante Aggiorna. La cockpit ha già quattro intervalli attivi; un quinto
 *     su un'aggregazione storica non ha nessuna ragione di esistere.
 *  2. **Stati vuoti.** Un bot senza trade chiusi e un progetto senza storico ML
 *     sono lo stato normale di un'installazione nuova, non un errore.
 *  3. **Timestamp.** `risk_equity_history.ts` è in secondi, `ml_history.ts` in
 *     millisecondi: senza normalizzazione una delle due curve finisce nel 1970.
 *
 * Come gli altri test di `public/*.js`: `node:vm` con DOM finto, e uno stub di
 * Lightweight Charts che registra i `setData` — la libreria vera è caricata da CDN
 * in pagina e qui non serve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');
const INDEX_HTML = path.join(HERE, '..', 'public', 'index.html');

function fakeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', dataset: {}, hidden: false,
    disabled: false, clientWidth: 640, clientHeight: 220, style: {}, listeners: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn({})); },
    change() { (this.listeners.change || []).forEach(fn => fn({ target: this })); },
    querySelector: () => null,
    hasClass: (c) => classes.has(c)
  };
}

const IDS = [
  'perfUpdatedAt', 'perfRefresh', 'perfNotice', 'perfEquityChart', 'perfEquityEmpty',
  'perfEquityRange', 'perfCloseReasons', 'perfMlCoin', 'perfMlChart', 'perfMlEmpty', 'perfBotsBody',
  'cockpit-panel-dashboard', 'cockpit-panel-execution', 'cockpit-panel-positions',
  'cockpit-panel-performance', 'cockpit-panel-risk', 'cockpit-panel-system',
  'cockpitChart', 'walletStatus', 'view-perps'
];

/** Dati di esempio nella forma del contratto concordato con Bruno. */
const PERFORMANCE = {
  bots: [
    { botId: 'b1', name: 'SOL scalper', trades: 24, winRate: 0.625, totalPnl: 412.5, expectancy: 17.19, avgWin: 48.2, avgLoss: -32.1, closeReasons: { tp: 15, sl: 7, manual: 2 } },
    { botId: 'b2', name: 'BTC trend', trades: 6, winRate: 0.333, totalPnl: -88.4, expectancy: -14.73, avgWin: 62, avgLoss: -71.5, closeReasons: { sl: 4, dca: 2 } }
  ],
  // `risk_equity_history` restituisce `time` in SECONDI.
  equityHistory: [
    { time: 1_769_990_000, value: 1000 },
    { time: 1_769_993_600, value: 1120 },
    { time: 1_769_997_200, value: 1080 }
  ],
  // `ml_history` restituisce `ts` in MILLISECONDI.
  mlHistory: [
    { ts: 1_769_900_000_000, coin: 'SOL', interval: '15m', accuracy: 0.58, baseline: 0.52, edge: 0.06, auc: 0.61, samples: 900 },
    { ts: 1_769_986_400_000, coin: 'SOL', interval: '15m', accuracy: 0.55, baseline: 0.52, edge: 0.03, auc: 0.57, samples: 940 },
    { ts: 1_769_986_400_000, coin: 'BTC', interval: '1h', accuracy: 0.51, baseline: 0.53, edge: -0.02, auc: 0.49, samples: 620 }
  ]
};

/** Stub minimale di Lightweight Charts: registra le serie e i dati ricevuti. */
function chartStub(record) {
  return {
    createChart: () => ({
      addAreaSeries: () => {
        const series = { type: 'area', data: [] };
        record.series.push(series);
        return { setData: (d) => { series.data = d; } };
      },
      addLineSeries: (opts) => {
        const series = { type: 'line', color: opts?.color, data: [] };
        record.series.push(series);
        return { setData: (d) => { series.data = d; } };
      },
      timeScale: () => ({ fitContent: () => { record.fits++; } }),
      resize: () => {}
    }),
    CrosshairMode: { Normal: 0 }
  };
}

function loadPerfUi({ data = PERFORMANCE, fails = false, withCharts = true } = {}) {
  const elements = Object.fromEntries(IDS.map(id => [id, fakeElement(id)]));
  const requests = [];
  const record = { series: [], fits: 0 };

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
      if (url.startsWith('/api/perps/performance')) {
        if (fails) return { ok: false, status: 500, json: async () => ({ success: false, error: 'aggregazioni non disponibili' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    },
    alert: () => {}, confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  if (withCharts) sandbox.window.LightweightCharts = chartStub(record);
  sandbox.LightweightCharts = sandbox.window.LightweightCharts;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  return {
    perps: sandbox.window.perps, elements, requests, record,
    perfCalls: () => requests.filter(r => r.url.startsWith('/api/perps/performance')).length
  };
}

test('la tab Performance esiste e apre il pannello, gli altri restano nascosti', () => {
  const ui = loadPerfUi();
  ui.perps.switchCockpitTab('performance');
  assert.equal(ui.perps.cockpitTab, 'performance');
  assert.equal(ui.elements['cockpit-panel-performance'].hidden, false);
  assert.equal(ui.elements['cockpit-panel-dashboard'].hidden, true);
  assert.equal(ui.elements['cockpit-panel-risk'].hidden, true);
});

test('i dati si caricano all\'apertura della sezione, non prima', async () => {
  const ui = loadPerfUi();
  assert.equal(ui.perfCalls(), 0, 'nessuna chiamata al caricamento della pagina');
  ui.perps.switchCockpitTab('performance');
  await new Promise(r => setImmediate(r));
  assert.equal(ui.perfCalls(), 1);
});

test('curva equity: serie ordinata, in secondi, con l\'intervallo dichiarato', async () => {
  const ui = loadPerfUi();
  await ui.perps.loadPerformance();

  const area = ui.record.series.find(s => s.type === 'area' && s.data.length === 3);
  assert.ok(area, 'la curva equity storica è stata disegnata');
  // `Array.from` riporta i dati nel realm del test: gli oggetti creati dentro il
  // contesto vm hanno un altro prototype e deepStrictEqual li rifiuterebbe.
  assert.deepEqual(Array.from(area.data, p => p.value), [1000, 1120, 1080]);
  assert.deepEqual(Array.from(area.data, p => p.time), [1_769_990_000, 1_769_993_600, 1_769_997_200]);
  assert.equal(ui.elements.perfEquityEmpty.hidden, true);
  assert.match(ui.elements.perfEquityRange.textContent, /3 campioni/);
});

test('QUALITÀ ML: accuracy e baseline nel tempo, con i ms convertiti in secondi', async () => {
  const ui = loadPerfUi();
  await ui.perps.loadPerformance();

  const lines = ui.record.series.filter(s => s.type === 'line');
  assert.equal(lines.length, 2, 'due serie: accuracy e baseline');
  const [accuracy, baseline] = lines;
  // Il coin di default è il primo in ordine alfabetico presente nello storico: BTC.
  assert.equal(ui.perps.perfMlCoin, 'BTC');
  const plain = (series) => Array.from(series.data, p => ({ time: p.time, value: p.value }));
  assert.deepEqual(plain(accuracy), [{ time: 1_769_986_400, value: 0.51 }]);
  assert.deepEqual(plain(baseline), [{ time: 1_769_986_400, value: 0.53 }]);
  // 1_769_986_400_000 ms → 1_769_986_400 s: se restasse in ms il punto finirebbe
  // nel 58 000 d.C. e la curva sarebbe illeggibile.
  assert.ok(accuracy.data[0].time < 2e10);
  assert.equal(ui.elements.perfMlEmpty.hidden, true);
});

test('il selettore del mercato ML cambia la serie mostrata senza rifare la chiamata', async () => {
  const ui = loadPerfUi();
  await ui.perps.loadPerformance();
  assert.match(ui.elements.perfMlCoin.innerHTML, /value="BTC"/);
  assert.match(ui.elements.perfMlCoin.innerHTML, /value="SOL"/);

  const before = ui.perfCalls();
  ui.perps.perfMlCoin = 'SOL';
  ui.perps._renderMlQuality();

  const lines = ui.record.series.filter(s => s.type === 'line');
  assert.deepEqual(Array.from(lines[0].data, p => p.value), [0.58, 0.55], 'due retraining su SOL');
  assert.equal(ui.perfCalls(), before, 'cambiare mercato non è una nuova richiesta al server');
});

test('breakdown dei motivi di chiusura: somma su tutti i bot, con le percentuali', async () => {
  const ui = loadPerfUi();
  await ui.perps.loadPerformance();

  const html = ui.elements.perfCloseReasons.innerHTML;
  // tp 15, sl 7+4=11, manual 2, dca 2 → totale 30
  assert.match(html, /Take profit<\/span><strong>15 · 50%/);
  assert.match(html, /Stop loss<\/span><strong>11 · 37%/);
  assert.match(html, /Chiusura manuale<\/span><strong>2 · 7%/);
  assert.match(html, /DCA<\/span><strong>2 · 7%/);
});

test('un motivo di chiusura sconosciuto viene mostrato, non scartato', async () => {
  const ui = loadPerfUi({
    data: { ...PERFORMANCE, bots: [{ botId: 'b1', name: 'X', trades: 3, closeReasons: { funding_flip: 3 } }] }
  });
  await ui.perps.loadPerformance();
  // Meglio un'etichetta grezza che nascondere trade veri perché il backend ha
  // aggiunto un motivo che la mappa della UI non conosce.
  assert.match(ui.elements.perfCloseReasons.innerHTML, /funding_flip<\/span><strong>3 · 100%/);
});

test('confronto per bot: PnL, win rate ed expectancy con il segno e la classe giusta', async () => {
  const ui = loadPerfUi();
  await ui.perps.loadPerformance();

  const html = ui.elements.perfBotsBody.innerHTML;
  assert.match(html, /SOL scalper/);
  assert.match(html, /62\.5%/, 'win rate espresso in percentuale');
  assert.match(html, /class="cockpit-positive">\+\$412\.5</);
  assert.match(html, /class="cockpit-positive">\+\$17\.19</, 'expectancy positiva evidenziata');
  assert.match(html, /BTC trend/);
  assert.match(html, /class="cockpit-negative">-\$88\.4</);
  assert.match(html, /class="cockpit-negative">-\$14\.73</, 'expectancy negativa evidenziata');
});

test('STATI VUOTI: installazione nuova senza trade chiusi né storico ML', async () => {
  const ui = loadPerfUi({ data: { bots: [], equityHistory: [], mlHistory: [] } });
  await ui.perps.loadPerformance();

  assert.match(ui.elements.perfBotsBody.innerHTML, /Nessun bot con trade chiusi/);
  assert.match(ui.elements.perfCloseReasons.innerHTML, /Nessun trade chiuso ancora registrato/);
  assert.equal(ui.elements.perfEquityEmpty.hidden, false, 'lo stato vuoto della curva è visibile');
  assert.equal(ui.elements.perfMlEmpty.hidden, false, 'lo stato vuoto della qualità ML è visibile');
  assert.equal(ui.elements.perfMlCoin.disabled, true);
  assert.equal(ui.elements.perfNotice.hidden, true, 'nessun trade non è un errore');
});

test('un bot con zero trade chiusi resta in tabella con i campi a "—"', async () => {
  const ui = loadPerfUi({
    data: { bots: [{ botId: 'b3', name: 'Appena creato', trades: 0, winRate: null, totalPnl: null, expectancy: null, closeReasons: {} }], equityHistory: [], mlHistory: [] }
  });
  await ui.perps.loadPerformance();
  const html = ui.elements.perfBotsBody.innerHTML;
  assert.match(html, /Appena creato/, 'il bot non viene nascosto');
  assert.match(html, /<td>0<\/td>/);
  assert.match(html, /—/, 'i valori non calcolabili sono "—", non zeri inventati');
});

test('errore del backend: lo dichiara e non inventa numeri', async () => {
  const ui = loadPerfUi({ fails: true });
  await ui.perps.loadPerformance();

  assert.equal(ui.perps.perfData, null);
  assert.equal(ui.elements.perfNotice.hidden, false);
  assert.match(ui.elements.perfNotice.textContent, /Dati storici non disponibili: aggregazioni non disponibili/);
  assert.match(ui.elements.perfBotsBody.innerHTML, /Dati non disponibili/);
});

test('senza Lightweight Charts la sezione non si rompe: tabelle e stati vuoti restano', async () => {
  const ui = loadPerfUi({ withCharts: false });
  await ui.perps.loadPerformance();
  assert.equal(ui.record.series.length, 0);
  assert.match(ui.elements.perfBotsBody.innerHTML, /SOL scalper/);
  assert.match(ui.elements.perfCloseReasons.innerHTML, /Take profit/);
});

test('il pulsante Aggiorna rifà la chiamata; niente timer la richiama da sola', async () => {
  const ui = loadPerfUi();
  await ui.perps.loadPerformance();
  assert.equal(ui.perfCalls(), 1);
  await ui.perps.loadPerformance(true);
  assert.equal(ui.perfCalls(), 2);

  const src = fs.readFileSync(PERPS_JS, 'utf8');
  assert.equal(/setInterval\([^)]*loadPerformance/.test(src), false, 'nessun intervallo sulla performance');
  assert.equal((src.match(/setInterval\(/g) || []).length, 4, 'ANA-01 non aggiunge intervalli');
});

test('index.html: tab e pannello Performance con tutti gli id che perps.js cerca', () => {
  const markup = fs.readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(markup, /id="cockpit-tab-performance"[^>]*aria-controls="cockpit-panel-performance"/);
  assert.match(markup, /perps\.switchCockpitTab\('performance'\)/);
  assert.match(markup, /id="cockpit-panel-performance"[^>]*hidden/);
  for (const id of ['perfUpdatedAt', 'perfRefresh', 'perfNotice', 'perfEquityChart', 'perfEquityEmpty',
    'perfEquityRange', 'perfCloseReasons', 'perfMlCoin', 'perfMlChart', 'perfMlEmpty', 'perfBotsBody']) {
    assert.match(markup, new RegExp(`id="${id}"`), `manca id="${id}" in index.html`);
  }
  // Nessuna libreria nuova: si riusa l'unico <script> Lightweight Charts già in pagina.
  assert.equal((markup.match(/<script[^>]*lightweight-charts/g) || []).length, 1);
});
