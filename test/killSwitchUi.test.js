/**
 * UI del kill-switch (public/perps.js)
 * ====================================
 *
 * Il kill-switch è un flag persistito su DB: prima di questo test l'unico modo di
 * spegnerlo era chiamare l'endpoint dalla console del browser, perché l'interfaccia
 * esponeva solo l'attivazione. Questi casi coprono la regressione che conta:
 * il bottone di riattivazione deve comparire *solo* a kill-switch attivo, e deve
 * chiamare `POST /api/agents/killswitch` con `{on:false}` dopo una conferma.
 *
 * `public/perps.js` è uno script di browser (nessun export): viene caricato in un
 * contesto `node:vm` con un DOM finto minimale — zero dipendenze aggiuntive, nessun
 * headless browser. Coperto quindi il comportamento della classe, non il rendering
 * reale: la corrispondenza degli id con `public/index.html` è verificata a mano.
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

/** Elemento DOM finto: solo ciò che perps.js usa davvero (textContent + classList). */
function fakeElement(id, initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    id,
    textContent: '',
    title: '',
    innerHTML: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c);
        else classes.delete(c);
        return classes.has(c);
      }
    },
    hasClass: (c) => classes.has(c)
  };
}

/** Carica perps.js in un contesto isolato e ritorna l'istanza + le sonde. */
function loadPerpsUi({ confirmResult = true } = {}) {
  const elements = {
    // Stato iniziale identico a quello dell'HTML: bottone nascosto di default.
    killswitchResumeBtn: fakeElement('killswitchResumeBtn', ['hidden']),
    killswitchState: fakeElement('killswitchState')
  };
  const requests = [];
  const toasts = [];
  const confirms = [];

  const sandbox = {
    console,
    BigInt,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method, body: opts.body });
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    },
    app: { showToast: (msg, type) => toasts.push({ msg, type }) },
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
  // loadAgents/loadBots fanno altre chiamate di refresh: fuori dal perimetro qui.
  perps.loadAgents = async () => {};
  perps.loadBots = async () => {};

  return {
    perps,
    requests,
    toasts,
    confirms,
    resumeHidden: () => elements.killswitchResumeBtn.hasClass('hidden'),
    stateLabel: () => elements.killswitchState.textContent
  };
}

test('kill-switch spento: bottone di riattivazione nascosto e nessuna etichetta di allarme', () => {
  const ui = loadPerpsUi();
  ui.perps._setKillSwitchUi(false);
  assert.equal(ui.resumeHidden(), true);
  assert.equal(ui.stateLabel(), '');
});

test('kill-switch attivo: bottone di riattivazione visibile con etichetta di blocco', () => {
  const ui = loadPerpsUi();
  ui.perps._setKillSwitchUi(true);
  assert.equal(ui.resumeHidden(), false);
  assert.match(ui.stateLabel(), /ATTIVO/);
});

test('killSwitch assente nella risposta: il bottone resta nascosto (nessun falso invito a riattivare)', () => {
  const ui = loadPerpsUi();
  ui.perps._setKillSwitchUi(true);
  ui.perps._setKillSwitchUi(undefined);
  assert.equal(ui.resumeHidden(), true);
});

test('resumeFromKillSwitch: chiede conferma, chiama {on:false} e aggiorna l\'UI senza refresh manuale', async () => {
  const ui = loadPerpsUi();
  ui.perps._setKillSwitchUi(true);
  await ui.perps.resumeFromKillSwitch();

  assert.equal(ui.confirms.length, 1, 'la conferma va chiesta prima di eseguire');
  const req = ui.requests.find(r => r.url === '/api/agents/killswitch');
  assert.ok(req, 'chiamato POST /api/agents/killswitch');
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body), { on: false });
  // Nessun /api/perps/killswitch: quella rotta riattiverebbe il flag, non lo spegne.
  assert.equal(ui.requests.some(r => r.url === '/api/perps/killswitch'), false);
  assert.equal(ui.resumeHidden(), true, 'il bottone sparisce subito dopo la riattivazione');
  assert.equal(ui.stateLabel(), '');
});

test('resumeFromKillSwitch: conferma negata non chiama nulla e lascia il kill-switch attivo', async () => {
  const ui = loadPerpsUi({ confirmResult: false });
  ui.perps._setKillSwitchUi(true);
  await ui.perps.resumeFromKillSwitch();

  assert.equal(ui.requests.length, 0);
  assert.equal(ui.resumeHidden(), false);
  assert.match(ui.stateLabel(), /ATTIVO/);
});

test('la conferma di riattivazione dichiara che i bot non ripartono da soli', async () => {
  const ui = loadPerpsUi();
  await ui.perps.resumeFromKillSwitch();
  // riskAgent.setKillSwitch(false) scrive solo il setting: nessun bot viene riavviato.
  assert.match(ui.confirms[0], /NON ripartono/);
});

test('index.html espone gli id usati dalla UI del kill-switch', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  assert.match(html, /id="killswitchResumeBtn"/);
  assert.match(html, /id="killswitchState"/);
  // Nascosto di default: senza `hidden` comparirebbe anche a kill-switch spento.
  assert.match(html, /class="btn btn-sm btn-success hidden" id="killswitchResumeBtn"/);
  assert.match(html, /perps\.resumeFromKillSwitch\(\)/);
});
