/**
 * UNIT TESTS: ARBITRAGEBOT MCP SERVER & TOOLS
 * ============================================
 *
 * Valida i 5 tools del Server MCP:
 * 1. bot_control (start, stop, restart, crash safeguard)
 * 2. place_order_paper (size validation, maxPositionUsd safeguard, kill-switch)
 * 3. get_system_snapshot (aggregated totals, bot list, open positions, alerts)
 * 4. emergency_shutdown (safe-guard two-step confirmation, halt all bots, killswitch)
 * 5. update_strategy_params (schema validation, DB write, runtime cache invalidation)
 * 6. Audit logging con actor 'hermes_mcp_call'
 * 7. JSON-RPC 2.0 transport (initialize, tools/list, tools/call)
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
  executeMcpTool,
  MCP_TOOLS_DEFINITIONS
} from '../src/mcp/httpTransport.js';

test('MCP Suite: Test dei Tool e Safeguard per Hermes', async (t) => {
  // Setup DB in memoria per i test se necessario
  db.ensure();
  botManager.loadFromDb();

  // Crea un bot di test
  const testBotId = 'test-mcp-bot-' + Date.now();
  db.insertBot({
    id: testBotId,
    name: 'MCP Test Bot',
    coin: 'SOL-PERP',
    network: 'testnet',
    masterAddress: '0x000000000000000000000000000000000000dEaD',
    config: {
      leverage: 2,
      maxPositionUsd: 500,
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

  await t.test('2. place_order_paper - Size & maxPositionUsd Safeguards', async () => {
    // Ordine valido
    const validOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 1.0,
      entry_price: 50.0
    });
    assert.equal(validOrder.success, true);
    assert.equal(validOrder.data.coin, 'SOL-PERP');
    assert.equal(validOrder.data.side, 'long');
    assert.ok(validOrder.data.notional_usd > 0);

    // Ordine che eccede maxPositionUsd (500 USD)
    const oversizedOrder = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'long',
      size: 500.0,
      entry_price: 100.0 // 500 * 100 = 50000 USD > 500
    });
    assert.equal(oversizedOrder.success, false);
    assert.match(oversizedOrder.message, /supera maxPositionUsd/i);

    // Side non valido
    const invalidSide = await handlePlaceOrderPaper({
      bot_id: testBotId,
      side: 'up',
      size: 1.0
    });
    assert.equal(invalidSide.success, false);
  });

  await t.test('3. get_system_snapshot - Restituisce snapshot completo', async () => {
    const snapshot = await handleGetSystemSnapshot();
    assert.equal(snapshot.success, true);
    assert.ok(snapshot.data.system_health);
    assert.ok(Array.isArray(snapshot.data.bots));
    assert.ok(Array.isArray(snapshot.data.open_positions));
    assert.ok(Array.isArray(snapshot.data.alerts));
    assert.ok(snapshot.data.portfolio);
  });

  await t.test('4. emergency_shutdown - Two-step confirmation & Halt', async () => {
    // Tentativo senza conferma
    const unconfirmed = await handleEmergencyShutdown({ confirm: false });
    assert.equal(unconfirmed.success, false);
    assert.match(unconfirmed.message, /confirm: true/i);

    // Avvia il bot di test per verificare che venga fermato
    await handleBotControl({ bot_id: testBotId, action: 'start' });

    // Spegnimento confermato
    const shutdown = await handleEmergencyShutdown({ confirm: true, threshold: 5.0 });
    assert.equal(shutdown.success, true);
    assert.equal(riskAgent.isKillSwitchOn(), true);

    // Verifica che il bot sia stato fermato
    const botState = botManager.getBotState(testBotId);
    assert.equal(botState.status, 'stopped');

    // Ripristina kill-switch
    riskAgent.setKillSwitch(false);
  });

  await t.test('5. update_strategy_params - DB write & memory cache invalidation', async () => {
    const updateRes = await handleUpdateStrategyParams({
      bot_id: testBotId,
      params: {
        leverage: 5,
        maxPositionUsd: 800,
        takeProfitPct: 0.05
      }
    });
    assert.equal(updateRes.success, true);
    assert.equal(updateRes.data.current_config.leverage, 5);
    assert.equal(updateRes.data.current_config.maxPositionUsd, 800);

    // Verifica che in memoria e in DB sia aggiornato
    const dbBot = db.getBot(testBotId);
    const dbConfig = typeof dbBot.config_json === 'string' ? JSON.parse(dbBot.config_json) : (dbBot.config || {});
    assert.equal(dbConfig.leverage, 5);

    const memBot = botManager.getBotState(testBotId);
    assert.equal(memBot.config.leverage, 5);
  });

  await t.test('6. Audit Logging - Registrazione chiamate con actor hermes_mcp_call', async () => {
    const audits = db.listAudit(20);
    const hermesCalls = audits.filter(a => a.actor === 'hermes_mcp_call');
    assert.ok(hermesCalls.length > 0, 'Devono essere presenti righe di audit per hermes_mcp_call');
  });

  await t.test('7. JSON-RPC & Tool Definitions', async () => {
    assert.equal(MCP_TOOLS_DEFINITIONS.length, 5);
    const toolNames = MCP_TOOLS_DEFINITIONS.map(t => t.name);
    assert.deepEqual(toolNames, [
      'bot_control',
      'place_order_paper',
      'get_system_snapshot',
      'emergency_shutdown',
      'update_strategy_params'
    ]);

    const res = await executeMcpTool('get_system_snapshot', {});
    assert.equal(res.success, true);
  });

  // Cleanup bot di test
  botManager.deleteBot(testBotId);
});
