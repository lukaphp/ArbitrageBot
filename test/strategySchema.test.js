/**
 * STRAT-01 (backend): schema di export/import delle strategie.
 * ============================================================
 *
 * Il criterio che conta è "un file malformato non crea un bot con
 * configurazione parzialmente vuota". Qui si verifica il pezzo che lo decide:
 * la validazione pura in `src/perps/strategySchema.js`, esercitata su un file
 * valido, uno malformato e uno con campi mancanti — più i casi che sembrano
 * validi e non lo sono (regola di tipo sconosciuto, leva oltre il massimo).
 *
 * Perché la validazione è un modulo a sé e non codice dentro le route: le due
 * route di import (storico strategie e bot) devono usare LA STESSA, e una
 * funzione pura si testa senza tirare su express, socket.io e i singleton di
 * mercato. È lo stesso motivo per cui i calcoli di rischio stanno in
 * riskManager.js e non in bot.js.
 *
 * Cosa NON copre questo file: le route HTTP (`/api/agents/strategy-history/import`,
 * `/api/perps/bots/import`) — `server.js` avvia server HTTP, socket.io, il
 * botManager e il runtime degli agenti al momento dell'import del modulo, quindi
 * un test end-to-end richiederebbe di mockare mezza applicazione. La logica di
 * ordinamento delle route (validare tutto PRIMA di creare il primo bot) è
 * verificabile solo per lettura: dichiarato qui, non nascosto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import schema, {
  EXPORT_KIND, EXPORT_VERSION, validateEnvelope, validateItemList,
  validateStrategyConfig, buildEnvelope, botExportItem, historyExportItem, exportFileName
} from '../src/perps/strategySchema.js';
import { HYPERLIQUID_CONFIG } from '../src/config/config.js';

const goodConfig = () => ({
  candleInterval: '15m',
  leverage: 3,
  sizing: { mode: 'percent', value: 10 },
  tp: { enabled: true, mode: 'percent', value: 5 },
  sl: { enabled: true, mode: 'percent', value: 2 },
  entryRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30 }],
  exitRules: [{ type: 'indicator', indicator: 'rsi', period: 14, op: '>', value: 70 }]
});

const goodFile = (overrides = {}) => ({
  kind: EXPORT_KIND,
  version: EXPORT_VERSION,
  exportedAt: '2026-08-10T00:00:00.000Z',
  network: 'testnet',
  items: [{
    coin: 'SOL-PERP',
    status: 'expired',
    rationale: 'RSI oversold mean reversion',
    confidence: 0.6,
    payload: { coin: 'SOL-PERP', interval: '15m', config: goodConfig() }
  }],
  ...overrides
});

// ---------- file valido ----------

test('file valido: passa e restituisce la voce normalizzata', () => {
  const r = validateEnvelope(goodFile());
  assert.equal(r.ok, true, r.errors.join(' '));
  assert.deepEqual(r.errors, []);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].coin, 'SOL-PERP');
  assert.equal(r.items[0].interval, '15m');
  assert.equal(r.items[0].config.candleInterval, '15m');
  assert.equal(r.items[0].config.entryRules.length, 1);
});

test('l\'intervallo dichiarato nel payload vince e viene allineato dentro la config', () => {
  const f = goodFile();
  f.items[0].payload.interval = '1h';
  f.items[0].payload.config.candleInterval = '15m'; // incoerenza nel file
  const r = validateEnvelope(f);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].interval, '1h');
  assert.equal(r.items[0].config.candleInterval, '1h',
    'la config scritta nel bot non deve restare su un intervallo diverso da quello importato');
});

// ---------- file malformato ----------

test('malformato: non è un oggetto JSON', () => {
  for (const bad of [null, undefined, 42, 'testo', [1, 2]]) {
    const r = validateEnvelope(bad);
    assert.equal(r.ok, false);
    assert.equal(r.items.length, 0);
  }
});

test('malformato: busta di un altro prodotto (kind sbagliato) → rifiutato subito', () => {
  const r = validateEnvelope(goodFile({ kind: 'qualcosaltro' }));
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /kind/);
});

test('malformato: versione futura del formato → rifiutato invece di interpretato a caso', () => {
  const r = validateEnvelope(goodFile({ version: 99 }));
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /[Vv]ersione/);
});

test('malformato: items assente o vuoto', () => {
  assert.equal(validateEnvelope(goodFile({ items: [] })).ok, false);
  assert.equal(validateEnvelope(goodFile({ items: undefined })).ok, false);
  assert.equal(validateEnvelope(goodFile({ items: 'no' })).ok, false);
});

test('malformato: troppe voci → rifiutato (limite esplicito, non troncamento)', () => {
  const many = Array.from({ length: 5 }, () => goodFile().items[0]);
  const r = validateEnvelope({ ...goodFile(), items: many }, { maxItems: 3 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /Troppe voci/);
  assert.equal(r.items.length, 0, 'nessuna voce accettata: non si importa "le prime 3"');
});

// ---------- campi mancanti ----------

test('campi mancanti: senza payload.config non si importa nulla', () => {
  const f = goodFile();
  delete f.items[0].payload.config;
  const r = validateEnvelope(f);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /payload\.config/);
  assert.equal(r.items.length, 0);
});

test('campi mancanti: senza coin', () => {
  const f = goodFile();
  delete f.items[0].coin;
  const r = validateEnvelope(f);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /coin/);
});

test('campi mancanti: senza regole d\'ingresso (bot che non aprirebbe mai)', () => {
  const f = goodFile();
  f.items[0].payload.config.entryRules = [];
  const r = validateEnvelope(f);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /regola d'ingresso|entryRules/);
});

test('campi mancanti: nessun intervallo, né nel payload né nella config', () => {
  const f = goodFile();
  delete f.items[0].payload.interval;
  delete f.items[0].payload.config.candleInterval;
  const r = validateEnvelope(f);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /[Ii]ntervallo/);
});

test('una voce buona e una rotta: NIENTE viene importato (tutto o nulla)', () => {
  const f = goodFile();
  const rotta = JSON.parse(JSON.stringify(f.items[0]));
  delete rotta.payload.config.entryRules;
  rotta.coin = 'ETH-PERP';
  f.items.push(rotta);

  const r = validateEnvelope(f);
  assert.equal(r.ok, false, 'la busta nel complesso non è valida');
  assert.equal(r.items.length, 1, 'la voce buona è riconosciuta…');
  assert.match(r.errors.join(' '), /ETH-PERP/, '…e l\'errore dice quale voce è il problema');
  // È il chiamante (la route) a non scrivere nulla quando ok === false: qui si
  // verifica che il segnale ci sia e sia inequivocabile.
});

// ---------- casi che sembrano validi ----------

test('regola di tipo sconosciuto → rifiutata (a runtime verrebbe ignorata in silenzio)', () => {
  const f = goodFile();
  f.items[0].payload.config.entryRules = [{ type: 'oroscopo', value: 1 }];
  const r = validateEnvelope(f);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /oroscopo/);
});

test('indicatore sconosciuto → rifiutato', () => {
  const f = goodFile();
  f.items[0].payload.config.entryRules = [{ type: 'indicator', indicator: 'supertrend', op: '>', value: 1 }];
  assert.equal(validateEnvelope(f).ok, false);
});

test('leva oltre il massimo del server → RIFIUTATA, mai ridotta in silenzio', () => {
  const maxLev = HYPERLIQUID_CONFIG.risk.maxLeverage;
  const f = goodFile();
  f.items[0].payload.config.leverage = maxLev + 5;
  const r = validateEnvelope(f);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /leva/i);
  assert.equal(r.items.length, 0, 'nessuna voce "corretta" a leva ridotta');
});

test('sizing percentuale oltre il 100% dell\'equity → rifiutato', () => {
  const f = goodFile();
  f.items[0].payload.config.sizing = { mode: 'percent', value: 250 };
  assert.equal(validateEnvelope(f).ok, false);
});

test('TP abilitato senza valore numerico → rifiutato', () => {
  const f = goodFile();
  f.items[0].payload.config.tp = { enabled: true, mode: 'percent' };
  assert.equal(validateEnvelope(f).ok, false);
});

test('validateStrategyConfig accetta una config con chiavi extra che non conosce', () => {
  const cfg = { ...goodConfig(), campoFuturo: { qualcosa: true }, mlGate: { enabled: false } };
  assert.deepEqual(validateStrategyConfig(cfg), [],
    'una config valida non deve essere rifiutata solo perché ha campi opzionali in più');
});

// ---------- lista nuda (quello che invia la UI) ----------

test('lista nuda di items (forma inviata dalla UI): stessa validazione', () => {
  const ok = validateItemList(goodFile().items);
  assert.equal(ok.ok, true, ok.errors.join(' '));
  assert.equal(validateItemList([]).ok, false);
  assert.equal(validateItemList(null).ok, false);
  const rotta = goodFile().items.map(i => ({ ...i, payload: {} }));
  assert.equal(validateItemList(rotta).ok, false);
});

// ---------- round-trip: un bot esportato è re-importabile ----------

test('round-trip: bot → export → import produce la stessa configurazione', () => {
  const botRow = {
    id: 'b1', name: 'RSI SOL', coin: 'SOL-PERP', network: 'testnet',
    master_address: '0xSEGRETO', created_at: 1_700_000_000_000,
    config_json: JSON.stringify(goodConfig())
  };
  const envelope = buildEnvelope([botExportItem(botRow)], { network: botRow.network, source: 'bot' });
  const serialized = JSON.stringify(envelope); // come uscirebbe dal file scaricato

  assert.ok(!serialized.includes('0xSEGRETO'),
    'l\'export non porta con sé il wallet di chi ha esportato');

  const r = validateEnvelope(JSON.parse(serialized));
  assert.equal(r.ok, true, r.errors.join(' '));
  assert.equal(r.items[0].coin, 'SOL-PERP');
  assert.equal(r.items[0].name, 'RSI SOL');
  assert.deepEqual(r.items[0].config.entryRules, goodConfig().entryRules);
  assert.equal(r.items[0].config.leverage, 3);
});

test('round-trip: voce dello storico → export → import', () => {
  const h = {
    id: 'p1', coin: 'ETH-PERP', status: 'expired', rationale: 'test', confidence: 0.4,
    createdAt: 1, decidedAt: 2, model: 'claude-sonnet-4-6', costUsd: 0.02,
    payload: { coin: 'ETH-PERP', interval: '1h', config: goodConfig() }
  };
  const r = validateEnvelope(buildEnvelope([historyExportItem(h)], { network: 'testnet' }));
  assert.equal(r.ok, true, r.errors.join(' '));
  assert.equal(r.items[0].interval, '1h');
  assert.equal(r.items[0].confidence, 0.4);
  assert.equal(r.items[0].model, 'claude-sonnet-4-6');
});

test('nome file: senza caratteri che rompano l\'header Content-Disposition', () => {
  const name = exportFileName('SOL/PERP "strana"', 1);
  assert.ok(!/["\\/\s]/.test(name), `nome file non sicuro: ${name}`);
  assert.match(name, /\.json$/);
  assert.match(exportFileName('storico', 7), /^strategie-7-\d{4}-\d{2}-\d{2}\.json$/);
});

test('il default export espone le stesse funzioni (usato da server.js)', () => {
  for (const k of ['validateEnvelope', 'validateItemList', 'buildEnvelope', 'botExportItem', 'historyExportItem', 'exportFileName']) {
    assert.equal(typeof schema[k], 'function', `manca ${k}`);
  }
  assert.equal(schema.EXPORT_KIND, EXPORT_KIND);
});
