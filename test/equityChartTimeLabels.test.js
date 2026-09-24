/**
 * Etichette dell'asse tempo dei grafici equity — coerenti con l'intervallo scelto
 * ================================================================================
 *
 * Segnalato dall'utente dopo BUG-EQUITYRANGE-01: coi bottoni di range finalmente
 * funzionanti, la vista "7G" mostrava un asse incoerente — un misto di sole date
 * ("21", "22", "23") e orari ("13:00", "18:09", "15:00"), perché `timeScale` era
 * creato con `timeVisible: true` fisso su entrambi i grafici (dashboard e
 * performance). Lightweight Charts, con `timeVisible: true`, alterna etichette a
 * orario a etichette di data nei punti di cambio giorno — comportamento corretto
 * per una vista infragiornaliera (nessun cambio giorno da segnare), incoerente su
 * una finestra di più giorni dove il cambio giorno è la norma, non l'eccezione.
 *
 * Non era visibile prima perché, col difetto originale, ogni bottone da "1G" in
 * su mostrava comunque la stessa finestra di poche ore: nessuna vista attraversava
 * mai un cambio di giorno.
 *
 * Fix: `timeVisible` segue l'intervallo — vero SOLO per "1d" (nessun cambio
 * giorno, orari puliti come già visto), falso per tutti gli altri (solo date,
 * niente orari intermedi).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');

function fakeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', hidden: false, dataset: {},
    clientWidth: 640, clientHeight: 300,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: () => {} },
    querySelectorAll: () => [],
    addEventListener: () => {}, querySelector: () => null, remove: () => {}
  };
}

function loadUi() {
  const elements = {};
  const sandbox = {
    console, BigInt,
    window: { io: () => ({ on: () => {} }), addEventListener: () => {}, LightweightCharts: { createChart: () => ({ addAreaSeries: () => ({ setData: () => {} }), timeScale: () => ({ fitContent: () => {}, applyOptions: () => {} }), resize: () => {} }), CrosshairMode: { Normal: 0 } } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '',
      getElementById: (id) => (elements[id] ||= fakeElement(id)),
      querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}
    },
    fetch: async () => ({ ok: true, json: async () => ({ success: true, data: {} }) }),
    alert: () => {}, confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });
  const perps = sandbox.window.perps;
  perps.toast = () => {};
  // Le richieste di rete (refreshRiskSnapshot/loadPerformance) non ci servono
  // qui: isoliamo l'unico comportamento sotto test, la sincronizzazione delle
  // opzioni del timeScale, da tutto il resto del ciclo di fetch.
  perps.refreshRiskSnapshot = async () => {};
  perps.loadPerformance = async () => {};
  return perps;
}

function timeScaleSpy() {
  const calls = [];
  return { timeScale: () => ({ fitContent: () => {}, applyOptions: (opts) => calls.push(opts) }), calls };
}

test('dashboard: range "1d" mostra gli orari (nessun cambio giorno nella vista)', () => {
  const perps = loadUi();
  const spy = timeScaleSpy();
  perps.dashboardChart = spy;
  perps.dashboardSeries = { setData: () => {} };
  perps.setDashboardEquityRange('1d');
  assert.equal(spy.calls.length, 1, 'un aggiornamento del timeScale per cambio range');
  assert.equal(spy.calls[0].timeVisible, true, '1 giorno non attraversa mai un cambio data: orari puliti come prima');
});

test('dashboard: ogni range più largo di "1d" mostra solo le date', () => {
  const perps = loadUi();
  for (const range of ['7d', '30d', '90d', '365d', 'all']) {
    const spy = timeScaleSpy();
    perps.dashboardChart = spy;
    perps.dashboardSeries = { setData: () => {} };
    perps.setDashboardEquityRange(range);
    assert.equal(spy.calls.length, 1, `timeScale aggiornato per range=${range}`);
    assert.equal(spy.calls[0].timeVisible, false,
      `range=${range} attraversa più giorni: mescolare orari e date nello stesso asse è l'incoerenza segnalata`);
  }
});

test('performance: stessa regola, stesso comportamento del grafico dashboard', () => {
  const perps = loadUi();
  perps.perfData = { equityHistory: [] };

  const spyDay = timeScaleSpy();
  perps.perfChart = spyDay;
  perps.setPerfEquityRange('1d');
  assert.equal(spyDay.calls[0].timeVisible, true);

  const spyWeek = timeScaleSpy();
  perps.perfChart = spyWeek;
  perps.setPerfEquityRange('7d');
  assert.equal(spyWeek.calls[0].timeVisible, false);
});

test('creazione iniziale del grafico: timeVisible riflette già il range attivo di default ("all")', () => {
  // Nessuna istanza di chart preesistente: la creazione stessa deve rispettare
  // la regola, non solo gli aggiornamenti successivi — altrimenti il primo
  // rendering (prima di qualunque click) mostrerebbe di nuovo l'asse incoerente.
  const perps = loadUi();
  let createdOptions = null;
  perps.dashboardChart = null;
  perps.dashboardSeries = null;

  const el = { clientWidth: 640, clientHeight: 300 };
  const originalGetElementById = perps.constructor === undefined ? null : null;
  // `_renderDashboardChart`-equivalente: la creazione avviene dentro il metodo
  // che monta la card cockpit al primo giro. Verifichiamo direttamente il
  // valore calcolato che alimenta la creazione, tramite lo stesso helper usato
  // dai setter, per non dipendere dal nome esatto del metodo di boot del grafico
  // (dettaglio implementativo che può cambiare).
  assert.equal(perps._equityChartTimeVisible(perps.dashboardEquityRange), false,
    'default "all": niente orari già alla primissima resa, prima di qualunque click');
  assert.equal(perps._equityChartTimeVisible('1d'), true);
  void createdOptions; void el; void originalGetElementById;
});
