/**
 * Chiusura manuale di una posizione SIMULATA — `_renderPositions`, issue #35 (parte UI)
 * =====================================================================================
 *
 * Dopo PR #33 le posizioni paper compaiono nel pannello "Posizioni attive". Il
 * pulsante "Chiudi" della tabella chiama `POST /api/perps/positions/:coin/close`,
 * che instrada SEMPRE a `hyperliquid.closePosition` — il broker reale — senza
 * guardare `isPaper`. Oggi è innocuo perché l'account reale è vuoto e la chiamata
 * fallisce; nello scenario MISTO (un bot reale e un bot paper sulla stessa coin)
 * l'utente chiuderebbe la posizione VERA credendo di chiudere la simulata.
 *
 * Questi casi bloccano la regressione sulla mitigazione lato UI: sulle righe paper
 * il pulsante non viene reso, e la riga dichiara di essere simulata. Verificano
 * anche che le righe reali NON perdano il pulsante — una mitigazione che rendesse
 * impossibile chiudere una posizione vera sarebbe un danno, non una difesa.
 *
 * Da aggiornare quando il routing backend sarà corretto (parte di Bruno): allora
 * il pulsante può tornare sulle righe paper, e questi test vanno riscritti per
 * asserire che punta al broker simulato.
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
      contains: (c) => classes.has(c)
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
  return { perps, elements };
}

/**
 * Una posizione come la restituisce `/api/perps/account`. `isPaper` lo valorizza
 * `riskManager.mergeAccountViews` su OGNI riga (verificato in src/server.js:
 * la rotta passa sempre da `mergeWithPaperAccount`), quindi nel payload vero è
 * sempre un booleano.
 */
function position(overrides = {}) {
  return {
    coin: 'BTC', side: 'long', size: 0.01, entryPx: 60000, unrealizedPnl: 12.5,
    leverage: 3, liquidationPx: 40000, openedAt: 1758800000000, botName: 'Scalper BTC',
    isPaper: false,
    ...overrides
  };
}

/** Rende le posizioni e restituisce il markup scritto in `#positionsList`. */
function render(rows) {
  const { perps, elements } = loadUi();
  perps._renderPositions(rows);
  return elements.positionsList.innerHTML;
}

/** Il markup di ogni `<tr>`, per attribuire un pulsante alla riga giusta. */
function rows(html) {
  return html.split('<tr>').slice(1);
}

test('una riga paper non offre il pulsante Chiudi', () => {
  const html = render([position({ isPaper: true })]);
  assert.equal(html.includes('perps.closePosition'), false,
    'il pulsante instrada al broker reale: su una riga simulata non deve esistere');
  assert.equal(html.includes('>Chiudi<'), false, 'nessuna etichetta Chiudi sulla riga simulata');
});

test('una riga paper dice di essere simulata e perché non si chiude da qui', () => {
  const html = render([position({ isPaper: true })]);
  // Due affermazioni distinte, entrambe necessarie: prima di PR #33 e di questa
  // modifica nulla nel markup diceva quali righe fossero simulate — l'utente non
  // poteva distinguerle nemmeno volendo.
  assert.match(html, /PAPER/, 'la riga simulata va marcata come tale');
  // Al posto del pulsante non deve restare un buco: una riga senza azioni e senza
  // spiegazione è a sua volta una mezza verità.
  assert.match(html, /gestita dal bot/, 'il posto del pulsante spiega chi chiude la posizione');
  assert.match(html, /title="[^"]*simulata[^"]*"/i, 'il motivo sta nel tooltip');
});

test('una riga reale conserva il pulsante Chiudi e non è marcata PAPER', () => {
  // Il caso che una mitigazione troppo larga romperebbe: chiudere a mano una
  // posizione VERA deve restare possibile.
  const html = render([position({ isPaper: false })]);
  assert.match(html, /perps\.closePosition\('BTC-PERP'\)/);
  assert.match(html, />Chiudi</);
  assert.equal(html.includes('PAPER'), false);
  assert.equal(html.includes('gestita dal bot'), false);
});

test('scenario misto sulla stessa coin: un solo Chiudi, ed è sulla riga reale', () => {
  // È esattamente lo scenario della issue: due esposizioni distinte sulla stessa
  // coin (mergeAccountViews non le fonde di proposito). L'endpoint non sa quale
  // delle due l'utente intendeva, quindi l'unica riga che può offrire il pulsante
  // è quella su cui il pulsante dice la verità.
  const html = render([
    position({ isPaper: true, botName: 'Paper BTC' }),
    position({ isPaper: false, botName: 'Live BTC' })
  ]);
  const [paperRow, realRow] = rows(html);
  assert.equal(rows(html).length, 2, 'precondizione: due righe rese, non fuse');
  assert.equal((html.match(/perps\.closePosition/g) || []).length, 1,
    'un solo pulsante di chiusura in tutta la tabella');
  assert.equal(paperRow.includes('perps.closePosition'), false, 'non sulla riga simulata');
  assert.match(paperRow, /Paper BTC/);
  assert.match(realRow, /perps\.closePosition/, 'il pulsante appartiene alla riga reale');
  assert.match(realRow, /Live BTC/);
});

test('il grafico resta disponibile anche sulle righe paper', () => {
  // Si toglie la sola azione che può fare danno: leggere il mercato non ne fa.
  const html = render([position({ isPaper: true })]);
  assert.match(html, /perps\.openChart\('BTC-PERP'\)/);
});

test('isPaper assente: la riga è trattata come reale, come fa l\'endpoint', () => {
  // Il confronto è stretto (`=== true`). Un payload senza `isPaper` non passa da
  // `mergeAccountViews`, e per quella riga l'unica cosa che si sa è ciò che
  // l'endpoint fa davvero: instradare al broker reale. Mostrare il pulsante è
  // quindi la descrizione corretta del comportamento, non un fail-open scelto a
  // caso — se un domani il payload perdesse il campo, va rivisto qui.
  const html = render([position({ isPaper: undefined })]);
  assert.match(html, /perps\.closePosition/);
  assert.equal(html.includes('PAPER'), false);
});

test('la tabella vuota resta invariata', () => {
  const { perps, elements } = loadUi();
  perps._renderPositions([]);
  assert.equal(elements.positionsList.innerHTML, '');
  assert.equal(elements.noPositions.classList.contains('hidden'), false);
});
