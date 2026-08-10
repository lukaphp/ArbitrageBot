/**
 * METRICHE (formato Prometheus)
 * =============================
 *
 * Espone metriche operative del sottosistema Perps per scraping/alerting.
 * I contatori sono incrementati dai vari moduli via inc(); i gauge sono letti
 * live al momento dello scrape da botManager/marketData/client (import lazy per
 * evitare cicli).
 *
 * OGNI SERIE HA `# HELP` E `# TYPE` (OBS-01)
 * ------------------------------------------
 * Prima solo `perps_uptime_seconds` era documentata. Con Prometheus+Grafana che
 * ora consumano davvero questo endpoint (deploy/monitoring/), l'HELP non è
 * decorazione: è il testo che Grafana mostra nel selettore delle metriche e
 * l'unico posto dove sta scritto cosa significa un valore fuori scala — per
 * esempio che `perps_bot_last_tick_seconds` vale -1 per un bot che non ha ancora
 * ticcato, un valore che va escluso dalle soglie di alert.
 * I nomi delle serie NON sono cambiati: qualunque query o alert scritto contro
 * questo endpoint prima di OBS-01 continua a valere.
 */

const counters = {
  api_errors_total: 0,     // errori verso le API Hyperliquid (retry esauriti)
  tick_errors_total: 0,    // errori nei tick dei bot
  orders_placed_total: 0,  // ordini market inviati
  ws_reconnects_total: 0   // riconnessioni WebSocket
};

/**
 * Descrizione dei contatori cumulativi. Vive qui e non accanto alle chiamate a
 * inc(), che sono sparse in più moduli: un solo posto da aggiornare quando si
 * aggiunge un contatore, e nessun rischio che una serie esca senza HELP.
 */
const COUNTER_HELP = {
  api_errors_total: 'Errori verso le API Hyperliquid contati dopo l\'esaurimento dei retry (non i singoli tentativi).',
  tick_errors_total: 'Errori sollevati dal ciclo di valutazione dei bot, cumulativi dall\'avvio del processo.',
  orders_placed_total: 'Ordini market inviati al broker (reali o paper), cumulativi dall\'avvio del processo.',
  ws_reconnects_total: 'Riconnessioni WebSocket completate con successo dal watchdog del feed di mercato.'
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

/**
 * Emette un blocco completo per una famiglia di metriche: HELP, TYPE e poi tutti
 * i campioni. I campioni di una stessa famiglia vanno tenuti insieme (prima le
 * righe HELP/TYPE, poi i valori): il formato testo di Prometheus lo richiede, e
 * la versione precedente dichiarava i tre TYPE per-bot in blocco per poi
 * interlacciare i campioni delle tre famiglie dentro un unico ciclo.
 */
function family(out, name, type, help, samples) {
  out.push(`# HELP ${name} ${help}`);
  out.push(`# TYPE ${name} ${type}`);
  for (const s of samples) out.push(line(name, s.value, s.labels));
}

/**
 * Renderizza tutte le metriche in formato testo Prometheus.
 *
 * `sources` esiste solo per i test: in esercizio non viene passato e le tre
 * dipendenze restano gli stessi singleton importati in modo lazy (l'import lazy
 * serve a evitare cicli, vedi intestazione). Senza questo aggancio, verificare
 * che ogni serie abbia HELP e TYPE richiederebbe di importare botManager, quindi
 * il singleton `db`, quindi di scrivere su data/perps.db da un test.
 */
export async function render(sources = {}) {
  const botManager = sources.botManager || (await import('./botManager.js')).default;
  const marketData = sources.marketData || (await import('./marketData.js')).default;
  const client = sources.client || (await import('./hyperliquidClient.js')).default;

  const states = botManager.listStates();
  const running = states.filter(s => s.status === 'running');
  const out = [];

  family(out, 'perps_uptime_seconds', 'gauge',
    'Tempo di attività del processo in secondi (si azzera a ogni riavvio del container).',
    [{ value: Math.floor((Date.now() - startedAt) / 1000) }]);

  family(out, 'perps_bots_total', 'gauge',
    'Bot configurati, indipendentemente dallo stato.',
    [{ value: states.length }]);

  family(out, 'perps_bots_running', 'gauge',
    'Bot attualmente in esecuzione (status=running).',
    [{ value: running.length }]);

  family(out, 'perps_positions_open', 'gauge',
    'Posizioni aperte in questo momento, una per bot in posizione.',
    [{ value: states.filter(s => s.inPosition).length }]);

  family(out, 'perps_ws_connected', 'gauge',
    'Feed WebSocket Hyperliquid: 1 connesso, 0 in fallback REST (prezzi validi ma meno freschi).',
    [{ value: client.wsConnected() ? 1 : 0 }]);

  family(out, 'perps_markets', 'gauge',
    'Mercati perp noti al modulo dati di mercato.',
    [{ value: marketData.getStatus().markets || 0 }]);

  // ---- Per-bot (etichette: bot, coin) ----
  const labelsOf = s => ({ bot: s.name, coin: s.coin });

  family(out, 'perps_bot_daily_pnl', 'gauge',
    'PnL realizzato della giornata corrente per bot, in USD (si azzera al rollover giornaliero).',
    states.map(s => ({ labels: labelsOf(s), value: Number(s.dailyPnl || 0).toFixed(4) })));

  family(out, 'perps_bot_last_tick_seconds', 'gauge',
    'Secondi dall\'ultimo ciclo di valutazione del bot; -1 se non ha ancora ticcato. ' +
    'Cresce anche per i bot fermi: incrociare con perps_bot_running per gli alert.',
    states.map(s => ({
      labels: labelsOf(s),
      value: s.lastTickAt ? Math.floor((Date.now() - s.lastTickAt) / 1000) : -1
    })));

  // Serie aggiunta da OBS-01 (nessuna esistente rinominata): senza lo stato
  // per-bot, un alert su perps_bot_last_tick_seconds spara per sempre su ogni bot
  // fermato a mano, perché lastTickAt resta all'ultimo tick e la sua età cresce
  // senza limite. È la stessa condizione che il watchdog interno di botManager
  // applica già in codice (`if (bot.status !== 'running') continue`), qui resa
  // interrogabile da Prometheus.
  family(out, 'perps_bot_running', 'gauge',
    'Stato del singolo bot: 1 in esecuzione, 0 fermo o in errore.',
    states.map(s => ({ labels: labelsOf(s), value: s.status === 'running' ? 1 : 0 })));

  family(out, 'perps_bot_tick_errors', 'gauge',
    'Errori consecutivi/accumulati nel ciclo del singolo bot dall\'ultimo avvio del bot.',
    states.map(s => ({ labels: labelsOf(s), value: s.tickErrors || 0 })));

  // ---- Contatori cumulativi ----
  for (const [name, val] of Object.entries(counters)) {
    family(out, `perps_${name}`, 'counter',
      COUNTER_HELP[name] || 'Contatore cumulativo del sottosistema Perps (nessuna descrizione registrata in COUNTER_HELP).',
      [{ value: val }]);
  }

  return out.join('\n') + '\n';
}

export default { inc, get, render };
