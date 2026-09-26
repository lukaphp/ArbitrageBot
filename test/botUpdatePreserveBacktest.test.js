/**
 * ISSUE-56 — il salvataggio manuale dalla UI non deve cancellare `backtestSummary`.
 * ================================================================================
 *
 * Lo scenario reale, passo per passo: Hermes registra un bot via MCP
 * (`register_bot`), il cancello pre-flight misura la strategia e salva l'esito in
 * `config.backtestSummary`. Poi una persona apre il modale di modifica nella UI e
 * cambia SOLO il nome. Il form (`_buildBotConfig` in public/perps.js) ricostruisce
 * la config da zero dai suoi campi — e non ha nessun campo per il riassunto del
 * backtest, perché quel dato non è un parametro che si imposta: è una misura. La
 * PATCH arriva con una config completa in cui `backtestSummary` semplicemente non
 * esiste, `db.updateBot` riscrive `config_json` per intero, e il verdetto
 * "✅ superato" diventa "mai verificato" senza che nulla lo dica.
 *
 * Il test si ferma un livello sotto la rotta HTTP: `PATCH /api/perps/bots/:id` è
 * tre righe che inoltrano `req.body` a `botManager.updateBot`, quindi chiamare
 * `botManager.updateBot` con il payload che il form produce esercita lo stesso
 * codice con una dipendenza in meno. Cosa NON è coperto: il DOM del modale (che
 * il form ometta davvero la chiave è verificato leggendo `_buildBotConfig`, non
 * eseguendolo) e la serializzazione HTTP.
 *
 * Seam di test: singleton DB su file temporaneo (mai data/perps.db), `notifier`
 * neutralizzato, bot sempre fermi — un update su bot fermo non fa partire tick,
 * quindi qui non serve nessun mock di mercato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import db from '../src/db/database.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-preserve-'));
db.dbPath = path.join(tempDir, 'perps.db');
db.init(); // insertBot() non fa init lazy

const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { default: botManager } = await import('../src/perps/botManager.js');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => {};

const ENTRY_RULES = [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30 }];

/** Il riassunto come lo scrive `runBacktestGate` (contesto della misura incluso). */
const SUMMARY = {
  verdict: 'passed',
  reason: 'Backtest superato: 42 trade, win rate 61.9%, profit factor 1.84, expectancy 3.10$/trade.',
  checkedAt: 1758800000000,
  trades: 42,
  winRate: 0.619,
  profitFactor: 1.84,
  expectancy: 3.1,
  totalPnl: 130.2,
  maxDrawdownPct: 8.4,
  periodDays: 30,
  candles: 2880,
  coin: 'SOL-PERP',
  interval: '15m',
  lookbackDays: 30
};

/**
 * La config come la ricostruisce il form di modifica: tutte le chiavi che il
 * modale conosce, NESSUNA che non conosce. Le chiavi opzionali di automazione
 * (`mtfConfirm`, `partialTp`, `dca`, `mlGate`) compaiono solo se la spunta è
 * attiva — vedi `_collectAdvancedAutomation`: è per questo che qui si passa un
 * oggetto costruito da zero e non uno spread della config esistente.
 */
function formConfig(over = {}) {
  return {
    direction: 'long',
    leverage: 3,
    sizing: { mode: 'fixed', value: 100 },
    candleInterval: '15m',
    logic: 'all',
    entryRules: ENTRY_RULES,
    exitRules: [],
    tp: { enabled: true, mode: 'percent', value: 4 },
    sl: { enabled: true, mode: 'percent', value: 2 },
    trailing: { enabled: false, mode: 'percent', value: 1 },
    risk: { maxDailyLossUsd: 50, maxPositionUsd: 500 },
    paper: true,
    ...over
  };
}

let seq = 0;
/** Bot fermo, nato dal percorso MCP: la config in DB ha già il riassunto. */
function botConMisura(configOver = {}) {
  seq++;
  const created = botManager.createBot({
    name: `Bot Misurato ${seq}`,
    coin: 'SOL-PERP',
    network: 'testnet',
    masterAddress: `0xPRE${seq}`,
    config: { ...formConfig(), backtestSummary: SUMMARY, ...configOver },
    linked_agent_id: 'hermes',
    is_managed_by_agent: true
  });
  return created.id;
}

const configInDb = (id) => JSON.parse(db.getBot(id).config_json);

test('rinominare un bot dalla UI non cancella il riassunto del backtest', async () => {
  const id = botConMisura();

  // Esattamente ciò che fa `saveBot`: name + coin + config ricostruita dal form.
  await botManager.updateBot(id, { name: 'Bot Rinominato', coin: 'SOL-PERP', config: formConfig() });

  const cfg = configInDb(id);
  assert.deepEqual(cfg.backtestSummary, SUMMARY,
    'il riassunto deve sopravvivere identico: il form non lo conosce, non lo sta cancellando di proposito');
  assert.equal(db.getBot(id).name, 'Bot Rinominato', 'la modifica richiesta è stata applicata');
  // E l'istanza runtime ricaricata deve vederlo, non solo la riga in DB: la card
  // legge `state.config`.
  assert.equal(botManager.bots.get(id).config.backtestSummary.verdict, 'passed');
});

test('cambiare i parametri di rischio dalla UI non cancella il riassunto', async () => {
  const id = botConMisura();

  await botManager.updateBot(id, {
    name: 'Bot Misurato', coin: 'SOL-PERP',
    config: formConfig({ leverage: 5, risk: { maxDailyLossUsd: 20, maxPositionUsd: 200 } })
  });

  const cfg = configInDb(id);
  assert.deepEqual(cfg.backtestSummary, SUMMARY,
    'leva e tetti cambiano QUANTO si rischia, non l\'edge misurato: il riassunto resta valido');
  assert.equal(cfg.leverage, 5, 'la modifica richiesta è stata applicata');
});

test('cambiare candleInterval dalla UI conserva il riassunto: a marcarlo scaduto ci pensa la UI', async () => {
  const id = botConMisura();

  await botManager.updateBot(id, { name: 'Bot Misurato', coin: 'SOL-PERP', config: formConfig({ candleInterval: '5m' }) });

  const cfg = configInDb(id);
  // `_backtestStaleReason` (public/perps.js) confronta `summary.interval` con
  // `config.candleInterval` e degrada la pill a "❔ non più valido" tenendo il
  // verdetto originale nel tooltip. Cancellare il dato qui distruggerebbe
  // proprio l'informazione su cui quel meccanismo si basa.
  assert.equal(cfg.backtestSummary.interval, '15m');
  assert.equal(cfg.candleInterval, '5m');
});

test('cambiare le regole di ingresso dalla UI SCARTA il riassunto: sarebbe un verdetto su un\'altra strategia', async () => {
  const id = botConMisura();

  await botManager.updateBot(id, {
    name: 'Bot Misurato', coin: 'SOL-PERP',
    config: formConfig({ entryRules: [{ type: 'price', op: '<', value: 100 }] })
  });

  const cfg = configInDb(id);
  assert.equal(cfg.backtestSummary, undefined,
    'regole nuove = misura non più attinente: meglio "mai verificato" di un ✅ verde che mente');
});

test('una scrittura esplicita del riassunto vince sempre su quello conservato', async () => {
  const id = botConMisura();
  const nuovo = { ...SUMMARY, verdict: 'inconclusive', trades: 3, checkedAt: 1758900000000 };

  // È il percorso di `update_strategy_params` → `applyConfigPatch`: la config
  // fusa contiene già il riassunto nuovo.
  await botManager.updateBot(id, { name: 'Bot Misurato', coin: 'SOL-PERP', config: formConfig({ backtestSummary: nuovo }) });
  assert.deepEqual(configInDb(id).backtestSummary, nuovo, 'il riassunto nuovo sostituisce il vecchio');

  // …e `null` esplicito resta il modo di cancellarlo: la conservazione non deve
  // rendere impossibile buttarlo via a chi lo chiede davvero.
  await botManager.updateBot(id, { name: 'Bot Misurato', coin: 'SOL-PERP', config: formConfig({ backtestSummary: null }) });
  assert.equal(configInDb(id).backtestSummary, null, 'una cancellazione esplicita passa');
});

test('la conservazione non impedisce di DISATTIVARE un blocco opzionale dalla UI', async () => {
  const id = botConMisura({
    dca: { steps: 3, stepPercent: 2, sizeMultiplier: 1.5 },
    mtfConfirm: { interval: '1h', period: 50 },
    partialTp: [{ portion: 0.5, atPercent: 2 }]
  });

  // Togliere la spunta a DCA/MTF/TP parziale significa, nel form, NON emettere
  // la chiave. Una fusione generica "tieni tutto ciò che non arriva" lascerebbe
  // DCA attivo su un bot con soldi veri: è la ragione per cui la conservazione
  // vale solo sui campi scritti dal backend, non su tutta la config.
  await botManager.updateBot(id, { name: 'Bot Misurato', coin: 'SOL-PERP', config: formConfig() });

  const cfg = configInDb(id);
  assert.equal(cfg.dca, undefined, 'DCA disattivato dalla UI deve sparire davvero');
  assert.equal(cfg.mtfConfirm, undefined, 'conferma multi-timeframe disattivata deve sparire davvero');
  assert.equal(cfg.partialTp, undefined, 'scala di TP parziali disattivata deve sparire davvero');
  assert.deepEqual(cfg.backtestSummary, SUMMARY, 'il riassunto resta comunque');
});

test('un update senza config non tocca la config esistente', async () => {
  const id = botConMisura();

  await botManager.updateBot(id, { name: 'Solo Nome' });

  const cfg = configInDb(id);
  assert.deepEqual(cfg.backtestSummary, SUMMARY);
  assert.equal(cfg.leverage, 3, 'nessun campo di strategia perso');
  assert.equal(db.getBot(id).name, 'Solo Nome');
});

test.after(() => {
  try { botManager.stopAll(); } catch { /* noop */ }
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
