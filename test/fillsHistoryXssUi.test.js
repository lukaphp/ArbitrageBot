/**
 * XSS stored nello storico operazioni — `_renderFills` (public/perps.js), issue #22
 * =================================================================================
 *
 * Superficie: "Posizioni" → sotto-tab "Storico". `_renderFills` interpolava
 * `f.botName`, `f.coin`, `f.dir`, `f.botId` e l'hash della transazione nel markup
 * della tabella senza passare da `_escapeHtml`.
 *
 * `f.botName` deriva da `bots.name` (`src/server.js`, endpoint `/api/perps/fills`):
 * lo STESSO campo che #9 aveva già identificato come vettore sulla card bot —
 * scritto dall'utente nel modale di creazione o da un agente esterno (Hermes).
 * Qui però non era mai stato censito, quindi un nome bot con markup veniva
 * eseguito nel browser di chiunque aprisse lo storico.
 *
 * File separato da `botCardXssUi.test.js` per due motivi: la superficie è un'altra
 * (un altro tab, un'altra funzione) e `_renderFills` non RESTITUISCE markup — lo
 * scrive in `#fillsList`, quindi l'harness deve leggere l'`innerHTML` di un nodo
 * finto invece del valore di ritorno.
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
    addEventListener: () => {}, querySelector: () => null, remove: () => {}
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

/** Una riga come arriva da `/api/perps/fills`, ridotta ai campi interpolati. */
function fill(overrides = {}) {
  return {
    time: 1758800000000, botId: 'b1c2d3e4-0000-4000-8000-000000000000', botName: 'Scalper BTC',
    coin: 'BTC', dir: 'Open Long', side: 'B', sz: 0.01, px: 60000,
    closedPnl: 12.5, fee: 0.3, hash: '0xabc', isPaper: false,
    ...overrides
  };
}

/** Rende le fills e restituisce il markup scritto in `#fillsList`. */
function renderFills(rows) {
  const { perps, elements } = loadUi();
  perps._renderFills(rows);
  return elements.fillsList.innerHTML;
}

/**
 * Le due assert servono insieme: la prima dice che il tag non esiste più, la
 * seconda che il valore è ancora mostrato (un fix che cancellasse il campo
 * passerebbe la prima e mentirebbe all'utente).
 */
function assertNeutralizzato(html, contesto) {
  assert.equal(html.includes(XSS), false, `${contesto}: il markup esce intatto ed è eseguibile`);
  assert.equal(html.includes('<img'), false, `${contesto}: nessun tag img nella tabella`);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, `${contesto}: il valore va mostrato come testo, non rimosso`);
}

test('un nome bot con markup non esce dalla colonna Bot', () => {
  const html = renderFills([fill({ botName: XSS })]);
  assertNeutralizzato(html, 'f.botName');
  assert.match(html, /class="hist-bot">🤖 &lt;img/, 'il nome resta nella sua cella, con l\'icona');
});

test('la coin con markup non esce dalla colonna Mercato', () => {
  const html = renderFills([fill({ coin: XSS })]);
  assertNeutralizzato(html, 'f.coin');
});

test('la direzione con markup non esce dal badge', () => {
  // `f.dir` serve anche a `/Long/i.test(...)` per scegliere la classe del badge:
  // l'escaping va sul valore interpolato, non sul confronto.
  const html = renderFills([fill({ dir: `Open Long ${XSS}` })]);
  assertNeutralizzato(html, 'f.dir');
  assert.match(html, /class="side-badge long"/, 'il riconoscimento Long/Short non deve cambiare');
});

test('un botId con markup non esce dal fallback "Bot #"', () => {
  // Precondizione: senza `botName` si prende il ramo di fallback su `botId`, che
  // è l'unico punto dove `botId` arriva nel markup.
  const html = renderFills([fill({ botName: null, botId: '<img src=x>' })]);
  assert.equal(html.includes('<img'), false, 'f.botId: nessun tag nella cella Bot');
  assert.match(html, /🤖 Bot #&lt;img/, 'restano i primi 4 caratteri, come testo');
});

test('un hash che chiude l\'attributo non inietta attributi nel link', () => {
  // Contesto attributo (`href=`): qui l'evasione è la virgoletta, non `<`.
  const html = renderFills([fill({ hash: '0xab" onmouseover="alert(1)' })]);
  assert.equal(html.includes('" onmouseover="'), false,
    'un href che si chiude da solo permette di iniettare un handler');
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/);
});

test('una riga legittima resta identica a prima', () => {
  const html = renderFills([fill()]);
  assert.match(html, /class="hist-bot">🤖 Scalper BTC</);
  assert.match(html, /<td>BTC<\/td>/);
  assert.match(html, /class="side-badge long">Open Long</);
  assert.match(html, /href="https:\/\/app\.hyperliquid-testnet\.xyz\/explorer\/tx\/0xabc"/);
  assert.equal(html.includes('&amp;'), false, 'niente escaping dove non serve');
});

test('il ramo "Manuale" e il badge PAPER non cambiano', () => {
  // Il confronto `f.botName === 'Manuale'` deve restare sul valore GREZZO: se
  // passasse dall'escaping prima del confronto, un domani basterebbe un carattere
  // speciale nella costante per far sparire l'icona.
  const manuale = renderFills([fill({ botName: 'Manuale' })]);
  assert.match(manuale, /class="hist-bot">✋ Manuale</);

  const paper = renderFills([fill({ isPaper: true })]);
  assert.match(paper, /<td>BTC <span class="testnet-badge"/);

  const senzaBot = renderFills([fill({ botName: null, botId: null })]);
  assert.match(senzaBot, /<span class="muted">—<\/span>/);
});

test('un elenco vuoto non scrive niente nella tabella', () => {
  const { perps, elements } = loadUi();
  perps._renderFills([]);
  assert.equal(elements.fillsList.innerHTML, '');
  assert.equal(elements.noFills.classList.contains('hidden'), false,
    'il messaggio "nessuna operazione" torna visibile');
});
