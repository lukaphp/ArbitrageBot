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
import {
  handleBotControl,
  handlePlaceOrderPaper,
  handleGetSystemSnapshot,
  handleEmergencyShutdown,
  handleUpdateStrategyParams
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
  });

  await t.test('8. Audit Logging - Registrazione chiamate con actor hermes_mcp_call', async () => {
    const audits = db.listAudit(30);
    const hermesCalls = audits.filter(a => a.actor === 'hermes_mcp_call');
    assert.ok(hermesCalls.length > 0, 'Devono essere presenti righe di audit per hermes_mcp_call');
  });

  await t.test('9. JSON-RPC 2.0 Tool Execution', async () => {
    assert.equal(MCP_TOOLS_DEFINITIONS.length, 5);
    const toolNames = MCP_TOOLS_DEFINITIONS.map(t => t.name);
    assert.ok(toolNames.includes('bot_control'));
    assert.ok(toolNames.includes('place_order_paper'));
    assert.ok(toolNames.includes('get_system_snapshot'));
    assert.ok(toolNames.includes('emergency_shutdown'));
    assert.ok(toolNames.includes('update_strategy_params'));

    const directCall = await executeMcpTool('get_system_snapshot', {});
    assert.equal(directCall.success, true);
  });

  // Cleanup finale del bot di test
  try {
    await handleBotControl({ bot_id: testBotId, action: 'stop' });
    db.deleteBot(testBotId);
  } catch {}
});
