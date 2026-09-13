/**
 * Card bot + eventi push non ascoltati (public/perps.js, public/styles_perps.css)
 * ==============================================================================
 *
 * Due cose che la UI non faceva:
 *
 * 1. La coin scambiata era testo `.muted` accanto al nome del bot ("· BTC"). Su una
 *    lista lunga è l'informazione che si cerca per prima: ora è un badge, con la
 *    stessa grammatica pill degli altri badge della card.
 *
 * 2. Il server emette `perps:killSwitch` e `perps:network`, ma nessun listener li
 *    registrava: kill-switch alzato da Hermes (MCP) o rete cambiata da un altro
 *    browser restavano invisibili qui fino al refresh manuale. Il caso che conta è
 *    il primo: aperture bloccate sul server, questa scheda che continua a mostrarle
 *    consentite.
 *
 * Il punto delicato è che i due emit di `perps:killSwitch` hanno payload diversi:
 * `emergency_shutdown` manda `{on:true}` e ha davvero alzato il flag, il Safe-Exit di
 * `POST /api/perps/kill-switch` manda l'esito dell'operazione e **non** tocca il flag.
 * Dedurre `on` dal secondo sarebbe inventare uno stato — questi casi lo bloccano.
 *
 * Come gli altri test di `public/*.js`: caricamento in `node:vm` con DOM finto, quindi
 * è coperto il comportamento della classe. La resa visiva del badge resta verificata a
 * mano; qui si asserisce il markup prodotto e la presenza della regola CSS.
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
    addEventListener: () => {}, querySelector: () => null, remove: () => {},
    hasClass: (c) => classes.has(c)
  };
}

/**
 * Carica perps.js con un socket finto: `_initSocket` registra i listener veri, e il
 * test li invoca con gli stessi payload che il server emette davvero.
 */
function loadPerpsUi({ network = 'testnet' } = {}) {
  const ids = ['killswitchResumeBtn', 'killswitchState', 'networkBadge',
    'footerNetworkNotice', 'cockpitNetworkEyebrow', 'cockpitOrderNotice',
    'faucetCard', 'botsList', 'noBots'];
  const elements = Object.fromEntries(ids.map(id => [id, fakeElement(id)]));
  elements.killswitchResumeBtn.classList.add('hidden'); // come nell'HTML

  const handlers = {};
  const toasts = [];
  const requests = [];
  const served = { network };

  const sandbox = {
    console, BigInt,
    window: {
      io: () => ({ on: (evt, cb) => { handlers[evt] = cb; } }),
      addEventListener: () => {} // _initSocket registra anche il popstate
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '',
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method, body: opts.body });
      // `api()` restituisce `data.data ?? data`, quindi la risposta va sempre dentro
      // `data`. La forma dipende dalla rotta: chi si aspetta una lista e riceve un
      // oggetto fallisce con un toast d'errore che maschererebbe l'assert vero.
      const payload = /\/(markets|bots|fills)/.test(url) ? [] : { network: served.network };
      return { ok: true, json: async () => ({ success: true, data: payload }) };
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
  perps.network = network;
  perps._initSocket();

  return {
    perps, handlers, toasts, requests, served,
    emit: (evt, payload) => handlers[evt]?.(payload),
    resumeHidden: () => elements.killswitchResumeBtn.hasClass('hidden'),
    stateLabel: () => elements.killswitchState.textContent,
    calls: (url) => requests.filter(r => r.url.startsWith(url)).length
  };
}

// ---------------------------------------------------------------- badge coin

test('la card del bot mostra la coin come badge, non come testo muted', () => {
  const ui = loadPerpsUi();
  const html = ui.perps._botCardHtml({ id: 'b1', name: 'Scalper BTC', coin: 'BTC', status: 'stopped' });

  assert.match(html, /<span class="coin-badge"[^>]*>BTC<\/span>/,
    'la coin va resa come badge dedicato');
  assert.equal(/class="muted">·\s*BTC/.test(html), false,
    'la vecchia resa "· BTC" in muted non deve sopravvivere');
  // Il badge sta nell'intestazione, accanto al nome: è lì che si guarda scorrendo.
  assert.match(html, /<strong>Scalper BTC<\/strong>\s*<span class="coin-badge"/);
});

test('il badge coin dichiara il mercato nel title e non lascia passare markup', () => {
  const ui = loadPerpsUi();
  const html = ui.perps._botCardHtml({ id: 'b1', name: 'x', coin: '"><img src=x>', status: 'stopped' });
  assert.equal(html.includes('<img src=x>'), false, 'la coin va escapata anche nel title');
  assert.match(html, /title="Mercato: [^"]*perp"/);
});

test('styles_perps.css definisce .coin-badge come pill leggibile', () => {
  const css = fs.readFileSync(PERPS_CSS, 'utf8');
  const rule = css.match(/\.coin-badge\s*\{[^}]*\}/);
  assert.ok(rule, 'manca la regola .coin-badge');
  // Stessa grammatica degli altri badge della card: pill con bordo e sfondo pieni,
  // così resta leggibile indipendentemente dalla superficie sotto.
  assert.match(rule[0], /border-radius:/);
  assert.match(rule[0], /background:/);
  assert.match(rule[0], /border:/);
  assert.match(rule[0], /font-weight:/);
  assert.equal(/rgba\(/.test(rule[0]), false,
    'niente colori in alpha: la card è chiara ma sta dentro body.cockpit-mode');
});

// ------------------------------------------------------- perps:killSwitch

test('perps:killSwitch con {on:true}: la UI del kill-switch si aggiorna senza refresh manuale', () => {
  const ui = loadPerpsUi();
  assert.equal(ui.resumeHidden(), true, 'precondizione: kill-switch spento');

  ui.emit('perps:killSwitch', { on: true, actor: 'hermes_mcp_call', reason: 'emergency_shutdown' });

  assert.equal(ui.resumeHidden(), false, 'il bottone di riattivazione deve comparire');
  assert.match(ui.stateLabel(), /ATTIVO/);
  assert.match(ui.toasts.at(-1).msg, /altra sessione/,
    '{on:true} arriva solo dal percorso MCP: l\'origine esterna è un fatto, non un\'ipotesi');
});

test('perps:killSwitch Safe-Exit (senza campo on): non inventa lo stato del flag', () => {
  const ui = loadPerpsUi();
  // Il Safe-Exit NON chiama riskAgent.setKillSwitch: partendo da "attivo", un
  // Boolean(data.on) lo spegnerebbe qui pur restando alzato sul server.
  ui.perps._setKillSwitchUi(true);
  assert.equal(ui.resumeHidden(), false, 'precondizione: kill-switch mostrato attivo');

  ui.emit('perps:killSwitch', {
    agent_id: 'hermes', threshold: 500,
    stopped: [{ botId: 'b1' }, { botId: 'b2' }], closedPositions: [{ coin: 'BTC' }],
    skippedPositions: [], errors: []
  });

  assert.equal(ui.resumeHidden(), false, 'senza `on` lo stato mostrato non va toccato');
  assert.match(ui.stateLabel(), /ATTIVO/);
});

test('perps:killSwitch Safe-Exit: rilegge la fonte autorevole e riassume l\'esito reale', () => {
  const ui = loadPerpsUi();
  ui.emit('perps:killSwitch', {
    agent_id: 'user_manual', threshold: 500,
    stopped: [{ botId: 'b1' }], closedPositions: [], skippedPositions: [{ coin: 'ETH' }], errors: []
  });

  // /api/perps/risk è l'unica fonte che conosce davvero il flag (riskAgent).
  assert.ok(ui.calls('/api/perps/risk') > 0, 'lo stato va riletto da /api/perps/risk');
  assert.ok(ui.calls('/api/perps/bots') > 0, 'i bot fermati vanno riletti');

  const msg = ui.toasts.at(-1).msg;
  assert.match(msg, /1 bot fermato/);
  assert.match(msg, /1 lasciata aperta/);
  assert.equal(/posizione chiusa|posizioni chiuse/.test(msg), false,
    'nessuna posizione è stata chiusa: non va annunciata');
});

test('perps:killSwitch con payload di forma inattesa: nessun annuncio inventato', () => {
  const ui = loadPerpsUi();
  ui.emit('perps:killSwitch', {});
  assert.equal(ui.toasts.length, 0,
    'senza `on` né `stopped` non si sa nulla: meglio tacere che dire "0 bot fermati"');
  assert.equal(ui.resumeHidden(), true);
});

// ---------------------------------------------------------- perps:network

test('perps:network: il cambio rete fatto altrove aggiorna branding, mercati e conto', async () => {
  const ui = loadPerpsUi({ network: 'testnet' });
  ui.served.network = 'mainnet'; // il server ha già cambiato rete

  await ui.emit('perps:network', { network: 'mainnet' });

  assert.equal(ui.perps.network, 'mainnet');
  assert.ok(ui.calls('/api/perps/network') > 0, 'la rete va riletta dalla sua fonte');
  assert.ok(ui.calls('/api/perps/markets') > 0, 'i mercati appartenevano alla rete precedente');
  assert.match(ui.toasts.at(-1).msg, /MAINNET/);
});

test('perps:network: eco del proprio cambio rete, nessun refresh a vuoto', async () => {
  const ui = loadPerpsUi({ network: 'mainnet' });
  const before = ui.requests.length;

  await ui.emit('perps:network', { network: 'mainnet' });

  assert.equal(ui.requests.length, before, 'rete invariata: niente da rileggere');
  assert.equal(ui.toasts.length, 0, 'niente toast per un cambio che non è avvenuto');
});

test('perps:network: valore non riconosciuto lasciato cadere', async () => {
  const ui = loadPerpsUi({ network: 'testnet' });

  await ui.emit('perps:network', { network: 'devnet' });

  assert.equal(ui.perps.network, 'testnet', 'meglio lo stato noto che uno inventato');
  assert.equal(ui.toasts.length, 0);
});

test('i due eventi emessi dal server hanno un listener registrato', () => {
  const ui = loadPerpsUi();
  // Il bug era esattamente questo: emit presenti lato server, nessun `on` lato client.
  assert.equal(typeof ui.handlers['perps:killSwitch'], 'function');
  assert.equal(typeof ui.handlers['perps:network'], 'function');
});
