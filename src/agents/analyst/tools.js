/**
 * STRUMENTI READ-ONLY per l'Analyst AI (tool-use) e per il consulente AI.
 *
 * ⚠️ Tutti gli strumenti sono di sola lettura: l'AI può osservare lo stato
 * (account, mercati, candele, statistiche, backtest, ML, rischio, proposte,
 * storico) ma NON può piazzare ordini né modificare nulla. Le azioni nascono
 * solo da proposte approvate da un umano, e passano dal gate di `riskAgent`.
 *
 * ADV-01 aggiunge 5 strumenti (`get_risk_snapshot`, `get_killswitch_state`,
 * `get_proposals`, `get_trade_history`, `get_equity_history`) **qui dentro** e
 * non in un file parallelo: sono wrapper sottili su logica già esistente, e
 * tenerli insieme agli altri 10 fa sì che ne benefici anche l'Analyst. Il
 * consulente non riceve tutto `TOOL_DEFS`: sopra c'è un'allowlist lato server
 * (`agents/advisor/toolset.js`).
 *
 * Ogni risultato che contiene una lista rientra in `TOOL_RESULT_CHAR_CAP`
 * togliendo elementi (vedi `withinCap`), non troncando il JSON a metà: un JSON
 * spezzato è un risultato che il modello interpreta a caso.
 */

import client from '../../perps/hyperliquidClient.js';
import marketData from '../../perps/marketData.js';
import predictor from '../../perps/predictor.js';
import portfolio from '../../perps/portfolio.js';
import db from '../../db/database.js';
import { runBacktest } from '../../perps/backtester.js';
import riskAgent from '../riskAgent.js';
import { TOOL_RESULT_CHAR_CAP } from '../usage.js';
import {
  calculateDrawdown, mergeDrawdownState, deriveRiskAlerts, summarizeRisk,
  RISK_ALERT_THRESHOLDS, toRiskBotView
} from '../../perps/riskSnapshot.js';
import { HYPERLIQUID_CONFIG } from '../../config/config.js';

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
  { name: 'get_recent_fills', description: 'Ultimi fill/ordini eseguiti sull\'account.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'scan_markets', description: 'Classifica i mercati per trovare candidati: variazione 24h, volume, |funding|, volatilità (|variazione|). Usalo per cercare opportunità su PIÙ mercati prima di proporre.', input_schema: { type: 'object', properties: { sortBy: { type: 'string', description: 'volume | change | volatility | funding (default volume)' }, limit: { type: 'number', description: 'quanti mercati (default 12)' } } } },
  { name: 'backtest_templates', description: 'Esegue il backtest di un set di strategie standard (RSI reversal, EMA trend, MACD momentum, Bollinger) su un mercato e ritorna quale ha edge, con la configurazione pronta. Usalo per SCOPRIRE rapidamente una strategia valida su un mercato candidato.', input_schema: { type: 'object', properties: { coin: { type: 'string' }, interval: { type: 'string', description: 'default 1h' }, lookbackDays: { type: 'number', description: 'default 45' } }, required: ['coin'] } },
  // --- ADV-01: 5 strumenti read-only aggiunti per il consulente AI ---
  { name: 'get_risk_snapshot', description: 'Stato di rischio corrente: esposizione, margine, drawdown, alert attivi con severità e sintesi (ok/review/blocked). È la stessa derivazione che alimenta il pannello Risk della cockpit. Usalo per rispondere a "quanto sono esposto?", "perché non posso aprire?", "quanto è profondo il drawdown?".', input_schema: { type: 'object', properties: {} } },
  { name: 'get_killswitch_state', description: 'Dice se il KILL-SWITCH è attivo. Se lo è, ogni nuova apertura è bloccata a monte dal gate di rischio: verificalo prima di suggerire qualunque apertura, altrimenti daresti un consiglio non eseguibile.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_proposals', description: 'Proposte AI e loro esito: in attesa, approvate, rifiutate, scadute. Include le strategie rifiutate di recente (contesto negativo: non riproporle). Usalo per rispondere a "cosa mi hai proposto e cosa ne ho fatto?".', input_schema: { type: 'object', properties: { status: { type: 'string', description: 'pending | approved | rejected | expired (default: tutte)' }, limit: { type: 'number', description: 'quante proposte (default 20)' } } } },
  { name: 'get_trade_history', description: 'Storico dei fill eseguiti (tabella trades), filtrabile per bot e mercato, più recenti prima. Serve per la performance nel tempo, non solo per gli ultimi ordini.', input_schema: { type: 'object', properties: { botId: { type: 'string' }, coin: { type: 'string' }, limit: { type: 'number', description: 'quanti fill (default 50)' } } } },
  { name: 'get_equity_history', description: 'Curva di equity persistita per l\'account corrente (campioni nel tempo) con drawdown massimo e corrente derivati. Usala per rispondere su andamento e profondità del drawdown.', input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'quanti campioni (default 60, max 180)' } } } }
];

/** Libreria di strategie standard che l'AI può scoprire e proporre. */
export const STRATEGY_TEMPLATES = {
  rsi_reversal: {
    label: 'Rimbalzo ipervenduto (RSI)',
    config: { direction: 'both', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' },
        { type: 'indicator', indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'short' }
      ], exitRules: [], tp: { enabled: true, mode: 'percent', value: 3 }, sl: { enabled: true, mode: 'percent', value: 1.5 } }
  },
  ema_trend: {
    label: 'Segui il trend (EMA50)',
    config: { direction: 'both', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'ema', period: 50, compareToPrice: true, op: '>', signal: 'long' },
        { type: 'indicator', indicator: 'ema', period: 50, compareToPrice: true, op: '<', signal: 'short' }
      ], exitRules: [], tp: { enabled: true, mode: 'percent', value: 5 }, sl: { enabled: true, mode: 'percent', value: 2.5 } }
  },
  macd_momentum: {
    label: 'Momentum (MACD)',
    config: { direction: 'both', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'macd', cond: 'bullish', signal: 'long' },
        { type: 'indicator', indicator: 'macd', cond: 'bearish', signal: 'short' }
      ], exitRules: [], tp: { enabled: true, mode: 'percent', value: 4 }, sl: { enabled: true, mode: 'percent', value: 2 } }
  },
  bollinger: {
    label: 'Bande di Bollinger',
    config: { direction: 'both', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'bollinger', cond: 'below_lower', signal: 'long' },
        { type: 'indicator', indicator: 'bollinger', cond: 'above_upper', signal: 'short' }
      ], exitRules: [], tp: { enabled: true, mode: 'percent', value: 3 }, sl: { enabled: true, mode: 'percent', value: 2 } }
  }
};

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
    case 'scan_markets': {
      const stats = await client.getMarketStats().catch(() => []);
      const usable = stats.filter(s => s.mark > 0);
      const sortBy = input.sortBy || 'volume';
      const sorter = {
        volume: (a, b) => b.volume24h - a.volume24h,
        change: (a, b) => (b.change24hPct || 0) - (a.change24hPct || 0),
        volatility: (a, b) => Math.abs(b.change24hPct || 0) - Math.abs(a.change24hPct || 0),
        funding: (a, b) => Math.abs(b.funding || 0) - Math.abs(a.funding || 0)
      }[sortBy] || ((a, b) => b.volume24h - a.volume24h);
      return usable.sort(sorter).slice(0, input.limit || 12).map(s => ({
        coin: s.coin, price: round(s.mark), change24hPct: round(s.change24hPct),
        volume24h: Math.round(s.volume24h), funding: s.funding, maxLeverage: s.maxLeverage
      }));
    }
    case 'backtest_templates': {
      const interval = input.interval || '1h';
      const days = input.lookbackDays || 45;
      const results = [];
      for (const [key, tpl] of Object.entries(STRATEGY_TEMPLATES)) {
        try {
          const r = await runBacktest({ ...tpl.config, candleInterval: interval }, input.coin, { interval, lookbackDays: days });
          if (r.error) { results.push({ template: key, label: tpl.label, error: r.error }); continue; }
          const s = r.stats;
          results.push({
            template: key, label: tpl.label,
            trades: s.trades, winRate: round(s.winRate), profitFactor: round(s.profitFactor),
            expectancy: round(s.expectancy), totalReturnPct: round(s.totalReturnPct),
            config: tpl.config // pronto per una proposta new_strategy_candidate
          });
        } catch (e) { results.push({ template: key, label: tpl.label, error: e.message }); }
      }
      // Ordina per expectancy (i migliori prima)
      results.sort((a, b) => (b.expectancy || -Infinity) - (a.expectancy || -Infinity));
      return { coin: input.coin, interval, lookbackDays: days, results };
    }
    // ---- ADV-01: strumenti read-only per il consulente AI (e per l'Analyst) ----

    case 'get_risk_snapshot': {
      // Nessun ricalcolo del rischio qui dentro: si assemblano gli INPUT e si
      // chiamano le stesse funzioni pure di riskSnapshot.js che alimentano
      // `/api/perps/risk`, con le stesse soglie (RISK_ALERT_THRESHOLDS) e lo
      // stesso adattatore bot (toRiskBotView). Se un giorno la cockpit e la chat
      // dessero risposte diverse sullo stesso account, sarebbe un bug qui.
      const { masterAddress, network, botManager } = await context();
      const now = Date.now();
      const killSwitch = riskAgent.isKillSwitchOn();
      const sourceErrors = [];

      let account = null;
      let orders = [];
      if (masterAddress) {
        account = await client.getAccount(masterAddress, network).catch(e => { sourceErrors.push(`account (${e.message})`); return null; });
        orders = await client.getFrontendOpenOrders(masterAddress, network).catch(e => { sourceErrors.push(`ordini (${e.message})`); return []; }) || [];
      }
      const limits = { ...portfolio.getLimits(), ...RISK_ALERT_THRESHOLDS };
      const bots = botManager.listStates().map(b => toRiskBotView(b, {
        now,
        defaultLoopInterval: HYPERLIQUID_CONFIG.botLoopInterval,
        defaultMaxDailyLossUsd: HYPERLIQUID_CONFIG.risk.maxDailyLossUsd
      }));
      const equityHistory = masterAddress ? db.listRiskEquityHistory(network, masterAddress, 180) : [];
      const persisted = masterAddress ? db.getRiskDrawdownState(network, masterAddress) : null;
      const drawdown = mergeDrawdownState(calculateDrawdown(equityHistory), persisted);
      const alerts = deriveRiskAlerts({
        now, address: masterAddress, account, orders, limits, bots,
        marketStatus: marketData.getStatus(), killSwitch, drawdown, sourceErrors,
        defaultMaxDailyLossUsd: HYPERLIQUID_CONFIG.risk.maxDailyLossUsd
      });
      const positions = Array.isArray(account?.positions) ? account.positions : [];
      const equity = round(account?.equity ?? account?.accountValue ?? null, 2);
      const margin = round(account?.totalMarginUsed ?? null, 2);
      return withinCap({
        killSwitch,
        summary: summarizeRisk(alerts, { killSwitch }),
        equity,
        marginUsed: margin,
        marginPct: equity > 0 ? round((margin / equity) * 100, 2) : null,
        openPositions: positions.length,
        exposureUsd: round(account?.totalNtlPos ?? positions.reduce((s, p) => s + Number(p.positionValue || 0), 0), 2),
        pendingOrders: orders.filter(o => !o.isTrigger).length,
        triggerOrders: orders.filter(o => o.isTrigger).length,
        drawdown: {
          maxUsd: round(drawdown.maxUsd, 2), maxPct: round(drawdown.maxPct, 2),
          currentUsd: round(drawdown.currentUsd, 2), currentPct: round(drawdown.currentPct, 2),
          peak: round(drawdown.peak, 2), scope: drawdown.scope
        },
        limits,
        sourceErrors,
        alerts: alerts.map(a => ({ severity: a.severity, id: a.id, title: a.title, body: a.body }))
      }, 'alerts');
    }

    case 'get_killswitch_state': {
      // Solo lettura del flag persistito. `riskAgent.setKillSwitch` NON è
      // raggiungibile da nessuno strumento: il kill-switch si tocca dal pannello
      // o da Telegram, mai da un modello.
      const on = riskAgent.isKillSwitchOn();
      return {
        killSwitch: on,
        opensBlocked: on,
        note: on
          ? 'Kill-switch ATTIVO: il gate di rischio respinge ogni nuova apertura. Le posizioni già aperte non sono state chiuse automaticamente.'
          : 'Kill-switch spento: le aperture sono consentite, sempre entro i limiti di rischio.'
      };
    }

    case 'get_proposals': {
      const limit = Math.max(1, Math.min(100, input.limit || 20));
      const rows = db.listProposals({ status: input.status || undefined, limit });
      const proposals = rows.map(p => ({
        id: p.id, type: p.type, coin: p.coin, status: p.status,
        confidence: round(p.confidence), rationale: p.rationale,
        createdAt: p.created_at, decidedAt: p.decided_at, expiresAt: p.expires_at,
        source: p.source, costUsd: round(p.cost_usd, 5)
      }));
      // Contesto negativo: strategie già scartate dall'utente. Riproporle (o
      // riproporne varianti equivalenti) è spesa senza destinatario.
      const rejected = db.getRecentRejected(12).map(r => {
        let cfg = null;
        try { cfg = JSON.parse(r.payload_json || '{}')?.config; } catch { /* payload illeggibile */ }
        const indicators = [...new Set((cfg?.entryRules || []).map(x => x.indicator).filter(Boolean))];
        return { coin: r.coin, indicators };
      });
      return withinCap({ counts: db.getStrategyCounts(), recentlyRejected: rejected, proposals }, 'proposals');
    }

    case 'get_trade_history': {
      const limit = Math.max(1, Math.min(500, input.limit || 50));
      const rows = db.listTradesBy({ botId: input.botId || null, coin: input.coin || null, limit });
      const trades = rows.map(t => ({
        ts: t.ts, botId: t.bot_id, coin: t.coin, side: t.side,
        px: round(t.px), sz: round(t.sz), fee: round(t.fee, 5)
      }));
      return withinCap({ filter: { botId: input.botId || null, coin: input.coin || null }, trades }, 'trades');
    }

    case 'get_equity_history': {
      const { masterAddress, network } = await context();
      if (!masterAddress) return { error: 'Nessun wallet collegato' };
      const limit = Math.max(1, Math.min(180, input.limit || 60));
      // La curva persistita è per (rete, indirizzo): si legge quella, non se ne
      // ricostruisce una a parte.
      const full = db.listRiskEquityHistory(network, masterAddress, 180);
      const persisted = db.getRiskDrawdownState(network, masterAddress);
      const drawdown = mergeDrawdownState(calculateDrawdown(full), persisted);
      // I campioni più RECENTI sono quelli che contano per una conversazione.
      const samples = full.slice(-limit).map(p => ({ t: p.time, equity: round(p.value, 2) }));
      return withinCap({
        network, samples: samples.reverse(), samplesAvailable: full.length,
        drawdown: {
          maxUsd: round(drawdown.maxUsd, 2), maxPct: round(drawdown.maxPct, 2),
          currentUsd: round(drawdown.currentUsd, 2), currentPct: round(drawdown.currentPct, 2),
          peak: round(drawdown.peak, 2), scope: drawdown.scope
        }
      }, 'samples');
    }

    default:
      return { error: `Strumento sconosciuto: ${name}` };
  }
}

/**
 * Fa rientrare un risultato entro `TOOL_RESULT_CHAR_CAP` rimuovendo elementi
 * dalla CODA della lista indicata (gli elementi più vecchi/meno rilevanti), e
 * dichiarando il taglio nel risultato stesso.
 *
 * Perché non troncare la stringa JSON: `analyst.js` tronca il `tool_result` a
 * 6.000 caratteri come rete di sicurezza, ma un JSON tagliato a metà arriva al
 * modello come testo non parsabile — e un modello che non riesce a leggere un
 * risultato inventa. Meglio meno righe, ma leggibili, e sapere che sono meno.
 */
function withinCap(result, listKey) {
  const items = Array.isArray(result[listKey]) ? result[listKey] : [];
  let kept = items.length;
  const shape = () => ({
    ...result,
    [listKey]: items.slice(0, kept),
    returned: kept,
    available: items.length,
    truncated: kept < items.length
  });
  let out = shape();
  while (kept > 0 && JSON.stringify(out).length > TOOL_RESULT_CHAR_CAP) {
    kept = Math.max(0, kept - Math.max(1, Math.ceil(kept * 0.15)));
    out = shape();
  }
  return out;
}

function round(n, d = 4) {
  if (n == null || isNaN(n) || !isFinite(n)) return n;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export default { TOOL_DEFS, runTool };
