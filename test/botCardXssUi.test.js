/**
 * XSS stored nella card bot — `_botCardHtml` (public/perps.js), issue #9
 * =====================================================================
 *
 * Il nome del bot è testo scritto dall'utente nel modale di creazione e persistito in
 * DB (ed è scrivibile anche da agenti esterni come Hermes). `lastError`, `crashReason`
 * e `lastEval.reason` arrivano dallo stesso giro e possono citare quel nome. Finché
 * finivano nel template senza escaping, un nome come `<img src=x onerror=alert(1)>`
 * veniva eseguito nel browser di chiunque aprisse la dashboard: non serviva accesso
 * privilegiato, bastava creare un bot.
 *
 * Questi casi bloccano la regressione sui cinque punti della issue: nome, `crashReason`
 * nel `title=` del badge CRASH, `crashReason` nel testo della riga watchdog, `lastError`
 * e `lastEval.reason` nella riga "Valutazione".
 *
 * Come gli altri test di `public/*.js`: caricamento in `node:vm` con DOM finto, quindi
 * si verifica il markup prodotto, non la resa visiva.
 *
 * ── Issue #22: tre punti residui nella stessa card ─────────────────────────────
 * Aggiunti in coda i casi per i tre punti che #9 aveva lasciato fuori perimetro:
 * la riga "Strategia" (`_describeEntryRules`), il badge strategia AI e il badge
 * actor. Non hanno tutti la stessa gravità e i test lo dicono caso per caso:
 *   • riga Strategia (testo delle pill, `candleInterval`, fallback di `direction`)
 *     e badge actor (`title=` senza NESSUN escaping) sono eseguibili oggi;
 *   • il `title=` delle pill e il badge strategia usavano un
 *     `.replace(/"/g,'&quot;')` fatto a mano: con `"` come delimitatore l'evasione
 *     dall'attributo non passa — reggono per la scelta del delimitatore, non per
 *     costruzione. Lì il test difende dal cambio di delimitatore e dal `&` non
 *     escapato, che oggi storpia il testo mostrato (`&quot;` reso come `"`).
 * La distinzione è voluta: dichiarare "5 XSS sfruttabili" sarebbe falso quanto
 * lasciare l'escaping a metà.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');

/** Il payload ostile usato ovunque: se esce intatto, esegue. */
const XSS = '<img src=x onerror=alert(1)>';

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

/** Bot come arriva da `/api/perps/bots`, ridotto ai campi che la card interpola. */
function bot(overrides = {}) {
  return {
    id: 'bot-1', name: 'Scalper BTC', coin: 'BTC', status: 'running', paper: true,
    dailyPnl: 12.5, position: null, lastEval: null, lastError: null, crashReason: null,
    config: { entryRules: [], logic: 'any' },
    ...overrides
  };
}

/**
 * Nessuna delle due assert basta da sola: la prima dice che il tag non esiste più,
 * la seconda che il testo è ancora lì (un fix che cancellasse il campo passerebbe la
 * prima e mentirebbe all'utente).
 */
function assertNeutralizzato(html, contesto) {
  assert.equal(html.includes(XSS), false, `${contesto}: il markup esce intatto ed è eseguibile`);
  assert.equal(html.includes('<img'), false, `${contesto}: nessun tag img deve comparire nella card`);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, `${contesto}: il valore va mostrato come testo, non rimosso`);
}

test('il nome del bot con markup esce come testo, non come tag', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ name: XSS }));
  assertNeutralizzato(html, 'nome del bot');
  assert.match(html, /<strong>&lt;img/, 'il nome resta nell\'intestazione della card');
});

test('lastError con markup non esce dalla riga di errore', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ status: 'running', lastError: `Ordine rifiutato per ${XSS}` }));
  assertNeutralizzato(html, 'lastError');
  assert.match(html, /class="bot-error">⚠️ Ordine rifiutato per &lt;img/);
});

test('crashReason con markup: né nel testo del watchdog né nel title del badge', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ status: 'crashed', crashReason: XSS }));
  assertNeutralizzato(html, 'crashReason');
  // Due punti di interpolazione diversi, stesso valore: entrambi devono essere coperti.
  assert.equal((html.match(/&lt;img src=x/g) || []).length, 2,
    'crashReason compare sia nel title del badge CRASH sia nella riga watchdog');
  assert.match(html, /🐕 Watchdog: &lt;img/);
});

test('crashReason che chiude l\'attributo title non inietta attributi nuovi', () => {
  const perps = loadUi();
  // Contesto attributo: qui l'apice/virgoletta è l'evasione, non `<`. `_escapeHtml`
  // deve coprirli entrambi, altrimenti basta `" onmouseover=...` per eseguire.
  const html = perps._botCardHtml(bot({ status: 'crashed', crashReason: '" onmouseover="alert(1)' }));
  // La stringa `onmouseover=` resta visibile come TESTO: quello che non deve esistere è
  // la virgoletta grezza che chiude `title` e la trasforma in un attributo vero.
  assert.equal(html.includes('" onmouseover="'), false,
    'un title che si chiude da solo permette di iniettare un handler');
  assert.match(html, /title="&quot; onmouseover=&quot;alert\(1\)"/);
});

test('crashReason con apice singolo resta dentro il title', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ status: 'crashed', crashReason: "' onfocus='alert(1)" }));
  assert.equal(html.includes("' onfocus='"), false,
    'l\'apice va escapato anche dentro un attributo delimitato da virgolette doppie');
  assert.match(html, /title="&#39; onfocus=&#39;alert\(1\)"/);
});

test('lastEval.reason con markup esce come testo nella riga Valutazione', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ lastEval: { action: 'hold', reason: `RSI sopra soglia ${XSS}` } }));
  assertNeutralizzato(html, 'lastEval.reason');
  assert.match(html, /<span class="eval">⏳ RSI sopra soglia &lt;img/,
    'l\'icona dell\'azione resta, solo il motivo viene escapato');
});

test('i fallback testuali della card restano quelli di prima', () => {
  const perps = loadUi();
  // L'escaping è stato messo sul valore finale: la logica dei default non deve cambiare.
  const crashSenzaMotivo = perps._botCardHtml(bot({ status: 'crashed', crashReason: null }));
  assert.match(crashSenzaMotivo, /title="Nessun tick rilevato"/);
  assert.match(crashSenzaMotivo, /🐕 Watchdog: nessun tick rilevato/);

  const senzaEval = perps._botCardHtml(bot({ lastEval: null }));
  assert.match(senzaEval, /<span class="eval">—<\/span>/);

  const warmup = perps._botCardHtml(bot({ lastEval: { action: 'hold', reason: "Nessuna regola d'ingresso configurata" } }));
  assert.match(warmup, /⏳ In attesa candele warmup/);
});

test('una card normale non viene alterata dall\'escaping', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    name: 'Scalper BTC', status: 'running',
    lastEval: { action: 'open_long', reason: 'RSI 28 < 30' }
  }));
  assert.match(html, /<strong>Scalper BTC<\/strong>/);
  // `<` dentro un motivo legittimo diventa entity: è corretto, il browser lo rende come `<`.
  assert.match(html, /RSI 28 &lt; 30/);
  assert.equal(html.includes('&amp;lt;'), false, 'niente doppio escaping');
});

// ===== Issue #22 · punto 1 — riga "Strategia" (`_describeEntryRules`) =========
//
// `b.config` è scrivibile dall'editor bot e, da quando esiste la coda advisory,
// da una patch approvata via agente. Il testo delle pill lo produce
// `_describeRule`, che monta i campi grezzi della regola in una frase: è TESTO,
// e finiva nel markup senza escaping.

test('il pattern di una regola price_action con markup non esce dalla riga Strategia', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    config: { entryRules: [{ type: 'price_action', pattern: XSS, signal: 'long' }], logic: 'any' }
  }));
  assertNeutralizzato(html, 'entryRules[].pattern');
  assert.match(html, />Price action: &lt;img src=x onerror=alert\(1\)&gt; \[LONG\]</,
    'il pattern resta leggibile come testo dentro la pill');
});

test('un r.type sconosciuto finisce nella pill come testo', () => {
  const perps = loadUi();
  // Ramo `default` di `_describeRule`: `${r.type} ${sig}`, l'unico punto dove il
  // `type` grezzo arriva nel markup senza passare da una mappa di etichette.
  const html = perps._botCardHtml(bot({
    config: { entryRules: [{ type: XSS }], logic: 'any' }
  }));
  assertNeutralizzato(html, 'entryRules[].type');
});

test('candleInterval e il fallback di direction sono escapati', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({
    config: { entryRules: [{ type: 'funding', op: '>', value: 0 }], logic: 'any',
      candleInterval: XSS, direction: XSS }
  }));
  assertNeutralizzato(html, 'config.candleInterval / config.direction');
  // Due interpolazioni distinte dello stesso valore: il pill del timeframe e il
  // fallback della direzione (che si attiva solo per un valore fuori whitelist).
  assert.equal((html.match(/&lt;img src=x/g) || []).length, 2,
    'candleInterval e direction devono essere coperti entrambi');
});

test('la whitelist delle frecce di direction non viene toccata dall\'escaping', () => {
  const perps = loadUi();
  // Precondizione: `direction: 'long'` è dentro la mappa, quindi si deve vedere la
  // freccia e NON il valore grezzo. L'escaping va sul solo fallback.
  const html = perps._botCardHtml(bot({
    config: { entryRules: [{ type: 'funding' }], logic: 'any', direction: 'long', candleInterval: '15m' }
  }));
  assert.match(html, /↑/, 'direction nella whitelist resta una freccia');
  assert.equal(html.includes('>long<'), false, 'il valore grezzo non sostituisce la freccia');
  assert.match(html, /class="muted rule-pill">15m</, 'un candleInterval legittimo resta invariato');
});

test('il title= della pill non si può chiudere né storpiare', () => {
  const perps = loadUi();
  // Il vecchio `.replace(/"/g,'&quot;')` copriva le virgolette ma non `&`: un
  // pattern che contiene già `&quot;` veniva mostrato come `"` nel tooltip (testo
  // alterato). Con `_escapeHtml` la `&` diventa `&amp;` e il testo resta fedele.
  const html = perps._botCardHtml(bot({
    config: { entryRules: [{ type: 'price_action', pattern: '&quot; onmouseover=&quot;alert(1)' }], logic: 'any' }
  }));
  assert.equal(html.includes('" onmouseover="'), false,
    'nessuna virgoletta grezza deve poter chiudere il title della pill');
  assert.match(html, /&amp;quot; onmouseover=&amp;quot;alert\(1\)/,
    'la & va escapata: il tooltip deve mostrare il testo scritto, non la sua decodifica');
});

// ===== Issue #22 · punto 2 — badge strategia AI ===============================

test('strat.rationale con apice singolo e markup resta dentro il title', () => {
  const perps = loadUi();
  perps._botStrategy = { 'bot-1': { rationale: `${XSS} ' onfocus='alert(1)`, decidedAt: null } };
  const html = perps._botCardHtml(bot());
  assert.equal(html.includes("' onfocus='"), false,
    'l\'apice va escapato anche con le virgolette doppie come delimitatore');
  assert.equal(html.includes('<img'), false, 'nessun tag deve comparire nel title del badge strategia');
  assert.match(html, /class="bot-strategy-badge" title="&lt;img src=x onerror=alert\(1\)&gt; &#39; onfocus=&#39;alert\(1\)"/);
});

// ===== Issue #22 · punto 3 — badge actor =====================================
//
// `actor_label`/`actor_id` arrivano dal chiamante di `botManager.createBot`
// (verificato in src/perps/botManager.js: solo `id` è un randomUUID interno),
// quindi un agente esterno come Hermes li scrive. Erano interpolati in un
// `title=` senza NESSUN escaping: qui l'evasione dall'attributo passa davvero.

test('actorLabel che chiude il title non inietta un handler', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ actorLabel: '" onmouseover="alert(1)' }));
  assert.equal(html.includes('" onmouseover="'), false,
    'un title che si chiude da solo permette di iniettare un attributo vero');
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/);
});

test('agentId con markup non esce dal badge actor', () => {
  const perps = loadUi();
  const html = perps._botCardHtml(bot({ actor_id: XSS }));
  assertNeutralizzato(html, 'actor_id');
});

test('actorIcon e actorColor arrivano dalla stessa API e vanno escapati', () => {
  const perps = loadUi();
  // `actorColor` finisce in `class=`, `actorIcon` nel testo del badge: stessa
  // provenienza di actorLabel (admin view / agente), stesso trattamento.
  const html = perps._botCardHtml(bot({
    actorColor: 'x" onmouseover="alert(1)', actorIcon: XSS
  }));
  assert.equal(html.includes('" onmouseover="'), false,
    'actorColor non deve poter chiudere l\'attributo class');
  assert.equal(html.includes('<img'), false, 'actorIcon non deve produrre un tag');
});

test('il title del pulsante di modifica su bot gestito da agente è escapato', () => {
  const perps = loadUi();
  // Precondizione: `is_managed_by_agent` vero, altrimenti il ramo con actorLabel
  // nel title non viene nemmeno costruito e il caso passerebbe per il motivo
  // sbagliato.
  const html = perps._botCardHtml(bot({ is_managed_by_agent: true, actorLabel: XSS }));
  assert.match(html, /🔒 ✏️/, 'precondizione: il pulsante lock deve essere quello reso');
  assertNeutralizzato(html, 'actorLabel nel title del pulsante edit');
});

test('una card con actor e strategia legittimi resta invariata', () => {
  const perps = loadUi();
  perps._botStrategy = { 'bot-1': { rationale: 'RSI < 30 su 15m & funding positivo', decidedAt: null } };
  const html = perps._botCardHtml(bot({ actorLabel: 'Hermes', actor_id: 'hermes-01', actor: 'hermes' }));
  assert.match(html, /title="Controllato da: Hermes \(hermes-01\)"/);
  assert.match(html, /class="agent-badge agent-badge-hermes"/);
  // `<` e `&` in un rationale legittimo diventano entity: il browser li rende come scritti.
  assert.match(html, /title="RSI &lt; 30 su 15m &amp; funding positivo"/);
  assert.equal(html.includes('&amp;amp;'), false, 'niente doppio escaping');
});
