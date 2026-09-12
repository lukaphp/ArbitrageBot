/**
 * UNIT TESTS: ARBITRAGEBOT MCP SERVER & PROTOCOLLO GUARDRAILS
 * ==========================================================
 *
 * Valida i 5 tools del Server MCP e i 4 cancelli di pre-flight validation del Protocollo Guardrails:
 * 1. bot_control (start, stop, restart, crash safeguard)
 * 2. place_order_paper (Risk Ceiling, Order Velocity, Blacklist)
 * 3. get_system_snapshot (aggregated totals, bot list, open positions, alerts)
 * 4. emergency_shutdown (Two-stage 60s token confirmation, halt all bots, killswitch)
 * 5. update_strategy_params (Two-stage 60s token confirmation, DB write, runtime cache invalidation)
 * 6. Guardrail Hard-Gates (Max Leverage <= 5x, Account Exposure, Daily Loss Limit)
 * 7. Guardrail Order Velocity Gate (Cooldown anti-loop)
 * 8. Guardrail Instruction Override (Blacklist check)
 * 9. Audit logging con actor 'hermes_mcp_call'
 * 10. JSON-RPC 2.0 transport (initialize, tools/list, tools/call)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db/database.js';
import botManager from '../src/perps/botManager.js';
import riskAgent from '../src/agents/riskAgent.js';
import client from '../src/perps/hyperliquidClient.js';
import {
  handleBotControl,
  handlePlaceOrderPaper,
  handleGetSystemSnapshot,
  handleEmergencyShutdown,
  handleUpdateStrategyParams,
  handleRegisterBot,
  handleDeleteBot,
  mergeStrategyConfig
} from '../src/mcp/tools.js';
import {
  resetOrderVelocity,
  addBlacklistedAsset,
  removeBlacklistedAsset,
  getBlacklistedAssets
} from '../src/mcp/guardrails.js';
import {
  executeMcpTool,
  MCP_TOOLS_DEFINITIONS
} from '../src/mcp/httpTransport.js';

// ROOT CAUSE (CI-02): `paperBroker.placeMarketOrder` chiama SEMPRE
// `client.getMid` per il prezzo di fill, anche quando chi chiama ha già un
// `entry_price` (usato solo per il guardrail di rischio, mai passato
// all'esecuzione). In locale quella chiamata esce sul vero endpoint
// Hyperliquid e funziona; in CI l'egress allowlist di harden-runner blocca
// `api.hyperliquid*.xyz` (non è tra i domini elencati in .github/workflows/*
// .yml) e la richiesta fallisce con "No response received from the server"
// dopo i retry — deterministico, non un flake di rete generico. Riprodotto e
// verificato in isolamento simulando il blocco prima di questo fix.
// Stesso identico problema già risolto in test/paperBroker.test.js con lo
// stesso mock: nessun ordine che arriva a `placeMarketOrder` deve dipendere
// da una rete esterna raggiungibile.
client.getMid = async () => 50.0;

test('MCP & Guardrails Suite: Test dei Tool e Pre-Flight Validation per Hermes', async (t) => {
  db.ensure();
  botManager.loadFromDb();

  // Crea un bot di test
  const testBotId = 'test-mcp-bot-' + Date.now();
  db.insertBot({
    id: testBotId,
    name: 'MCP Guardrails Test Bot',
    coin: 'SOL-PERP',
    network: 'testnet',
    masterAddress: '0x000000000000000000000000000000000000dEaD',
    config: {
      leverage: 2,
      maxPositionUsd: 5000,
      maxDailyLossUsd: 200,
      loopInterval: 60000
    },
    status: 'stopped',
    linked_agent_id: 'hermes_agent_01',
    actor_label: 'Hermes',
    actor_id: 'hermes_agent_01',
    is_managed_by_agent: 1
  });
  botManager.loadFromDb();

  await t.test('1. bot_control - Start, Stop, Restart & Crash Safeguard', async () => {
    // Start
    const startRes = await handleBotControl({ bot_id: testBotId, action: 'start' });
    assert.equal(startRes.success, true);
    assert.equal(startRes.data.status, 'running');

    // Bot già running
    const duplicateStart = await handleBotControl({ bot_id: testBotId, action: 'start' });
    assert.equal(duplicateStart.success, true);

    // Stop
    const stopRes = await handleBotControl({ bot_id: testBotId, action: 'stop' });
    assert.equal(stopRes.success, true);
    assert.equal(stopRes.data.status, 'stopped');

    // Restart
    const restartRes = await handleBotControl({ bot_id: testBotId, action: 'restart' });
    assert.equal(restartRes.success, true);
    assert.equal(restartRes.data.status, 'running');

    // Stop per cleanup
    await handleBotControl({ bot_id: testBotId, action: 'stop' });

    // Bot inesistente
    const missingRes = await handleBotControl({ bot_id: 'non-existent-uuid', action: 'start' });
    assert.equal(missingRes.success, false);
  });

  await t.test('2. Guardrail: Risk Ceiling Hard-Gate (Leverage, Exposure, Daily Loss)', async () => {
    resetOrderVelocity(testBotId);

    // 2.1 Max Account Leverage (> 5x rifiutato)
    const highLevOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 1.0,
      entry_price: 50.0,
      leverage: 10 // > 5x
    });
    assert.equal(highLevOrder.success, false);
    assert.match(highLevOrder.message, /GUARDRAIL_VIOLATION: Max Account Leverage exceeded/i);

    // 2.2 Account Exposure (> maxPositionUsd = 500$ rifiutato)
    resetOrderVelocity(testBotId);
    const oversizedOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 100.0,
      entry_price: 100.0 // 100 * 100 = 10000 USD > 500
    });
    assert.equal(oversizedOrder.success, false);
    assert.match(oversizedOrder.message, /GUARDRAIL_VIOLATION: Account Exposure exceeded/i);

    // 2.3 Daily Loss Limit
    const today = new Date().toISOString().split('T')[0];
    db.setDailyPnl(testBotId, today, -300); // Supera soglia maxDailyLossUsd (200$)
    const botInstance = botManager.bots.get(testBotId);
    if (botInstance) {
      botInstance.dailyPnl = -300;
    }
    resetOrderVelocity(testBotId);
    const lossBlockedOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 0.5,
      entry_price: 50.0
    });
    assert.equal(lossBlockedOrder.success, false);
    assert.match(lossBlockedOrder.message, /GUARDRAIL_VIOLATION: Daily Loss Limit exceeded/i);

    // Ripristina dailyPnl
    db.setDailyPnl(testBotId, today, 0);
    if (botInstance) {
      botInstance.dailyPnl = 0;
    }
  });

  await t.test('3. Guardrail: Order Velocity Gate (Cooldown anti-loop)', async () => {
    resetOrderVelocity(testBotId);

    // Primo ordine valido
    const firstOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 1.0,
      entry_price: 50.0
    });
    if (!firstOrder.success) console.error('SUBTEST 3 FIRST ORDER ERROR:', firstOrder);
    assert.equal(firstOrder.success, true);

    // Secondo ordine immediato (cooldown attivo)
    const rapidOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 1.0,
      entry_price: 50.0
    });
    assert.equal(rapidOrder.success, false);
    assert.match(rapidOrder.message, /GUARDRAIL_VIOLATION: Order velocity limit exceeded/i);

    resetOrderVelocity(testBotId);
  });

  await t.test('4. Guardrail: Instruction Override & Blacklist', async () => {
    resetOrderVelocity(testBotId);

    // Aggiunge asset in blacklist
    addBlacklistedAsset('SOL-PERP');

    const blacklistedOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 1.0,
      entry_price: 50.0
    });
    assert.equal(blacklistedOrder.success, false);
    assert.match(blacklistedOrder.message, /GUARDRAIL_VIOLATION: Asset Blacklisted/i);

    // Rimuove da blacklist
    removeBlacklistedAsset('SOL-PERP');

    resetOrderVelocity(testBotId);
    const allowedOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 1.0,
      entry_price: 50.0
    });
    if (!allowedOrder.success) console.error('SUBTEST 4 ALLOWED ORDER ERROR:', allowedOrder);
    assert.equal(allowedOrder.success, true);
    resetOrderVelocity(testBotId);
  });

  await t.test('5. get_system_snapshot - Restituisce snapshot consolidato', async () => {
    const snapshot = await handleGetSystemSnapshot();
    assert.equal(snapshot.success, true);
    assert.ok(snapshot.data.system_health);
    assert.ok(Array.isArray(snapshot.data.bots));
    assert.ok(Array.isArray(snapshot.data.open_positions));
    assert.ok(Array.isArray(snapshot.data.alerts));
    assert.ok(snapshot.data.portfolio);
  });

  await t.test('6. Confirm Execution Mode: emergency_shutdown (Due Stadi)', async () => {
    // Stadio 1: Richiesta senza token
    const prompt = await handleEmergencyShutdown({ threshold: 5.0 });
    assert.equal(prompt.success, false);
    assert.equal(prompt.status, 'confirmation_required');
    assert.ok(prompt.confirmation_token);
    assert.equal(prompt.expires_in_seconds, 60);

    // Avvia il bot di test per verificare che venga fermato
    await handleBotControl({ bot_id: testBotId, action: 'start' });

    // Stadio 2: Esecuzione con token valido
    const shutdown = await handleEmergencyShutdown({
      confirmation_token: prompt.confirmation_token,
      threshold: 5.0
    });
    assert.equal(shutdown.success, true);
    assert.equal(riskAgent.isKillSwitchOn(), true);

    // Token consumato: riutilizzo (replay) deve fallire
    const replay = await handleEmergencyShutdown({
      confirmation_token: prompt.confirmation_token
    });
    assert.equal(replay.success, false);
    assert.match(replay.message, /GUARDRAIL_VIOLATION: Confirmation token non valido o inesistente/i);

    // Verifica che il bot sia stato fermato
    const botState = botManager.getBotState(testBotId);
    assert.equal(botState.status, 'stopped');

    // Ripristina kill-switch
    riskAgent.setKillSwitch(false);
  });

  await t.test('7. Confirm Execution Mode: update_strategy_params (Due Stadi)', async () => {
    // Stadio 1: Richiesta senza token
    const prompt = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: {
        leverage: 4,
        maxPositionUsd: 800,
        takeProfitPct: 0.05
      }
    });
    assert.equal(prompt.success, false);
    assert.equal(prompt.status, 'confirmation_required');
    assert.ok(prompt.confirmation_token);

    // Stadio 2: Esecuzione con token valido
    const updateRes = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: {
        leverage: 4,
        maxPositionUsd: 800,
        takeProfitPct: 0.05
      },
      confirmation_token: prompt.confirmation_token
    });
    assert.equal(updateRes.success, true);
    assert.equal(updateRes.data.current_config.leverage, 4);
    assert.equal(updateRes.data.current_config.maxPositionUsd, 800);

    // Token consumato: riutilizzo deve fallire
    const replay = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: { leverage: 4 },
      confirmation_token: prompt.confirmation_token
    });
    assert.equal(replay.success, false);

    // Validazione leva > 5x deve fallire subito
    const invalidLev = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: { leverage: 10 }
    });
    assert.equal(invalidLev.success, false);
    assert.match(invalidLev.message, /GUARDRAIL_VIOLATION: Leva non valida/i);

    // Sizing dinamico ATR: parametri fuori range rifiutati PRIMA della conferma.
    // Un riskPerTradePct di 500 non è un errore di battitura innocuo — è una
    // posizione dimensionata cinque volte l'equity, e senza questo cancello
    // arriverebbe nella config senza che nessuno l'abbia mai vista.
    const badRiskPct = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: { risk: { useDynamicSizing: true, riskPerTradePct: 500 } }
    });
    assert.equal(badRiskPct.success, false);
    assert.notEqual(badRiskPct.status, 'confirmation_required',
      'un parametro invalido non deve nemmeno arrivare allo stadio di conferma');
    assert.match(badRiskPct.message, /GUARDRAIL_VIOLATION/i);
    assert.match(badRiskPct.message, /riskPerTradePct/i);

    const badMultiplier = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: { risk: { atrMultiplier: 0 } }
    });
    assert.equal(badMultiplier.success, false);
    assert.match(badMultiplier.message, /GUARDRAIL_VIOLATION/i);
    assert.match(badMultiplier.message, /atrMultiplier/i);

    const badPeriod = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: { risk: { atrPeriod: 1.5 } }
    });
    assert.equal(badPeriod.success, false);
    assert.match(badPeriod.message, /GUARDRAIL_VIOLATION/i);
    assert.match(badPeriod.message, /atrPeriod/i);

    const badFlag = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: { risk: { useDynamicSizing: 'si' } }
    });
    assert.equal(badFlag.success, false);
    assert.match(badFlag.message, /GUARDRAIL_VIOLATION/i);
    assert.match(badFlag.message, /useDynamicSizing/i);

    // Valori validi: il tool deve tornare a comportarsi normalmente (stadio 1),
    // altrimenti il cancello starebbe bloccando anche l'uso legittimo.
    const okDynamic = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: { risk: { useDynamicSizing: true, riskPerTradePct: 1.5, atrMultiplier: 2, atrPeriod: 21 } }
    });
    assert.equal(okDynamic.status, 'confirmation_required');
  });

  await t.test('7-bis. update_strategy_params: un blocco annidato parziale non cancella i campi che non nomina', async () => {
    // Il merge era shallow: `params.risk = { useDynamicSizing: true }` sostituiva
    // l'INTERO oggetto risk e portava via maxPositionUsd/maxLeverage, cioè il
    // tetto di rischio PER BOT, in silenzio. Restava solo il cap globale.
    const nestedBotId = 'test-mcp-nested-' + Date.now();
    db.insertBot({
      id: nestedBotId,
      name: 'MCP Nested Merge Bot',
      coin: 'SOL-PERP',
      network: 'testnet',
      masterAddress: '0x000000000000000000000000000000000000dEaD',
      config: {
        leverage: 2,
        risk: { maxPositionUsd: 500, maxLeverage: 3, useDynamicSizing: false },
        sizing: { mode: 'percent', value: 10 },
        entryRules: [{ type: 'price', op: '>', value: 1 }]
      },
      status: 'stopped',
      linked_agent_id: 'hermes_agent_01',
      actor_label: 'Hermes',
      actor_id: 'hermes_agent_01',
      is_managed_by_agent: 1
    });
    botManager.loadFromDb();

    const params = { risk: { useDynamicSizing: true, riskPerTradePct: 1.5 } };
    const prompt = await handleUpdateStrategyParams({ bot_id: nestedBotId, params });
    assert.equal(prompt.status, 'confirmation_required');

    const res = await handleUpdateStrategyParams({
      bot_id: nestedBotId, params, confirmation_token: prompt.confirmation_token
    });
    assert.equal(res.success, true);

    const risk = res.data.current_config.risk;
    assert.equal(risk.maxPositionUsd, 500, 'il tetto per-bot non deve sparire perché non è stato nominato');
    assert.equal(risk.maxLeverage, 3);
    assert.equal(risk.useDynamicSizing, true, 'il campo aggiornato vale il nuovo valore');
    assert.equal(risk.riskPerTradePct, 1.5, 'il campo nuovo è presente');
    // Gli altri blocchi restano intatti, e la verifica è sul DB, non solo sulla
    // risposta: è la config persistita quella con cui il bot opera domani.
    assert.deepEqual(res.data.current_config.sizing, { mode: 'percent', value: 10 });
    const persisted = JSON.parse(db.getBot(nestedBotId).config_json);
    assert.equal(persisted.risk.maxPositionUsd, 500);
    assert.equal(persisted.risk.riskPerTradePct, 1.5);

    // Sostituire un blocco per intero resta possibile: `risk: null` è il modo
    // legittimo di azzerarlo, e non deve diventare un merge.
    const p2 = { risk: null };
    const prompt2 = await handleUpdateStrategyParams({ bot_id: nestedBotId, params: p2 });
    const res2 = await handleUpdateStrategyParams({
      bot_id: nestedBotId, params: p2, confirmation_token: prompt2.confirmation_token
    });
    assert.equal(res2.success, true);
    assert.equal(res2.data.current_config.risk, null, 'un valore non-oggetto sostituisce, non fonde');

    try { db.deleteBot(nestedBotId); } catch {}
  });

  await t.test('8. Audit Logging - Registrazione chiamate con actor hermes_mcp_call', async () => {
    const audits = db.listAudit(30);
    const hermesCalls = audits.filter(a => a.actor === 'hermes_mcp_call');
    assert.ok(hermesCalls.length > 0, 'Devono essere presenti righe di audit per hermes_mcp_call');
  });

  await t.test('9. JSON-RPC 2.0 Tool Execution', async () => {
    assert.equal(MCP_TOOLS_DEFINITIONS.length, 7);
    const toolNames = MCP_TOOLS_DEFINITIONS.map(t => t.name);
    assert.ok(toolNames.includes('bot_control'));
    assert.ok(toolNames.includes('place_order_paper'));
    assert.ok(toolNames.includes('get_system_snapshot'));
    assert.ok(toolNames.includes('emergency_shutdown'));
    assert.ok(toolNames.includes('update_strategy_params'));
    assert.ok(toolNames.includes('register_bot'));
    assert.ok(toolNames.includes('delete_bot'));

    const directCall = await executeMcpTool('get_system_snapshot', {});
    assert.equal(directCall.success, true);
  });

  await t.test('10. register_bot - Validazione guardrails e creazione bot', async () => {
    // 10.1 Violazione Guardrail: Leva > 5x rifiutata
    const invalidLev = await handleRegisterBot({
      name: 'High Leverage Bot',
      coin: 'BTC-PERP',
      config: { leverage: 10 }
    });
    assert.equal(invalidLev.success, false);
    assert.match(invalidLev.message, /GUARDRAIL_VIOLATION: Max Account Leverage exceeded/i);

    // 10.2 Violazione Blacklist
    addBlacklistedAsset('AVAX-PERP');
    const blacklisted = await handleRegisterBot({
      name: 'Blacklisted Bot',
      coin: 'AVAX-PERP',
      config: { leverage: 2 }
    });
    assert.equal(blacklisted.success, false);
    assert.match(blacklisted.message, /GUARDRAIL_VIOLATION: Asset Blacklisted/i);
    removeBlacklistedAsset('AVAX-PERP');

    // 10.2-bis Sizing dinamico ATR con parametri fuori range: nessun bot creato.
    for (const [label, risk] of [
      ['riskPerTradePct', { useDynamicSizing: true, riskPerTradePct: 0 }],
      ['atrMultiplier', { useDynamicSizing: true, atrMultiplier: -1 }],
      ['atrPeriod', { useDynamicSizing: true, atrPeriod: 1 }],
      ['useDynamicSizing', { useDynamicSizing: 'yes' }]
    ]) {
      const res = await handleRegisterBot({
        name: `Dynamic Sizing Bot ${label}`,
        coin: 'BTC-PERP',
        config: { leverage: 2, risk }
      });
      assert.equal(res.success, false, `${label}: la registrazione doveva essere rifiutata`);
      assert.match(res.message, /GUARDRAIL_VIOLATION/i);
      assert.match(res.message, new RegExp(label, 'i'));
    }

    // 10.3 Creazione valida
    const regRes = await handleRegisterBot({
      name: 'Automated Hermes Trend Bot',
      coin: 'ETH-PERP',
      config: { leverage: 3, maxPositionUsd: 1500 },
      actor_label: 'Hermes',
      actor_id: 'hermes_agent_01'
    });
    assert.equal(regRes.success, true);
    assert.ok(regRes.data.bot_id);
    assert.equal(regRes.data.coin, 'ETH-PERP');
    assert.equal(regRes.data.actor_label, 'Hermes');
    assert.equal(regRes.data.is_managed_by_agent, true);

    const createdBotId = regRes.data.bot_id;

    // Verifica persistenza DB
    const dbBot = db.getBot(createdBotId);
    assert.ok(dbBot);
    assert.equal(dbBot.name, 'Automated Hermes Trend Bot');
    assert.equal(dbBot.actor_label, 'Hermes');

    // 11. delete_bot - Two-stage deletion
    // Stadio 1: Prompt conferma
    const delPrompt = await handleDeleteBot({ bot_id: createdBotId });
    assert.equal(delPrompt.success, false);
    assert.equal(delPrompt.status, 'confirmation_required');
    assert.ok(delPrompt.confirmation_token);

    // Stadio 2: Esecuzione con token valido
    const delRes = await handleDeleteBot({
      bot_id: createdBotId,
      confirmation_token: delPrompt.confirmation_token
    });
    assert.equal(delRes.success, true);

    // Verifica cancellazione DB
    const deletedDbBot = db.getBot(createdBotId);
    assert.ok(!deletedDbBot);
  });

  // Cleanup finale del bot di test
  try {
    await handleBotControl({ bot_id: testBotId, action: 'stop' });
    db.deleteBot(testBotId);
  } catch {}
});

/**
 * Merge della config di strategia — funzione pura, testata in isolamento
 * (passare dalle due conferme MCP per verificare l'aritmetica di un merge
 * sarebbe un test lento che fallisce per dieci motivi diversi da quello che
 * dichiara). Il contratto è: UN livello di profondità, oggetto su oggetto.
 */
test('mergeStrategyConfig: oggetto su oggetto fonde, tutto il resto sostituisce', () => {
  const current = {
    leverage: 2,
    risk: { maxPositionUsd: 500, maxLeverage: 3, useDynamicSizing: false },
    sizing: { mode: 'percent', value: 10 },
    entryRules: [{ type: 'price', op: '>', value: 1 }],
    dca: { steps: 2, stepPercent: 1 }
  };

  // Oggetto su oggetto: i campi non nominati sopravvivono.
  const fuso = mergeStrategyConfig(current, { risk: { useDynamicSizing: true, riskPerTradePct: 1.5 } });
  assert.deepEqual(fuso.risk, {
    maxPositionUsd: 500, maxLeverage: 3, useDynamicSizing: true, riskPerTradePct: 1.5
  });
  assert.deepEqual(fuso.sizing, current.sizing, 'i blocchi non nominati restano identici');
  assert.equal(fuso.leverage, 2);

  // Primitivi: sostituiscono, come già oggi.
  assert.equal(mergeStrategyConfig(current, { leverage: 5 }).leverage, 5);

  // Array: sostituiscono in blocco, mai elemento per elemento — un entryRules
  // fuso a metà sarebbe una strategia che nessuno ha scritto.
  const nuoveRegole = [{ type: 'funding', op: '<', value: 0 }];
  assert.deepEqual(mergeStrategyConfig(current, { entryRules: nuoveRegole }).entryRules, nuoveRegole);

  // Valore non-oggetto su un blocco: sostituisce (è il modo di azzerarlo).
  assert.equal(mergeStrategyConfig(current, { risk: null }).risk, null);
  assert.equal(mergeStrategyConfig(current, { dca: 0 }).dca, 0);

  // Oggetto su un valore che oggetto non è: sostituisce, niente merge inventato.
  assert.deepEqual(mergeStrategyConfig({ tp: 'percent' }, { tp: { enabled: true } }), { tp: { enabled: true } });

  // Chiavi nuove entrano normalmente.
  assert.deepEqual(mergeStrategyConfig({}, { trailing: { enabled: true } }).trailing, { enabled: true });

  // UN livello, dichiarato: il secondo livello sostituisce, non si fonde.
  const annidato = mergeStrategyConfig(
    { tp: { enabled: true, ladder: { a: 1 } } },
    { tp: { ladder: { b: 2 } } }
  );
  assert.deepEqual(annidato.tp, { enabled: true, ladder: { b: 2 } });
});

test('mergeStrategyConfig: non muta né la config esistente né i parametri', () => {
  const current = { risk: { maxPositionUsd: 500 } };
  const params = { risk: { riskPerTradePct: 1 } };
  const out = mergeStrategyConfig(current, params);
  assert.deepEqual(current, { risk: { maxPositionUsd: 500 } }, 'la config di partenza resta intatta');
  assert.deepEqual(params, { risk: { riskPerTradePct: 1 } });
  out.risk.maxPositionUsd = 1;
  assert.equal(current.risk.maxPositionUsd, 500, 'il blocco fuso è una copia, non un alias');
});

test('mergeStrategyConfig: params assente o non oggetto lascia la config com\'è', () => {
  const current = { leverage: 2, risk: { maxPositionUsd: 500 } };
  assert.deepEqual(mergeStrategyConfig(current, null), current);
  assert.deepEqual(mergeStrategyConfig(current, undefined), current);
});
