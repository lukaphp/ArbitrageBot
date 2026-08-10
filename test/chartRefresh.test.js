/**
 * Grafico posizione (public/perps.js) — refresh periodico e chiusura del modale
 * =============================================================================
 *
 * Segnalazione utente: apertura di un grafico dalle posizioni → toast di errore,
 * e il grafico "cambia continuamente" da solo mentre è aperto. Due bug distinti,
 * entrambi nel ciclo di refresh automatico di openChart()/_renderChart():
 *
 *  1. Il modale può chiudersi anche da click sullo sfondo o Escape (gestiti in
 *     modo generico da shell.js), che NON passa da closeChart(). Prima di questo
 *     fix, this.chartTimer restava vivo per sempre: continuava a interrogare
 *     /api/perps/candles ogni 6s a modale nascosto, e qualunque riapertura
 *     successiva poteva correre in parallelo con quel timer fantasma.
 *  2. candleSeries.setData() sostituisce tutto il dataset e, di suo, azzera lo
 *     zoom/pan impostato dall'utente: ogni tick di refresh (ogni 6s) faceva
 *     "saltare" il grafico da solo, anche senza alcuna interazione.
 *
 * Come per gli altri test di public/*.js: caricamento in node:vm con DOM finto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');

function fakeElement(id, initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    clientWidth: 640, clientHeight: 420,
    addEventListener: () => {},
    onclick: null
  };
}

/** Chart finto: registra le chiamate che contano per i due fix. */
function makeFakeChart(calls) {
  const range = { from: 10, to: 20 }; // sentinella: identità confrontabile
  return {
    addCandlestickSeries: () => ({
      setData: () => calls.setData.push('candle'),
      setMarkers: () => {},
      createPriceLine: () => ({}),
      removePriceLine: () => {}
    }),
    addLineSeries: () => ({ setData: () => calls.setData.push('ema') }),
    timeScale: () => ({
      getVisibleLogicalRange: () => range,
      setVisibleLogicalRange: (r) => calls.setVisibleLogicalRange.push(r),
      fitContent: () => calls.fitContent++
    }),
    resize: () => {},
    remove: () => calls.remove++,
    _range: range
  };
}

function loadChartUi() {
  const calls = { setData: [], setVisibleLogicalRange: [], fitContent: 0, remove: 0, renderChart: 0 };
  const fakeChart = makeFakeChart(calls);

  const elements = {
    chartModal: fakeElement('chartModal', ['show']),
    chartTitle: fakeElement('chartTitle'),
    chartContainer: fakeElement('chartContainer'),
    chartLegend: fakeElement('chartLegend')
  };

  let intervalFn = null;
  const clearedIntervals = [];

  const candles = [
    { t: 1000000, o: '10', h: '11', l: '9', c: '10.5' },
    { t: 1006000, o: '10.5', h: '12', l: '10', c: '11.8' }
  ];

  const lwCharts = {
    createChart: () => fakeChart,
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2 }
  };
  const sandbox = {
    console, BigInt,
    // perps.js usa sia `window.LightweightCharts` (il controllo in openChart)
    // sia il globale bare `LightweightCharts` (dentro _renderChart) — nel
    // browser sono la stessa cosa perché window È il global object, qui no.
    LightweightCharts: lwCharts,
    window: { LightweightCharts: lwCharts },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '', getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: (sel) => sel === '.chart-int' ? [
        { dataset: { int: '5m', days: '1' }, classList: { contains: () => false, toggle: () => {} }, onclick: null },
        { dataset: { int: '15m', days: '3' }, classList: { contains: () => true, toggle: () => {} }, onclick: null }
      ] : [],
      addEventListener: () => {}
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (url) => {
      if (String(url).includes('/api/perps/candles')) {
        return { ok: true, json: async () => ({ success: true, data: candles }) };
      }
      return { ok: true, json: async () => ({ success: true, data: [] }) };
    },
    alert: () => {}, confirm: () => true,
    setInterval: (fn) => { intervalFn = fn; return 'TIMER_1'; },
    clearInterval: (id) => clearedIntervals.push(id),
    setTimeout: () => 0, // il primo render lo pilotiamo a mano, non via timer
    clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const perps = sandbox.window.perps;
  const realRenderChart = perps._renderChart.bind(perps);
  perps._renderChart = (...args) => { calls.renderChart++; return realRenderChart(...args); };

  return { perps, elements, calls, fakeChart, getIntervalFn: () => intervalFn, clearedIntervals };
}

test('chiusura da sfondo/Escape (bypassa closeChart): il timer si autospegne e distrugge il grafico', async () => {
  const ui = loadChartUi();
  ui.perps.openChart('BTC-PERP');
  await ui.perps._renderChart(); // primo caricamento, come farebbe il setTimeout reale

  assert.equal(typeof ui.getIntervalFn(), 'function', 'il timer di refresh deve essere stato armato');
  assert.equal(ui.calls.remove, 0, 'il grafico non deve essere già distrutto dopo il primo render');

  // Simula la chiusura da sfondo/Escape: shell.js toglie solo la classe 'show',
  // senza passare da perps.closeChart().
  ui.elements.chartModal.classList.remove('show');

  const rendersBefore = ui.calls.renderChart;
  ui.getIntervalFn()(); // prossimo tick del setInterval

  assert.equal(ui.calls.renderChart, rendersBefore, 'a modale chiuso il tick non deve richiedere nuove candele');
  assert.deepEqual(ui.clearedIntervals, ['TIMER_1'], 'il timer va spento da solo');
  assert.equal(ui.perps.chartTimer, null);
  assert.equal(ui.calls.remove, 1, 'il grafico va distrutto quando il tick si accorge che il modale è chiuso');
});

test('a modale ancora aperto, il tick continua ad aggiornare normalmente', async () => {
  const ui = loadChartUi();
  ui.perps.openChart('BTC-PERP');
  await ui.perps._renderChart();

  const rendersBefore = ui.calls.renderChart;
  await ui.getIntervalFn()();

  assert.equal(ui.calls.renderChart, rendersBefore + 1, 'a modale aperto il tick deve richiamare _renderChart');
  assert.equal(ui.clearedIntervals.length, 0, 'nessuna auto-pulizia finché il modale resta aperto');
});

test('il refresh periodico preserva lo zoom/pan invece di resettarlo ad ogni tick', async () => {
  const ui = loadChartUi();
  ui.perps.openChart('BTC-PERP');
  await ui.perps._renderChart(); // isUpdate=false: fitContent(), nessun ripristino

  assert.equal(ui.calls.fitContent, 1, 'il primo caricamento inquadra tutto il contenuto');
  assert.equal(ui.calls.setVisibleLogicalRange.length, 0);

  await ui.perps._renderChart(true); // tick periodico simulato

  assert.equal(ui.calls.fitContent, 1, 'un aggiornamento periodico non deve richiamare fitContent()');
  assert.equal(ui.calls.setVisibleLogicalRange.length, 1, 'il range visibile va ripristinato dopo il refresh');
  assert.deepEqual(ui.calls.setVisibleLogicalRange[0], ui.fakeChart._range, 'ripristina esattamente il range salvato prima del setData');
});
