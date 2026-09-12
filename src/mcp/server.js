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
  handleUpdateStrategyParams,
  handleRegisterBot,
  handleDeleteBot
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
    "Piazza un ordine di trading paper validando i guardrail di rischio (leva <= 5x, account exposure, blacklist, cooldown, daily loss limit). Un ingresso nello STESSO verso di una posizione già aperta sul mercato del bot è rifiutato: se il segnale è già stato agito l'azione corretta è HOLD, non un nuovo ordine. Un ordine di verso opposto è sempre accettato (riduzione/chiusura).",
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
      params: z.record(z.any()).describe('Dizionario chiave-valore con i nuovi parametri (es. { leverage: 5, maxPositionUsd: 1000, takeProfitPct: 0.02 }). I blocchi annidati (risk, sizing, tp, sl, trailing, dca) vengono FUSI un livello in profondità: i campi non nominati restano invariati. Per sostituire o azzerare un blocco intero passa un valore non-oggetto (es. risk: null).'),
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

  // 6. Tool: register_bot
  server.tool(
    'register_bot',
    'Registra e crea un nuovo bot di trading nel DB e in memoria, validando parametri, leverage <= 5x e blacklist.',
    {
      name: z.string().describe('Nome descrittivo del bot (es. "Trend Rider SOL")'),
      coin: z.string().describe('Simbolo del perpetual market (es. "SOL" o "SOL-PERP")'),
      config: z.record(z.any()).optional().describe('Configurazione opzionale della strategia (es. { leverage: 2, maxPositionUsd: 1000 })'),
      network: z.string().optional().describe('Rete di trading ("testnet" o "mainnet", default: testnet)'),
      master_address: z.string().optional().describe('Master address o wallet associato (default: paper_hermes)'),
      actor_label: z.string().optional().describe('Label identità visualizzata in UI (default: "Hermes")'),
      actor_id: z.string().optional().describe('ID agente (default: "hermes_agent_01")'),
      is_managed_by_agent: z.boolean().optional().describe('Indica se il bot è gestito da agente AI per inibire modifiche manuali in UI (default: true)'),
      auto_start: z.boolean().optional().describe('Se true, avvia immediatamente il bot dopo la registrazione (default: false)')
    },
    async (args) => {
      const res = await handleRegisterBot(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.success
      };
    }
  );

  // 7. Tool: delete_bot
  server.tool(
    'delete_bot',
    'Elimina definitivamente un bot dal DB e dalla memoria runtime con conferma a due stadi (60s TTL).',
    {
      bot_id: z.string().describe('UUID del bot da eliminare'),
      confirmation_token: z.string().optional().describe('Token di conferma ricevuto allo stadio 1 (obbligatorio per confermare ed eliminare entro 60s)')
    },
    async (args) => {
      const res = await handleDeleteBot(args);
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
