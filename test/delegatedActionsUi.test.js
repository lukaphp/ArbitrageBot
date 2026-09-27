/**
 * Click delegato al posto di `onclick` inline — bot-card e tabella posizioni
 * (public/perps.js), issue #60
 * ============================================================================
 *
 * Prima: `onclick="perps.editBot('${b.id}')"` (e i pulsanti gemelli
 * start/stop/monitor/delete sulla card, close/chart sulla riga posizione) —
 * un attributo HTML il cui contenuto è codice JavaScript. `_escapeHtml`
 * protegge il contesto markup/`title=`, non questo: le entity si decodificano
 * PRIMA che il motore JS veda la stringa, quindi un valore con un apice
 * (`'); alert(1); //`) romperebbe la chiamata. Oggi `b.id` è sempre un
 * `crypto.randomUUID()` server-side — innocuo per un invariante, non per
 * costruzione.
 *
 * Dopo: `data-action="edit-bot" data-id="${escaped}"` letto da un unico
 * dispatcher (`_handleDelegatedClick`), collegato una volta sola
 * (`_bindDelegatedActions`) sui contenitori stabili `#botsList`/`#positionsList`.
 * Un `data-*` non è mai codice: qualunque cosa contenga arriva come argomento
 * di stringa inerte, mai come sorgente da eseguire.
 *
 * Questi test verificano tre cose distinte, tutte necessarie: (a) il markup
 * non contiene più `onclick=` per questi pulsanti, (b) il dispatch delegato
 * funziona ancora (click simulato → funzione giusta con l'id/coin giusto),
 * (c) un id "malevolo" non esegue nulla — non perché oggi è sempre un UUID,
 * ma perché la struttura stessa non lo permette.
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
  const listeners = {};
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    _listeners: listeners,
    querySelector: () => null, querySelectorAll: () => [], remove: () => {}
  };
}

function loadUi() {
  const elements = {};
  const sandbox = {
    console, BigInt,
    window: { io: () => ({ on: () => {} }), addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '',
      getElementById: (id) => (elements[id] ||= fakeElement(id)),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
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
  return { perps, elements };
}

function bot(overrides = {}) {
  return {
    id: 'bot-1', name: 'Scalper BTC', coin: 'BTC', status: 'running', paper: true,
    dailyPnl: 12.5, position: null, lastEval: null, lastError: null, crashReason: null,
    config: { entryRules: [], logic: 'any' },
    ...overrides
  };
}

function position(overrides = {}) {
  return {
    coin: 'BTC', side: 'long', size: 0.01, entryPx: 60000, unrealizedPnl: 12.5,
    leverage: 3, liquidationPx: 40000, openedAt: 1758800000000, botName: 'Scalper BTC',
    isPaper: false,
    ...overrides
  };
}

/** Simula il click su un `data-action` costruendo l'evento a mano: la fake DOM
 * non fa parsing/bubbling reale di `innerHTML`, quindi il dataset arriva
 * direttamente (esattamente ciò che il browser passerebbe dopo aver
 * decodificato le entity — è il punto della issue). */
function clickOn(perps, dataset) {
  perps._handleDelegatedClick({ target: { closest: (sel) => (sel === '[data-action]' ? { dataset } : null) } });
}

test('_bindDelegatedActions collega UN listener su ciascun contenitore stabile', () => {
  const { perps, elements } = loadUi();
  perps._bindDelegatedActions();
  assert.equal(elements.positionsList._listeners.click?.length, 1);
  assert.equal(elements.botsList._listeners.click?.length, 1);
});

test('un click fuori da qualunque [data-action] non fa nulla e non lancia', () => {
  const { perps } = loadUi();
  assert.doesNotThrow(() => perps._handleDelegatedClick({ target: { closest: () => null } }));
});

for (const [action, method, argKey] of [
  ['start-bot', 'startBot', 'id'],
  ['stop-bot', 'stopBot', 'id'],
  ['edit-bot', 'editBot', 'id'],
  ['open-bot-monitor', 'openBotMonitor', 'id'],
  ['delete-bot', 'deleteBot', 'id'],
  ['close-position', 'closePosition', 'coin'],
  ['open-chart', 'openChart', 'coin']
]) {
  test(`data-action="${action}" chiama perps.${method} con il valore giusto`, () => {
    const { perps } = loadUi();
    let received;
    perps[method] = (arg) => { received = arg; };
    clickOn(perps, { action, [argKey]: 'valore-di-prova' });
    assert.equal(received, 'valore-di-prova');
  });
}

test('un id malevolo con apice non esegue nulla: arriva come stringa inerte', () => {
  const { perps } = loadUi();
  const payload = "x'); alert(document.cookie); //";
  let received;
  perps.editBot = (id) => { received = id; };
  clickOn(perps, { action: 'edit-bot', id: payload });
  // La prova che conta: `editBot` riceve il payload intatto come ARGOMENTO,
  // non come sorgente valutata — non c'è nessun punto del dispatcher che lo
  // interpoli in una stringa da eseguire (niente `eval`, niente `Function`,
  // niente `onclick` costruito a runtime).
  assert.equal(received, payload);
});

test('_botCardHtml: nessun onclick inline, i pulsanti azione hanno data-action/data-id', () => {
  const { perps } = loadUi();
  // `mainAction` è o start-bot o stop-bot a seconda di `running` — mai entrambi
  // sulla stessa card, quindi servono due bot per coprirli entrambi.
  const running = perps._botCardHtml(bot({ status: 'running' }));
  const stopped = perps._botCardHtml(bot({ status: 'stopped' }));
  assert.equal(running.includes('onclick='), false, 'nessun handler inline residuo sulla card (running)');
  assert.equal(stopped.includes('onclick='), false, 'nessun handler inline residuo sulla card (stopped)');
  assert.match(running, /data-action="stop-bot" data-id="bot-1"/);
  assert.match(stopped, /data-action="start-bot" data-id="bot-1"/);
  for (const action of ['edit-bot', 'open-bot-monitor', 'delete-bot']) {
    assert.match(running, new RegExp(`data-action="${action}" data-id="bot-1"`), action);
  }
});

test('_botCardHtml: un id con virgolette non chiude anticipatamente l\'attributo data-id', () => {
  const { perps } = loadUi();
  const html = perps._botCardHtml(bot({ id: 'bot"1' }));
  assert.equal(html.includes('data-id="bot"1"'), false,
    'un id non escapato romperebbe il confine dell\'attributo');
  assert.match(html, /data-id="bot&quot;1"/);
});

test('_renderPositions: nessun onclick inline, i pulsanti azione hanno data-action/data-coin', () => {
  const { perps, elements } = loadUi();
  perps._renderPositions([position()]);
  const html = elements.positionsList.innerHTML;
  assert.equal(html.includes('onclick='), false, 'nessun handler inline residuo sulla tabella posizioni');
  assert.match(html, /data-action="close-position" data-coin="BTC-PERP"/);
  assert.match(html, /data-action="open-chart" data-coin="BTC-PERP"/);
});
