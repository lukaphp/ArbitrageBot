/**
 * Badge "Trade Velocity" e intestazione a due livelli della card bot
 * ==================================================================
 * `_tradeVelocityBadge` / `_overtradingGateActive` / `_botCardHtml` (public/perps.js)
 *
 * OVERTRADE-01 aggiunge `openRate` allo stato di ogni bot: quante volte è entrato a
 * mercato nell'ultima ora e nelle ultime 4, più la soglia del freno. La card lo rende
 * come badge a quattro esiti (assente / ⚡ elevato / 🚦 in pausa / ❔ sconosciuto).
 *
 * Cosa questi casi difendono, in ordine di importanza:
 *  1. `openRate: null` NON diventa "zero aperture". È il conteggio che il backend non è
 *     riuscito a leggere: renderlo come un bot tranquillo è la bugia peggiore possibile
 *     su questo pannello. `Number(null)` vale 0, quindi la regressione è a una riga di
 *     distanza in ogni momento.
 *  2. Soglia e finestra si leggono dal payload, mai dai default riscritti lato UI: un bot
 *     con `overtrading` sovrascritto in config mostrerebbe una soglia che non è la sua.
 *  3. `lastEval.reason` entra in un attributo `title` ed è testo non fidato (cita il nome
 *     del bot): stessa disciplina di escaping del badge CRASH, issue #9.
 *  4. L'intestazione è davvero su due livelli, e lo slot alert contiene solo allarmi.
 *
 * Come gli altri test di `public/*.js`: caricamento in `node:vm` con DOM finto, quindi si
 * verifica il markup prodotto, non la resa visiva.
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

/** `openRate` come lo produce `_openRateView()` in src/perps/bot.js. */
function openRate(overrides = {}) {
  return {
    lastHour: 0, last4h: 0, inWindow: 0, windowMinutes: 30, maxOpensPerWindow: 4, enabled: true,
    ...overrides
  };
}

function bot(overrides = {}) {
  return {
    id: 'bot-1', name: 'Scalper BTC', coin: 'BTC', status: 'running', paper: false,
    dailyPnl: 12.5, position: null, lastEval: null, lastError: null, crashReason: null,
    openRate: openRate(),
    config: { entryRules: [], logic: 'any' },
    ...overrides
  };
}

/** Motivo esatto prodotto da `checkOvertrading` (src/perps/riskManager.js). */
function motivoGate(opens = 5, win = 30, max = 4) {
  return `Overtrading: ${opens} aperture negli ultimi ${win} min (max ${max}) — nuove aperture sospese per ~12 min`;
}

// ---------------------------------------------------------------------------
// 1. Ignoto ≠ zero — il caso da scrivere per primo
// ---------------------------------------------------------------------------

test('openRate null non diventa "zero aperture": badge grigio, non badge assente', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ openRate: null }));
  assert.match(html, /bot-velocity-badge is-unknown/,
    'un conteggio non leggibile va dichiarato, non taciuto come un bot tranquillo');
  assert.match(html, /❔ velocità sconosciuta/);
  assert.equal(html.includes('is-elevated'), false);
  assert.equal(html.includes('is-paused'), false);
});

test('openRate assente dal payload è trattato come ignoto, non come normale', () => {
  const perps = loadUi();
  const senza = bot();
  delete senza.openRate;
  assert.match(perps._botCardHtml(senza), /bot-velocity-badge is-unknown/);
});

test('lastHour a 0 con conteggio leggibile è invece silenzio: nessun badge', () => {
  const perps = loadUi();
  // Precondizione: il campo c'è ed è uno zero VERO, non un null coercizzato.
  const b = bot({ openRate: openRate({ lastHour: 0, last4h: 0 }) });
  assert.equal(b.openRate.lastHour, 0, 'precondizione: zero misurato');
  const html = perps._botCardHtml(b);
  assert.equal(html.includes('bot-velocity-badge'), false,
    'un bot con ritmo normale non ha bisogno di dirlo');
});

test('un solo campo illeggibile basta per dichiarare ignoto', () => {
  const perps = loadUi();
  // Senza soglia non c'è niente con cui confrontare il conteggio: inventarla
  // duplicando i default del backend è esattamente ciò che va evitato.
  // Il confronto con la soglia usa `inWindow` (stessa finestra del freno),
  // non `lastHour`/`last4h`: sono finestre diverse (60/240 min contro
  // `windowMinutes`) e non dicono "quanto manca al blocco".
  assert.match(perps._botCardHtml(bot({ openRate: openRate({ inWindow: 9, maxOpensPerWindow: null }) })),
    /bot-velocity-badge is-unknown/);
  assert.match(perps._botCardHtml(bot({ openRate: openRate({ inWindow: null }) })),
    /bot-velocity-badge is-unknown/);
  assert.match(perps._botCardHtml(bot({ openRate: openRate({ inWindow: 3, windowMinutes: 'mezz\'ora' }) })),
    /bot-velocity-badge is-unknown/);
});

// ---------------------------------------------------------------------------
// 2. Stato giallo — ritmo elevato
// ---------------------------------------------------------------------------

test('ritmo vicino alla soglia: badge giallo con i numeri del payload', () => {
  const perps = loadUi();
  // `inWindow` è il conteggio nella STESSA finestra del freno (30 min qui):
  // è il numero che confrontato con la soglia dice davvero "quanto manca".
  // `lastHour`/`last4h` restano come contesto supplementare nel title.
  const html = perps._botCardHtml(bot({ openRate: openRate({ inWindow: 3, lastHour: 3, last4h: 6 }) }));
  assert.match(html, /bot-velocity-badge is-elevated/);
  assert.match(html, /⚡ 3\/4 in 30min/);
  assert.match(html, /title="[^"]*3 aperture negli ultimi 30 min[^"]*"/);
  // L'apostrofo di "nell'ultima" esce come `&#39;`: è `_escapeHtml` applicata
  // all'intero title, non un caso particolare.
  assert.match(html, /title="[^"]*3 aperture nell&#39;ultima ora, 6 nelle ultime 4 ore[^"]*"/);
});

test('soglia e finestra vengono dal payload, non dai default riscritti lato UI', () => {
  const perps = loadUi();
  // Bot con `overtrading` sovrascritto in config: 2 aperture ogni 10 minuti.
  const html = perps._botCardHtml(bot({
    openRate: openRate({ inWindow: 1, lastHour: 1, last4h: 1, maxOpensPerWindow: 2, windowMinutes: 10 })
  }));
  assert.match(html, /⚡ 1\/2 in 10min/,
    'la soglia e la finestra mostrate devono essere quelle del bot, non il default 4/30');
  assert.equal(html.includes('4/30min'), false);
});

test('soglia 1: zero aperture non è "elevato"', () => {
  const perps = loadUi();
  // `maxOpensPerWindow - 1` varrebbe 0 e renderebbe elevato qualunque bot fermo.
  const fermo = perps._botCardHtml(bot({ openRate: openRate({ maxOpensPerWindow: 1, inWindow: 0 }) }));
  assert.equal(fermo.includes('bot-velocity-badge'), false);
  const attivo = perps._botCardHtml(bot({ openRate: openRate({ maxOpensPerWindow: 1, inWindow: 1 }) }));
  assert.match(attivo, /bot-velocity-badge is-elevated/);
});

test('freno disattivato per il bot: nessun badge, neanche con un ritmo alto', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ openRate: openRate({ enabled: false, inWindow: 12, lastHour: 12, last4h: 40 }) }));
  assert.equal(html.includes('bot-velocity-badge'), false,
    'senza freno non c\'è nessuna soglia da avvicinare: il badge affermerebbe un rischio inesistente');
});

// ---------------------------------------------------------------------------
// 3. Stato rosso — il gate è attivo ADESSO
// ---------------------------------------------------------------------------

test('gate attivo: badge rosso con il motivo completo nel title', () => {
  const perps = loadUi();
  const reason = motivoGate(5);
  const html = perps._botCardHtml(bot({
    lastEval: { action: 'hold', reason },
    openRate: openRate({ lastHour: 5, last4h: 9 })
  }));
  assert.match(html, /bot-velocity-badge is-paused/);
  assert.match(html, /🚦 IN PAUSA — troppe aperture/);
  assert.match(html, /title="Overtrading: 5 aperture negli ultimi 30 min \(max 4\)/);
  assert.equal(html.includes('is-elevated'), false, 'un solo badge velocità per card');
});

test('il rosso vince anche quando il conteggio non è leggibile', () => {
  const perps = loadUi();
  // Fail-closed lato backend: il gate blocca proprio perché non sa contare.
  const reason = 'Overtrading: conteggio delle aperture recenti non leggibile (SQLITE_BUSY) — apertura sospesa per prudenza';
  const html = perps._botCardHtml(bot({ lastEval: { action: 'hold', reason }, openRate: null }));
  assert.match(html, /bot-velocity-badge is-paused/);
  assert.equal(html.includes('is-unknown'), false,
    'un blocco già deciso dal backend è un fatto, non uno stato incerto');
});

test('un altro motivo di hold non accende il badge rosso', () => {
  const perps = loadUi();
  for (const reason of [
    'Cooldown post-perdite: riapertura tra ~12 min',
    'Portafoglio: esposizione massima raggiunta',
    'Sizing: margine insufficiente',
    'Bloccato: kill switch attivo'
  ]) {
    const html = perps._botCardHtml(bot({ lastEval: { action: 'hold', reason } }));
    assert.equal(html.includes('is-paused'), false, `"${reason}" non è il freno di overtrading`);
  }
});

test('il prefisso si riconosce all\'inizio, non ovunque: un nome di bot non accende il rosso', () => {
  const perps = loadUi();
  // `lastEval.reason` cita testo scritto dall'utente. Con un `includes` bastava
  // chiamare un bot "Overtrading: tutto a posto" per fingere una pausa che non c'è.
  const html = perps._botCardHtml(bot({
    name: 'Overtrading: tutto a posto',
    lastEval: { action: 'hold', reason: 'Cooldown post-perdite su Overtrading: tutto a posto — tra ~5 min' }
  }));
  assert.equal(html.includes('is-paused'), false);
});

test('una valutazione non-hold con lo stesso prefisso non è un gate attivo', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    lastEval: { action: 'open_long', reason: 'Overtrading: 5 aperture negli ultimi 30 min (max 4)' }
  }));
  assert.equal(html.includes('is-paused'), false, 'il gate blocca sempre in hold');
});

// ---------------------------------------------------------------------------
// 4. Escaping del testo nuovo (issue #9, stessa disciplina di crashBadge)
// ---------------------------------------------------------------------------

test('lastEval.reason ostile nel title del badge IN PAUSA non inietta attributi', () => {
  const perps = loadUi();
  const reason = 'Overtrading: 5 aperture del bot " onmouseover="alert(1)';
  const html = perps._botCardHtml(bot({ lastEval: { action: 'hold', reason } }));
  assert.equal(html.includes('" onmouseover="'), false,
    'un title che si chiude da solo permette di iniettare un handler');
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/,
    'il valore va mostrato, non cancellato: un fix che lo rimuove mentirebbe all\'utente');
});

test('lastEval.reason con markup non produce tag dentro la card', () => {
  const perps = loadUi();
  const reason = 'Overtrading: 5 aperture <img src=x onerror=alert(1)>';
  const html = perps._botCardHtml(bot({ lastEval: { action: 'hold', reason } }));
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // Due punti di interpolazione dello stesso valore: title del badge + riga Valutazione.
  assert.equal((html.match(/&lt;img src=x/g) || []).length, 2);
});

test('apice singolo dentro il title del badge IN PAUSA', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    lastEval: { action: 'hold', reason: "Overtrading: ' onfocus='alert(1)" }
  }));
  assert.equal(html.includes("' onfocus='"), false);
  assert.match(html, /&#39; onfocus=&#39;alert\(1\)/);
});

// ---------------------------------------------------------------------------
// 5. Intestazione riorganizzata su due livelli
// ---------------------------------------------------------------------------

test('riga primaria: solo identità del bot e PnL', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ paper: true, max_allocation_usd: 500 }));
  const head = html.match(/<div class="bot-card-head">([\s\S]*?)<\/div>\s*<div class="bot-card-context"/);
  assert.ok(head, 'l\'intestazione deve essere seguita dalla riga di contesto');

  const ident = html.match(/<div class="bot-card-ident">([\s\S]*?)<\/div>/)[1];
  assert.match(ident, /bot-status-dot/);
  assert.match(ident, /<strong>Scalper BTC<\/strong>/);
  assert.match(ident, /class="coin-badge"/);
  // I badge di contesto NON devono più stare qui: era il problema da risolvere.
  assert.equal(ident.includes('agent-badge'), false);
  assert.equal(ident.includes('testnet-badge'), false);
  assert.equal(ident.includes('bot-budget-info'), false);
});

test('riga secondaria: agente, PAPER e budget, tutti insieme e solo loro', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ paper: true, max_allocation_usd: 500 }));
  const ctx = html.match(/<div class="bot-card-context">([\s\S]*?)<\/div>\s*<div class="bot-card-body">/)[1];
  assert.match(ctx, /class="agent-badge/);
  assert.match(ctx, /class="testnet-badge"[^>]*>PAPER</);
  assert.match(ctx, /bot-budget-info[^>]*>max /);
  assert.equal(ctx.includes('bot-alert-badge'), false, 'gli allarmi non stanno fra i badge di contesto');
});

test('slot alert: CRASH e velocità convivono, con lo stesso trattamento visivo', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    status: 'crashed', crashReason: 'nessun tick da 6 min',
    lastEval: { action: 'hold', reason: motivoGate(6) }
  }));
  const slot = html.match(/<div class="bot-alert-slot">([\s\S]*?)<\/div>/)[1];
  assert.match(slot, /bot-status-crashed-badge/, 'il badge CRASH è nello slot alert');
  assert.match(slot, /bot-velocity-badge is-paused/, 'e il badge velocità pure');
  // Stessa classe di base ⇒ stessa dimensione e stessa forma: sono due allarmi
  // pari grado, nessuno dei due deve sembrare un'etichetta accanto all'altro.
  assert.equal((slot.match(/bot-alert-badge/g) || []).length, 2);
});

test('nessun allarme: lo slot non esiste affatto', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot());
  assert.equal(html.includes('bot-alert-slot'), false,
    'un contenitore vuoto lascerebbe un buco nell\'angolo di ogni card tranquilla');
  assert.match(html, /class="bot-card-alerts">\s*<span class="bot-pnl/);
});

test('il corpo della card resta quello di prima', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    lastEval: { action: 'open_long', reason: 'RSI 28 < 30' },
    stats: { trades: 4, winRate: 0.5, profitFactor: 1.4, totalPnl: 22 }
  }));
  assert.match(html, /<span class="label">Strategia<\/span>/);
  assert.match(html, /<span class="label">Posizione<\/span>/);
  assert.match(html, /<span class="eval">📈 RSI 28 &lt; 30<\/span>/);
  assert.match(html, /<span class="label">Storico reale<\/span>/);
  assert.match(html, /class="bot-card-actions"/);
});

// ---------------------------------------------------------------------------
// 6. Le classi CSS usate qui esistono davvero nel foglio di stile
//    (il DOM finto non carica CSS: senza questo check un refuso in una classe
//    passerebbe tutti i casi sopra e non si vedrebbe nulla a schermo)
// ---------------------------------------------------------------------------

test('ogni classe nuova della card ha una regola in styles_perps.css', () => {
  const css = fs.readFileSync(path.join(HERE, '..', 'public', 'styles_perps.css'), 'utf8');
  for (const cls of [
    'bot-card-ident', 'bot-card-alerts', 'bot-card-context', 'bot-alert-slot',
    'bot-alert-badge', 'bot-velocity-badge', 'is-paused', 'is-elevated', 'is-unknown',
    'bot-budget-info'
  ]) {
    assert.match(css, new RegExp(`\\.${cls}[\\s.,:{]`), `manca la regola CSS per .${cls}`);
  }
});
