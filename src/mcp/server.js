#!/usr/bin/env node

/**
 * ARBITRAGE BOT MCP SERVER
 * ========================
 *
 * Server Model Context Protocol (MCP) per Hermes AI Agent.
 * Espone i tools per il controllo del bot, ordini paper, monitoraggio sistema,
 * emergency shutdown e aggiornamento configurazione strategie in memoria e DB.
 *
 * Utilizzo:
 *   node src/mcp/server.js
 *
 * Configurazione Hermes config.yaml:
 *   mcp_servers:
 *     arbitragebot:
 *       command: "node"
 *       args: ["/opt/arbitragebot/app/src/mcp/server.js"]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import db from '../db/database.js';
import botManager from '../perps/botManager.js';
import logger from '../utils/logger.js';
import {
  handleBotControl,
  handlePlaceOrderPaper,
  handleGetSystemSnapshot,
  handleEmergencyShutdown,
  handleUpdateStrategyParams
} from './tools.js';

export function createArbitrageBotMcpServer() {
  const server = new McpServer({
    name: 'arbitragebot-mcp',
    version: '1.0.0'
  });

  // 1. Tool: bot_control
  server.tool(
    'bot_control',
    'Controlla il ciclo di vita del bot (start, stop, restart) con salvaguardia watchdog e gestione crash.',
    {
      bot_id: z.string().describe('UUID univoco del bot da controllare'),
      action: z.enum(['start', 'stop', 'restart']).describe("Azione da eseguire sul bot: 'start', 'stop' o 'restart'")
    },
    async ({ bot_id, action }) => {
      const res = await handleBotControl({ bot_id, action });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.success
      };
    }
  );

  // 2. Tool: place_order_paper
  server.tool(
    'place_order_paper',
    'Piazza un ordine di trading paper validando i guardrail di rischio (leva <= 5x, account exposure, blacklist, cooldown, daily loss limit).',
    {
      bot_id: z.string().describe('UUID del bot che invia l\'ordine'),
      side: z.enum(['long', 'short']).describe("Direzione dell'operazione: 'long' o 'short'"),
      size: z.number().positive().describe('Dimensione/quantità in unità della coin (es. 10.5)'),
      entry_price: z.number().positive().optional().describe('Prezzo stimato di ingresso (opzionale, default: mid di mercato corrente)'),
      leverage: z.number().int().min(1).max(5).optional().describe('Leva richiesta per l\'ordine (max 5x autorizzata da guardrail)')
    },
    async ({ bot_id, side, size, entry_price, leverage }) => {
      const res = await handlePlaceOrderPaper({ bot_id, side, size, entry_price, leverage });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.success
      };
    }
  );

  // 3. Tool: get_system_snapshot
  server.tool(
    'get_system_snapshot',
    'Restituisce lo stato consolidato del sistema: stato bot, P&L cumulativo, uPNL posizioni e alert attivi.',
    {},
    async () => {
      const res = await handleGetSystemSnapshot();
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.success
      };
    }
  );

  // 4. Tool: emergency_shutdown
  server.tool(
    'emergency_shutdown',
    'Arresta immediatamente tutti i bot attivi e abilita il kill-switch globale con conferma a due stadi (60s TTL).',
    {
      confirmation_token: z.string().optional().describe('Token di conferma ricevuto allo stadio 1 (obbligatorio per confermare ed eseguire entro 60s)'),
      confirm: z.boolean().optional().describe('Legacy flag di conferma diretta'),
      threshold: z.number().optional().describe('Soglia numerica di perdita o drawdown che ha innescato l\'emergenza (opzionale per tracciamento)')
    },
    async ({ confirmation_token, confirm, threshold }) => {
      const res = await handleEmergencyShutdown({ confirmation_token, confirm, threshold });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.success
      };
    }
  );

  // 5. Tool: update_strategy_params
  server.tool(
    'update_strategy_params',
    'Modifica i parametri di strategia del bot nel DB SQLite con conferma a due stadi (60s) e ricarica della cache runtime.',
    {
      bot_id: z.string().describe('UUID del bot da riconfigurare'),
      params: z.record(z.any()).describe('Dizionario chiave-valore con i nuovi parametri (es. { leverage: 5, maxPositionUsd: 1000, takeProfitPct: 0.02 })'),
      confirmation_token: z.string().optional().describe('Token di conferma ricevuto allo stadio 1 (obbligatorio per confermare ed applicare le modifiche entro 60s)')
    },
    async ({ bot_id, params, confirmation_token }) => {
      const res = await handleUpdateStrategyParams({ bot_id, params, confirmation_token });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.success
      };
    }
  );

  return server;
}

// Avvio automatico se eseguito direttamente via CLI / Stdio
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  // Garantisce che STDOUT sia riservato esclusivamente ai messaggi di protocollo JSON-RPC MCP
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);

  (async () => {
    try {
      db.init();
      botManager.loadFromDb();
      botManager.startWatchdog();

      const server = createArbitrageBotMcpServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info('🚀 ArbitrageBot MCP Server avviato su trasporto Stdio');
    } catch (err) {
      logger.error('❌ Avvio MCP Server fallito:', err);
      process.exit(1);
    }
  })();
}
