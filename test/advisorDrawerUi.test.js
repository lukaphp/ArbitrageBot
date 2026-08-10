/**
 * Drawer del consulente AI (public/advisor.js, public/index.html) — ADV-02
 * ========================================================================
 *
 * Copre la parte UI della fase 1 dell'advisor: apertura/chiusura del drawer,
 * invio di un messaggio, errore di budget, eliminazione conversazione e — il caso
 * che conta più di tutti — il **degrado pulito** quando il server dichiara il
 * consulente non utilizzabile.
 *
 * PERCHÉ IL DEGRADO È IL CASO PRINCIPALE
 * --------------------------------------
 * Con `AGENTS_ENABLED=false` o senza API key le route rispondono con un errore.
 * Un drawer che in quello stato solleva un'eccezione durante `open()` porterebbe
 * giù la cockpit intera: qui si verifica che l'errore diventi un messaggio
 * leggibile dentro il pannello e che `perps` continui a funzionare — i due moduli
 * sono caricati nello stesso contesto proprio per poterlo affermare.
 *
 * NIENTE STATO CONDIVISO
 * ----------------------
 * Un caso verifica che `advisor.js` non nomini `perps` e che `perps.js` non nomini
 * `advisor`: è il vincolo che arriva dalla lezione di EVM-01 (vedi
 * test/walletPerpsUi.test.js), e un test sul sorgente è l'unico modo di
 * accorgersene prima che il difetto si riformi.
 *
 * Come gli altri test di `public/*.js`: `node:vm` con DOM finto, zero dipendenze
 * aggiuntive. È coperto il comportamento delle classi, non il rendering reale;
 * la corrispondenza degli id con `index.html` è verificata a parte, sul markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADVISOR_JS = path.join(HERE, '..', 'public', 'advisor.js');
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');
const INDEX_HTML = path.join(HERE, '..', 'public', 'index.html');

/**
 * Nodo DOM finto con quel tanto di API che serve al drawer: il transcript è
 * costruito con createElement/appendChild + textContent (mai innerHTML sul
 * contenuto del modello), quindi il finto DOM deve saperli reggere.
 */
class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this._text = '';
    this._html = '';
    this._classes = new Set();
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.selected = false;
    this.title = '';
    this.placeholder = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.focused = 0;
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const classes = this._classes;
    return {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    };
  }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join('\n');
    return this._text;
  }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v ?? ''); this.children = []; this._text = ''; }
  appendChild(child) { this.children.push(child); return child; }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() { this.focused++; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  hasClass(c) { return this._classes.has(c); }
  /** Testo di tutto il sottoalbero, per gli assert sul transcript. */
  allText() {
    if (!this.children.length) return this._text;
    return this.children.map(c => c.allText()).join(' | ');
  }
  fire(ev, payload = {}) {
    (this.listeners[ev] || []).forEach(fn => fn({ preventDefault() {}, target: this, ...payload }));
  }
  click() { this.fire('click'); }
}

const DRAWER_IDS = [
  'advisorToggle', 'advisorDrawer', 'advisorClose', 'advisorBudget', 'advisorSessionList',
  'advisorNewSession', 'advisorDeleteSession', 'advisorNotice', 'advisorTranscript',
  'advisorInput', 'advisorSend'
];

const SESSION = { id: 's1', title: 'Come sto andando?', startedAt: 1_770_000_000_000, lastAt: 1_770_000_600_000, costUsd: 0.12 };

/**
 * Carica advisor.js (e, se richiesto, anche perps.js nello stesso contesto) con
 * un fetch finto che risponde secondo il contratto concordato con Bruno.
 *
 * `routes` sovrascrive la risposta di una singola route: il valore può essere un
 * oggetto `{status, body}` oppure una funzione `(url, opts) => ({status, body})`.
 */
function loadAdvisor({ routes = {}, withPerps = false, confirmAnswer = true } = {}) {
  const elements = Object.fromEntries(DRAWER_IDS.map(id => [id, new FakeEl('div', id)]));
  elements.advisorInput = new FakeEl('textarea', 'advisorInput');
  elements.advisorSessionList = new FakeEl('select', 'advisorSessionList');
  const body = new FakeEl('body');
  const requests = [];
  const toasts = [];
  const confirms = [];
  const docListeners = {};

  const defaults = {
    // Forma reale della route di Bruno: `monthlyLimitUsd`, più `exceeded`/`resetsAt`.
    'GET /api/advisor/status': {
      status: 200,
      body: { success: true, data: { enabled: true, available: true, reason: null, code: null, model: 'claude-haiku-4-5', retentionDays: 90 } }
    },
    'GET /api/advisor/budget': {
      status: 200,
      body: { success: true, data: { monthlyLimitUsd: 10, spentUsd: 2.5, remainingUsd: 7.5, exceeded: false, resetsAt: 1_772_000_000_000, changeableVia: 'telegram:/advisorbudget' } }
    },
    'GET /api/advisor/sessions': { status: 200, body: { success: true, data: [SESSION] } },
    'POST /api/advisor/sessions': { status: 200, body: { success: true, data: { id: 's2', startedAt: 1_770_001_000_000 } } },
    'GET /api/advisor/sessions/s1/messages': {
      status: 200,
      body: { success: true, data: [{ id: 'm1', role: 'user', content: 'Come sto andando?', ts: 1_770_000_000_000 }] }
    },
    'POST /api/advisor/sessions/s1/messages': {
      status: 200,
      body: { success: true, data: { reply: 'Equity a $1.240, drawdown 1,8%.', toolsUsed: ['get_account', 'get_risk_snapshot'], costUsd: 0.031, budgetRemainingUsd: 7.47 } }
    },
    'DELETE /api/advisor/sessions/s1': { status: 200, body: { success: true } }
  };

  const sandbox = {
    console, BigInt, Map, Set, Array, Object, Number, String, Date, JSON, Math, Error, Promise,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      readyState: 'complete',
      title: '🤖 ArbitrageBot Perps',
      body,
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => new FakeEl(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); }
    },
    fetch: async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      requests.push({ url, method, body: opts.body });
      const key = `${method} ${url}`;
      let entry = key in routes ? routes[key] : defaults[key];
      if (typeof entry === 'function') entry = entry(url, opts);
      if (!entry) entry = { status: 404, body: { success: false, error: `route non prevista: ${key}` } };
      return {
        ok: entry.status >= 200 && entry.status < 300,
        status: entry.status,
        json: async () => entry.body
      };
    },
    alert: (msg) => toasts.push({ msg, type: 'alert' }),
    confirm: (msg) => { confirms.push(msg); return confirmAnswer; },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.window.shell = { showToast: (msg, type) => toasts.push({ msg, type }) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (withPerps) vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });
  vm.runInContext(fs.readFileSync(ADVISOR_JS, 'utf8'), sandbox, { filename: 'advisor.js' });

  return {
    advisor: sandbox.window.advisor,
    perps: sandbox.window.perps,
    elements, requests, toasts, confirms, body,
    docKeydown: (key) => (docListeners.keydown || []).forEach(fn => fn({ key })),
    notice: () => elements.advisorNotice.textContent,
    transcript: () => elements.advisorTranscript.allText(),
    calls: (method, url) => requests.filter(r => r.method === method && r.url === url)
  };
}

test('init aggancia il toggle in header: un click apre il drawer, il secondo lo chiude', async () => {
  const ui = loadAdvisor();
  assert.equal(ui.advisor.isOpen, false);
  assert.equal(ui.elements.advisorDrawer.hidden, false, 'stato iniziale del finto DOM');

  ui.elements.advisorToggle.click();
  await new Promise(r => setImmediate(r));
  assert.equal(ui.advisor.isOpen, true);
  assert.equal(ui.elements.advisorDrawer.hidden, false);
  assert.equal(ui.elements.advisorDrawer.hasClass('is-open'), true);
  assert.equal(ui.elements.advisorToggle.getAttribute('aria-expanded'), 'true');

  ui.elements.advisorToggle.click();
  assert.equal(ui.advisor.isOpen, false);
  assert.equal(ui.elements.advisorDrawer.hidden, true, 'chiuso = hidden, non solo una classe');
  assert.equal(ui.elements.advisorToggle.getAttribute('aria-expanded'), 'false');
});

test('Escape chiude il drawer aperto', async () => {
  const ui = loadAdvisor();
  await ui.advisor.open();
  assert.equal(ui.advisor.isOpen, true);
  ui.docKeydown('Escape');
  assert.equal(ui.advisor.isOpen, false);
});

test('apertura: carica stato, budget, sessioni e transcript della più recente', async () => {
  const ui = loadAdvisor();
  await ui.advisor.open();

  // `/status` è la route che Bruno ha aggiunto per dichiarare la disponibilità
  // senza dover prima spendere un turno: si interroga per prima.
  assert.equal(ui.calls('GET', '/api/advisor/status').length, 1);
  assert.equal(ui.advisor.retentionDays, 90);
  assert.equal(ui.calls('GET', '/api/advisor/budget').length, 1);
  assert.equal(ui.calls('GET', '/api/advisor/sessions').length, 1);
  assert.equal(ui.calls('GET', '/api/advisor/sessions/s1/messages').length, 1);
  assert.equal(ui.advisor.activeSessionId, 's1');
  assert.match(ui.transcript(), /Come sto andando\?/);
  // Budget e speso corrente visibili, in sola lettura (ADV-03).
  assert.match(ui.elements.advisorBudget.textContent, /\$2\.50 \/ \$10\.00/);
  assert.match(ui.elements.advisorBudget.textContent, /residuo \$7\.50/);
});

test('nessun polling: una seconda apertura non rifà le chiamate di caricamento', async () => {
  const ui = loadAdvisor();
  await ui.advisor.open();
  ui.advisor.close();
  await ui.advisor.open();
  assert.equal(ui.calls('GET', '/api/advisor/sessions').length, 1, 'le sessioni si caricano una volta');
});

test('invio messaggio: bolla utente subito, poi la risposta con strumenti e costo', async () => {
  const ui = loadAdvisor();
  await ui.advisor.open();
  ui.elements.advisorInput.value = 'perché la posizione SOL è in rosso?';
  await ui.advisor.send();

  const post = ui.calls('POST', '/api/advisor/sessions/s1/messages')[0];
  assert.ok(post, 'messaggio inviato alla sessione attiva');
  assert.deepEqual(JSON.parse(post.body), { message: 'perché la posizione SOL è in rosso?' });

  const text = ui.transcript();
  assert.match(text, /perché la posizione SOL è in rosso\?/, 'il messaggio dell\'utente resta a schermo');
  assert.match(text, /Equity a \$1\.240/, 'la risposta del consulente è mostrata');
  assert.match(text, /get_account, get_risk_snapshot/, 'gli strumenti usati sono dichiarati');
  assert.match(text, /\$0\.0310/, 'il costo del turno è visibile');
  assert.equal(ui.elements.advisorInput.value, '', 'il campo si svuota dopo un invio riuscito');
  // Il residuo di budget arriva nella risposta del turno: va aggiornato subito.
  assert.equal(ui.advisor.budget.remainingUsd, 7.47);
  assert.match(ui.elements.advisorBudget.textContent, /residuo \$7\.47/);
});

test('un campo vuoto non produce nessuna chiamata', async () => {
  const ui = loadAdvisor();
  await ui.advisor.open();
  ui.elements.advisorInput.value = '   ';
  await ui.advisor.send();
  assert.equal(ui.calls('POST', '/api/advisor/sessions/s1/messages').length, 0);
});

test('BUDGET ESAURITO: mostra il messaggio del server e blocca gli invii successivi', async () => {
  const ui = loadAdvisor({
    routes: {
      // Forma reale del rifiuto: HTTP 200, `success:false`, messaggio leggibile
      // e `code` per distinguerlo senza interpretare il testo.
      'POST /api/advisor/sessions/s1/messages': {
        status: 200,
        body: {
          success: false, code: 'budget_exceeded',
          error: 'Budget mensile raggiunto: $10,00 su $10,00 — si sblocca il 1° del mese o alzando il budget da Telegram.'
        }
      }
    }
  });
  await ui.advisor.open();
  ui.elements.advisorInput.value = 'come sto andando?';
  await ui.advisor.send();

  // Il messaggio del server è già scritto per un umano: si mostra quello, non un generico.
  assert.match(ui.notice(), /Budget mensile raggiunto: \$10,00 su \$10,00/);
  assert.match(ui.notice(), /da Telegram/);
  assert.equal(ui.advisor.available, false);
  assert.equal(ui.elements.advisorSend.disabled, true);
  assert.equal(ui.elements.advisorInput.disabled, true);

  // Nessuna chiamata ulteriore: superata la soglia non si spende un altro token.
  ui.elements.advisorInput.value = 'e ora?';
  await ui.advisor.send();
  assert.equal(ui.calls('POST', '/api/advisor/sessions/s1/messages').length, 1);
  // Il testo dell'utente non viene perso quando l'invio è rifiutato a monte.
  assert.equal(ui.elements.advisorInput.value, 'e ora?');
});

test('un rifiuto passeggero NON spegne il campo di invio', async () => {
  // `turn_in_progress`, `message_too_long`, `session_not_found` sono rifiuti
  // temporanei: dirlo e restare utilizzabili. Trattarli come "advisor spento"
  // costringerebbe a ricaricare la pagina per un messaggio troppo lungo.
  for (const code of ['turn_in_progress', 'message_too_long', 'session_not_found']) {
    const ui = loadAdvisor({
      routes: {
        'POST /api/advisor/sessions/s1/messages': {
          status: 200, body: { success: false, code, error: `rifiuto ${code}` }
        }
      }
    });
    await ui.advisor.open();
    ui.elements.advisorInput.value = 'domanda';
    await ui.advisor.send();

    assert.match(ui.notice(), new RegExp(`rifiuto ${code}`), `${code}: il motivo va detto`);
    assert.equal(ui.advisor.available, true, `${code} non è un degrado`);
    assert.equal(ui.elements.advisorSend.disabled, false, `${code}: si può riprovare`);
  }
});

test('ADVISOR DISABILITATO: messaggio chiaro nel drawer, cockpit intatta', async () => {
  const ui = loadAdvisor({
    withPerps: true,
    routes: {
      // `/status` risponde 200 con `available:false` e il motivo: è così che
      // l'advisor di Bruno dichiara il degrado, non con un errore HTTP.
      'GET /api/advisor/status': {
        status: 200,
        body: { success: true, data: { enabled: false, available: false, code: 'agents_disabled', reason: 'Agenti AI disabilitati (AGENTS_ENABLED=false): il consulente non può rispondere.', retentionDays: 90 } }
      },
      'GET /api/advisor/budget': { status: 503, body: { success: false, error: 'budget non leggibile' } },
      'GET /api/advisor/sessions': { status: 200, body: { success: true, data: [] } }
    }
  });
  await ui.advisor.open();

  assert.match(ui.notice(), /Agenti AI disabilitati \(AGENTS_ENABLED=false\)/);
  assert.equal(ui.elements.advisorNotice.hidden, false);
  assert.equal(ui.advisor.available, false);
  assert.equal(ui.elements.advisorSend.disabled, true);
  assert.equal(ui.elements.advisorNewSession.disabled, true);
  assert.match(ui.elements.advisorBudget.textContent, /Budget —/);
  assert.match(ui.transcript(), /Il consulente non è attivo/);
  // Nessun turno parte: a consulente spento non si spende un token.
  ui.elements.advisorInput.value = 'ciao';
  await ui.advisor.send();
  assert.equal(ui.calls('POST', '/api/advisor/sessions/s1/messages').length, 0);

  // Il drawer resta apribile e chiudibile, e il resto della cockpit non se ne accorge:
  // `perps` è nello stesso contesto e continua a rispondere.
  ui.advisor.close();
  assert.equal(ui.advisor.isOpen, false);
  assert.equal(typeof ui.perps.switchCockpitTab, 'function');
  ui.perps.switchCockpitTab('positions');
  assert.equal(ui.perps.cockpitTab, 'positions');
});

test('nuova conversazione: la sessione creata diventa attiva e il transcript è vuoto', async () => {
  const ui = loadAdvisor();
  await ui.advisor.open();
  ui.elements.advisorNewSession.click();
  await new Promise(r => setImmediate(r));

  assert.equal(ui.calls('POST', '/api/advisor/sessions').length, 1);
  assert.equal(ui.advisor.activeSessionId, 's2');
  assert.equal(ui.advisor.messages.length, 0);
  assert.match(ui.transcript(), /Conversazione vuota/);
});

test('eliminazione conversazione: chiede conferma e chiama DELETE', async () => {
  const ui = loadAdvisor();
  await ui.advisor.open();
  const done = await ui.advisor.deleteSession();

  assert.equal(done, true);
  assert.equal(ui.confirms.length, 1);
  assert.match(ui.confirms[0], /Come sto andando\?/, 'la conferma nomina la conversazione');
  assert.match(ui.confirms[0], /non è recuperabile/);
  assert.equal(ui.calls('DELETE', '/api/advisor/sessions/s1').length, 1);
  assert.equal(ui.advisor.sessions.length, 0);
  assert.equal(ui.advisor.activeSessionId, null);
  assert.ok(ui.toasts.some(t => /eliminata/i.test(t.msg)));
});

test('conferma rifiutata: nessuna DELETE parte', async () => {
  const ui = loadAdvisor({ confirmAnswer: false });
  await ui.advisor.open();
  const done = await ui.advisor.deleteSession();
  assert.equal(done, false);
  assert.equal(ui.calls('DELETE', '/api/advisor/sessions/s1').length, 0);
  assert.equal(ui.advisor.sessions.length, 1);
});

test('eliminazione fallita: lo dice e non rimuove la sessione dalla lista', async () => {
  const ui = loadAdvisor({
    routes: { 'DELETE /api/advisor/sessions/s1': { status: 500, body: { success: false, error: 'database in sola lettura' } } }
  });
  await ui.advisor.open();
  const done = await ui.advisor.deleteSession();
  assert.equal(done, false);
  assert.match(ui.notice(), /database in sola lettura/);
  assert.equal(ui.advisor.sessions.length, 1, 'la lista non mente sullo stato del server');
});

test('il contenuto del modello non finisce mai in innerHTML', async () => {
  const ui = loadAdvisor({
    routes: {
      'GET /api/advisor/sessions/s1/messages': {
        status: 200,
        body: { success: true, data: [{ id: 'm1', role: 'assistant', content: '<img src=x onerror="alert(1)">', ts: 1_770_000_000_000 }] }
      }
    }
  });
  await ui.advisor.open();
  // Il markup del modello arriva come testo dentro un nodo, non come HTML.
  assert.match(ui.transcript(), /<img src=x onerror="alert\(1\)">/);
  assert.equal(ui.elements.advisorTranscript.innerHTML, '', 'il transcript non usa innerHTML per il contenuto');
});

test('VINCOLO EVM-01: advisor.js e perps.js non si leggono lo stato a vicenda', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const advisorSrc = strip(fs.readFileSync(ADVISOR_JS, 'utf8'));
  assert.equal(/(^|[^.\w])perps\s*\??\./.test(advisorSrc), false, 'advisor.js non deve toccare perps');
  assert.equal(/window\.perps/.test(advisorSrc), false, 'advisor.js non deve leggere window.perps');

  const perpsSrc = strip(fs.readFileSync(PERPS_JS, 'utf8'));
  assert.equal(/(^|[^.\w])advisor\s*\??\./.test(perpsSrc), false, 'perps.js non deve toccare advisor');
  assert.equal(/window\.advisor/.test(perpsSrc), false, 'perps.js non deve leggere window.advisor');
});

test('index.html: toggle accanto al pill wallet, drawer presente e advisor.js caricato', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');

  assert.match(markup, /<script src="advisor\.js/);
  assert.match(markup, /<link rel="stylesheet" href="styles_advisor\.css">/);

  // Il toggle sta ACCANTO al pill #walletStatus, non al suo posto: il pill resta
  // l'unico punto d'ingresso alla connessione MetaMask (EVM-01).
  assert.match(markup, /id="walletStatus"/);
  const wallet = markup.indexOf('id="walletStatus"');
  const toggle = markup.indexOf('id="advisorToggle"');
  assert.ok(toggle > wallet, 'il toggle del consulente segue il pill wallet nell\'header');
  const closeStatus = markup.indexOf('</div>', markup.indexOf('class="connection-status"'));
  assert.ok(toggle > 0 && closeStatus > 0, 'entrambi dentro .connection-status');

  // Il drawer è un <aside> nascosto, con tutti gli id che advisor.js cerca.
  assert.match(markup, /<aside id="advisorDrawer"[^>]*hidden>/);
  for (const id of DRAWER_IDS) {
    assert.match(markup, new RegExp(`id="${id}"`), `manca id="${id}" in index.html`);
  }
});
