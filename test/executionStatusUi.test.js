/**
 * Card EXECUTION STATUS onesta (DEBT-03) + segno degli importi negativi (DEBT-04)
 * ==============================================================================
 *
 * DEBT-03. La card era l'ultima superficie non onesta della cockpit: tre id nel
 * markup che `perps.js` non scriveva mai (`#cockpitFills`, `#cockpitPending`,
 * `#cockpitRejectRate`, fissi a '—'), un badge "LIVE" verde e una riga
 * "Queue health: Stable" scritti a mano. Su un pannello di trading "Stable" non è
 * un'etichetta, è un'affermazione: diceva che la coda di esecuzione era in salute
 * anche a server spento.
 *
 * I casi coprono le tre metà del problema:
 *  1. il **markup statico** non afferma più niente (nessun "LIVE", nessuno
 *     "Stable", nessun id orfano);
 *  2. la **derivazione** distingue tre stati e non due — `null` è "non lo so",
 *     `0` è una misura;
 *  3. il **rendering** scrive quei tre stati, e il percorso di fallimento li
 *     riporta a "non lo so" invece di lasciare a schermo l'ultimo valore letto.
 *
 * DEBT-04. `fmtUsd()` produceva `$-12.34`, e due chiamanti rimediavano con un
 * `.replace('$-', '-$')` copiato a mano: ogni altro punto della cockpit che
 * stampasse un valore negativo mostrava la forma sbagliata. I casi qui sotto
 * verificano la funzione e l'assenza del replace nel sorgente, che è il solo modo
 * di impedire che rientri per copia-incolla.
 *
 * Come gli altri test di `public/*.js`: `node:vm` con DOM finto, zero dipendenze.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveExecutionStatus, EXECUTION_FILL_WINDOW_MIN } from '../src/perps/riskSnapshot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');
const INDEX_HTML = path.join(HERE, '..', 'public', 'index.html');

/** Markup senza commenti: i commenti citano di proposito le stringhe rimosse. */
function markup() {
  return fs.readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

/** Il solo blocco della card EXECUTION STATUS. */
function executionCard() {
  const html = markup();
  const start = html.indexOf('aria-labelledby="execution-status-title"');
  assert.ok(start > 0, 'card EXECUTION STATUS non individuata');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

function fakeElement(id) {
  return { id, textContent: '', innerHTML: '', className: '', style: {}, hidden: false,
    dataset: {}, value: '', disabled: false,
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
    addEventListener: () => {}, querySelector: () => null };
}

const IDS = [
  'cockpitExecMode', 'cockpitFills', 'cockpitFillsLabel', 'cockpitPending',
  'cockpitQueueDepth', 'cockpitQueueHealth',
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
  'cockpitRealized', 'cockpitUnrealized', 'killswitchBtn', 'killswitchState', 'walletStatus'
];

/** Snapshot nella forma di `GET /api/perps/risk`, incluso il blocco `execution`. */
const SNAPSHOT = {
  generatedAt: 1_770_000_000_000,
  account: { equity: 1500, totalMarginUsed: 300, positions: [] },
  limits: { maxTotalExposureUsd: 5000 },
  orders: { open: 3, pending: 1, trigger: 2 },
  bots: { total: 4, running: 3, errors: 0, stale: 0 },
  system: { wsConnected: true, wsFresh: true },
  killSwitch: false,
  summary: { status: 'ok', actionable: 0 },
  alerts: [],
  execution: {
    windowMin: 5, fills: 7, pendingProposals: 2,
    queueDepth: 0, queueThreshold: 10, queueState: 'idle', mode: 'live'
  },
  sourceErrors: []
};

function loadCockpit({ snapshot = SNAPSHOT, riskFails = false } = {}) {
  const elements = Object.fromEntries(IDS.map(id => [id, fakeElement(id)]));
  const sandbox = {
    console, BigInt, Map, Set, Date, JSON, Math, Number, String, Array, Object, Error, Promise,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '🤖 ArbitrageBot Perps',
      getElementById: (id) => elements[id] || null,
      createElement: () => ({ textContent: '', className: '', children: [], appendChild() {}, outerHTML: '' }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url) => {
      if (url.startsWith('/api/perps/risk')) {
        if (riskFails) return { ok: false, status: 503, json: async () => ({ success: false, error: 'snapshot non disponibile' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: snapshot }) };
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

// ------------------------------------------------------------------ markup

test('MARKUP: la card non afferma più niente — via "LIVE" verde e "Queue health: Stable"', () => {
  const card = executionCard();
  assert.equal(card.includes('Stable'), false, '"Stable" era uno stato dichiarato senza misurarlo');
  assert.equal(/>LIVE</.test(card), false, '"LIVE" fisso nel markup afferma che l\'esecuzione è attiva');
  assert.equal(card.includes('cockpit-positive'), false, 'nessun verde di default nella card');
  // Il badge esiste ma parte da "ignoto", e lo scrive il codice.
  assert.match(card, /id="cockpitExecMode"[^>]*>—</);
});

test('MARKUP: nessun id orfano e nessun valore di partenza diverso da "—"', () => {
  const card = executionCard();
  // #cockpitRejectRate era un id che nessuno scriveva mai: rimosso insieme alla riga.
  assert.equal(markup().includes('cockpitRejectRate'), false, 'id mai scritto ancora nel markup');
  for (const id of ['cockpitFills', 'cockpitPending', 'cockpitQueueDepth', 'cockpitQueueHealth']) {
    assert.match(card, new RegExp(`id="${id}"[^>]*>—<`), `${id} deve partire da "—"`);
  }
  // La riga delle proposte era `class="cockpit-warning"` fissa: anche uno zero o
  // un '—' venivano mostrati in giallo, come una cosa da guardare.
  assert.equal(/id="cockpitPending" class=/.test(card), false);
  assert.equal(/class="[^"]*" id="cockpitPending"/.test(card), false);
});

test('MARKUP: ogni id che il renderer scrive esiste davvero in index.html', () => {
  // Il difetto originale era proprio questo: id nel markup senza codice che li
  // scriva, e (simmetrico) codice che scrive id inesistenti. Nessuno dei due
  // fallisce a runtime, entrambi lasciano la card muta.
  const src = fs.readFileSync(PERPS_JS, 'utf8');
  const body = src.slice(src.indexOf('_renderExecutionStatus(snapshot) {'));
  const end = body.indexOf('\n  _dashboardEquityData');
  const written = [...body.slice(0, end).matchAll(/'(cockpit[A-Za-z]+)'/g)].map(m => m[1]);
  assert.ok(written.length >= 5, 'id scritti dal renderer non individuati');
  const html = markup();
  for (const id of new Set(written)) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} scritto da perps.js ma assente in index.html`);
  }
});

// -------------------------------------------------------------- derivazione

test('DERIVAZIONE: zero è una misura, null è "non lo so"', () => {
  const now = 1_770_000_000_000;
  // Storico letto e vuoto: 0 fill è un'informazione vera.
  const letto = deriveExecutionStatus({ now, fills: [], fillsAvailable: true, queue: { max: 0, threshold: 10 } });
  assert.equal(letto.fills, 0);
  // Storico NON letto: l'array vuoto del catch non deve diventare uno zero.
  const nonLetto = deriveExecutionStatus({ now, fills: [], fillsAvailable: false, queue: { max: 0, threshold: 10 } });
  assert.equal(nonLetto.fills, null, 'una lettura fallita non può affermare "nessuna operazione"');
});

test('DERIVAZIONE: conta solo i fill dentro la finestra dichiarata', () => {
  const now = 1_770_000_000_000;
  const min = (n) => now - n * 60 * 1000;
  const fills = [{ time: min(1) }, { time: min(4) }, { time: min(6) }, { time: min(120) }];
  const out = deriveExecutionStatus({ now, fills, fillsAvailable: true });
  assert.equal(out.windowMin, EXECUTION_FILL_WINDOW_MIN);
  assert.equal(out.fills, 2, 'i fill più vecchi della finestra non contano');
});

test('DERIVAZIONE: stato della coda dai dati di WARN-02, soglia compresa', () => {
  const base = { now: 1, fills: [], fillsAvailable: true };
  assert.equal(deriveExecutionStatus({ ...base, queue: { max: 0, threshold: 10 } }).queueState, 'idle');
  assert.equal(deriveExecutionStatus({ ...base, queue: { max: 3, threshold: 10 } }).queueState, 'busy');
  assert.equal(deriveExecutionStatus({ ...base, queue: { max: 11, threshold: 10 } }).queueState, 'warning');
  // Senza fotografia della coda non si dichiara "in salute": è il difetto che
  // "Queue health: Stable" incarnava.
  const muto = deriveExecutionStatus({ ...base, queue: null });
  assert.equal(muto.queueState, 'unknown');
  assert.equal(muto.queueDepth, null);
  assert.equal(muto.queueThreshold, null);
});

test('DERIVAZIONE: il badge non dice LIVE quando l\'esecuzione non è live', () => {
  const base = { now: 1, fills: [], fillsAvailable: true, queue: { max: 0, threshold: 10 } };
  assert.equal(deriveExecutionStatus({ ...base, botsRunning: 2 }).mode, 'live');
  assert.equal(deriveExecutionStatus({ ...base, botsRunning: 0 }).mode, 'idle');
  // Il kill-switch vince su tutto: con le aperture bloccate "LIVE" sarebbe falso
  // anche con dieci bot in marcia.
  assert.equal(deriveExecutionStatus({ ...base, botsRunning: 10, killSwitch: true }).mode, 'blocked');
  assert.equal(deriveExecutionStatus({ ...base, botsRunning: null }).mode, 'unknown');
});

test('DERIVAZIONE: le proposte non leggibili non diventano zero', () => {
  const base = { now: 1, fills: [], fillsAvailable: true, queue: { max: 0, threshold: 10 } };
  assert.equal(deriveExecutionStatus({ ...base, pendingProposals: 0 }).pendingProposals, 0);
  assert.equal(deriveExecutionStatus({ ...base, pendingProposals: 4 }).pendingProposals, 4);
  assert.equal(deriveExecutionStatus({ ...base, pendingProposals: 4, proposalsAvailable: false }).pendingProposals, null);
  assert.equal(deriveExecutionStatus({ ...base }).pendingProposals, null, 'default: non interrogate');
});

test('DERIVAZIONE: nessun campo per un tasso di rifiuto che nessuno misura', () => {
  const out = deriveExecutionStatus({ now: 1, fills: [], fillsAvailable: true });
  const suspicious = Object.keys(out).filter(k => /reject|rifiut/i.test(k));
  assert.deepEqual(suspicious, [], 'un campo "reject" senza fonte inviterebbe a inventarne il valore');
});

// --------------------------------------------------------------- rendering

test('PRIMO RENDER senza snapshot: la card dichiara di non sapere', () => {
  const ui = loadCockpit();
  ui.perps._refreshCockpitDashboard();

  for (const id of ['cockpitFills', 'cockpitPending', 'cockpitQueueDepth', 'cockpitQueueHealth', 'cockpitExecMode']) {
    assert.equal(ui.text(id), '—', `${id} deve dire "non lo so" prima del primo dato`);
  }
  assert.equal(ui.elements.cockpitExecMode.className, 'cockpit-surface-note',
    'nessun colore di stato prima di aver misurato');
  assert.equal(ui.elements.cockpitQueueHealth.className, '');
});

test('CON I DATI REALI: quattro righe misurate e il badge derivato', async () => {
  const ui = loadCockpit();
  await ui.perps.refreshRiskSnapshot();

  assert.equal(ui.text('cockpitFills'), '7');
  assert.equal(ui.text('cockpitFillsLabel'), 'Fills / 5m');
  assert.equal(ui.text('cockpitPending'), '2');
  assert.equal(ui.elements.cockpitPending.className, 'cockpit-warning', 'con proposte in attesa è giallo');
  assert.equal(ui.text('cockpitQueueDepth'), '0 azioni / soglia 10');
  assert.equal(ui.text('cockpitQueueHealth'), 'nessuna coda');
  assert.equal(ui.text('cockpitExecMode'), 'LIVE');
  assert.equal(ui.elements.cockpitExecMode.className, 'cockpit-surface-note cockpit-positive');
});

test('l\'etichetta dei fill segue la finestra del server, non è "5m" scritto a mano', async () => {
  const ui = loadCockpit({
    snapshot: { ...SNAPSHOT, execution: { ...SNAPSHOT.execution, windowMin: 15, fills: 3 } }
  });
  await ui.perps.refreshRiskSnapshot();
  assert.equal(ui.text('cockpitFillsLabel'), 'Fills / 15m');
  assert.equal(ui.text('cockpitFills'), '3');
});

test('ZERO MISURATO: si stampa 0, e la riga proposte non è più gialla', async () => {
  const ui = loadCockpit({
    snapshot: {
      ...SNAPSHOT,
      execution: { ...SNAPSHOT.execution, fills: 0, pendingProposals: 0 }
    }
  });
  await ui.perps.refreshRiskSnapshot();
  assert.equal(ui.text('cockpitFills'), '0', 'zero misurato non è "—"');
  assert.equal(ui.text('cockpitPending'), '0');
  assert.equal(ui.elements.cockpitPending.className, '', 'niente da decidere, niente giallo');
});

test('KILL-SWITCH e coda oltre soglia: la card lo dice invece di restare verde', async () => {
  const ui = loadCockpit({
    snapshot: {
      ...SNAPSHOT, killSwitch: true,
      execution: { windowMin: 5, fills: 0, pendingProposals: null, queueDepth: 14, queueThreshold: 10, queueState: 'warning', mode: 'blocked' }
    }
  });
  await ui.perps.refreshRiskSnapshot();

  assert.match(ui.text('cockpitExecMode'), /BLOCCATA/);
  assert.equal(ui.elements.cockpitExecMode.className, 'cockpit-surface-note cockpit-negative');
  assert.equal(ui.text('cockpitQueueDepth'), '14 azioni / soglia 10');
  assert.equal(ui.text('cockpitQueueHealth'), 'oltre soglia');
  assert.equal(ui.elements.cockpitQueueHealth.className, 'cockpit-warning');
  assert.equal(ui.text('cockpitPending'), '—', 'proposte non leggibili: "—", non 0');
});

test('SNAPSHOT VECCHIO senza `execution`: la card non inventa, torna a "—"', async () => {
  // Un server non ancora aggiornato non manda il blocco: la card deve dichiarare
  // di non sapere, non ereditare valori da altre parti dello snapshot.
  const { execution, ...senzaExecution } = SNAPSHOT;
  assert.ok(execution, 'la fixture completa deve avere il blocco');
  const ui = loadCockpit({ snapshot: senzaExecution });
  await ui.perps.refreshRiskSnapshot();
  assert.equal(ui.text('cockpitFills'), '—');
  assert.equal(ui.text('cockpitQueueHealth'), '—');
  assert.equal(ui.text('cockpitExecMode'), '—');
});

test('FETCH FALLITA: la card non resta sull\'ultimo valore letto', async () => {
  const ui = loadCockpit();
  await ui.perps.refreshRiskSnapshot();
  assert.equal(ui.text('cockpitFills'), '7', 'precondizione: prima aveva un dato');

  ui.perps.api = async () => { throw new Error('snapshot non disponibile'); };
  await ui.perps.refreshRiskSnapshot();

  for (const id of ['cockpitFills', 'cockpitPending', 'cockpitQueueDepth', 'cockpitQueueHealth', 'cockpitExecMode']) {
    assert.equal(ui.text(id), '—', `${id}: un dato non aggiornato non va lasciato a schermo`);
  }
});

// ------------------------------------------------- DEBT-04 · importi negativi

test('DEBT-04: fmtUsd mette il segno prima del simbolo di valuta', () => {
  const { perps } = loadCockpit();
  assert.equal(perps.fmtUsd(-12.34), '-$12.34');
  assert.equal(perps.fmtUsd(12.34), '$12.34');
  assert.equal(perps.fmtUsd(-1234.5), '-$1,234.5');
  assert.equal(perps.fmtUsd(0), '$0');
  assert.equal(perps.fmtUsd(-0), '$0', '-0 non è una perdita');
  // Contratto preesistente da non rompere: null/NaN restano "—".
  assert.equal(perps.fmtUsd(null), '—');
  assert.equal(perps.fmtUsd(undefined), '—');
  assert.equal(perps.fmtUsd(NaN), '—');
  // Stessa forma della funzione sorella, che il segno lo metteva già giusto.
  assert.equal(perps.fmtUsd(-5).slice(0, 2), '-$');
});

test('DEBT-04: nessun chiamante rimedia più a mano nel sorgente', () => {
  const src = fs.readFileSync(PERPS_JS, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/replace\(\s*['"]\$-['"]/.test(code), false,
    'il replace del segno è tornato in un chiamante invece di stare in fmtUsd');
});

test('DEBT-04: un valore negativo arriva formattato bene fino al DOM', async () => {
  const ui = loadCockpit({
    snapshot: {
      ...SNAPSHOT,
      account: { equity: -250.5, totalMarginUsed: 0, positions: [] },
      pnl: { realized: -10, unrealized: -5, net: -15 }
    }
  });
  await ui.perps.refreshRiskSnapshot();
  assert.equal(ui.text('cockpitRiskEquity'), '-$250.5');
  assert.equal(ui.text('cockpitRiskExposure'), '$0 / $5,000');
  // Il PnL usa il proprio segno esplicito su un valore assoluto: non deve
  // diventare un doppio segno ora che fmtUsd ne mette uno suo.
  assert.equal(ui.text('cockpitNetPnl'), '-$15');
  assert.equal(ui.text('cockpitRealized'), 'Realized -$10');
});
