/**
 * Nessun dato finto nel cockpit prima del primo dato reale — DEBT (Sprint 4, extra)
 * ================================================================================
 *
 * `public/index.html` nasceva da un mockup e ne aveva conservato i dati di
 * esempio **scritti nel markup**: tre alert inventati in `#cockpitAlerts`
 * ("NQ exposure above limit", "ICE feed 92ms"), quattro posizioni su ES/NQ/CL/GC
 * — mercati di future che su Hyperliquid non esistono — in
 * `#cockpitPositionsSummary` con PnL a quattro cifre, e una card SYSTEM HEALTH
 * con CME/ICE/COMEX a 28ms/31ms e "3/3 ONLINE".
 *
 * Restavano visibili finché `perps.js` non li sovrascriveva. Se la prima fetch
 * era lenta, o falliva, l'utente vedeva numeri plausibili e completamente falsi:
 * indistinguibili da quelli veri, esattamente il difetto già corretto altrove in
 * questo repo (la curva equity non sintetizza più una serie finta, i tile della
 * dashboard mostrano '—' invece di un valore di ripiego).
 *
 * Questi casi coprono le due metà del problema:
 *  1. il **markup statico** non contiene più nessun valore inventato;
 *  2. i **percorsi di fallimento** dichiarano che il dato non c'è, invece di
 *     lasciare a schermo quello che c'era prima.
 *
 * Come gli altri test di `public/*.js`: `node:vm` con DOM finto.
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

/** Markup senza commenti: i commenti citano di proposito le stringhe rimosse. */
function markup() {
  return fs.readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

/** Il solo pannello Dashboard, che è dove viveva il mockup. */
function dashboardPanel() {
  const html = markup();
  const start = html.indexOf('id="cockpit-panel-dashboard"');
  const end = html.indexOf('id="cockpit-panel-system"');
  assert.ok(start > 0 && end > start, 'pannello dashboard non individuato');
  return html.slice(start, end);
}

function fakeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', dataset: {}, hidden: false,
    disabled: false, style: {}, className: '',
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener: () => {},
    querySelector: () => null,
    hasClass: (c) => classes.has(c)
  };
}

const IDS = [
  'cockpitAlerts', 'cockpitRiskAlerts', 'cockpitAttentionCount', 'cockpitHeaderAlertBadge',
  'cockpitRiskBadge', 'cockpitRiskLiveCount', 'cockpitPositionsSummary', 'cockpitOpenPositionsCount',
  'cockpitHealthSummary', 'cockpitHealthFeed', 'cockpitHealthFeedDot', 'cockpitHealthBots',
  'cockpitHealthBotsDot', 'cockpitHealthOrders', 'cockpitHealthOrdersDot', 'cockpitHealthApi',
  'cockpitHealthApiDot', 'cockpitEquity', 'cockpitHeaderEquity', 'cockpitEquityEur',
  'cockpitHeaderEquityEur', 'cockpitNetPnl', 'cockpitNetPnlEur', 'cockpitUpdatedAt',
  'cockpitMarginUsed', 'cockpitMarginFree', 'cockpitMarginBar', 'cockpitDrawdown',
  'cockpitRiskUpdated', 'cockpitRiskStatus', 'cockpitRiskChecks', 'cockpitFxNote',
  'cockpitRiskEquity', 'cockpitRiskMargin', 'cockpitRiskExposure', 'cockpitMarginLimit',
  'cockpitRiskOpenPositions', 'cockpitRiskDrawdown', 'cockpitDrawdownStatus', 'cockpitRiskFeed',
  'killswitchBtn', 'killswitchState', 'walletStatus', 'view-perps'
];

/** Snapshot di rischio realistico, nella forma di `GET /api/perps/risk`. */
const SNAPSHOT = {
  generatedAt: 1_770_000_000_000,
  account: { equity: 1500, totalMarginUsed: 300, positions: [] },
  limits: {},
  orders: { open: 3, pending: 1, trigger: 2 },
  bots: { total: 4, running: 3, errors: 0, stale: 0 },
  system: { wsConnected: true, wsFresh: true },
  killSwitch: false,
  summary: { status: 'ok', actionable: 0 },
  alerts: [],
  sourceErrors: []
};

function loadCockpit({ riskFails = false } = {}) {
  const elements = Object.fromEntries(IDS.map(id => [id, fakeElement(id)]));
  const created = [];

  const sandbox = {
    console, BigInt, Map, Set, Date, JSON, Math, Number, String, Array, Object, Error, Promise,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '🤖 ArbitrageBot Perps',
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => {
        const node = {
          tagName: String(tag).toUpperCase(), textContent: '', className: '', children: [],
          appendChild(c) { this.children.push(c); return c; },
          get outerHTML() {
            const t = this.tagName.toLowerCase();
            const inner = this.children.map(c => c.outerHTML ?? c.textContent).join('');
            return `<${t}${this.className ? ` class="${this.className}"` : ''}>${this.textContent}${inner}</${t}>`;
          }
        };
        created.push(node);
        return node;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url) => {
      if (url.startsWith('/api/perps/risk')) {
        if (riskFails) return { ok: false, status: 503, json: async () => ({ success: false, error: 'snapshot di rischio non disponibile' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: SNAPSHOT }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    },
    alert: () => {}, confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  return { perps: sandbox.window.perps, elements, text: (id) => elements[id].textContent };
}

// ---------------------------------------------------------------- markup

test('MARKUP: nessuna posizione inventata — via ES/NQ/CL/GC e i loro PnL', () => {
  const panel = dashboardPanel();
  for (const symbol of ['>ES<', '>NQ<', '>CL<', '>GC<']) {
    assert.equal(panel.includes(symbol), false, `mercato inventato ${symbol} ancora nel markup`);
  }
  for (const amount of ['+$1,388', '+$1,275', '+$2,950', '+$650', '5842.25', '20155.00', '2658.40']) {
    assert.equal(panel.includes(amount), false, `valore inventato ${amount} ancora nel markup`);
  }
  // Invariante generale, non un elenco di stringhe: nel pannello Dashboard non
  // deve esistere NESSUN importo in dollari scritto a mano.
  const importi = panel.match(/[+-]?\$\s?[\d.,]+/g) || [];
  assert.deepEqual(importi, [], `importi in dollari nel markup statico: ${importi.join(', ')}`);
});

test('MARKUP: nessun alert inventato in #cockpitAlerts, ma uno stato di attesa', () => {
  const panel = dashboardPanel();
  const start = panel.indexOf('id="cockpitAlerts"');
  const box = panel.slice(start, panel.indexOf('cockpit-alert-legend', start));

  assert.equal(/class="cockpit-alert /.test(box), false, 'nessun <article class="cockpit-alert"> statico');
  for (const testo of ['NQ exposure above limit', 'Feed latency above threshold', '2 orders pending review', 'ICE feed reached 92ms']) {
    assert.equal(panel.includes(testo), false, `alert inventato ancora presente: "${testo}"`);
  }
  // Al posto loro uno stato onesto: non "nessun alert" (che è un'affermazione
  // che non possiamo fare prima del primo controllo), ma "in attesa".
  assert.match(box, /In attesa/i);
});

test('MARKUP: SYSTEM HEALTH senza borse inventate né latenze finte', () => {
  const panel = dashboardPanel();
  for (const finto of ['CME', 'COMEX', '28ms', '31ms', '92ms', '4ms · healthy', '3/3 ONLINE']) {
    assert.equal(panel.includes(finto), false, `valore inventato "${finto}" ancora in SYSTEM HEALTH`);
  }
  // ICE è una borsa vera ma estranea a Hyperliquid: spariscono sia la riga sia
  // l'id che nessuno ha mai scritto.
  assert.equal(panel.includes('cockpitIceLatency'), false, 'id mai scritto ancora nel markup');
  // Le voci reali sono quelle che lo snapshot di rischio sa davvero misurare.
  assert.match(panel, /Feed Hyperliquid/);
  assert.match(panel, /Bot watchdog/);
});

test('MARKUP: nessun conteggio inventato (posizioni aperte, alert da verificare)', () => {
  const panel = dashboardPanel();
  assert.equal(/OPEN POSITIONS <span[^>]*>\[4\]/.test(panel), false, 'il conteggio "[4]" era inventato');
  assert.match(panel, /id="cockpitOpenPositionsCount"[^>]*>—</);
  assert.match(panel, /id="cockpitAttentionCount"[^>]*>—</, '"0 alert" è un\'affermazione, prima dei dati va "—"');
});

test('MARKUP: nessun badge parte da "0" — è un conteggio senza misura', () => {
  const html = markup();
  for (const id of ['cockpitHeaderAlertBadge', 'cockpitRiskBadge', 'cockpitSystemBadge', 'cockpitRiskLiveCount']) {
    assert.match(html, new RegExp(`id="${id}">—<`), `${id} parte da un conteggio inventato`);
  }
});

test('MARKUP: nessun numero inventato negli attributi di accessibilità', () => {
  // Un aria-label con un valore fisso legge ad alta voce un numero inventato a
  // chi usa uno screen reader: è lo stesso difetto, solo meno visibile.
  assert.equal(/aria-label="[^"]*\d+\s*percent/i.test(markup()), false, 'aria-label con percentuale fissa');
});

test('MARKUP: la legenda del grafico non annuncia una serie che non esiste', () => {
  // Il grafico disegna una sola serie (equity). "Session high" veniva dal mockup.
  assert.equal(dashboardPanel().includes('Session high'), false);
});

// ------------------------------------------------------------- comportamento

test('primo render senza dati: attesa dichiarata, nessun conteggio inventato', () => {
  const ui = loadCockpit();
  ui.perps._refreshCockpitDashboard();

  assert.match(ui.elements.cockpitPositionsSummary.innerHTML, /In attesa/i,
    'senza dati del conto non si può dire "nessuna posizione aperta"');
  assert.equal(ui.text('cockpitOpenPositionsCount'), '—');
  assert.equal(ui.text('cockpitEquity'), '—');
  assert.equal(ui.text('cockpitHealthFeed'), '—');
  assert.equal(ui.elements.cockpitHealthFeedDot.className, 'cockpit-health-dot unknown',
    'pallino grigio: anche "è giù" sarebbe un\'affermazione');
});

test('con i dati reali: "nessuna posizione aperta" solo quando il conto ha risposto', async () => {
  const ui = loadCockpit();
  await ui.perps.refreshRiskSnapshot();

  assert.match(ui.elements.cockpitPositionsSummary.innerHTML, /Nessuna posizione aperta/);
  assert.equal(ui.text('cockpitOpenPositionsCount'), '[0]');
});

test('SYSTEM HEALTH mostra lo stato reale che lo snapshot misura davvero', async () => {
  const ui = loadCockpit();
  await ui.perps.refreshRiskSnapshot();

  assert.match(ui.text('cockpitHealthFeed'), /live · fresco/);
  assert.equal(ui.elements.cockpitHealthFeedDot.className, 'cockpit-health-dot ok');
  assert.match(ui.text('cockpitHealthBots'), /3\/4 attivi/);
  assert.match(ui.text('cockpitHealthOrders'), /2 protettivi/);
  assert.match(ui.text('cockpitHealthApi'), /ok/);
  assert.match(ui.text('cockpitHealthSummary'), /3\/3 OK/);
});

test('bot stale e fonti non disponibili: lo dice invece di dichiarare tutto verde', async () => {
  const ui = loadCockpit();
  ui.perps.riskSnapshot = { ...SNAPSHOT, bots: { total: 4, running: 3, stale: 2 }, sourceErrors: ['orders'] };
  ui.perps._renderSystemHealth(ui.perps.riskSnapshot);

  assert.match(ui.text('cockpitHealthBots'), /2 stale/);
  assert.equal(ui.elements.cockpitHealthBotsDot.className, 'cockpit-health-dot offline');
  assert.match(ui.text('cockpitHealthApi'), /1 fonti non disponibili/);
  assert.match(ui.text('cockpitHealthSummary'), /1\/3 OK/);
});

test('FETCH FALLITA: gli alert non restano quelli di prima, si dichiara il guasto', async () => {
  const ui = loadCockpit({ riskFails: true });
  await ui.perps.refreshRiskSnapshot();

  // È il caso che rendeva pericoloso il markup del mockup: senza questo, il
  // contenuto precedente (finto o vecchio) restava a schermo per sempre.
  assert.match(ui.elements.cockpitAlerts.innerHTML, /non disponibil/i);
  assert.match(ui.elements.cockpitAlerts.innerHTML, /snapshot di rischio non disponibile/);
  assert.match(ui.elements.cockpitRiskAlerts.innerHTML, /non disponibil/i);
  // Nessun contatore che affermi "zero condizioni da verificare".
  for (const id of ['cockpitHeaderAlertBadge', 'cockpitRiskBadge', 'cockpitAttentionCount', 'cockpitRiskLiveCount']) {
    assert.equal(ui.text(id), '—', `${id} non deve dire 0 quando il dato manca`);
  }
  assert.equal(ui.text('cockpitHealthFeed'), '—');
  assert.equal(ui.elements.cockpitHealthFeedDot.className, 'cockpit-health-dot unknown');
});

test('il messaggio di errore del server viene escapato, non interpretato', async () => {
  const ui = loadCockpit({ riskFails: true });
  ui.perps.api = async () => { throw new Error('<img src=x onerror="alert(1)">'); };
  await ui.perps.refreshRiskSnapshot();
  assert.match(ui.elements.cockpitAlerts.innerHTML, /&lt;img src=x/);
  assert.equal(ui.elements.cockpitAlerts.innerHTML.includes('<img'), false);
});
