/**
 * METRICHE (formato Prometheus)
 * =============================
 *
 * Espone metriche operative del sottosistema Perps per scraping/alerting.
 * I contatori sono incrementati dai vari moduli via inc(); i gauge sono letti
 * live al momento dello scrape da botManager/marketData/client (import lazy per
 * evitare cicli).
 */

const counters = {
  api_errors_total: 0,     // errori verso le API Hyperliquid (retry esauriti)
  tick_errors_total: 0,    // errori nei tick dei bot
  orders_placed_total: 0,  // ordini market inviati
  ws_reconnects_total: 0   // riconnessioni WebSocket
};

const startedAt = Date.now();

export function inc(name, by = 1) {
  counters[name] = (counters[name] || 0) + by;
}

/**
 * Valore corrente di un contatore. Esiste per poter asserire un contatore nei
 * test senza passare da render(), che importa botManager/marketData (troppi
 * singleton per un test mirato).
 */
export function get(name) {
  return counters[name] || 0;
}

/** Riga Prometheus per una metrica con etichette opzionali. */
function line(name, value, labels) {
  const lbl = labels
    ? '{' + Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(',') + '}'
    : '';
  return `${name}${lbl} ${value}`;
}

/** Renderizza tutte le metriche in formato testo Prometheus. */
export async function render() {
  const { default: botManager } = await import('./botManager.js');
  const { default: marketData } = await import('./marketData.js');
  const { default: client } = await import('./hyperliquidClient.js');

  const states = botManager.listStates();
  const running = states.filter(s => s.status === 'running');
  const out = [];

  out.push('# HELP perps_uptime_seconds Tempo di attività del processo.');
  out.push('# TYPE perps_uptime_seconds gauge');
  out.push(line('perps_uptime_seconds', Math.floor((Date.now() - startedAt) / 1000)));

  out.push('# TYPE perps_bots_total gauge');
  out.push(line('perps_bots_total', states.length));
  out.push('# TYPE perps_bots_running gauge');
  out.push(line('perps_bots_running', running.length));

  out.push('# TYPE perps_positions_open gauge');
  out.push(line('perps_positions_open', states.filter(s => s.inPosition).length));

  out.push('# TYPE perps_ws_connected gauge');
  out.push(line('perps_ws_connected', client.wsConnected() ? 1 : 0));

  out.push('# TYPE perps_markets gauge');
  out.push(line('perps_markets', marketData.getStatus().markets || 0));

  // Per-bot: PnL giornaliero, ultimo tick, errori
  out.push('# TYPE perps_bot_daily_pnl gauge');
  out.push('# TYPE perps_bot_last_tick_seconds gauge');
  out.push('# TYPE perps_bot_tick_errors gauge');
  for (const s of states) {
    const labels = { bot: s.name, coin: s.coin };
    out.push(line('perps_bot_daily_pnl', Number(s.dailyPnl || 0).toFixed(4), labels));
    const ageSec = s.lastTickAt ? Math.floor((Date.now() - s.lastTickAt) / 1000) : -1;
    out.push(line('perps_bot_last_tick_seconds', ageSec, labels));
    out.push(line('perps_bot_tick_errors', s.tickErrors || 0, labels));
  }

  // Contatori cumulativi
  for (const [name, val] of Object.entries(counters)) {
    out.push(`# TYPE perps_${name} counter`);
    out.push(line(`perps_${name}`, val));
  }

  return out.join('\n') + '\n';
}

export default { inc, get, render };
