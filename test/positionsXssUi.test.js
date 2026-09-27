/**
 * XSS stored nella tabella "Posizioni attive" — `_renderPositions`/`_populatePosBotFilter`
 * (public/perps.js), issue #59
 * ============================================================================
 *
 * Quinta superficie della stessa classe di #9/#22/#39: `_renderPositions`
 * interpolava `p.botName`, `p.coin`, `p.side` nel markup senza `_escapeHtml`,
 * e `_populatePosBotFilter` metteva `botName` in `<option value="...">` senza
 * escaping — stesso vettore (`bots.name`, scrivibile dall'utente o da un
 * agente esterno) già chiuso su `_renderFills` in #22 ma mai censito qui.
 *
 * File separato da `fillsHistoryXssUi.test.js`: altra tabella, altre funzioni,
 * e `_populatePosBotFilter` scrive in un nodo diverso (`#posBot`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');

/** Il payload ostile: se esce intatto, esegue. */
const XSS = '<img src=x onerror=alert(1)>';

function fakeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], remove: () => {}
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

/** Una posizione come arriva da `/api/perps/account`, ridotta ai campi interpolati. */
function position(overrides = {}) {
  return {
    openedAt: 1758800000000, botName: 'Scalper BTC', coin: 'BTC-PERP', side: 'long',
    size: 0.01, entryPx: 60000, unrealizedPnl: 12.5, leverage: 5, liquidationPx: 50000,
    isPaper: false,
    ...overrides
  };
}

/** Rende le posizioni e restituisce il markup scritto in `#positionsList`. */
function renderPositions(rows) {
  const { perps, elements } = loadUi();
  perps._renderPositions(rows);
  return elements.positionsList.innerHTML;
}

function assertNeutralizzato(html, contesto) {
  assert.equal(html.includes(XSS), false, `${contesto}: il markup esce intatto ed è eseguibile`);
  assert.equal(html.includes('<img'), false, `${contesto}: nessun tag img nella tabella`);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, `${contesto}: il valore va mostrato come testo, non rimosso`);
}

test('un nome bot con markup non esce dalla colonna Bot', () => {
  const html = renderPositions([position({ botName: XSS })]);
  assertNeutralizzato(html, 'p.botName');
  assert.match(html, /class="hist-bot">🤖 &lt;img/, 'il nome resta nella sua cella, con l\'icona');
});

test('la coin con markup non esce dalla colonna Mercato', () => {
  const html = renderPositions([position({ coin: XSS })]);
  assertNeutralizzato(html, 'p.coin');
});

test('il side con markup non esce dal badge, né come classe né come testo', () => {
  const html = renderPositions([position({ side: `long ${XSS}` })]);
  assertNeutralizzato(html, 'p.side');
});

test('una riga legittima resta identica a prima', () => {
  const html = renderPositions([position()]);
  assert.match(html, /class="hist-bot">🤖 Scalper BTC</);
  assert.match(html, /<td>BTC-PERP<\/td>/);
  assert.match(html, /class="side-badge long">LONG</);
  assert.equal(html.includes('&amp;'), false, 'niente escaping dove non serve');
});

test('il ramo "Manuale" e il badge PAPER non cambiano', () => {
  const manuale = renderPositions([position({ botName: 'Manuale' })]);
  assert.match(manuale, /class="hist-bot">✋ Manuale</);

  const paper = renderPositions([position({ isPaper: true })]);
  assert.match(paper, /<td>BTC-PERP <span class="testnet-badge"/);
  assert.match(paper, /gestita dal bot/, 'riga paper: nessun pulsante Chiudi, solo il marcatore (issue #35)');
});

test('un elenco vuoto non scrive niente nella tabella', () => {
  const { perps, elements } = loadUi();
  perps._renderPositions([]);
  assert.equal(elements.positionsList.innerHTML, '');
  assert.equal(elements.noPositions.classList.contains('hidden'), false,
    'il messaggio "nessuna posizione" torna visibile');
});

/** `_populatePosBotFilter` scrive in `#posBot` a partire da `perps._allPositions`. */
function populateFilter(rows) {
  const { perps, elements } = loadUi();
  perps._allPositions = rows;
  perps._populatePosBotFilter();
  return elements.posBot.innerHTML;
}

test('un nome bot con markup non esce dal filtro select', () => {
  const html = populateFilter([position({ botName: XSS })]);
  assertNeutralizzato(html, '_populatePosBotFilter: botName');
});

test('un nome bot con virgolette non chiude anticipatamente il value dell\'opzione', () => {
  const html = populateFilter([position({ botName: 'Bot" onmouseover="alert(1)' })]);
  assert.equal(html.includes('" onmouseover="'), false,
    'un value che si chiude da solo permette di iniettare un attributo');
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/);
});

test('il filtro elenca i nomi legittimi ordinati, senza duplicati', () => {
  const html = populateFilter([
    position({ botName: 'Zeta' }),
    position({ botName: 'Alpha' }),
    position({ botName: 'Alpha' })
  ]);
  assert.match(html, /<option value="">Tutti i bot<\/option><option value="Alpha">Alpha<\/option><option value="Zeta">Zeta<\/option>/);
});
