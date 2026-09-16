/**
 * XSS stored nella card bot — `_botCardHtml` (public/perps.js), issue #9
 * =====================================================================
 *
 * Il nome del bot è testo scritto dall'utente nel modale di creazione e persistito in
 * DB (ed è scrivibile anche da agenti esterni come Hermes). `lastError`, `crashReason`
 * e `lastEval.reason` arrivano dallo stesso giro e possono citare quel nome. Finché
 * finivano nel template senza escaping, un nome come `<img src=x onerror=alert(1)>`
 * veniva eseguito nel browser di chiunque aprisse la dashboard: non serviva accesso
 * privilegiato, bastava creare un bot.
 *
 * Questi casi bloccano la regressione sui cinque punti della issue: nome, `crashReason`
 * nel `title=` del badge CRASH, `crashReason` nel testo della riga watchdog, `lastError`
 * e `lastEval.reason` nella riga "Valutazione".
 *
 * Come gli altri test di `public/*.js`: caricamento in `node:vm` con DOM finto, quindi
 * si verifica il markup prodotto, non la resa visiva.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');

/** Il payload ostile usato ovunque: se esce intatto, esegue. */
const XSS = '<img src=x onerror=alert(1)>';

function fakeElement(id) {
  const classes = new Set();
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
  return perps;
}

/** Bot come arriva da `/api/perps/bots`, ridotto ai campi che la card interpola. */
function bot(overrides = {}) {
  return {
    id: 'bot-1', name: 'Scalper BTC', coin: 'BTC', status: 'running', paper: true,
    dailyPnl: 12.5, position: null, lastEval: null, lastError: null, crashReason: null,
    config: { entryRules: [], logic: 'any' },
    ...overrides
  };
}

/**
 * Nessuna delle due assert basta da sola: la prima dice che il tag non esiste più,
 * la seconda che il testo è ancora lì (un fix che cancellasse il campo passerebbe la
 * prima e mentirebbe all'utente).
 */
function assertNeutralizzato(html, contesto) {
  assert.equal(html.includes(XSS), false, `${contesto}: il markup esce intatto ed è eseguibile`);
  assert.equal(html.includes('<img'), false, `${contesto}: nessun tag img deve comparire nella card`);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, `${contesto}: il valore va mostrato come testo, non rimosso`);
}

test('il nome del bot con markup esce come testo, non come tag', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ name: XSS }));
  assertNeutralizzato(html, 'nome del bot');
  assert.match(html, /<strong>&lt;img/, 'il nome resta nell\'intestazione della card');
});

test('lastError con markup non esce dalla riga di errore', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ status: 'running', lastError: `Ordine rifiutato per ${XSS}` }));
  assertNeutralizzato(html, 'lastError');
  assert.match(html, /class="bot-error">⚠️ Ordine rifiutato per &lt;img/);
});

test('crashReason con markup: né nel testo del watchdog né nel title del badge', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ status: 'crashed', crashReason: XSS }));
  assertNeutralizzato(html, 'crashReason');
  // Due punti di interpolazione diversi, stesso valore: entrambi devono essere coperti.
  assert.equal((html.match(/&lt;img src=x/g) || []).length, 2,
    'crashReason compare sia nel title del badge CRASH sia nella riga watchdog');
  assert.match(html, /🐕 Watchdog: &lt;img/);
});

test('crashReason che chiude l\'attributo title non inietta attributi nuovi', () => {
  const perps = loadUi();
  // Contesto attributo: qui l'apice/virgoletta è l'evasione, non `<`. `_escapeHtml`
  // deve coprirli entrambi, altrimenti basta `" onmouseover=...` per eseguire.
  const html = perps._botCardHtml(bot({ status: 'crashed', crashReason: '" onmouseover="alert(1)' }));
  // La stringa `onmouseover=` resta visibile come TESTO: quello che non deve esistere è
  // la virgoletta grezza che chiude `title` e la trasforma in un attributo vero.
  assert.equal(html.includes('" onmouseover="'), false,
    'un title che si chiude da solo permette di iniettare un handler');
  assert.match(html, /title="&quot; onmouseover=&quot;alert\(1\)"/);
});

test('crashReason con apice singolo resta dentro il title', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ status: 'crashed', crashReason: "' onfocus='alert(1)" }));
  assert.equal(html.includes("' onfocus='"), false,
    'l\'apice va escapato anche dentro un attributo delimitato da virgolette doppie');
  assert.match(html, /title="&#39; onfocus=&#39;alert\(1\)"/);
});

test('lastEval.reason con markup esce come testo nella riga Valutazione', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ lastEval: { action: 'hold', reason: `RSI sopra soglia ${XSS}` } }));
  assertNeutralizzato(html, 'lastEval.reason');
  assert.match(html, /<span class="eval">⏳ RSI sopra soglia &lt;img/,
    'l\'icona dell\'azione resta, solo il motivo viene escapato');
});

test('i fallback testuali della card restano quelli di prima', () => {
  const perps = loadUi();
  // L'escaping è stato messo sul valore finale: la logica dei default non deve cambiare.
  const crashSenzaMotivo = perps._botCardHtml(bot({ status: 'crashed', crashReason: null }));
  assert.match(crashSenzaMotivo, /title="Nessun tick rilevato"/);
  assert.match(crashSenzaMotivo, /🐕 Watchdog: nessun tick rilevato/);

  const senzaEval = perps._botCardHtml(bot({ lastEval: null }));
  assert.match(senzaEval, /<span class="eval">—<\/span>/);

  const warmup = perps._botCardHtml(bot({ lastEval: { action: 'hold', reason: "Nessuna regola d'ingresso configurata" } }));
  assert.match(warmup, /⏳ In attesa candele warmup/);
});

test('una card normale non viene alterata dall\'escaping', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    name: 'Scalper BTC', status: 'running',
    lastEval: { action: 'open_long', reason: 'RSI 28 < 30' }
  }));
  assert.match(html, /<strong>Scalper BTC<\/strong>/);
  // `<` dentro un motivo legittimo diventa entity: è corretto, il browser lo rende come `<`.
  assert.match(html, /RSI 28 &lt; 30/);
  assert.equal(html.includes('&amp;lt;'), false, 'niente doppio escaping');
});
