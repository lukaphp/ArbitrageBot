/**
 * ADV-02 · finestra scorrevole e riassunto rotante (`agents/advisor/session.js`).
 * =============================================================================
 *
 * In chat il transcript si rispedisce a ogni turno: senza un tetto il costo
 * cresce in modo quadratico nel numero di turni (spike §4.2 punto 1). La finestra
 * è quel tetto, e il riassunto è ciò che resta dei turni usciti.
 *
 * La parte che va davvero verificata, e che un test "funziona/non funziona" non
 * coglierebbe, è l'**anti-bias** (spike §5 punto 3, rischio S6): il riassunto
 * conserva fatti e numeri — le domande dell'operatore e i dati consultati — e
 * **non** le risposte dell'assistente. Un consulente che si rilegge le proprie
 * conclusioni come premesse si autoconferma: dice "come dicevamo, SOL è forte"
 * anche quando i dati sono cambiati. Qui è verificato che il testo del riassunto
 * non contenga le opinioni dei turni precedenti.
 *
 * Modulo puro: nessun DB, nessuna rete, nessun singleton.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitWindow, buildRollingSummary, buildApiMessages, normalizeAlternation } from '../src/agents/advisor/session.js';

let seq = 0;
const row = (role, content, extra = {}) => ({
  id: ++seq, session_id: 's1', ts: 1786000000000 + seq * 60000,
  role, content, tool_name: null, tokens: null, cost_usd: null, ...extra
});

/** N turni completi: domanda utente + risposta assistente. */
function turns(n, { withTool = false } = {}) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push(row('user', `domanda numero ${i}`));
    if (withTool) rows.push(row('tool', JSON.stringify({ coin: `C${i}-PERP`, equity: 1000 }), { tool_name: 'get_account' }));
    rows.push(row('assistant', `secondo me il mercato ${i} è molto promettente`));
  }
  return rows;
}

test('splitWindow: sotto la soglia nessun taglio', () => {
  const rows = turns(3);
  const { older, window, droppedTurns } = splitWindow(rows, 15);
  assert.equal(older.length, 0);
  assert.equal(window.length, rows.length);
  assert.equal(droppedTurns, 0);
});

test('splitWindow: taglia sui TURNI, non a metà di uno', () => {
  const rows = turns(20);
  const { older, window, droppedTurns } = splitWindow(rows, 15);
  assert.equal(droppedTurns, 5, '20 turni con finestra 15 → 5 riassunti');
  assert.equal(window[0].role, 'user', 'la finestra inizia sempre da una domanda, non da una risposta orfana');
  assert.equal(window.filter(r => r.role === 'user').length, 15);
  assert.equal(older.filter(r => r.role === 'user').length, 5);
  assert.equal(older.length + window.length, rows.length, 'nessun messaggio perso per strada');
});

test('riassunto rotante: conserva domande e strumenti consultati (fatti)', () => {
  const rows = turns(20, { withTool: true });
  const { older } = splitWindow(rows, 15);
  const summary = buildRollingSummary(older);

  assert.match(summary, /Turni precedenti riassunti: 5/);
  assert.match(summary, /domanda numero 1/, 'le domande dell\'operatore sono fatti e restano');
  assert.match(summary, /get_account/, 'quali dati sono già stati letti è un fatto utile');
  assert.match(summary, /C1-PERP/, 'il mercato consultato viene estratto dal payload dello strumento');
});

test('ANTI-BIAS: il riassunto NON riporta le risposte né le opinioni dell\'assistente', () => {
  const rows = turns(20, { withTool: true });
  const { older } = splitWindow(rows, 15);
  const summary = buildRollingSummary(older);

  assert.equal(/promettente/.test(summary), false,
    'un\'opinione precedente dell\'assistente non deve rientrare come premessa');
  assert.equal(/secondo me/.test(summary), false);
  assert.match(summary, /Nessuna conclusione o opinione/,
    'il riassunto dichiara esplicitamente al modello di non fidarsi di conclusioni passate');
});

test('riassunto rotante: senza turni da riassumere restituisce il precedente, non null', () => {
  assert.equal(buildRollingSummary([], { previousSummary: 'vecchio riassunto' }), 'vecchio riassunto');
  assert.equal(buildRollingSummary([]), null);
});

test('riassunto rotante: deterministico (gli stessi messaggi danno lo stesso testo)', () => {
  const { older } = splitWindow(turns(20, { withTool: true }), 15);
  assert.equal(buildRollingSummary(older), buildRollingSummary(older),
    'nessuna chiamata al modello, nessuna variabilità: è compressione, non generazione');
});

test('buildApiMessages: il riassunto entra come contesto e i payload degli strumenti passati restano fuori', () => {
  const rows = turns(20, { withTool: true });
  const { messages, droppedTurns } = buildApiMessages({ rows, summary: null, windowTurns: 15 });

  assert.equal(droppedTurns, 5);
  assert.match(messages[0].content[0].text, /Contesto della conversazione, riassunto/);
  assert.equal(messages[1].role, 'assistant', 'il contesto è "accettato" dall\'assistente per non rompere l\'alternanza');

  const flat = JSON.stringify(messages);
  assert.equal(/"equity":1000/.test(flat), false,
    'i tool_result dei turni conclusi NON si rispediscono: è la crescita di prompt che la finestra deve evitare');
  assert.match(flat, /domanda numero 20/, 'i turni nella finestra ci sono per intero');
});

test('buildApiMessages: il nuovo messaggio dell\'utente finisce in coda', () => {
  const { messages } = buildApiMessages({ rows: turns(2), summary: null, windowTurns: 15, userMessage: 'e adesso?' });
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].text, 'e adesso?');
});

test('normalizeAlternation: un transcript sbilanciato non manda l\'API in 400', () => {
  // Stato reale possibile: turno interrotto a metà da un errore o da un riavvio.
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'risposta orfana in testa' }] },
    { role: 'user', content: [{ type: 'text', text: 'prima domanda' }] },
    { role: 'user', content: [{ type: 'text', text: 'seconda domanda senza risposta in mezzo' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'ultima domanda' }] }
  ];
  const out = normalizeAlternation(messages);

  assert.equal(out[0].role, 'user', 'niente assistant in testa');
  assert.equal(out[out.length - 1].role, 'user', 'si risponde sempre a un messaggio dell\'utente');
  for (let i = 1; i < out.length; i++) {
    assert.notEqual(out[i].role, out[i - 1].role, 'ruoli alternati');
  }
  const flat = JSON.stringify(out);
  assert.match(flat, /prima domanda/);
  assert.match(flat, /seconda domanda/, 'i due user consecutivi vengono FUSI, non scartati: una domanda non si perde');
});

test('normalizeAlternation: transcript che finisce con l\'assistente viene troncato in coda', () => {
  const out = normalizeAlternation([
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});
