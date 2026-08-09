/**
 * Export/import dello storico strategie (public/perps.js) — STRAT-01, parte UI
 * ============================================================================
 *
 * L'esportazione è interamente lato client: le voci dello storico arrivano da
 * `GET /api/agents/strategy-history` già complete di `payload.config`, cioè lo
 * stesso blob che finisce in `bots.config_json`. Il file scaricato è quindi
 * esattamente quello che l'utente sta guardando, senza una seconda verità
 * costruita dal server.
 *
 * L'importazione invece scrive, quindi passa dal server (parte di Bruno). Qui è
 * coperto il gate che sta prima: la validazione dello schema **prima** di inviare
 * qualunque cosa. Il criterio di accettazione è "un file malformato non crea un
 * bot con configurazione parzialmente vuota", e il caso che conta davvero è la
 * strategia senza regole d'ingresso: JSON valido, busta valida, ma un bot che non
 * aprirebbe mai una posizione. Un import parziale è trattato come errore: se una
 * voce non passa, non si spedisce niente.
 *
 * Nota di copertura: la validazione qui è il primo dei due controlli, non quello
 * autorevole — quello resta lato server, dove si scrive.
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

/** Voce di storico realistica: quello che `proposals.history()` restituisce. */
function voce(id, coin, over = {}) {
  return {
    id, coin, status: 'approved', rationale: 'RSI ipervenduto con volumi in crescita',
    confidence: 0.62, createdAt: 1754000000000, decidedAt: 1754003600000,
    model: 'claude-sonnet-4', costUsd: 0.0412,
    payload: {
      coin, interval: '15m',
      config: {
        direction: 'both', leverage: 3, candleInterval: '15m', logic: 'any',
        entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }],
        exitRules: []
      }
    },
    ...over
  };
}

function fakeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', files: null, dataset: {},
    clicked: 0,
    click() { this.clicked++; },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener: () => {}, querySelector: () => null, hasClass: (c) => classes.has(c)
  };
}

function loadPerpsUi() {
  const elements = {
    strategyHistory: fakeElement('strategyHistory'),
    shImportFile: fakeElement('shImportFile'),
    shSelCount: fakeElement('shSelCount'),
    shSelectAll: fakeElement('shSelectAll'),
    shRecycleBtn: fakeElement('shRecycleBtn')
  };
  const requests = [];
  const toasts = [];
  const downloads = [];
  const revoked = [];

  const sandbox = {
    console, BigInt, Blob: class { constructor(parts) { this.parts = parts; } },
    URL: {
      createObjectURL: (blob) => { downloads.push({ blob }); return 'blob:fake-' + downloads.length; },
      revokeObjectURL: (url) => revoked.push(url)
    },
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '',
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      // L'ancora di download: registra href/download al click, come farebbe il browser.
      createElement: () => ({
        href: '', download: '',
        click() { downloads.at(-1).name = this.download; downloads.at(-1).href = this.href; }
      })
    },
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method, body: opts.body });
      return { ok: true, json: async () => ({ success: true, data: { imported: 1, skipped: 0 } }) };
    },
    alert: (msg) => toasts.push({ msg, type: 'alert' }),
    confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.window.shell = { showToast: (msg, type) => toasts.push({ msg, type }) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const perps = sandbox.window.perps;
  perps.loadStrategyHistory = async () => {};
  return {
    perps, requests, toasts, downloads, revoked, elements,
    exported: () => JSON.parse(downloads.at(-1).blob.parts[0]),
    lastToast: () => toasts.at(-1)
  };
}

/** Simula la scelta di un file dal disco. */
function fileFinto(contenuto) {
  const text = typeof contenuto === 'string' ? contenuto : JSON.stringify(contenuto);
  return { files: [{ name: 'strategie.json', text: async () => text }], value: 'strategie.json' };
}

// ---- Esportazione ----

test('export: busta autodescrittiva con configurazione completa e metadati', () => {
  const ui = loadPerpsUi();
  ui.perps._strategyHistory = [voce('p1', 'SOL'), voce('p2', 'BTC')];
  ui.perps.network = 'testnet';
  ui.perps.exportStrategies(['p1']);

  const env = ui.exported();
  assert.equal(env.kind, 'arbitragebot.strategies');
  assert.equal(env.version, 1);
  assert.equal(env.network, 'testnet');
  assert.ok(env.exportedAt, 'la data di export è tracciata');
  assert.equal(env.items.length, 1, 'esporta solo la voce chiesta');

  const it = env.items[0];
  assert.equal(it.coin, 'SOL');
  assert.equal(it.status, 'approved');
  assert.equal(it.model, 'claude-sonnet-4');
  assert.ok(it.payload.config.entryRules.length, 'la strategia vera e propria è nel file');
  // L'id interno del DB non serve fuori da questo database e non va nel file.
  assert.equal('id' in it, false);
});

test('export: nome file parlante e object URL revocato (nessun Blob trattenuto)', () => {
  const ui = loadPerpsUi();
  ui.perps._strategyHistory = [voce('p1', 'SOL'), voce('p2', 'BTC')];

  ui.perps.exportStrategies(['p1']);
  assert.match(ui.downloads.at(-1).name, /^strategia-sol-\d{4}-\d{2}-\d{2}\.json$/);

  ui.perps.exportStrategies(['p1', 'p2']);
  assert.match(ui.downloads.at(-1).name, /^strategie-2-\d{4}-\d{2}-\d{2}\.json$/);

  assert.equal(ui.revoked.length, 2, 'ogni object URL creato viene revocato');
});

test('export delle selezionate: usa la selezione corrente e avvisa se è vuota', () => {
  const ui = loadPerpsUi();
  ui.perps._strategyHistory = [voce('p1', 'SOL'), voce('p2', 'BTC')];

  ui.perps.exportSelectedStrategies();
  assert.equal(ui.downloads.length, 0, 'senza selezione non scarica nulla');
  assert.match(ui.lastToast().msg, /Nessuna strategia selezionata/);

  ui.perps.toggleStrategySelection('p2', true);
  ui.perps.exportSelectedStrategies();
  assert.deepEqual(ui.exported().items.map(i => i.coin), ['BTC']);
});

test('export di una voce senza configurazione: avvisa che non è riutilizzabile', () => {
  const ui = loadPerpsUi();
  ui.perps._strategyHistory = [voce('p1', 'SOL', { payload: { coin: 'SOL' } })];
  ui.perps.exportStrategies(['p1']);
  assert.match(ui.toasts[0].msg, /senza configurazione/);
  assert.equal(ui.toasts[0].type, 'warning');
  assert.equal(ui.downloads.length, 1, 'la cronologia si esporta comunque, dichiarandolo');
});

// ---- Importazione: validazione prima di scrivere ----

test('import di un file valido: invia gli items e ricarica lo storico', async () => {
  const ui = loadPerpsUi();
  const input = fileFinto({
    kind: 'arbitragebot.strategies', version: 1, exportedAt: '2026-08-10T00:00:00Z',
    network: 'testnet', items: [ui.perps._strategyExportItem(voce('p1', 'SOL'))]
  });
  await ui.perps.importStrategiesFromFile(input);

  const req = ui.requests.find(r => r.url === '/api/agents/strategy-history/import');
  assert.ok(req, 'chiamato POST /api/agents/strategy-history/import');
  assert.equal(req.method, 'POST');
  const body = JSON.parse(req.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].coin, 'SOL');
  assert.equal(ui.lastToast().type, 'success');
  assert.equal(input.value, '', 'l\'input viene azzerato per poter reimportare lo stesso file');
});

test('import di JSON malformato: errore leggibile e nessuna chiamata al server', async () => {
  const ui = loadPerpsUi();
  await ui.perps.importStrategiesFromFile(fileFinto('{"kind": "arbitragebot.strategies", items:'));
  assert.equal(ui.requests.length, 0, 'niente va al server');
  assert.equal(ui.lastToast().type, 'error');
  assert.match(ui.lastToast().msg, /JSON non valido/);
});

test('import di un file estraneo (kind sbagliato): rifiutato prima di scrivere', async () => {
  const ui = loadPerpsUi();
  await ui.perps.importStrategiesFromFile(fileFinto({ kind: 'qualcos-altro', version: 1, items: [] }));
  assert.equal(ui.requests.length, 0);
  assert.match(ui.lastToast().msg, /Non è un export di strategie/);
});

test('import di una versione di formato futura: rifiutato invece di indovinare', async () => {
  const ui = loadPerpsUi();
  await ui.perps.importStrategiesFromFile(fileFinto({
    kind: 'arbitragebot.strategies', version: 99, items: [ui.perps._strategyExportItem(voce('p1', 'SOL'))]
  }));
  assert.equal(ui.requests.length, 0);
  assert.match(ui.lastToast().msg, /Versione del formato non supportata/);
});

test('import con campi mancanti (nessun payload.config): rifiutato, niente config a metà', async () => {
  const ui = loadPerpsUi();
  await ui.perps.importStrategiesFromFile(fileFinto({
    kind: 'arbitragebot.strategies', version: 1,
    items: [{ coin: 'SOL', status: 'approved' }]
  }));
  assert.equal(ui.requests.length, 0);
  assert.match(ui.lastToast().msg, /manca payload\.config/);
});

test('import con strategia senza regole d\'ingresso: rifiutato (bot che non aprirebbe mai)', async () => {
  const ui = loadPerpsUi();
  const it = ui.perps._strategyExportItem(voce('p1', 'SOL'));
  it.payload.config.entryRules = [];
  await ui.perps.importStrategiesFromFile(fileFinto({
    kind: 'arbitragebot.strategies', version: 1, items: [it]
  }));
  assert.equal(ui.requests.length, 0);
  assert.match(ui.lastToast().msg, /nessuna regola d'ingresso/i);
});

test('import senza campo coin: rifiutato', async () => {
  const ui = loadPerpsUi();
  const it = ui.perps._strategyExportItem(voce('p1', 'SOL'));
  delete it.coin;
  await ui.perps.importStrategiesFromFile(fileFinto({
    kind: 'arbitragebot.strategies', version: 1, items: [it]
  }));
  assert.equal(ui.requests.length, 0);
  assert.match(ui.lastToast().msg, /"coin" mancante/);
});

test('import parziale: una sola voce rotta su tre blocca tutto l\'import', async () => {
  const ui = loadPerpsUi();
  const buone = [voce('p1', 'SOL'), voce('p3', 'ETH')].map(v => ui.perps._strategyExportItem(v));
  const rotta = ui.perps._strategyExportItem(voce('p2', 'BTC'));
  delete rotta.payload.config;
  await ui.perps.importStrategiesFromFile(fileFinto({
    kind: 'arbitragebot.strategies', version: 1, items: [buone[0], rotta, buone[1]]
  }));
  assert.equal(ui.requests.length, 0, 'nessuna scrittura parziale');
  assert.match(ui.lastToast().msg, /voce 2 \(BTC\)/);
});

test('import di un file senza strategie: rifiutato', async () => {
  const ui = loadPerpsUi();
  await ui.perps.importStrategiesFromFile(fileFinto({
    kind: 'arbitragebot.strategies', version: 1, items: []
  }));
  assert.equal(ui.requests.length, 0);
  assert.match(ui.lastToast().msg, /non contiene strategie/);
});

test('nessun file scelto: nessun effetto', async () => {
  const ui = loadPerpsUi();
  await ui.perps.importStrategiesFromFile({ files: [] });
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.toasts.length, 0);
});

test('il pulsante Importa apre l\'input file dopo averlo azzerato', () => {
  const ui = loadPerpsUi();
  ui.elements.shImportFile.value = 'vecchio.json';
  ui.perps.pickStrategiesFile();
  assert.equal(ui.elements.shImportFile.value, '');
  assert.equal(ui.elements.shImportFile.clicked, 1);
});

// ---- Markup ----

test('index.html: i comandi export/import sono nella barra dello storico strategie', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const barra = html.slice(html.indexOf('class="sh-bulkbar"'), html.indexOf('id="strategyHistory"'));

  assert.match(barra, /perps\.exportSelectedStrategies\(\)/);
  assert.match(barra, /perps\.pickStrategiesFile\(\)/);
  assert.match(barra, /id="shImportFile"/);
  assert.match(barra, /onchange="perps\.importStrategiesFromFile\(this\)"/);
  assert.match(barra, /accept="application\/json,\.json"/);
  // L'input file resta nascosto: si apre dal pulsante.
  assert.match(barra, /id="shImportFile" class="hidden"/);
});

test('ogni riga dello storico offre l\'export della singola strategia', () => {
  const ui = loadPerpsUi();
  ui.perps._strategyHistory = [voce('p1', 'SOL')];
  ui.perps._strategyCounts = { approved: 1, rejected: 0, expired: 0 };
  ui.perps._renderStrategyHistory();
  const html = ui.elements.strategyHistory.innerHTML;
  assert.match(html, /class="sh-export"/);
  assert.match(html, /perps\.exportStrategies\(\['p1'\]\)/);
});
