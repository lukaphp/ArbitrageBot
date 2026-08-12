/**
 * Secondo valore in EUR (public/perps.js, public/index.html) — CUR-01
 * ==================================================================
 *
 * La storia è di sola visualizzazione: l'EUR è un secondo numero di comodo
 * accanto agli importi USD, che restano la fonte primaria. Il criterio di
 * accettazione che conta più di tutti è quello negativo:
 *
 *   **tasso `stale: true`, oppure chiamata fallita ⇒ si mostra SOLO USD.**
 *
 * Un EUR calcolato su un tasso di ieri è peggio di nessun EUR, perché è
 * indistinguibile da uno giusto — è la stessa ragione per cui la curva equity
 * della dashboard non sintetizza più una serie finta quando lo storico manca.
 * Questi casi coprono entrambe le direzioni: EUR presente a tasso fresco, EUR
 * assente (elemento svuotato *e* nascosto) in ogni altro caso.
 *
 * Come gli altri test di `public/*.js`: `node:vm` con DOM finto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');
const INDEX_HTML = path.join(HERE, '..', 'public', 'index.html');

function fakeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', dataset: {}, hidden: false,
    style: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener: () => {},
    querySelector: () => null,
    hasClass: (c) => classes.has(c)
  };
}

const IDS = [
  'cockpitEquity', 'cockpitEquityEur', 'cockpitHeaderEquity', 'cockpitHeaderEquityEur',
  'cockpitNetPnl', 'cockpitNetPnlEur', 'cockpitFxNote', 'cockpitUpdatedAt',
  'cockpitMarginUsed', 'cockpitMarginFree', 'cockpitDrawdown', 'cockpitRealized', 'cockpitUnrealized',
  'walletStatus', 'positionsList', 'noPositions'
];

/**
 * Carica perps.js con `/api/fx/eurusd` che risponde come indicato (o fallisce) e
 * uno snapshot di rischio minimale da cui la dashboard prende equity e PnL.
 */
function loadFxUi({ fx = { rate: 1.10, asOf: Date.now(), stale: false }, fxFails = false } = {}) {
  const elements = Object.fromEntries(IDS.map(id => [id, fakeElement(id)]));
  const requests = [];

  const sandbox = {
    console, BigInt, Map, Set, Date, JSON, Math, Number, String, Array, Object, Error, Promise,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '🤖 ArbitrageBot Perps',
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => ({
        tagName: String(tag).toUpperCase(), textContent: '', className: '', children: [],
        appendChild(c) { this.children.push(c); return c; },
        get outerHTML() {
          const inner = this.children.map(c => c.outerHTML ?? c.textContent).join('');
          return `<${this.tagName.toLowerCase()}>${this.textContent}${inner}</${this.tagName.toLowerCase()}>`;
        }
      }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method || 'GET' });
      if (url.startsWith('/api/fx/eurusd')) {
        if (fxFails) return { ok: false, status: 502, json: async () => ({ success: false, error: 'fonte tasso non raggiungibile' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: fx }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    },
    alert: () => {}, confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const perps = sandbox.window.perps;
  // Snapshot minimale: equity e PnL netto, cioè i due valori a cui la storia
  // chiede di affiancare l'EUR.
  perps.riskSnapshot = {
    account: { equity: 2200, totalMarginUsed: 220, positions: [] },
    pnl: { net: -110, realized: -60, unrealized: -50 },
    limits: {}
  };
  perps.account = perps.riskSnapshot.account;

  return { perps, elements, requests, eur: (id) => elements[id] };
}

test('tasso fresco: EUR mostrato accanto a equity e PnL, USD sempre per primo', async () => {
  const ui = loadFxUi({ fx: { rate: 1.10, asOf: Date.now(), stale: false } });
  await ui.perps.loadFxRate();

  assert.deepEqual(
    { rate: ui.perps.fx.rate },
    { rate: 1.10 }
  );
  // USD invariato: resta la fonte primaria.
  assert.equal(ui.elements.cockpitEquity.textContent, '$2,200');
  assert.equal(ui.elements.cockpitHeaderEquity.textContent, '$2,200');
  // 2200 / 1.10 = 2000
  assert.equal(ui.eur('cockpitEquityEur').textContent, '≈ €2,000');
  assert.equal(ui.eur('cockpitEquityEur').hidden, false);
  assert.equal(ui.eur('cockpitHeaderEquityEur').textContent, '≈ €2,000');
  // PnL negativo: -110 / 1.10 = -100, con il segno davanti al simbolo.
  assert.equal(ui.elements.cockpitNetPnl.textContent, '-$110');
  assert.equal(ui.eur('cockpitNetPnlEur').textContent, '≈ -€100');
});

test('la nota dichiara tasso ed età, così l\'EUR non sembra una conversione ufficiale', async () => {
  const ui = loadFxUi({ fx: { rate: 1.0925, asOf: Date.now() - 5 * 60_000, stale: false } });
  await ui.perps.loadFxRate();

  const note = ui.elements.cockpitFxNote;
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /EUR indicativo/);
  assert.match(note.textContent, /EURUSD 1\.0925/);
  assert.match(note.textContent, /aggiornato 5 min fa/);
});

test('con la forma reale del modulo tasso (asOf = data BCE) la nota dichiara il giorno', async () => {
  // `src/perps/fxRate.js` restituisce `asOf` come data di riferimento BCE
  // (`YYYY-MM-DD`) più `ageMs`. Il tasso è una fissazione giornaliera: dire
  // "aggiornato 12 min fa" sarebbe una mezza bugia, si dichiara il giorno.
  const ui = loadFxUi({
    fx: {
      rate: 1.0842, asOf: '2026-08-09', stale: false, ageMs: 32 * 60 * 60 * 1000,
      fetchedAt: new Date().toISOString(), fetchAgeMs: 1200, source: 'frankfurter', error: null
    }
  });
  await ui.perps.loadFxRate();

  assert.equal(ui.perps.fx.rate, 1.0842);
  assert.match(ui.elements.cockpitFxNote.textContent, /EURUSD 1\.0842/);
  assert.match(ui.elements.cockpitFxNote.textContent, /tasso BCE del 09\/08/);
  assert.equal(ui.eur('cockpitEquityEur').hidden, false, 'un tasso BCE di ieri ma non stale si usa');
});

test('forma reale del fallimento: HTTP 200, success:true, rate null e stale true', async () => {
  // La route non restituisce un errore HTTP quando la fonte è giù: risponde
  // `{success:true, data:{rate:null, stale:true, error:"..."}}`. La UI deve
  // riconoscerlo dai dati, non dallo stato HTTP.
  const ui = loadFxUi({
    fx: { rate: null, asOf: null, stale: true, ageMs: null, fetchedAt: null, fetchAgeMs: null, source: 'frankfurter', error: 'timeout' }
  });
  await ui.perps.loadFxRate();

  assert.equal(ui.perps.fx, null);
  assert.equal(ui.eur('cockpitEquityEur').hidden, true);
  assert.equal(ui.elements.cockpitFxNote.hidden, true);
  assert.equal(ui.elements.cockpitEquity.textContent, '$2,200', 'l\'USD non viene toccato');
});

test('CRITERIO PRINCIPALE — stale: true ⇒ solo USD, nessun EUR calcolato', async () => {
  const ui = loadFxUi({ fx: { rate: 1.10, asOf: Date.now() - 86_400_000, stale: true } });
  await ui.perps.loadFxRate();

  assert.equal(ui.perps.fx, null, 'un tasso stantio non viene nemmeno conservato');
  assert.equal(ui.perps.fmtEur(2200), '', 'nessuna formattazione EUR possibile');
  // USD intatto.
  assert.equal(ui.elements.cockpitEquity.textContent, '$2,200');
  // EUR: svuotato E nascosto. Solo svuotarlo lascerebbe un elemento vuoto ma
  // presente nel layout.
  for (const id of ['cockpitEquityEur', 'cockpitHeaderEquityEur', 'cockpitNetPnlEur']) {
    assert.equal(ui.eur(id).textContent, '', `${id} deve restare vuoto`);
    assert.equal(ui.eur(id).hidden, true, `${id} deve essere nascosto`);
  }
  assert.equal(ui.elements.cockpitFxNote.hidden, true, 'nessuna nota su un tasso che non si usa');
});

test('chiamata fallita ⇒ solo USD, e nessun fallback su un tasso precedente', async () => {
  const ui = loadFxUi({ fx: { rate: 1.10, asOf: Date.now(), stale: false } });
  await ui.perps.loadFxRate();
  assert.equal(ui.eur('cockpitEquityEur').hidden, false, 'prima il tasso c\'era');

  // La fonte cade: l'EUR deve sparire, non restare congelato sull'ultimo tasso.
  ui.perps.api = async () => { throw new Error('fonte tasso non raggiungibile'); };
  await ui.perps.loadFxRate();

  assert.equal(ui.perps.fx, null);
  assert.equal(ui.eur('cockpitEquityEur').textContent, '');
  assert.equal(ui.eur('cockpitEquityEur').hidden, true);
  assert.equal(ui.elements.cockpitEquity.textContent, '$2,200', 'l\'USD non viene toccato');
});

test('risposta senza tasso utilizzabile (rate assente, zero o negativo) ⇒ solo USD', async () => {
  for (const rate of [undefined, null, 0, -1.1, 'abc']) {
    const ui = loadFxUi({ fx: { rate, asOf: Date.now(), stale: false } });
    await ui.perps.loadFxRate();
    assert.equal(ui.perps.fx, null, `rate=${rate} non deve produrre un tasso`);
    assert.equal(ui.eur('cockpitEquityEur').hidden, true);
  }
});

test('un tasso vecchio di ore non viene più usato anche se il server lo diceva fresco', async () => {
  const ui = loadFxUi({ fx: { rate: 1.10, asOf: Date.now(), stale: false } });
  await ui.perps.loadFxRate();
  assert.equal(ui.perps.fmtEur(1100), '€1,000');

  // Pagina lasciata aperta a lungo: la risposta "fresco" di sette ore fa non lo è più.
  ui.perps.fxFetchedAt = Date.now() - 7 * 60 * 60 * 1000;
  assert.equal(ui.perps.fmtEur(1100), '', 'oltre FX_MAX_AGE_MS l\'EUR sparisce da sé');
  ui.perps._applyFxNote();
  assert.equal(ui.elements.cockpitFxNote.hidden, true);
});

test('PnL per posizione: EUR presente a tasso fresco, assente altrimenti', async () => {
  const positions = [{
    coin: 'SOL', side: 'long', size: 12, entryPx: 140, unrealizedPnl: -55,
    leverage: 3, liquidationPx: 120, openedAt: 1_770_000_000_000, botName: 'Manuale'
  }];

  const fresh = loadFxUi({ fx: { rate: 1.10, asOf: Date.now(), stale: false } });
  await fresh.perps.loadFxRate();
  fresh.perps._renderPositions(positions);
  // Qui c'era `$-55`: questa tabella non passava dalla normalizzazione del segno
  // che il cockpit si faceva a mano, e l'incoerenza era annotata come fuori dal
  // perimetro di CUR-01. **DEBT-04 l'ha chiusa alla radice** portando il segno
  // dentro `fmtUsd()`, quindi ora anche la tabella Positions stampa `-$55` senza
  // che nessuno qui abbia dovuto ricordarsene — che era il punto della storia.
  // Il resto dell'assert è invariato: l'USD resta primario, l'EUR gli sta accanto.
  assert.match(fresh.elements.positionsList.innerHTML, /-\$55/, 'USD primario, segno prima del simbolo');
  assert.equal(fresh.elements.positionsList.innerHTML.includes('$-55'), false, 'la vecchia forma non deve tornare');
  assert.match(fresh.elements.positionsList.innerHTML, /≈ -€50/, 'EUR indicativo sotto');

  const stale = loadFxUi({ fx: { rate: 1.10, asOf: Date.now(), stale: true } });
  await stale.perps.loadFxRate();
  stale.perps._renderPositions(positions);
  assert.match(stale.elements.positionsList.innerHTML, /-\$55/);
  assert.equal(/€/.test(stale.elements.positionsList.innerHTML), false, 'nessun euro con tasso stantio');
});

test('nessun timer nuovo: il ricontrollo del tasso è una verifica di TTL, non un intervallo', () => {
  const src = fs.readFileSync(PERPS_JS, 'utf8');
  // Gli intervalli esistenti sono quelli di prima: account, rischio, monitor bot,
  // grafico posizione. CUR-01 non ne aggiunge nessuno.
  const intervals = src.match(/setInterval\(/g) || [];
  assert.equal(intervals.length, 4, `attesi 4 setInterval, trovati ${intervals.length}`);
  assert.match(src, /_maybeRefreshFxRate\(\)/);
  assert.equal(/setInterval\([^)]*loadFxRate/.test(src), false, 'il tasso non va in polling dedicato');
});

test('INVARIANTE DI SPRINT: CUR-01 non tocca la logica di rischio', () => {
  const src = fs.readFileSync(PERPS_JS, 'utf8');
  // Nessun limite viene convertito: i tre cap restano espressi in USD.
  for (const limit of ['maxDailyLossUsd', 'maxPositionUsd', 'maxTotalExposureUsd']) {
    const converted = new RegExp(`${limit}[^\\n]*(fmtEur|_eur\\()`);
    assert.equal(converted.test(src), false, `${limit} non deve passare per la conversione EUR`);
  }
  // `_eur`/`fmtEur` sono usati solo per presentare valori, mai per calcolare
  // qualcosa che rientri in un confronto di rischio.
  assert.equal(/if\s*\([^)]*_eur\(/.test(src), false, 'nessuna decisione presa su un valore in EUR');
});

test('index.html: gli elementi EUR esistono, nascosti per default', () => {
  const markup = fs.readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const id of ['cockpitEquityEur', 'cockpitHeaderEquityEur', 'cockpitNetPnlEur', 'cockpitFxNote']) {
    assert.match(markup, new RegExp(`id="${id}"[^>]*hidden`), `${id} deve partire nascosto`);
  }
  // L'USD resta il valore principale, l'EUR gli sta accanto (dopo, non al posto).
  assert.ok(markup.indexOf('id="cockpitEquity"') < markup.indexOf('id="cockpitEquityEur"'));
  assert.ok(markup.indexOf('id="cockpitNetPnl"') < markup.indexOf('id="cockpitNetPnlEur"'));
});
