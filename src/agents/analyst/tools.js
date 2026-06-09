/**
 * STRUMENTI READ-ONLY per l'Analyst AI (tool-use).
 *
 * ⚠️ Tutti gli strumenti sono di sola lettura: l'AI può osservare lo stato
 * (account, mercati, candele, statistiche, backtest, ML) ma NON può piazzare
 * ordini né modificare nulla. Le azioni nascono solo da proposte approvate.
 */

import client from '../../perps/hyperliquidClient.js';
import marketData from '../../perps/marketData.js';
import predictor from '../../perps/predictor.js';
import portfolio from '../../perps/portfolio.js';
import db from '../../db/database.js';
import { runBacktest } from '../../perps/backtester.js';

/** Risolve master address + rete dal primo bot (o ENV). */
async function context() {
  const { default: botManager } = await import('../../perps/botManager.js');
  const bot = [...botManager.bots.values()][0];
  return {
    masterAddress: bot?.masterAddress || process.env.WALLET_ADDRESS || null,
    network: bot?.network || client.network,
    botManager
  };
}

/** Definizioni tool nel formato Anthropic. */
export const TOOL_DEFS = [
  { name: 'get_account', description: 'Stato dell\'account: equity, margine, posizioni aperte con PnL.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_bots', description: 'Elenco dei bot con stato (running/stopped), mercato e statistiche reali (win rate, trade, PnL).', input_schema: { type: 'object', properties: {} } },
  { name: 'get_markets', description: 'Mercati principali con prezzo corrente e leva massima.', input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'quanti mercati (default 25)' } } } },
  { name: 'get_candles', description: 'Statistiche di prezzo recenti per un mercato (ultimo prezzo, variazione %, max/min, volatilità).', input_schema: { type: 'object', properties: { coin: { type: 'string' }, interval: { type: 'string', description: 'es. 15m,1h,4h,1d' }, lookbackDays: { type: 'number' } }, required: ['coin'] } },
  { name: 'ml_predict', description: 'Stima ML (FreqAI-lite) della probabilità di rialzo per un mercato, con accuratezza e baseline del modello.', input_schema: { type: 'object', properties: { coin: { type: 'string' }, interval: { type: 'string' } }, required: ['coin'] } },
  { name: 'run_backtest', description: 'Backtest di una strategia a regole su dati storici. config: { entryRules:[{type:"indicator",indicator:"rsi",period:14,op:"<",value:30,signal:"long"}], tp:{enabled:true,value:3}, sl:{enabled:true,value:1.5} }. Ritorna win rate, profit factor, expectancy.', input_schema: { type: 'object', properties: { coin: { type: 'string' }, interval: { type: 'string' }, lookbackDays: { type: 'number' }, config: { type: 'object' } }, required: ['coin', 'config'] } },
  { name: 'get_portfolio_limits', description: 'Limiti di rischio di portafoglio attivi (max posizioni concorrenti, esposizione, perdite consecutive, cooldown).', input_schema: { type: 'object', properties: {} } },
  { name: 'get_recent_fills', description: 'Ultimi fill/ordini eseguiti sull\'account.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } }
];

/** Esegue uno strumento read-only. */
export async function runTool(name, input = {}) {
  switch (name) {
    case 'get_account': {
      const { masterAddress, network } = await context();
      if (!masterAddress) return { error: 'Nessun wallet collegato' };
      const acc = await client.getAccount(masterAddress, network);
      return {
        equity: round(acc.equity), accountValue: round(acc.accountValue),
        marginUsed: round(acc.totalMarginUsed), spotUsdc: round(acc.spotUsdc),
        positions: acc.positions.map(p => ({
          coin: p.coin, side: p.side, size: p.size, entryPx: p.entryPx,
          unrealizedPnl: round(p.unrealizedPnl), leverage: p.leverage, liquidationPx: p.liquidationPx
        }))
      };
    }
    case 'get_bots': {
      const { botManager } = await context();
      return botManager.listStates().map(s => ({
        id: s.id, name: s.name, coin: s.coin, status: s.status, inPosition: s.inPosition,
        stats: s.stats ? { trades: s.stats.trades, winRate: round(s.stats.winRate), totalPnl: round(s.stats.totalPnl) } : null
      }));
    }
    case 'get_markets': {
      const limit = input.limit || 25;
      const markets = marketData.getMarkets().slice(0, limit);
      return markets.map(m => ({ coin: m.coin, mid: m.mid ?? marketData.getMid(m.coin), maxLeverage: m.maxLeverage }));
    }
    case 'get_candles': {
      const interval = input.interval || '1h';
      const days = input.lookbackDays || 7;
      const candles = await marketData.getCandles(input.coin, interval, days * 86400000) || [];
      if (!candles.length) return { error: 'Nessun dato' };
      const closes = candles.map(c => +c.c);
      const last = closes[closes.length - 1], first = closes[0];
      const hi = Math.max(...candles.map(c => +c.h)), lo = Math.min(...candles.map(c => +c.l));
      const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
      const vol = Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) * 100;
      return { coin: input.coin, interval, candles: candles.length, last, changePct: round(((last - first) / first) * 100), high: hi, low: lo, volatilityPct: round(vol) };
    }
    case 'ml_predict': {
      const r = await predictor.predict(input.coin, input.interval || '1h');
      if (r.error) return r;
      return { coin: input.coin, probUp: round(r.probUp), hasEdge: r.hasEdge, accuracy: round(r.model.accuracy), baseline: round(r.model.baseline) };
    }
    case 'run_backtest': {
      const r = await runBacktest(input.config, input.coin, { interval: input.interval || '1h', lookbackDays: input.lookbackDays || 30 });
      if (r.error) return r;
      const s = r.stats;
      return { trades: s.trades, winRate: round(s.winRate), profitFactor: round(s.profitFactor), expectancy: round(s.expectancy), totalReturnPct: round(s.totalReturnPct), maxDrawdownPct: round(s.maxDrawdownPct), period: r.period };
    }
    case 'get_portfolio_limits':
      return portfolio.getLimits();
    case 'get_recent_fills': {
      const { masterAddress, network } = await context();
      if (!masterAddress) return { error: 'Nessun wallet collegato' };
      const fills = await client.getUserFills(masterAddress, network).catch(() => []);
      return (fills || []).slice(0, input.limit || 20);
    }
    default:
      return { error: `Strumento sconosciuto: ${name}` };
  }
}

function round(n, d = 4) {
  if (n == null || isNaN(n) || !isFinite(n)) return n;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export default { TOOL_DEFS, runTool };
