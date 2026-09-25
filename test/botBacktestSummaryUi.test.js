/**
 * Riga "Backtest" della card bot
 * ==============================
 * `_backtestRowHtml` / `_backtestStaleReason` / `_botCardHtml` (public/perps.js)
 *
 * La PR #54 ha aggiunto un cancello pre-flight sul percorso MCP: `register_bot` e
 * `update_strategy_params` eseguono un backtest vero prima di scrivere la strategia in
 * DB e salvano l'esito in `config.backtestSummary` (vedi `evaluateBacktestGate` in
 * src/mcp/guardrails.js e `runBacktestGate` in src/mcp/tools.js). Il dato esisteva ma
 * non era mostrato da nessuna parte: chi apriva la scheda di un bot creato da Hermes
 * non aveva modo di sapere se e come fosse stato validato.
 *
 * Cosa questi casi difendono, in ordine di importanza:
 *  1. Un riassunto SCADUTO non resta verde. L'unica chiave che una proposta
 *     `tune_params` approvata a mano può cambiare è `candleInterval` (`TUNABLE_KEYS`,
 *     src/agents/tunePatch.js) — cioè proprio il timeframe su cui il backtest è stato
 *     misurato — e `applyConfigPatch` fonde la patch lasciando il riassunto intatto.
 *     È la strada realistica per un "✅ superato" che descrive un'altra strategia.
 *  2. I campi `null` non diventano zeri. `Number(null)` vale 0: senza `_jevNumber` un
 *     `trades: null` diventa "0 trade" e un `checkedAt: null` diventa il 01/01/1970,
 *     due dati plausibili e falsi su un pannello di trading.
 *  3. Un verdetto che la UI non conosce compare in grigio col valore grezzo, non
 *     sparisce e non diventa verde di default.
 *  4. `reason`, `coin` e `interval` arrivano dal DB / da un agente esterno e finiscono
 *     in un attributo `title`: stessa disciplina di escaping del badge CRASH (issue #9).
 *  5. L'assenza del riassunto non produce "undefined" né una sezione vuota.
 *
 * Come gli altri test di `public/*.js`: caricamento in `node:vm` con DOM finto, quindi
 * si verifica il markup prodotto, non la resa visiva.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');

function fakeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener: () => {}, querySelector: () => null, remove: () => {}
  };
}

function loadUi() {
  const elements = {};
  const sandbox = {
    console, BigInt,
    window: { io: () => ({ on: () => {} }), addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '',
      getElementById: (id) => (elements[id] ||= fakeElement(id)),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async () => ({ ok: true, json: async () => ({ success: true, data: {} }) }),
    alert: () => {}, confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const perps = sandbox.window.perps;
  perps.toast = () => {};
  return perps;
}

/** Riassunto nella forma esatta prodotta da `runBacktestGate` (src/mcp/tools.js). */
function summary(overrides = {}) {
  return {
    verdict: 'passed',
    reason: 'Backtest superato: 12 trade, win rate 41.7%, profit factor 1.34, expectancy 2.10$/trade.',
    checkedAt: Date.UTC(2026, 8, 25, 12, 3, 0),
    trades: 12,
    winRate: 0.417,
    profitFactor: 1.34,
    expectancy: 2.1,
    totalPnl: 25.2,
    maxDrawdownPct: 6.75,
    periodDays: 30,
    candles: 2880,
    coin: 'SOL-PERP',
    interval: '15m',
    lookbackDays: 30,
    ...overrides
  };
}

/** Bot gestito da un agente: è il caso per cui la riga nasce. */
function bot(overrides = {}) {
  const { config, ...rest } = overrides;
  return {
    id: 'bot-1', name: 'Hermes SOL', coin: 'SOL-PERP', status: 'running', paper: true,
    dailyPnl: 0, position: null, lastEval: null, lastError: null, crashReason: null,
    openRate: null,
    is_managed_by_agent: true, actor_id: 'hermes_agent_01',
    config: { entryRules: [], logic: 'any', candleInterval: '15m', backtestSummary: summary(), ...config },
    ...rest
  };
}

/** Estrae la sola riga Backtest dal markup della card. */
function riga(html) {
  const m = html.match(/<div class="bot-meta bot-backtest-row">([\s\S]*?)<\/div>/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 1. Il caso base: il verdetto e i numeri che decidono
// ---------------------------------------------------------------------------

test('verdetto passed: pill verde, win rate in percentuale, trade, PF e data leggibile', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot()));
  assert.ok(r, 'la riga Backtest deve esistere su un bot che ne ha uno');
  assert.match(r, /bot-backtest-verdict is-passed/);
  assert.match(r, /✅ superato/);
  // Win rate come frazione 0-1 nel payload, percentuale a schermo. Una cifra
  // decimale come nel testo di `reason`: due numeri diversi per la stessa
  // grandezza sulla stessa card sarebbero indifendibili.
  assert.match(r, /41\.7% win/);
  assert.match(r, /12 trade/);
  assert.match(r, /PF 1\.34/);
  // `checkedAt` mai in epoch grezzo.
  assert.match(r, /class="bot-backtest-when">\d{2}\/\d{2}\/\d{2}/);
  assert.equal(r.includes('1790337780000'), false);
});

test('la riga Backtest sta subito sotto "Storico reale", per il confronto', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ stats: { trades: 4, winRate: 0.25, profitFactor: 0.6, totalPnl: -12 } }));
  const iStorico = html.indexOf('>Storico reale<');
  const iBacktest = html.indexOf('bot-backtest-row');
  assert.ok(iStorico > -1 && iBacktest > iStorico,
    'promessa del backtest e risultato reale vanno letti uno sotto l\'altro');
});

test('gli importi in dollari del backtest restano fuori dalla riga', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot({ config: { backtestSummary: summary({ totalPnl: 4321.5 }) } })));
  // Il P&L simulato esiste ma è solo nel tooltip, con la parola "simulato": un
  // importo in dollari su una card di trading si legge come soldi veri.
  assert.equal(/>[^<]*\$4,321/.test(r.replace(/title="[^"]*"/g, '')), false,
    'nessun importo simulato nel testo visibile della riga');
  assert.match(r, /title="[^"]*P&amp;L simulato \$4,321\.5/);
});

test('il tooltip porta il contesto della misura e il motivo testuale del gate', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot()));
  // Coin, intervallo e giorni di storico sono stati salvati apposta dal gate:
  // un profit factor senza sapere su cosa è stato misurato non è riproducibile.
  assert.match(r, /title="[^"]*su SOL-PERP, candele 15m, 30 giorni di storico/);
  assert.match(r, /title="[^"]*expectancy 2\.10\$\/trade/);
  assert.match(r, /title="[^"]*max drawdown 6\.75%/);
  assert.match(r, /title="[^"]*Backtest superato: 12 trade/);
});

test('periodDays assente: si dichiara la finestra RICHIESTA, non la si spaccia per storico coperto', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot({ config: { backtestSummary: summary({ periodDays: null }) } })));
  assert.match(r, /title="[^"]*finestra richiesta 30 giorni/);
  assert.equal(r.includes('30 giorni di storico'), false,
    'i due numeri dicono cose diverse e non vanno confusi');
});

// ---------------------------------------------------------------------------
// 2. I tre verdetti si distinguono a colpo d'occhio
// ---------------------------------------------------------------------------

test('verdetto inconclusive: grigio, mai verde — nessuno ha verificato l\'edge', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot({
    config: {
      backtestSummary: summary({
        verdict: 'inconclusive', trades: 3, winRate: 0.667, profitFactor: 1.9,
        reason: 'Backtest con troppi pochi trade per giudicare (3 < 10 richiesti): 3 trade, win rate 66.7%, profit factor 1.900, expectancy 1.20$/trade. Creazione consentita, edge NON verificato.'
      })
    }
  })));
  assert.match(r, /bot-backtest-verdict is-unknown/);
  assert.match(r, /❔ non concludente/);
  assert.equal(r.includes('is-passed'), false, 'un edge non verificato non è un edge superato');
  assert.equal(r.includes('is-blocked'), false, 'e non è nemmeno una bocciatura');
  assert.match(r, /3 trade/, 'i numeri che ci sono vanno mostrati comunque');
});

test('verdetto blocked: rosso, e non viene silenziato perché "non dovrebbe capitare"', () => {
  const perps = loadUi();
  // Sul percorso MCP un `blocked` è fail-fast e in DB non viene scritta nessuna
  // riga: se un riassunto bloccato compare su un bot vivo, quella config è
  // entrata per una via che il cancello non attraversa. È l'ultima cosa da
  // nascondere, non la prima.
  const r = riga(perps._botCardHtml(bot({
    config: {
      backtestSummary: summary({
        verdict: 'blocked', trades: 18, winRate: 0.278, profitFactor: 0.41,
        reason: 'strategia in perdita netta sul backtest degli ultimi dati storici — 18 trade, win rate 27.8%, profit factor 0.410, expectancy -3.40$/trade. Soglia di blocco: profit factor < 1 con almeno 10 trade.'
      })
    }
  })));
  assert.match(r, /bot-backtest-verdict is-blocked/);
  assert.match(r, /⛔ non superato/);
  assert.match(r, /PF 0\.41/);
  assert.match(r, /title="[^"]*in perdita netta/);
});

test('un verdetto che la UI non conosce compare grigio col valore grezzo, non sparisce', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot({ config: { backtestSummary: summary({ verdict: 'degraded' }) } })));
  assert.ok(r, 'un quarto esito lato backend non deve far sparire la riga');
  assert.match(r, /bot-backtest-verdict is-unknown/);
  assert.match(r, /degraded/, 'meglio un nome tecnico che una modifica invisibile');
  assert.equal(r.includes('is-passed'), false);
});

// ---------------------------------------------------------------------------
// 3. Il riassunto scaduto — il caso che vale più di tutti
// ---------------------------------------------------------------------------

test('candleInterval cambiato dopo il backtest: il verde decade in grigio "non più valido"', () => {
  const perps = loadUi();
  // Esattamente lo scenario di una proposta `tune_params` approvata: l'unica
  // chiave tunabile è `candleInterval`, `applyConfigPatch` la fonde e lascia
  // `backtestSummary` intatto. Il verdetto parla di un'altra strategia.
  const r = riga(perps._botCardHtml(bot({
    config: { candleInterval: '5m', backtestSummary: summary({ interval: '15m', verdict: 'passed' }) }
  })));
  assert.match(r, /bot-backtest-verdict is-unknown/);
  assert.match(r, /❔ non più valido/);
  assert.equal(r.includes('is-passed'), false,
    'un "superato" misurato su un altro timeframe è un numero plausibile e falso');
  // Il verdetto originale non si perde: resta consultabile nel tooltip.
  assert.match(r, /title="[^"]*misurato su candele 15m, ma il bot ora opera su 5m/);
  assert.match(r, /title="[^"]*Verdetto originale: passed/);
});

test('coin diversa fra riassunto e bot: stessa decadenza', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot({
    coin: 'BTC-PERP', config: { backtestSummary: summary({ coin: 'SOL-PERP' }) }
  })));
  assert.match(r, /❔ non più valido/);
  assert.match(r, /title="[^"]*misurato su SOL-PERP, ma il bot ora opera su BTC-PERP/);
});

test('il suffisso -PERP non è una differenza: nessun falso allarme', () => {
  const perps = loadUi();
  // Il gate normalizza la coin, la riga in DB non sempre: senza la
  // normalizzazione OGNI bot risulterebbe "non più valido".
  const r = riga(perps._botCardHtml(bot({ coin: 'SOL', config: { backtestSummary: summary({ coin: 'SOL-PERP' }) } })));
  assert.match(r, /✅ superato/);
  assert.equal(r.includes('non più valido'), false);
});

test('candleInterval assente in config significa "default", non "diverso"', () => {
  const perps = loadUi();
  // Il confronto scatta solo con ENTRAMBI i valori presenti: altrimenti ogni bot
  // che non sovrascrive l'intervallo porterebbe un avviso inventato.
  const cfg = { entryRules: [], logic: 'any', backtestSummary: summary({ interval: '15m' }) };
  const b = bot();
  b.config = cfg;
  assert.equal(cfg.candleInterval, undefined, 'precondizione: nessun intervallo in config');
  const r = riga(perps._botCardHtml(b));
  assert.match(r, /✅ superato/);
  assert.equal(r.includes('non più valido'), false);
});

// ---------------------------------------------------------------------------
// 4. Ignoto non è zero (`Number(null)` vale 0)
// ---------------------------------------------------------------------------

test('trades null non diventa "0 trade": si dichiara che le statistiche mancano', () => {
  const perps = loadUi();
  // Caso vero: backtest mai eseguito perché la strategia non ha entryRules, o
  // perché la rete era giù. `evaluateBacktestGate` mette tutto a null.
  const r = riga(perps._botCardHtml(bot({
    config: {
      backtestSummary: summary({
        verdict: 'inconclusive', trades: null, winRate: null, profitFactor: null,
        expectancy: null, totalPnl: null, maxDrawdownPct: null, periodDays: null, candles: null,
        reason: 'Backtest non concludente: nessuna regola di ingresso da valutare (strategia senza entryRules). Creazione consentita, edge NON verificato.'
      })
    }
  })));
  assert.match(r, /statistiche non disponibili/);
  assert.equal(/\b0 trade\b/.test(r), false, 'un conteggio assente non è un conteggio pari a zero');
  assert.equal(/0\.0% win/.test(r), false);
  assert.match(r, /title="[^"]*nessuna regola di ingresso da valutare/);
});

test('profitFactor null accanto a trade misurati: "PF n/d", non un valore inventato', () => {
  const perps = loadUi();
  // Il gate collassa su null sia "non calcolabile" sia `Infinity`: la UI non può
  // ricostruire quale dei due, e il valore vero resta nel testo di `reason`.
  const r = riga(perps._botCardHtml(bot({
    config: {
      backtestSummary: summary({
        verdict: 'inconclusive', trades: 14, winRate: 1, profitFactor: null,
        reason: 'Backtest con profit factor non calcolabile (Infinity) su 14 trade: 14 trade, win rate 100.0%, profit factor ∞, expectancy 4.00$/trade. Creazione consentita, edge NON verificato.'
      })
    }
  })));
  assert.match(r, /14 trade/);
  assert.match(r, /PF n\/d/);
  assert.equal(/PF 0\.00/.test(r), false, '`Number(null)` vale 0: sarebbe una strategia in perdita totale');
  assert.match(r, /title="[^"]*profit factor ∞/, 'il valore vero resta leggibile nel motivo del gate');
});

test('checkedAt null non diventa il 1° gennaio 1970', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot({ config: { backtestSummary: summary({ checkedAt: null }) } })));
  assert.match(r, /class="bot-backtest-when">data ignota</);
  assert.equal(r.includes('01/01/70'), false, 'una data plausibile e finta è peggio di una data assente');
  assert.match(r, /title="[^"]*\(data non registrata\)/);
});

test('checkedAt a 0 riceve lo stesso trattamento di null', () => {
  const perps = loadUi();
  const r = riga(perps._botCardHtml(bot({ config: { backtestSummary: summary({ checkedAt: 0 }) } })));
  assert.match(r, /data ignota/);
  assert.equal(r.includes('01/01/70'), false);
});

// ---------------------------------------------------------------------------
// 5. Assenza del riassunto: niente "undefined", niente sezione vuota
// ---------------------------------------------------------------------------

test('bot manuale senza backtest: nessuna riga, nessun rumore', () => {
  const perps = loadUi();
  const b = bot({ name: 'Scalper a mano', is_managed_by_agent: false, actor_id: 'user_manual' });
  delete b.config.backtestSummary;
  assert.equal(b.config.backtestSummary, undefined, 'precondizione: nessun backtest in config');
  const html = perps._botCardHtml(b);
  assert.equal(html.includes('bot-backtest-row'), false,
    'il cancello vive sul percorso MCP: su un bot creato a mano l\'assenza non informa nessuno');
  assert.equal(html.toLowerCase().includes('undefined'), false);
});

test('bot gestito da agente ma senza backtest: lo dice, e non lo chiama bocciatura', () => {
  const perps = loadUi();
  const b = bot();
  delete b.config.backtestSummary;
  const r = riga(perps._botCardHtml(b));
  assert.ok(r, 'su un bot di Hermes "mai verificato" è un\'informazione, non un vuoto');
  assert.match(r, /bot-backtest-none/);
  assert.match(r, /mai verificato/);
  assert.equal(r.includes('is-blocked'), false);
  assert.equal(r.includes('is-passed'), false);
  assert.match(r, /title="[^"]*Non vuol dire che la strategia sia stata bocciata/);
});

test('backtestSummary non è un oggetto: trattato come assente, non come dato', () => {
  const perps = loadUi();
  for (const rotto of [null, 'passed', 42, []]) {
    const html = perps._botCardHtml(bot({ config: { backtestSummary: rotto } }));
    assert.equal(html.toLowerCase().includes('undefined'), false, `payload ${JSON.stringify(rotto)}`);
    assert.equal(html.includes('bot-backtest-verdict'), false,
      'un riassunto malformato non produce un verdetto');
    assert.match(html, /mai verificato/);
  }
});

test('config assente del tutto non rompe la card', () => {
  const perps = loadUi();
  const b = bot();
  delete b.config;
  const html = perps._botCardHtml(b);
  assert.match(html, /class="bot-card-actions"/, 'la card si costruisce comunque fino in fondo');
  assert.equal(html.toLowerCase().includes('undefined'), false);
});

// ---------------------------------------------------------------------------
// 6. Escaping — `reason`, `coin` e `interval` arrivano dal DB (issue #9)
// ---------------------------------------------------------------------------

test('reason ostile nel title non chiude l\'attributo', () => {
  const perps = loadUi();
  // `reason` ingloba il messaggio di un'eccezione vera, che può citare
  // parametri scritti da un agente esterno.
  const html = perps._botCardHtml(bot({
    config: { backtestSummary: summary({ reason: 'Backtest non concludente: getaddrinfo " onmouseover="alert(1)' }) }
  }));
  assert.equal(html.includes('" onmouseover="'), false);
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/,
    'il valore va mostrato escapato, non cancellato');
});

test('coin e interval ostili non producono tag né attributi', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    config: {
      candleInterval: '15m',
      backtestSummary: summary({ coin: '<img src=x onerror=alert(1)>', interval: "' onfocus='alert(1)" })
    }
  }));
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes("' onfocus='"), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('un verdetto sconosciuto con markup dentro non entra nel DOM come tag', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    config: { backtestSummary: summary({ verdict: '<b>passed</b>' }) }
  }));
  assert.equal(html.includes('<b>passed</b>'), false);
  assert.match(html, /&lt;b&gt;passed&lt;\/b&gt;/);
});

// ---------------------------------------------------------------------------
// 7. Le classi CSS usate qui esistono davvero nel foglio di stile
//    (il DOM finto non carica CSS: senza questo check un refuso passerebbe
//    tutti i casi sopra e a schermo non si vedrebbe nessun colore)
// ---------------------------------------------------------------------------

test('ogni classe nuova della riga Backtest ha una regola in styles_perps.css', () => {
  const css = fs.readFileSync(path.join(HERE, '..', 'public', 'styles_perps.css'), 'utf8');
  for (const cls of [
    'bot-backtest-value', 'bot-backtest-verdict', 'bot-backtest-stats',
    'bot-backtest-when', 'bot-backtest-none', 'muted'
  ]) {
    assert.match(css, new RegExp(`\\.${cls}[\\s.,:{]`), `manca la regola CSS per .${cls}`);
  }
  // I tre stati devono avere colori DIVERSI, altrimenti il verdetto non si legge
  // a colpo d'occhio ed è come non averlo reso.
  const colori = ['is-passed', 'is-blocked', 'is-unknown'].map((stato) => {
    const m = css.match(new RegExp(`\\.bot-backtest-verdict\\.${stato}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `manca la regola per .bot-backtest-verdict.${stato}`);
    return m[1].match(/(?:^|[^-])color:\s*([^;]+);/)[1].trim();
  });
  assert.equal(new Set(colori).size, 3, 'i tre verdetti devono essere distinguibili per colore');
});
