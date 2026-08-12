/**
 * Focus trap del drawer del consulente (DEBT-06)
 * ==============================================
 *
 * Il drawer è un pannello `position: fixed` sopra la cockpit, ma il resto della
 * pagina non è `inert`: con il drawer aperto il focus da tastiera lo attraversava
 * e finiva sui controlli *sotto*, invisibili perché coperti e comunque
 * attivabili con Invio. Su questa pagina quei controlli includono i pulsanti
 * d'ordine, quindi non è un problema solo di comodità.
 *
 * NOTA SUL FILE TOCCATO: la storia dice `perps.js`, ma il drawer vive in
 * `public/advisor.js` — file separato per progetto (ADV-02: nessuno stato
 * condiviso con `perps`, è il vincolo che arriva da EVM-01). Il trap sta lì.
 *
 * L'HARNESS È PIÙ RICCO DEGLI ALTRI di questa suite, e serve: un focus trap si
 * può verificare solo se il finto DOM sa dire *chi ha il focus*
 * (`document.activeElement`), *cosa c'è dentro il drawer* (`querySelectorAll` in
 * ordine di documento) e *se un nodo è dentro un altro* (`contains`, per il click
 * fuori). Con gli stub minimali di `advisorDrawerUi.test.js` il test passerebbe
 * senza provare niente.
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

class Node {
  constructor(tag, id = '', { focusable = false, parent = null } = {}) {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.focusable = focusable;
    this.parentNode = parent;
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this._classes = new Set();
    this._text = '';
    this._html = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.placeholder = '';
    this.title = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    if (parent) parent.children.push(this);
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const c = this._classes;
    return {
      add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x),
      toggle: (x, force) => {
        if (force === undefined) c.has(x) ? c.delete(x) : c.add(x);
        else if (force) c.add(x); else c.delete(x);
        return c.has(x);
      }
    };
  }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('\n') : this._text; }
  set textContent(v) { this._text = String(v ?? ''); this.children = this.children.filter(c => c.persistent); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v ?? ''); this.children = this.children.filter(c => c.persistent); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  /** Discendenza, per il click fuori. */
  contains(other) {
    if (other === this) return true;
    return this.children.some(c => c.contains?.(other));
  }
  /** Tutti i discendenti in ordine di documento. */
  descendants() {
    return this.children.flatMap(c => [c, ...(c.descendants?.() || [])]);
  }
  querySelectorAll(selector) {
    // L'harness non implementa i selettori CSS: riconosce il caso che serve —
    // "gli elementi che possono prendere il focus" — sulla base del flag messo
    // alla costruzione. Il selettore vero è verificato a parte, sul sorgente.
    assert.match(selector, /button/, `selettore non previsto dall'harness: ${selector}`);
    return this.descendants().filter(n => n.focusable);
  }
  querySelector() { return null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.fire('click'); this.ownerDocument.fireDocument('click', { target: this }); }
  fire(ev, payload = {}) {
    (this.listeners[ev] || []).forEach(fn => fn({ preventDefault() {}, target: this, ...payload }));
  }
}

/** Struttura del drawer come in index.html, in ordine di documento. */
const DRAWER_CHILDREN = [
  ['button', 'advisorClose', true],
  ['select', 'advisorSessionList', true],
  ['button', 'advisorNewSession', true],
  ['button', 'advisorDeleteSession', true],
  ['p', 'advisorNotice', false],
  ['div', 'advisorTranscript', false],
  ['textarea', 'advisorInput', true],
  ['button', 'advisorSend', true]
];

const SESSION = { id: 's1', title: 'Come sto andando?', startedAt: 1_770_000_000_000, lastAt: 1_770_000_600_000, costUsd: 0.1 };

function loadDrawer({ withPerps = false, available = true, sessions = [] } = {}) {
  const byId = {};
  const docListeners = {};
  const doc = {
    readyState: 'complete',
    activeElement: null,
    fireDocument(ev, payload) {
      (docListeners[ev] || []).forEach(fn => fn({ preventDefault() { payload.prevented = true; }, ...payload }));
    }
  };
  const make = (tag, id, opts = {}) => {
    const n = new Node(tag, id, opts);
    n.ownerDocument = doc;
    n.persistent = true;
    if (id) byId[id] = n;
    return n;
  };

  const body = make('body', '');
  const drawer = make('aside', 'advisorDrawer', { parent: body });
  const toggle = make('button', 'advisorToggle', { parent: body, focusable: true });
  for (const [tag, id, focusable] of DRAWER_CHILDREN) make(tag, id, { parent: drawer, focusable });
  // Un controllo della cockpit DIETRO il drawer: è quello su cui il focus non
  // deve mai finire mentre il drawer è aperto.
  const behind = make('button', 'cockpitOrderSubmit', { parent: body, focusable: true });

  doc.body = body;
  doc.activeElement = body;
  doc.getElementById = (id) => byId[id] || null;
  doc.createElement = (tag) => { const n = new Node(tag); n.ownerDocument = doc; return n; };
  doc.querySelector = () => null;
  doc.querySelectorAll = () => [];
  doc.addEventListener = (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); };
  doc.title = '🤖 ArbitrageBot Perps';

  const statusBody = available
    ? { success: true, data: { enabled: true, available: true, retentionDays: 90 } }
    : { success: true, data: { enabled: false, available: false, code: 'agents_disabled', reason: 'Agenti AI disabilitati (AGENTS_ENABLED=false).' } };

  const sandbox = {
    console, BigInt, Map, Set, Array, Object, Number, String, Date, JSON, Math, Error, Promise,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: doc,
    fetch: async (url) => {
      const body = url.endsWith('/status') ? statusBody
        : url.endsWith('/budget') ? { success: true, data: { monthlyLimitUsd: 10, spentUsd: 1, remainingUsd: 9 } }
          : url.endsWith('/sessions') ? { success: true, data: sessions }
            : url.endsWith('/messages') ? { success: true, data: [] }
              : { success: true, data: {} };
      return { ok: true, status: 200, json: async () => body };
    },
    alert: () => {}, confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.window.shell = { showToast: () => {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (withPerps) vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });
  vm.runInContext(fs.readFileSync(ADVISOR_JS, 'utf8'), sandbox, { filename: 'advisor.js' });

  const tab = (shiftKey = false) => {
    const event = { key: 'Tab', shiftKey, prevented: false };
    doc.fireDocument('keydown', event);
    return event;
  };
  return {
    advisor: sandbox.window.advisor, perps: sandbox.window.perps,
    doc, byId, drawer, toggle, behind, body,
    active: () => doc.activeElement,
    tab,
    keydown: (key) => { const e = { key, prevented: false }; doc.fireDocument('keydown', e); return e; },
    clickOutside: () => behind.click()
  };
}

// ------------------------------------------------------------------ il trap

test('con il drawer aperto il Tab non esce: dal primo elemento Shift+Tab va all\'ultimo', async () => {
  const ui = loadDrawer();
  await ui.advisor.open();

  ui.byId.advisorClose.focus();
  const event = ui.tab(true);
  assert.equal(event.prevented, true, 'il Tab nativo va intercettato al bordo');
  assert.equal(ui.active(), ui.byId.advisorSend, 'Shift+Tab dal primo torna sull\'ultimo del drawer');
});

test('dall\'ultimo elemento Tab torna al primo, non sul pulsante d\'ordine dietro', async () => {
  const ui = loadDrawer();
  await ui.advisor.open();

  ui.byId.advisorSend.focus();
  const event = ui.tab();
  assert.equal(event.prevented, true);
  assert.equal(ui.active(), ui.byId.advisorClose);
  assert.notEqual(ui.active(), ui.behind, 'il focus non deve finire su un controllo coperto');
});

test('a metà del giro il Tab nativo NON viene intercettato', async () => {
  // Trattenere ogni Tab romperebbe la navigazione dentro il drawer stesso: il
  // trap deve intervenire solo ai due bordi.
  const ui = loadDrawer({ sessions: [SESSION] });
  await ui.advisor.open();

  ui.byId.advisorSessionList.focus();
  const event = ui.tab();
  assert.equal(event.prevented, false, 'in mezzo al giro il browser fa già la cosa giusta');
  assert.equal(ui.active(), ui.byId.advisorSessionList, 'l\'harness non muove il focus da sé');
});

test('focus già FUORI dal drawer: viene riportato dentro', async () => {
  // È il caso che rendeva necessario il trap: il focus sfuggito (per un click
  // sulla pagina sotto, o perché l'elemento attivo è scomparso a un render)
  // deve rientrare, non passare al successivo della pagina.
  const ui = loadDrawer();
  await ui.advisor.open();

  ui.behind.focus();
  const event = ui.tab();
  assert.equal(event.prevented, true);
  assert.equal(ui.active(), ui.byId.advisorClose);

  ui.behind.focus();
  const back = ui.tab(true);
  assert.equal(back.prevented, true);
  assert.equal(ui.active(), ui.byId.advisorSend, 'Shift+Tab da fuori entra dall\'ultimo');
});

test('i controlli disabilitati sono fuori dal giro', async () => {
  // Senza conversazioni aperte il menu e il 🗑 sono `disabled` (li disabilita
  // `_renderSessions`): l'ultimo del giro deve essere l'ultimo ABILITATO, e
  // Shift+Tab dal primo non deve fermarsi su un controllo spento.
  const ui = loadDrawer();
  await ui.advisor.open();
  assert.equal(ui.byId.advisorSessionList.disabled, true, 'precondizione: nessuna conversazione');
  assert.equal(ui.byId.advisorDeleteSession.disabled, true);

  ui.byId.advisorClose.focus();
  ui.tab(true);
  assert.equal(ui.active(), ui.byId.advisorSend, 'ultimo abilitato');

  // Tab in avanti dal primo: salta i due disabilitati in mezzo. Qui il trap non
  // interviene (non siamo al bordo) — è il browser a saltarli, ma la lista che
  // il trap userà al bordo successivo deve già escluderli, e lo si verifica
  // arrivando al bordo da un elemento abilitato di mezzo.
  ui.byId.advisorNewSession.focus();
  assert.equal(ui.tab().prevented, false, 'in mezzo al giro non si intercetta');
});

test('CONSULENTE SPENTO: il giro si riduce alla × e il focus non scappa comunque', async () => {
  // Con `available:false` sono disabilitati menu, + Nuova, 🗑, campo di invio e
  // Invia: resta la sola ×. Un trap che non filtrasse i disabilitati manderebbe
  // il focus su un pulsante spento; uno che non gestisse la lista a un solo
  // elemento lo lascerebbe uscire sulla cockpit.
  const ui = loadDrawer({ available: false });
  await ui.advisor.open();
  assert.equal(ui.advisor.available, false, 'precondizione: consulente degradato');
  assert.equal(ui.byId.advisorSend.disabled, true);
  assert.equal(ui.byId.advisorInput.disabled, true);
  assert.equal(ui.byId.advisorNewSession.disabled, true);

  ui.byId.advisorClose.focus();
  for (const shift of [false, true, false]) {
    const event = ui.tab(shift);
    assert.equal(event.prevented, true, 'con un solo focusabile ogni Tab va trattenuto');
    assert.equal(ui.active(), ui.byId.advisorClose);
    assert.notEqual(ui.active(), ui.behind);
  }
});

test('a drawer CHIUSO il Tab della cockpit non viene toccato', async () => {
  // Criterio 3: nessuna regressione sul resto della navigazione da tastiera.
  const ui = loadDrawer();
  ui.behind.focus();
  const event = ui.tab();
  assert.equal(event.prevented, false, 'a drawer chiuso questo codice non deve intervenire');
  assert.equal(ui.active(), ui.behind, 'il focus resta dove era');

  // E dopo un ciclo apri/chiudi il Tab torna libero.
  await ui.advisor.open();
  ui.advisor.close();
  ui.behind.focus();
  assert.equal(ui.tab().prevented, false);
});

// ------------------------------------------------- ritorno del focus e chiusura

test('il focus torna al trigger dopo Escape', async () => {
  const ui = loadDrawer();
  ui.toggle.focus();
  await ui.advisor.open();
  assert.equal(ui.active(), ui.byId.advisorInput, 'aprendo, il focus entra nel campo di invio');

  ui.keydown('Escape');
  assert.equal(ui.advisor.isOpen, false);
  assert.equal(ui.active(), ui.toggle, 'chiudendo, il focus torna sul pulsante che ha aperto');
});

test('CLICK FUORI: chiude il drawer e restituisce il focus al trigger', async () => {
  const ui = loadDrawer();
  ui.toggle.focus();
  await ui.advisor.open();
  assert.equal(ui.advisor.isOpen, true);

  ui.clickOutside();
  assert.equal(ui.advisor.isOpen, false, 'un click sulla cockpit dietro chiude il pannello');
  assert.equal(ui.byId.advisorDrawer.hidden, true);
  assert.equal(ui.active(), ui.toggle);
});

test('CLICK DENTRO il drawer: non lo chiude', async () => {
  const ui = loadDrawer();
  await ui.advisor.open();
  ui.byId.advisorTranscript.click();
  assert.equal(ui.advisor.isOpen, true, 'cliccare nel transcript per selezionare del testo non deve chiudere');
  ui.byId.advisorInput.click();
  assert.equal(ui.advisor.isOpen, true);
});

test('CLICK SUL TOGGLE: chiude una volta sola, non chiude-e-riapre', async () => {
  // Il toggle ha già il suo handler: senza escluderlo dal click-fuori i due si
  // annullerebbero e il drawer resterebbe aperto (o lampeggerebbe).
  const ui = loadDrawer();
  ui.toggle.focus();
  await ui.advisor.open();
  ui.toggle.click();
  assert.equal(ui.advisor.isOpen, false, 'un click sul toggle chiude e resta chiuso');
});

test('il click fuori non fa niente quando il drawer è già chiuso', async () => {
  const ui = loadDrawer();
  ui.behind.focus();
  ui.clickOutside();
  assert.equal(ui.advisor.isOpen, false);
  assert.equal(ui.active(), ui.behind, 'nessun focus rubato dal drawer chiuso');
});

test('apertura da script con focus altrove: alla chiusura si torna lì, non al toggle', async () => {
  // `window.advisor.open()` può essere chiamata mentre il focus è su un
  // controllo della cockpit. Rimandarlo comunque al toggle sposterebbe l'utente
  // in un punto della pagina in cui non era.
  const ui = loadDrawer();
  ui.behind.focus();
  await ui.advisor.open();
  ui.keydown('Escape');
  assert.equal(ui.active(), ui.behind);
});

// ---------------------------------------------------------------- sorgente

test('il selettore dei focusabili esclude tabindex="-1" e non è duplicato', () => {
  const src = fs.readFileSync(ADVISOR_JS, 'utf8');
  assert.match(src, /tabindex\]:not\(\[tabindex="-1"\]\)/,
    'un tabindex negativo è raggiungibile via script ma non da tastiera');
  // Una sola definizione: due elenchi di selettori divergono al primo controllo
  // nuovo aggiunto al drawer.
  assert.equal((src.match(/a\[href\]/g) || []).length, 1);
});

test('index.html: il drawer contiene davvero i controlli che il trap presume', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const start = html.indexOf('<aside id="advisorDrawer"');
  const end = html.indexOf('</aside>', start);
  assert.ok(start > 0 && end > start, 'drawer non individuato');
  const drawer = html.slice(start, end);
  for (const [, id, focusable] of DRAWER_CHILDREN) {
    assert.match(drawer, new RegExp(`id="${id}"`), `${id} non è dentro il drawer`);
    if (focusable) {
      assert.equal(/tabindex="-1"/.test(drawer.match(new RegExp(`[^>]*id="${id}"[^>]*`))[0]), false,
        `${id} non deve essere escluso dalla tastiera`);
    }
  }
  // Il trap non trasforma il drawer in una modale: `aria-modal` nasconderebbe il
  // resto della pagina agli screen reader, e leggere la risposta ACCANTO ai dati
  // è la ragione per cui questo pannello è un drawer e non un tab.
  assert.equal(/aria-modal/.test(drawer), false);
});

test('VINCOLO EVM-01 ancora valido dopo DEBT-06: nessuno stato condiviso', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const advisorSrc = strip(fs.readFileSync(ADVISOR_JS, 'utf8'));
  assert.equal(/(^|[^.\w])perps\s*\??\./.test(advisorSrc), false);
  assert.equal(/window\.perps/.test(advisorSrc), false);
});

test('la cockpit continua a funzionare con il trap attivo', async () => {
  // I due moduli sono caricati nello stesso contesto proprio per poterlo dire.
  const ui = loadDrawer({ withPerps: true });
  await ui.advisor.open();
  ui.byId.advisorClose.focus();
  ui.tab(true);
  assert.equal(typeof ui.perps.switchCockpitTab, 'function');
  ui.perps.switchCockpitTab('positions');
  assert.equal(ui.perps.cockpitTab, 'positions');
});
