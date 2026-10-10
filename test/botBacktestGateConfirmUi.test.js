/**
 * #78 — UI: salvataggio di un bot respinto dai cancelli di scrittura della config
 * ==============================================================================
 *
 * Il server ora risponde al salvataggio di un bot (`saveBot` in public/perps.js)
 * in due modi nuovi:
 *  - 400 con `errors` (lista leggibile) quando la config non passa
 *    `validateConfigForWrite`: va mostrata la lista, non un messaggio generico;
 *  - 409 `BACKTEST_GATE` col `backtestSummary` quando il backtest dà la
 *    strategia in perdita: la UI mostra i numeri e chiede una conferma
 *    ESPLICITA; solo se confermata rimanda la STESSA richiesta con
 *    `confirmBacktestOverride: true`.
 *
 * Stesso seam degli altri *Ui.test.js: `public/perps.js` caricato in `node:vm`
 * con un DOM finto minimale e `fetch` scriptato. Coperto il comportamento della
 * classe, non il rendering reale del browser.
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

const CONFIG = { leverage: 2, entryRules: [{ type: 'price', op: '>', value: 0, signal: 'long' }] };

/** Riassunto come lo produce `runBacktestGate`, con una coin ostile. */
const SUMMARY = {
  verdict: 'blocked',
  reason: 'strategia in perdita netta sul backtest degli ultimi dati storici — 24 trade, win rate 25.0%, profit factor 0.41, expectancy -2.10$/trade.',
  trades: 24,
  winRate: 0.25,
  profitFactor: 0.413,
  expectancy: -2.1,
  totalPnl: -50.4,
  maxDrawdownPct: 9.25,
  coin: '<img src=x onerror=alert(1)>',
  interval: '1h',
  lookbackDays: 30
};

function loadPerpsUi({ responses, confirmResult = true, editId = '' }) {
  const values = { botEditId: editId, botName: 'Bot di prova', botMarket: 'SOL-PERP' };
  const elements = {};
  const el = (id) => (elements[id] ||= { id, value: values[id] ?? '', textContent: '', innerHTML: '', checked: false });
  const requests = [];
  const toasts = [];
  const confirms = [];
  const closedModals = [];
  const queue = [...responses];

  const sandbox = {
    console,
    BigInt,
    window: {
      shell: {
        showToast: (msg, type) => toasts.push({ msg, type }),
        showModal: () => {},
        closeModal: (id) => closedModals.push(id)
      }
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: (id) => el(id),
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
      const next = queue.shift() || { status: 200, body: { success: true, data: {} } };
      return { ok: next.status < 400, status: next.status, json: async () => next.body };
    },
    alert: (msg) => toasts.push({ msg, type: 'alert' }),
    confirm: (msg) => { confirms.push(msg); return confirmResult; },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const perps = sandbox.window.perps;
  perps._buildBotConfig = () => JSON.parse(JSON.stringify(CONFIG));
  perps.loadBots = async () => {};
  perps.loadStrategyHistory = () => {};
  return { perps, requests, toasts, confirms, closedModals, elements };
}

const GATE_409 = { status: 409, body: { success: false, code: 'BACKTEST_GATE', error: 'Backtest Gate — ' + SUMMARY.reason, backtestSummary: SUMMARY } };
const CREATED = { status: 200, body: { success: true, data: { id: 'bot-1', name: 'Bot di prova', warning: null } } };

test('409 BACKTEST_GATE → conferma con i numeri del backtest → stessa richiesta con confirmBacktestOverride', async () => {
  const ui = loadPerpsUi({ responses: [GATE_409, CREATED], confirmResult: true });
  await ui.perps.saveBot();

  assert.equal(ui.confirms.length, 1, 'la forzatura richiede una conferma esplicita');
  const text = ui.confirms[0];
  assert.match(text, /Profit factor: 0\.41/);
  assert.match(text, /Trade: 24/);
  assert.match(text, /PnL totale: -\$50\.4/);
  assert.match(text, /Win rate: 25\.0%/);
  assert.match(text, /in perdita netta/);

  assert.equal(ui.requests.length, 2);
  const [first, second] = ui.requests;
  assert.equal(first.url, '/api/perps/bots');
  assert.equal(first.method, 'POST');
  assert.equal(first.body.confirmBacktestOverride, undefined, 'il primo invio non forza nulla');
  assert.equal(second.url, '/api/perps/bots');
  assert.equal(second.body.confirmBacktestOverride, true);
  assert.deepEqual(second.body.config, first.body.config, 'si rimanda la config che il server ha misurato');
  assert.equal(second.body.name, first.body.name);

  assert.ok(ui.toasts.some(t => t.type === 'success'), 'salvataggio confermato');
  assert.deepEqual(ui.closedModals, ['botModal']);
});

test('409 BACKTEST_GATE in modifica (PATCH): stesso flusso sull\'URL del bot', async () => {
  const ui = loadPerpsUi({ responses: [GATE_409, { status: 200, body: { success: true, data: {} } }], editId: 'bot-7' });
  await ui.perps.saveBot();

  assert.equal(ui.requests.length, 2);
  assert.ok(ui.requests.every(r => r.url === '/api/perps/bots/bot-7' && r.method === 'PATCH'));
  assert.equal(ui.requests[1].body.confirmBacktestOverride, true);
});

test('409 BACKTEST_GATE con conferma negata: un solo invio, nessun salvataggio, modale aperto', async () => {
  const ui = loadPerpsUi({ responses: [GATE_409], confirmResult: false });
  await ui.perps.saveBot();

  assert.equal(ui.confirms.length, 1);
  assert.equal(ui.requests.length, 1, 'nessun secondo invio senza conferma');
  assert.equal(ui.toasts.some(t => t.type === 'success'), false);
  assert.deepEqual(ui.closedModals, []);
});

test('il riassunto del server finisce nella conferma come TESTO, mai come markup', async () => {
  const ui = loadPerpsUi({ responses: [GATE_409], confirmResult: false });
  await ui.perps.saveBot();

  // `confirm()` mostra testo semplice: la coin ostile compare letterale, e
  // nessun elemento della pagina ha ricevuto quel valore come innerHTML.
  assert.ok(ui.confirms[0].includes(SUMMARY.coin));
  for (const element of Object.values(ui.elements)) {
    assert.equal(String(element.innerHTML).includes('<img'), false, `innerHTML di ${element.id}`);
  }
});

test('riassunto incompleto: la conferma dice n/d, mai NaN o undefined', () => {
  const ui = loadPerpsUi({ responses: [] });
  const text = ui.perps._backtestGateConfirmText({ verdict: 'blocked', profitFactor: null, trades: 12 }, 'Backtest Gate — motivo');
  assert.doesNotMatch(text, /NaN|undefined|null/);
  assert.match(text, /Profit factor: n\/d/);
  assert.match(text, /Trade: 12/);

  const noSummary = ui.perps._backtestGateConfirmText(undefined, 'Backtest Gate — motivo dal messaggio');
  assert.match(noSummary, /motivo dal messaggio/);
  assert.doesNotMatch(noSummary, /NaN|undefined/);
});

test('400 dal cancello di config: si mostrano gli errori leggibili, nessuna conferma', async () => {
  const errors = ['dca.steps non valido: 50 (atteso un intero da 0 a 5).', 'regola d\'ingresso 1: tipo mancante.'];
  const ui = loadPerpsUi({
    responses: [{ status: 400, body: { success: false, code: 'CONFIG_INVALID', error: 'GUARDRAIL_VIOLATION: …', errors } }]
  });
  await ui.perps.saveBot();

  assert.equal(ui.confirms.length, 0);
  assert.equal(ui.requests.length, 1);
  const err = ui.toasts.find(t => t.type === 'error');
  assert.ok(err, 'errore mostrato');
  for (const e of errors) assert.ok(err.msg.includes(e), `manca: ${e}`);
  assert.deepEqual(ui.closedModals, [], 'il modale resta aperto per correggere');
});

test('index.html: i campi DCA dichiarano gli stessi limiti dello schema', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const steps = html.match(/<input[^>]*id="botDcaSteps"[^>]*>/)?.[0] || '';
  const mult = html.match(/<input[^>]*id="botDcaMult"[^>]*>/)?.[0] || '';
  assert.match(steps, /max="5"/);
  assert.match(steps, /min="0"/);
  assert.match(mult, /max="2"/);
  assert.match(mult, /min="0\.1"/);
  assert.match(mult, /step="0\.1"/);
});
