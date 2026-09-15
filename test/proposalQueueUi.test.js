/**
 * Coda di approvazione: resa e flusso di una proposta `tune_params`
 * (public/perps.js, public/styles_perps.css)
 * =================================================================
 *
 * `tune_params` è il primo tipo di proposta che NON viene da un modello: la produce
 * l'inactivity-watcher (regola deterministica) e, una volta approvata, scrive davvero
 * dentro la config del bot. Due conseguenze che questi casi bloccano:
 *
 * 1. Il dettaglio deve dire PRIMA del click cosa verrà applicato, in italiano. Il
 *    riassunto generico del payload mostrava l'unica cosa che conta — la patch — come
 *    JSON in mezzo a un botId inutile: leggibile per un programmatore, non per chi deve
 *    decidere.
 * 2. Una proposta di tuning può essere DIAGNOSTICA (senza patch): approvarla non
 *    modifica niente. Dirlo prima vale più che spiegarlo dopo.
 *
 * In più: `rationale` e `payload.botName` contengono il nome del bot, che è testo
 * scritto dall'utente. Qui passano da `_escapeHtml` — è la stessa XSS stored della card
 * bot (issue #9) su un'altra superficie, e questo file la tiene chiusa.
 *
 * Come gli altri test di `public/*.js`: caricamento in `node:vm` con DOM finto, quindi
 * è coperto il markup prodotto e il comportamento della classe. La resa visiva resta
 * verificata a mano; della parte CSS si asserisce l'esistenza delle regole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');
const PERPS_CSS = path.join(HERE, '..', 'public', 'styles_perps.css');

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

/**
 * Carica perps.js in un contesto isolato. `respond` decide cosa risponde `fetch`:
 * le risposte hanno la forma vera del server (`{ success, data, error }`), perché è
 * `api()` a decidere se lanciare — e sul percorso di approvazione un rifiuto arriva
 * con HTTP 200 e `success: false`, non con un codice di errore.
 */
function loadUi({ respond = () => ({ success: true, data: {} }) } = {}) {
  const elements = {};
  const toasts = [];
  const requests = [];

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
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method });
      const body = respond(url, opts);
      return { ok: body.httpOk !== false, json: async () => body };
    },
    alert: (msg) => toasts.push({ msg, type: 'alert' }),
    confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const perps = sandbox.window.perps;
  perps.toast = (msg, type) => toasts.push({ msg, type });
  // `loadAgents` rilegge stato + proposte da due rotte: qui interessa solo che venga
  // richiamato dopo una decisione, non cosa ne fa.
  let reloads = 0;
  perps.loadAgents = async () => { reloads += 1; };

  return {
    perps, toasts, requests,
    reloads: () => reloads,
    render: (list) => { perps._renderProposals(list); return elements.agentProposals.innerHTML; },
    lastToast: () => toasts.at(-1)
  };
}

/** Proposta come la crea davvero `inactivityWatcherAgent` (src/agents/inactivityWatcher.js). */
function tuneProposal(overrides = {}) {
  const { payload, ...rest } = overrides;
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    type: 'tune_params',
    coin: 'BTC',
    confidence: null,
    source: 'inactivity-watcher',
    rationale: 'Il bot «Scalper BTC» (BTC) è in esecuzione con 2 regole d\'ingresso, ma non ha mai aperto una posizione.',
    payload: {
      botId: 'bot-uuid-9f8e7d6c', botName: 'Scalper BTC',
      cause: 'no_signal', idleMinutes: 42, patch: { candleInterval: '5m' },
      ...(payload || {})
    },
    ...rest
  };
}

// ------------------------------------------------- tune_params con patch applicabile

test('tune_params con patch: il dettaglio dice in italiano cosa verrà applicato', () => {
  const ui = loadUi();
  const html = ui.render([tuneProposal()]);

  assert.match(html, /Se approvi:\s*<strong>intervallo candele → 5m<\/strong>/,
    'la modifica va detta prima del click, con il nome del parametro in italiano');
  assert.equal(html.includes('{"candleInterval"'), false,
    'la patch non deve comparire come JSON grezzo');
  assert.equal(html.includes('bot-uuid-9f8e7d6c'), false,
    'il botId è un UUID: non aiuta a decidere e non va mostrato');
  assert.match(html, /bot «Scalper BTC» · fermo da 42 min/,
    'il contesto utile è nome del bot e da quanto è fermo');
});

test('tune_params: il dettaglio dichiara cosa NON cambia', () => {
  const ui = loadUi();
  const html = ui.render([tuneProposal()]);
  // Approvare scrive in `bots.config_json` con un click: la frase che delimita la
  // portata della modifica è parte di ciò che si sta approvando, non decorazione.
  assert.match(html, /Leva, size, TP\/SL e tetti di rischio restano invariati/);
});

test('tune_params con patch: il bottone approva esegue, non apre il creatore bot', () => {
  const ui = loadUi();
  const html = ui.render([tuneProposal()]);
  assert.match(html, /onclick="perps\.approveProposal\('a1b2c3d4-0000-4000-8000-000000000001'\)"/);
  assert.equal(html.includes('applyStrategyProposal'), false,
    'tune_params non è una candidatura di strategia: non passa dal creatore bot');
  assert.match(html, /onclick="perps\.rejectProposal\('a1b2c3d4-0000-4000-8000-000000000001'\)"/);
});

test('durate lunghe leggibili: 185 minuti diventano 3h 05m', () => {
  const ui = loadUi();
  const html = ui.render([tuneProposal({ payload: { idleMinutes: 185 } })]);
  assert.match(html, /fermo da 3h 05m/);
});

// ------------------------------------------------------ tune_params diagnostica

test('tune_params senza patch: dice che approvare non modifica il bot', () => {
  const ui = loadUi();
  const html = ui.render([tuneProposal({ payload: { patch: undefined, cause: 'no_entry_rules' } })]);

  assert.match(html, /class="ap-change ap-change-none"/);
  assert.match(html, /non modifica il bot/);
  assert.equal(/Se approvi/.test(html), false,
    'senza patch non c\'è niente da applicare: promettere un effetto sarebbe falso');
});

// ------------------------------------------------------------------ escaping

test('il nome del bot non porta markup dentro la coda (issue #9, altra superficie)', () => {
  const ui = loadUi();
  const html = ui.render([tuneProposal({
    rationale: 'Il bot «<img src=x onerror=alert(1)>» è fermo.',
    payload: { botName: '<img src=x onerror=alert(1)>' }
  })]);

  assert.equal(html.includes('<img src=x'), false, 'il nome del bot è testo utente: va escapato');
  assert.equal((html.match(/&lt;img src=x/g) || []).length, 2,
    'sia la motivazione sia il contesto passano da _escapeHtml');
});

test('un valore ostile nel tipo o nella coin non esce dai suoi attributi', () => {
  const ui = loadUi();
  const html = ui.render([tuneProposal({ type: '"><script>x</script>', coin: '"><b>' })]);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('"><b>'), false);
});

// ------------------------------------------------------- etichetta di confidenza

test('proposta deterministica: "regola automatica" invece di una confidenza assente', () => {
  const ui = loadUi();
  const html = ui.render([tuneProposal()]);
  assert.match(html, /⚙️ regola automatica/);
  assert.equal(html.includes('confidenza —'), false,
    'l\'inactivity-watcher non ha un modello dietro: "confidenza —" farebbe sembrare mancante un dato che non esiste');
  assert.match(html, /title="[^"]*inactivity-watcher[^"]*"/, 'il title dice da dove viene la proposta');
});

test('proposta dell\'Analyst senza confidenza: resta "confidenza —" (ignoto, non assente)', () => {
  const ui = loadUi();
  const html = ui.render([{ id: 'p2', type: 'pause_bot', coin: 'ETH', source: 'analyst', confidence: null, rationale: 'x', payload: {} }]);
  assert.match(html, /confidenza —/);
});

// --------------------------------------------------------- fallback generico

test('un tipo che la UI non conosce resta leggibile e decidibile', () => {
  const ui = loadUi();
  const html = ui.render([{
    id: 'p3', type: 'tipo_mai_visto', coin: 'SOL', confidence: 0.6, source: 'analyst',
    rationale: 'Motivazione leggibile.', payload: { foo: 'bar' }
  }]);
  assert.match(html, /tipo_mai_visto/);
  assert.match(html, /Motivazione leggibile\./);
  assert.match(html, /foo: bar/);
  assert.match(html, /approveProposal\('p3'\)/);
  assert.match(html, /rejectProposal\('p3'\)/);
});

// ------------------------------------------------- flusso approva / rifiuta

test('approvazione applicata: il toast riporta il valore prima e dopo', async () => {
  const ui = loadUi({
    respond: () => ({
      success: true,
      data: { ok: true, suggestion: false, result: { botId: 'b1', tuned: { candleInterval: { da: '15m', a: '5m' } } } }
    })
  });

  await ui.perps.approveProposal('a1b2c3d4-0000-4000-8000-000000000001');

  assert.match(ui.requests.at(-1).url, /\/api\/agents\/proposals\/a1b2c3d4-0000-4000-8000-000000000001\/approve$/);
  assert.equal(ui.requests.at(-1).method, 'POST');
  assert.match(ui.lastToast().msg, /intervallo candele: 15m → 5m/);
  assert.equal(ui.reloads(), 1, 'la coda va riletta dopo la decisione');
});

test('approvazione di una diagnostica: il messaggio è quello del server, non "creatore bot"', async () => {
  const ui = loadUi({
    respond: () => ({
      success: true,
      data: {
        ok: true, suggestion: true,
        result: { noop: true, botId: 'b1', message: 'Nessun parametro applicabile: la proposta è diagnostica, la modifica va decisa a mano.' }
      }
    })
  });

  await ui.perps.approveProposal('p1');

  assert.match(ui.lastToast().msg, /la proposta è diagnostica/);
  assert.equal(/creatore bot/.test(ui.lastToast().msg), false,
    'su un tuning diagnostico non c\'è nessun creatore bot da aprire: sarebbe un\'istruzione falsa');
});

test('approvazione bloccata dal gate: HTTP 200 con success false non è un\'approvazione', async () => {
  // Il server risponde 200 anche quando il RiskAgent respinge: è `api()` a lanciare
  // sul `success: false`. Se il toast dicesse "approvata" mentirebbe su una proposta
  // che sul server è rimasta pendente.
  const ui = loadUi({
    respond: () => ({ success: false, data: { ok: false, reason: 'RiskAgent: Kill-switch attivo' }, error: 'RiskAgent: Kill-switch attivo' })
  });

  await ui.perps.approveProposal('p1');

  assert.match(ui.lastToast().msg, /Non eseguita: RiskAgent: Kill-switch attivo/);
  assert.equal(ui.lastToast().type, 'warning');
  assert.equal(ui.reloads(), 1, 'la coda va riletta comunque: la proposta è ancora lì');
});

test('rifiuto: stessa rotta per tutti i tipi, coda ricaricata', async () => {
  const ui = loadUi({ respond: () => ({ success: true, data: { ok: true } }) });
  await ui.perps.rejectProposal('a1b2c3d4-0000-4000-8000-000000000001');
  assert.match(ui.requests.at(-1).url, /\/proposals\/a1b2c3d4-0000-4000-8000-000000000001\/reject$/);
  assert.match(ui.lastToast().msg, /Proposta rifiutata/);
  assert.equal(ui.reloads(), 1);
});

// ------------------------------------------------------------------------ CSS

test('styles_perps.css definisce la riga "cosa succede se approvi"', () => {
  const css = fs.readFileSync(PERPS_CSS, 'utf8');
  const change = css.match(/\.ap-change\s*\{[^}]*\}/);
  const none = css.match(/\.ap-change-none\s*\{[^}]*\}/);
  assert.ok(change, 'manca la regola .ap-change');
  assert.ok(none, 'manca la regola .ap-change-none');
  assert.match(change[0], /background:/);
  assert.match(change[0], /border:/);
  assert.equal(/rgba\(/.test(change[0]), false,
    'niente colori in alpha: la card è chiara ma sta dentro body.cockpit-mode');
  assert.equal(/rgba\(/.test(none[0]), false);
});
