/**
 * HTTP / JSON-RPC / REST TRANSPORT FOR MCP
 * =========================================
 *
 * Espone le API MCP via HTTP per permettere l'integrazione con agenti sia via
 * JSON-RPC 2.0 (`POST /api/mcp`), sia via endpoint REST (`POST /api/mcp/call`, `GET /api/mcp/tools`).
 */

import {
  handleBotControl,
  handlePlaceOrderPaper,
  handleGetSystemSnapshot,
  handleEmergencyShutdown,
  handleUpdateStrategyParams
} from './tools.js';

export const MCP_TOOLS_DEFINITIONS = [
  {
    name: 'bot_control',
    description: 'Controlla il ciclo di vita del bot (start, stop, restart) con salvaguardia watchdog e gestione crash.',
    inputSchema: {
      type: 'object',
      properties: {
        bot_id: { type: 'string', description: 'UUID univoco del bot da controllare' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'], description: "Azione: 'start', 'stop' o 'restart'" }
      },
      required: ['bot_id', 'action']
    }
  },
  {
    name: 'place_order_paper',
    description: 'Piazza un ordine di trading paper validando i guardrail di rischio (leva <= 5x, account exposure, blacklist, cooldown, daily loss limit).',
    inputSchema: {
      type: 'object',
      properties: {
        bot_id: { type: 'string', description: "UUID del bot che invia l'ordine" },
        side: { type: 'string', enum: ['long', 'short'], description: "Direzione: 'long' o 'short'" },
        size: { type: 'number', description: 'Dimensione/quantità in unità della coin' },
        entry_price: { type: 'number', description: 'Prezzo stimato di ingresso (opzionale)' },
        leverage: { type: 'number', description: 'Leva richiesta per l\'ordine (max 5x)' }
      },
      required: ['bot_id', 'side', 'size']
    }
  },
  {
    name: 'get_system_snapshot',
    description: 'Restituisce lo stato consolidato del sistema: stato bot, P&L cumulativo, uPNL posizioni e alert attivi.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'emergency_shutdown',
    description: 'Arresta immediatamente tutti i bot attivi e abilita il kill-switch globale con conferma a due stadi (60s TTL).',
    inputSchema: {
      type: 'object',
      properties: {
        confirmation_token: { type: 'string', description: 'Token di conferma ricevuto allo stadio 1 (obbligatorio per confermare ed eseguire)' },
        confirm: { type: 'boolean', description: 'Legacy flag di conferma diretta' },
        threshold: { type: 'number', description: 'Soglia numerica di perdita o drawdown (opzionale)' }
      }
    }
  },
  {
    name: 'update_strategy_params',
    description: 'Modifica i parametri di strategia del bot nel DB SQLite con conferma a due stadi (60s) e ricarica della cache runtime.',
    inputSchema: {
      type: 'object',
      properties: {
        bot_id: { type: 'string', description: 'UUID del bot da riconfigurare' },
        params: { type: 'object', description: 'Dizionario chiave-valore con i nuovi parametri' },
        confirmation_token: { type: 'string', description: 'Token di conferma ricevuto allo stadio 1 (obbligatorio per confermare ed applicare le modifiche)' }
      },
      required: ['bot_id', 'params']
    }
  }
];

export async function executeMcpTool(toolName, args = {}) {
  switch (toolName) {
    case 'bot_control':
      return await handleBotControl(args);
    case 'place_order_paper':
      return await handlePlaceOrderPaper(args);
    case 'get_system_snapshot':
      return await handleGetSystemSnapshot(args);
    case 'emergency_shutdown':
      return await handleEmergencyShutdown(args);
    case 'update_strategy_params':
      return await handleUpdateStrategyParams(args);
    default:
      return { success: false, message: `Tool sconosciuto: '${toolName}'` };
  }
}

/**
 * Gestore JSON-RPC 2.0 conforme a specifiche MCP per POST /api/mcp
 */
export async function handleJsonRpcMcp(req, res) {
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: id || null,
      error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' }
    });
  }

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'arbitragebot-mcp', version: '1.0.0' }
      }
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS_DEFINITIONS }
    });
  }

  if (method === 'tools/call') {
    const { name, arguments: toolArgs } = params || {};
    const result = await executeMcpTool(name, toolArgs || {});
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.success
      }
    });
  }

  if (method === 'ping') {
    return res.json({ jsonrpc: '2.0', id, result: {} });
  }

  return res.status(404).json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  });
}
