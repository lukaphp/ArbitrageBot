/**
 * XSS stored e handler inline su storico strategie, banner di crash, coda
 * proposte e selettori strategia/rischio (public/perps.js), issue #77 e #64
 * ============================================================================
 *
 * #77 — lo storico strategie interpolava `botName`, `model`, `coin` e
 * `rationale` (quest'ultimo generato da un LLM) dentro `innerHTML` senza
 * `_escapeHtml`; il banner `perps:botCrash` faceva lo stesso con
 * `botName`/`coin` arrivati via socket. Stessa classe di #9/#59.
 *
 * #64 — gli stessi componenti avevano ancora `onclick="perps.X('${id}')"` /
 * `onchange="...('${h.id}', this.checked)"`: contesto stringa-JS dentro un
 * attributo, dove `_escapeHtml` non basta (le entity si decodificano prima
 * che il motore JS veda la stringa). Ora sono `data-action`/`data-id` letti
 * dai dispatcher delegati, come la bot-card dopo #60.
 *
 * Verifichiamo: (a) nessun markup grezzo né handler inline con valori
 * interpolati, (b) i dispatcher delegati chiamano ancora il metodo giusto con
 * l'id giusto, anche quando l'id contiene un payload con apici.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');

const IMG = '<img src=x onerror=alert(1)>';
const QUOTE = "');alert(1);//";

function fakeElement(id) {
  const classes = new Set();
  const listeners = {};
  const children = [];
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', className: '', dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    _listeners: listeners,
    children,
    appendChild: (child) => { children.push(child); return child; },
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
      createElement: () => fakeElement(''),
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

function voce(overrides = {}) {
  return {
    id: 'sh-1', status: 'approved', coin: 'SOL', decidedAt: 1754003600000,
    rationale: 'RSI ipervenduto', model: 'claude-sonnet-4', costUsd: 0.04,
    linkedBotId: 'bot-1', botExists: true, botName: 'Bot SOL',
    outcome: { trades: 3, winRate: 0.5, profitFactor: 1.2, totalPnl: 4.2 },
    ...overrides
  };
}

function renderHistory(perps, elements, items, tab = 'approved') {
  perps.strategyTab = tab;
  perps._strategyHistory = items;
  perps._strategyCounts = null;
  perps._renderStrategyHistory();
  return elements.strategyHistory.innerHTML;
}

/** Evento sintetico come quello che il browser passerebbe al listener
 * delegato dopo aver decodificato le entity di `data-id` (vedi
 * test/delegatedActionsUi.test.js per la stessa tecnica). */
function eventOn(dataset, extra = {}) {
  const el = { dataset, ...extra };
  return { target: { closest: (sel) => (sel === '[data-action]' ? el : null) } };
}

// ------------------------------------------------------------ storico strategie

test('storico: botName/model/coin/rationale malevoli escono escapati', () => {
  const { perps, elements } = loadUi();
  const html = renderHistory(perps, elements, [voce({
    botName: IMG, model: IMG, coin: IMG, rationale: IMG
  })]);
  assert.equal(html.includes(IMG), false, 'nessun markup grezzo dai campi testuali');
  // coin, model, rationale, botName (riga outcome con trades)
  assert.equal(html.split('&lt;img src=x onerror=alert(1)&gt;').length - 1, 4);
});

test('storico: botName escapato anche nella riga "in attesa di operazioni"', () => {
  const { perps, elements } = loadUi();
  const html = renderHistory(perps, elements, [voce({ botName: IMG, outcome: null })]);
  assert.equal(html.includes(IMG), false);
  assert.match(html, /▶️ &lt;img src=x onerror=alert\(1\)&gt; · in attesa/);
});

test('storico: nessun onclick/onchange inline, azioni come data-action/data-id', () => {
  const { perps, elements } = loadUi();
  const html = renderHistory(perps, elements, [voce({ id: 'sh-9', status: 'expired' })], 'expired');
  assert.equal(/onclick=|onchange=/.test(html), false, 'nessun handler inline residuo');
  for (const action of ['recycle-strategy', 'toggle-strategy-selection', 'export-strategy', 'delete-strategy']) {
    assert.match(html, new RegExp(`data-action="${action}" data-id="sh-9"`), action);
  }
});

test('storico: un id con apici/virgolette resta dentro data-id, escapato', () => {
  const { perps, elements } = loadUi();
  const html = renderHistory(perps, elements, [voce({ id: `x"${QUOTE}`, status: 'expired' })], 'expired');
  assert.equal(html.includes(QUOTE), false, 'l\'apice non deve arrivare grezzo nel markup');
  assert.match(html, /data-id="x&quot;&#39;\);alert\(1\);\/\/"/);
});

for (const [action, method, expected] of [
  ['recycle-strategy', 'recycleStrategies', [QUOTE]],
  ['export-strategy', 'exportStrategies', [QUOTE]],
  ['delete-strategy', 'deleteStrategy', QUOTE]
]) {
  test(`storico: data-action="${action}" chiama perps.${method} con l'id giusto`, () => {
    const { perps } = loadUi();
    let received;
    perps[method] = (arg) => { received = arg; };
    perps._handleDelegatedClick(eventOn({ action, id: QUOTE }));
    assert.deepEqual(Array.isArray(received) ? [...received] : received, expected);
  });
}

test('storico: la checkbox passa id e stato checked a toggleStrategySelection', () => {
  const { perps } = loadUi();
  const calls = [];
  perps.toggleStrategySelection = (id, on) => calls.push([id, on]);
  perps._handleDelegatedChange(eventOn({ action: 'toggle-strategy-selection', id: QUOTE }, { checked: true }));
  perps._handleDelegatedChange(eventOn({ action: 'toggle-strategy-selection', id: 'sh-2' }, { checked: false }));
  assert.deepEqual(calls, [[QUOTE, true], ['sh-2', false]]);
});

test('storico: il click sulla checkbox non scatena nessun\'altra azione', () => {
  const { perps } = loadUi();
  let called = false;
  for (const m of ['recycleStrategies', 'exportStrategies', 'deleteStrategy', 'toggleStrategySelection']) {
    perps[m] = () => { called = true; };
  }
  perps._handleDelegatedClick(eventOn({ action: 'toggle-strategy-selection', id: 'sh-1' }));
  assert.equal(called, false);
});

// ------------------------------------------------------------ banner di crash

test('banner perps:botCrash: botName e coin escapati', () => {
  const { perps, elements } = loadUi();
  perps._showCrashBanner({ botId: 'b1', botName: IMG, coin: IMG, silentSinceMs: 90000 });
  const banner = elements['perps-crash-banners'].children[0];
  assert.ok(banner, 'il banner è stato aggiunto al contenitore');
  assert.equal(banner.innerHTML.includes(IMG), false);
  assert.equal(banner.innerHTML.split('&lt;img src=x onerror=alert(1)&gt;').length - 1, 2);
});

// ------------------------------------------------------------ coda proposte

test('proposte: nessun onclick inline, id malevolo solo in data-id escapato', () => {
  const { perps, elements } = loadUi();
  perps._renderProposals([
    { id: QUOTE, type: 'new_strategy_candidate', coin: 'BTC', rationale: 'r', payload: {} },
    { id: QUOTE, type: 'tipo_generico', coin: 'ETH', rationale: 'r', payload: {} }
  ]);
  const html = elements.agentProposals.innerHTML;
  assert.equal(html.includes('onclick='), false, 'nessun handler inline residuo');
  assert.equal(html.includes(QUOTE), false);
  for (const action of ['apply-strategy-proposal', 'approve-proposal', 'reject-proposal']) {
    assert.match(html, new RegExp(`data-action="${action}" data-id="&#39;\\);alert\\(1\\);//"`), action);
  }
});

for (const [action, method] of [
  ['apply-strategy-proposal', 'applyStrategyProposal'],
  ['approve-proposal', 'approveProposal'],
  ['reject-proposal', 'rejectProposal']
]) {
  test(`proposte: data-action="${action}" chiama perps.${method} con l'id giusto`, () => {
    const { perps } = loadUi();
    let received;
    perps[method] = (arg) => { received = arg; };
    perps._handleDelegatedClick(eventOn({ action, id: QUOTE }));
    assert.equal(received, QUOTE);
  });
}

// ------------------------------------------------------------ selettori

test('selettori strategia/rischio: nessun onclick inline, chiavi in data-id', () => {
  const { perps, elements } = loadUi();
  perps._renderStrategyCards();
  perps._renderRiskProfiles();
  const cards = elements.strategyCards.innerHTML;
  const risks = elements.riskProfiles.innerHTML;
  assert.equal(cards.includes('onclick='), false);
  assert.equal(risks.includes('onclick='), false);
  assert.match(cards, /data-action="select-strategy" data-id="[^"]+"/);
  assert.match(risks, /data-action="select-risk" data-id="[^"]+"/);
});

for (const [action, method] of [['select-strategy', 'selectStrategy'], ['select-risk', 'selectRisk']]) {
  test(`selettori: data-action="${action}" chiama perps.${method} con la chiave giusta`, () => {
    const { perps } = loadUi();
    let received;
    perps[method] = (arg) => { received = arg; };
    perps._handleDelegatedClick(eventOn({ action, id: 'chiave' }));
    assert.equal(received, 'chiave');
  });
}

// ------------------------------------------------------------ binding

test('_bindDelegatedActions collega un solo listener per contenitore (click e change)', () => {
  const { perps, elements } = loadUi();
  perps._bindDelegatedActions();
  for (const id of ['strategyHistory', 'agentProposals', 'strategyCards', 'riskProfiles']) {
    assert.equal(elements[id]._listeners.click?.length, 1, `click su #${id}`);
  }
  assert.equal(elements.strategyHistory._listeners.change?.length, 1, 'change su #strategyHistory');
});
