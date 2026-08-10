/**
 * OBS-01: l'esposizione /metrics deve essere scrapabile da Prometheus
 * ==================================================================
 *
 * Da quando esistono davvero un Prometheus e una dashboard Grafana che leggono
 * questo endpoint (deploy/monitoring/), il formato del testo non è più un
 * dettaglio estetico: una famiglia senza `# TYPE`, o con HELP/TYPE dopo il primo
 * campione, viene interpretata male o scartata dal parser — e il pannello resta
 * vuoto senza che nessuno sappia perché.
 *
 * Il test verifica le regole del formato testo di Prometheus 0.0.4 su cui la
 * dashboard si appoggia, non i valori: HELP e TYPE presenti una volta sola per
 * famiglia e prima dei suoi campioni.
 *
 * `render()` riceve sorgenti finte: importare botManager reale tirerebbe dentro
 * il singleton `db` e farebbe scrivere il test su data/perps.db.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { render } from '../src/perps/metrics.js';

/** Sorgenti finte: due bot, uno in esecuzione che ha ticcato e uno fermo che non ha mai ticcato. */
function fakeSources({ wsConnected = true } = {}) {
  return {
    botManager: {
      listStates: () => ([
        {
          name: 'btc-trend', coin: 'BTC', status: 'running', inPosition: true,
          dailyPnl: 12.3456789, lastTickAt: Date.now() - 45_000, tickErrors: 2
        },
        {
          name: 'eth-scalp', coin: 'ETH', status: 'stopped', inPosition: false,
          dailyPnl: 0, lastTickAt: null, tickErrors: 0
        }
      ])
    },
    marketData: { getStatus: () => ({ markets: 187 }) },
    client: { wsConnected: () => wsConnected }
  };
}

/**
 * Ricostruisce la struttura dell'esposizione: per ogni famiglia, quante righe
 * HELP/TYPE ha e in quale ordine sono comparse rispetto ai campioni.
 */
function parseExposition(text) {
  const families = new Map();
  const of = (name) => {
    if (!families.has(name)) families.set(name, { help: 0, type: null, typeLines: 0, samples: 0, sampleBeforeMeta: false });
    return families.get(name);
  };

  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    let m;
    if ((m = /^# HELP (\S+) (.+)$/.exec(l))) { of(m[1]).help++; of(m[1]).helpText = m[2]; continue; }
    if ((m = /^# TYPE (\S+) (\S+)$/.exec(l))) { const f = of(m[1]); f.type = m[2]; f.typeLines++; continue; }
    assert.doesNotMatch(l, /^#/, `commento non riconosciuto nell'esposizione: "${l}"`);

    m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?[\d.eE+]+)$/.exec(l);
    assert.ok(m, `riga non conforme al formato Prometheus: "${l}"`);
    const f = of(m[1]);
    if (!f.help || !f.typeLines) f.sampleBeforeMeta = true;
    f.samples++;
    f.lastValue = m[3];
    f.labels = m[2] || '';
  }
  return families;
}

test('ogni famiglia esposta ha HELP e TYPE, una volta sola e prima dei campioni', async () => {
  const families = parseExposition(await render(fakeSources()));

  assert.ok(families.size >= 10, `attese almeno 10 famiglie, trovate ${families.size}`);
  for (const [name, f] of families) {
    assert.equal(f.help, 1, `${name}: attesa esattamente una riga # HELP, trovate ${f.help}`);
    assert.equal(f.typeLines, 1, `${name}: attesa esattamente una riga # TYPE, trovate ${f.typeLines}`);
    assert.match(f.type, /^(gauge|counter)$/, `${name}: tipo non valido (${f.type})`);
    assert.equal(f.sampleBeforeMeta, false, `${name}: un campione precede le righe HELP/TYPE`);
    assert.ok(f.samples > 0, `${name}: dichiarata ma senza campioni`);
    assert.ok(f.helpText.length > 10, `${name}: HELP troppo generico per essere utile in Grafana`);
  }
});

test('le serie usate dalla dashboard e dagli alert sono tutte presenti', async () => {
  // Se una di queste sparisce o viene rinominata, un pannello di
  // deploy/monitoring/grafana/dashboards/ o una regola di alerts.yml smette di
  // funzionare in silenzio. Elenco allineato a OBS-01.
  const required = {
    perps_bot_daily_pnl: 'gauge',
    perps_ws_connected: 'gauge',
    perps_bot_last_tick_seconds: 'gauge',
    perps_bot_running: 'gauge',
    perps_api_errors_total: 'counter',
    perps_positions_open: 'gauge',
    perps_uptime_seconds: 'gauge'
  };

  const families = parseExposition(await render(fakeSources()));
  for (const [name, type] of Object.entries(required)) {
    assert.ok(families.has(name), `serie mancante: ${name}`);
    assert.equal(families.get(name).type, type, `${name}: tipo cambiato`);
  }
});

test('bot fermo o mai ticcato: valori distinguibili invece che indistinguibili da un guasto', async () => {
  const text = await render(fakeSources());

  // -1 = "non ha mai ticcato": è la convenzione documentata nell'HELP, e sta
  // sotto qualunque soglia di staleness, quindi non fa scattare l'alert.
  assert.match(text, /^perps_bot_last_tick_seconds\{bot="eth-scalp",coin="ETH"\} -1$/m);
  assert.match(text, /^perps_bot_last_tick_seconds\{bot="btc-trend",coin="BTC"\} 4[45]$/m);

  // perps_bot_running distingue "fermo a mano" da "bloccato": senza questo,
  // l'alert sulla staleness spara per sempre su ogni bot fermato.
  assert.match(text, /^perps_bot_running\{bot="btc-trend",coin="BTC"\} 1$/m);
  assert.match(text, /^perps_bot_running\{bot="eth-scalp",coin="ETH"\} 0$/m);
});

test('WS disconnesso: perps_ws_connected a 0 (è la condizione dell\'alert)', async () => {
  const text = await render(fakeSources({ wsConnected: false }));
  assert.match(text, /^perps_ws_connected 0$/m);
});

test('render() senza argomenti resta la firma usata da /metrics', async () => {
  // Il parametro `sources` è un aggancio per i test: la chiamata di produzione
  // (src/server.js) non passa nulla e deve continuare a compilare/funzionare
  // senza che questo test importi i singleton reali — qui si verifica solo che
  // l'arità non sia diventata obbligatoria.
  assert.equal(render.length, 0, 'render() non deve avere parametri obbligatori');
});
