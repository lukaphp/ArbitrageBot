/**
 * Pannello dell'osservatore Jev — `public/perps.js` (JEV-OBS-01)
 * ==============================================================
 *
 * Il pannello legge `GET /api/perps/jev-evaluations` e mostra, per ogni segnale
 * vero di un bot, il giudizio di un modello esterno. Tre cose vanno bloccate qui,
 * perché sono esattamente quelle che una prossima modifica può rompere senza che
 * nessuno se ne accorga guardando lo schermo:
 *
 *  1. **L'onestà dello stato vuoto.** Oggi in produzione l'osservatore è spento e
 *     l'endpoint risponde con una lista vuota. "Vuoto" non deve diventare né un
 *     errore né un pannello che sembra rotto né — peggio — un placeholder con
 *     numeri finti. E "mai caricato" / "lettura fallita" / "caricato e vuoto"
 *     sono tre stati distinti, non due.
 *  2. **Le tre domande a id fisso** (`coerenza_segnale`, `contesto_sfavorevole`,
 *     `fattore_dominante`, definite in `_jevPrompt` di `src/perps/bot.js`) rese in
 *     modo leggibile, con degradazione garbata se una manca o cambia forma: un
 *     giudizio chiesto e pagato non deve sparire dalla dashboard.
 *  3. **L'escaping.** `state` è testo composto da `bot.js` e la sua prima riga
 *     contiene il NOME DEL BOT, cioè testo scritto dall'utente e salvato in DB:
 *     è la issue #9 che rientra dalla porta di servizio di una feature backend.
 *
 * Come gli altri test di `public/*.js`: caricamento in `node:vm` con DOM finto,
 * quindi si verifica il markup prodotto, non la resa visiva.
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
    fetch: async () => ({ ok: true, json: async () => ({ success: true, data: [] }) }),
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

/** Riga come la restituisce `/api/perps/jev-evaluations`, forma completa. */
function evaluation(overrides = {}) {
  return {
    id: 1,
    botId: 'bot-uuid-1234',
    coin: 'BTC-PERP',
    ts: 1789700000000,
    action: 'open_long',
    model: 'jev-1.13.0',
    state: 'Bot "Scalper BTC" sul mercato BTC-PERP (rete testnet, esecuzione simulata/paper).',
    questions: {
      coerenza_segnale: { type: 'noul', instructions: 'Quanto il segnale è coerente col contesto?' },
      contesto_sfavorevole: {
        type: 'score',
        instructions: 'Quanto il contesto è sfavorevole?',
        criteria: [
          'contesto favorevole: dati coerenti e volatilità ordinaria',
          'contesto neutro: nessun segnale contrario evidente',
          'contesto incerto: indicatori discordanti o dati insufficienti',
          'contesto sfavorevole: movimento contrario o volatilità anomala',
          'contesto molto sfavorevole: più elementi contrari nello stesso momento'
        ]
      },
      fattore_dominante: {
        type: 'choice',
        instructions: 'Qual è l\'elemento che pesa di più?',
        criteria: {
          nessuno: 'niente di rilevante: contesto ordinario',
          controtendenza: 'il segnale va contro il movimento recente del prezzo',
          volatilita: 'ampiezza dei movimenti anomala rispetto al periodo'
        }
      }
    },
    answers: {
      coerenza_segnale: { type: 'noul', noul: 0.78 },
      contesto_sfavorevole: { type: 'score', score: 0.4, confidence: 0.6 },
      fattore_dominante: { type: 'choice', choice: 'controtendenza', confidence: 0.9 }
    },
    latencyMs: 1200,
    tokensIn: 340,
    tokensOut: 21,
    costUsd: 0.000015,
    error: null,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. Stato vuoto, stato ignoto, stato non letto: tre cose diverse
// ---------------------------------------------------------------------------

test('lista vuota: lo dice, non sembra rotto e non inventa numeri', () => {
  const { perps, elements } = loadUi();
  perps.jevEvaluations = [];
  perps.jevError = null;
  perps._renderJevEvaluations();

  const html = elements.jevLog.innerHTML;
  assert.match(html, /Nessuna osservazione Jev ancora registrata/);
  // Le DUE cause vanno dichiarate entrambe: da qui non si distinguono, e
  // sceglierne una sarebbe un'affermazione che nessuno ha verificato.
  assert.match(html, /osservatore è spento/, 'la prima causa possibile va nominata');
  assert.match(html, /nessun bot ha ancora prodotto un segnale vero/, 'la seconda causa possibile va nominata');
  assert.equal(html.includes('jev-empty-error'), false, 'un elenco vuoto non è un errore');
  assert.equal(/\d+%/.test(html), false, 'nessuna percentuale inventata nello stato vuoto');
  assert.equal(html.includes('jev-entry'), false, 'nessuna riga finta');
  assert.match(elements.jevUpdated.textContent, /nessuna osservazione/);
});

test('mai caricato non è "caricato e vuoto"', () => {
  const { perps, elements } = loadUi();
  // Stato iniziale del costruttore: `null`, non `[]`.
  assert.equal(perps.jevEvaluations, null, 'precondizione: nessun caricamento ancora avvenuto');
  perps._renderJevEvaluations();
  const html = elements.jevLog.innerHTML;
  assert.match(html, /Caricamento…/);
  assert.equal(html.includes('Nessuna osservazione Jev ancora registrata'), false,
    'prima di aver letto non si può affermare che non ci sia niente');
  assert.equal(elements.jevUpdated.textContent, '—');
});

test('lettura fallita: lo dichiara invece di mostrare un elenco vuoto', () => {
  const { perps, elements } = loadUi();
  perps.jevEvaluations = [];
  perps.jevError = 'Errore 500';
  perps._renderJevEvaluations();

  const html = elements.jevLog.innerHTML;
  assert.match(html, /Elenco non disponibile: Errore 500/);
  assert.equal(html.includes('Nessuna osservazione Jev ancora registrata'), false,
    'un elenco non letto non è un elenco vuoto');
  assert.equal(elements.jevUpdated.textContent, 'lettura fallita');
});

test('il messaggio di errore del server viene escapato, non interpretato', () => {
  const { perps, elements } = loadUi();
  perps.jevError = `Errore ${XSS}`;
  perps._renderJevEvaluations();
  const html = elements.jevLog.innerHTML;
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('il DOM non viene riscritto se il markup non è cambiato', () => {
  const { perps, elements } = loadUi();
  perps.jevEvaluations = [evaluation()];
  perps._renderJevEvaluations();
  const first = elements.jevLog.innerHTML;
  assert.ok(first.length > 0, 'precondizione: il primo render ha scritto qualcosa');

  // Un tick di polling senza novità: riscrivere `innerHTML` azzererebbe lo scroll
  // del log e richiuderebbe lo "Stato inviato a Jev" aperto dall'utente.
  elements.jevLog.innerHTML = 'SENTINELLA';
  perps._renderJevEvaluations();
  assert.equal(elements.jevLog.innerHTML, 'SENTINELLA', 'nessuna scrittura sul DOM a markup invariato');

  // Ma una riga nuova deve passare.
  perps.jevEvaluations = [evaluation({ id: 2, ts: 1789700005000 }), evaluation()];
  perps._renderJevEvaluations();
  assert.equal(elements.jevLog.innerHTML.includes('SENTINELLA'), false);
});

// ---------------------------------------------------------------------------
// 2. Le tre domande a id fisso
// ---------------------------------------------------------------------------

test('le tre domande fisse escono come giudizi leggibili, non come JSON grezzo', () => {
  const { perps } = loadUi();
  const html = perps._jevEntryHtml(evaluation());

  // noul → percentuale con etichetta parlante
  assert.match(html, /coerenza col contesto<\/span>\s*<span class="jev-j-value">78%/);
  // score → percentuale + livello preso dai criteri della domanda
  assert.match(html, /contesto sfavorevole<\/span>\s*<span class="jev-j-value">40%/);
  assert.match(html, /contesto incerto: indicatori discordanti o dati insufficienti/);
  assert.match(html, /confidenza 60%/);
  // choice → badge con la descrizione dell'opzione nel tooltip
  assert.match(html, /<span class="jev-choice" title="il segnale va contro il movimento recente del prezzo">controtendenza<\/span>/);
  assert.match(html, /confidenza 90%/);
  // Nessun oggetto renderizzato come `[object Object]` né JSON sputato addosso
  assert.equal(html.includes('[object Object]'), false);
  assert.equal(html.includes('"type":"noul"'), false);
});

test('intestazione: ora, mercato, azione tradotta, bot e modello', () => {
  const { perps } = loadUi();
  perps.bots = [{ id: 'bot-uuid-1234', name: 'Scalper BTC' }];
  const html = perps._jevEntryHtml(evaluation());
  assert.match(html, /BTC-PERP/);
  assert.match(html, /apertura long/, 'l\'azione tecnica va tradotta');
  assert.match(html, /Scalper BTC/, 'il nome del bot se è ancora in elenco');
  assert.match(html, /jev-1\.13\.0/);
});

test('bot non più in elenco: id corto, mai una riga senza soggetto', () => {
  const { perps } = loadUi();
  perps.bots = [];
  const html = perps._jevEntryHtml(evaluation());
  assert.match(html, /Bot #bot-/);
});

test('azione sconosciuta: esce col suo nome tecnico, non sparisce', () => {
  const { perps } = loadUi();
  assert.equal(perps._jevActionLabel('open_long'), 'apertura long');
  assert.equal(perps._jevActionLabel('close'), 'chiusura');
  assert.equal(perps._jevActionLabel('reduce_half'), 'reduce half');
  assert.equal(perps._jevActionLabel(null), '—');
});

test('risposta parziale: le domande presenti si vedono, le altre non rompono niente', () => {
  const { perps } = loadUi();
  const row = evaluation();
  delete row.answers.contesto_sfavorevole;
  delete row.answers.fattore_dominante;
  const html = perps._jevEntryHtml(row);
  assert.match(html, /coerenza col contesto/);
  assert.equal(html.includes('contesto sfavorevole'), false);
  assert.equal(html.includes('fattore dominante'), false);
  assert.equal(html.includes('undefined'), false);
});

test('domanda sconosciuta (versione futura del prompt): mostrata, mai nascosta', () => {
  const { perps } = loadUi();
  const row = evaluation();
  row.answers.regime_di_mercato = { type: 'choice', choice: 'laterale', confidence: 0.5 };
  const html = perps._jevEntryHtml(row);
  assert.match(html, /regime di mercato/, 'la chiave grezza diventa l\'etichetta');
  assert.match(html, /choice: laterale/);
  assert.match(html, /coerenza col contesto/, 'le tre note restano al loro posto');
});

test('risposta nota ma di forma inattesa: ripiega sul grezzo invece di sparire', () => {
  const { perps } = loadUi();
  // `noul` assente: la resa dedicata non sa decodificare. Un giudizio chiesto e
  // pagato non deve svanire dalla dashboard perché la forma è cambiata.
  const row = evaluation({ answers: { coerenza_segnale: { type: 'noul', valore: 0.5 } } });
  const html = perps._jevEntryHtml(row);
  assert.match(html, /jev-judgement-raw/);
  assert.match(html, /coerenza segnale/);
  assert.match(html, /valore: 0\.5/);
});

test('answers illeggibile e nessun errore: lo dice, non finge un giudizio', () => {
  const { perps } = loadUi();
  // Il server restituisce `null` anche quando il JSON in audit è malformato.
  const html = perps._jevEntryHtml(evaluation({ answers: null, error: null }));
  assert.match(html, /Nessuna risposta leggibile in questa riga di audit/);
  assert.equal(/\d+%/.test(html.split('jev-meta')[0]), false, 'niente percentuali inventate');
});

// ---------------------------------------------------------------------------
// 3. Livello dello score: legend, criteri, e le due convenzioni possibili
// ---------------------------------------------------------------------------

test('legend numerica: si sceglie il livello raggiunto, non il più vicino per eccesso', () => {
  const { perps } = loadUi();
  const question = evaluation().questions.contesto_sfavorevole;
  const answer = {
    type: 'score', score: 0.55,
    legend: { 0: 'favorevole', 0.25: 'neutro', 0.5: 'incerto', 0.75: 'sfavorevole', 1: 'molto sfavorevole' }
  };
  const level = perps._jevScoreLevel(answer, question);
  assert.equal(level.label, 'incerto');
  assert.equal(level.ratio, 0.55);
});

test('legend di forma inattesa: si ripiega sui criteri della domanda, non si inventa', () => {
  const { perps } = loadUi();
  const question = evaluation().questions.contesto_sfavorevole;
  // Legend "al contrario" (descrizione → valore): non decodificabile per livello.
  const level = perps._jevScoreLevel({ type: 'score', score: 1, legend: { favorevole: 0, incerto: 0.5 } }, question);
  assert.equal(level.label, 'contesto molto sfavorevole: più elementi contrari nello stesso momento');
});

test('score senza legend e senza criteri: resta il numero, nessuna etichetta inventata', () => {
  const { perps } = loadUi();
  const level = perps._jevScoreLevel({ type: 'score', score: 0.7 }, undefined);
  assert.equal(level.label, null);
  assert.equal(level.ratio, 0.7);
});

test('score espresso come indice di livello non diventa una percentuale assurda', () => {
  const { perps } = loadUi();
  const question = evaluation().questions.contesto_sfavorevole;
  const level = perps._jevScoreLevel({ type: 'score', score: 3 }, question);
  assert.equal(level.ratio, null, 'fuori da 0..1 non si può leggere come percentuale');
  assert.equal(level.label, 'contesto sfavorevole: movimento contrario o volatilità anomala');

  const html = perps._jevScoreHtml({ type: 'score', score: 3 }, question);
  assert.equal(html.includes('300%'), false, 'mai una percentuale > 100% da una convenzione diversa');
  assert.match(html, /<span class="jev-j-value">3<\/span>/);
});

test('score non numerico: nessun livello, e il blocco ripiega sul grezzo', () => {
  const { perps } = loadUi();
  // `Number(null)` vale 0, `Number('')` vale 0 e `Number(true)` vale 1: con un
  // `Number()` nudo un campo assente diventerebbe uno score di 0, cioè
  // l'etichetta "contesto favorevole" — un giudizio che nessuno ha espresso.
  const question = evaluation().questions.contesto_sfavorevole;
  for (const assente of [null, undefined, '', true, false, 'alto', NaN]) {
    assert.equal(perps._jevScoreLevel({ type: 'score', score: assente }, question), null,
      `score ${JSON.stringify(assente)} non è un livello`);
  }
  assert.equal(perps._jevScoreHtml({ type: 'score', score: null }, question), '',
    'il blocco dedicato si tira indietro e lascia la resa grezza');
  const html = perps._jevEntryHtml(evaluation({
    answers: { contesto_sfavorevole: { type: 'score', score: null, confidence: 0.6 } }
  }));
  assert.equal(html.includes('contesto favorevole'), false,
    'uno score assente non deve diventare il livello più basso della scala');
  assert.match(html, /jev-judgement-raw/, 'la risposta resta visibile in forma grezza');
});

test('un campo numerico assente non diventa zero nella riga di dettaglio', () => {
  const { perps } = loadUi();
  const html = perps._jevEntryHtml(evaluation({ latencyMs: null, tokensIn: null, tokensOut: null, costUsd: null }));
  assert.equal(html.includes('0 ms'), false, '"latenza ignota" non è "latenza zero"');
  assert.equal(html.includes('0→0 token'), false);
  assert.equal(html.includes('$0'), false);
  assert.equal(html.includes('jev-meta'), false, 'senza nessun dato la riga di dettaglio non si stampa');
  // Un solo campo noto: si mostra quello, e l'ignoto resta un trattino.
  const parziale = perps._jevEntryHtml(evaluation({ latencyMs: 900, tokensIn: 340, tokensOut: null, costUsd: null }));
  assert.match(parziale, /900 ms · 340→— token/);
});

test('coerenza col contesto: un `noul` assente non diventa 0%', () => {
  const { perps } = loadUi();
  const html = perps._jevEntryHtml(evaluation({ answers: { coerenza_segnale: { type: 'noul', noul: null } } }));
  assert.equal(html.includes('0%'), false, 'nessun giudizio espresso non è "coerenza zero"');
  assert.match(html, /jev-judgement-raw/);
});

test('confidenza assente: si tace, non si stampa un trattino', () => {
  const { perps } = loadUi();
  const html = perps._jevChoiceHtml({ type: 'choice', choice: 'volatilita' }, undefined);
  assert.match(html, /volatilita/);
  assert.equal(html.includes('confidenza'), false,
    'un "confidenza —" farebbe sembrare mancante un dato che questa risposta non promette');
});

// ---------------------------------------------------------------------------
// 4. Valutazione tentata e non riuscita: è un dato, non un guasto della UI
// ---------------------------------------------------------------------------

test('error non-null con answers null: mostra il tentativo, non un pannello rotto', () => {
  const { perps } = loadUi();
  const html = perps._jevEntryHtml(evaluation({ answers: null, error: 'timeout dopo 2500ms' }));
  assert.match(html, /jev-entry-failed/);
  assert.match(html, /nessun giudizio/);
  assert.match(html, /timeout dopo 2500ms/);
  // La cosa che conta per chi legge: l'operazione è avvenuta comunque.
  assert.match(html, /Jev non fa parte del percorso di trading/);
  // Il contesto resta leggibile: ora, mercato, azione, bot.
  assert.match(html, /BTC-PERP/);
  assert.match(html, /apertura long/);
  // E non si somma il messaggio "nessuna risposta leggibile": il motivo è uno solo.
  assert.equal(html.includes('Nessuna risposta leggibile'), false);
});

test('la riga porta latenza, token e costo reale (non arrotondato a zero)', () => {
  const { perps } = loadUi();
  const html = perps._jevEntryHtml(evaluation());
  assert.match(html, /1200 ms/);
  assert.match(html, /340→21 token/);
  assert.match(html, /\$0\.000015/, 'un costo di 15 micro-dollari non deve leggersi "$0.0000"');
});

test('niente semaforo: nessun trattamento visivo da guardrail o raccomandazione', () => {
  const { perps } = loadUi();
  // Jev è un osservatore: non decide, non blocca, non consiglia. Le classi che
  // altrove significano "buono/cattivo" o "alert" non devono comparire qui, o la
  // riga si leggerebbe come un ordine operativo.
  for (const row of [evaluation(), evaluation({ answers: { coerenza_segnale: { type: 'noul', noul: 0.02 } } })]) {
    const html = perps._jevEntryHtml(row);
    for (const banned of ['profit-positive', 'profit-negative', 'cockpit-positive', 'cockpit-negative', 'cockpit-alert', 'badge-danger']) {
      assert.equal(html.includes(banned), false, `"${banned}" trasformerebbe l'osservazione in un giudizio operativo`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Escaping — issue #9 che rientra da una feature backend
// ---------------------------------------------------------------------------

/**
 * Nessuna delle due assert basta da sola: la prima dice che il tag non esiste più,
 * la seconda che il testo è ancora lì (un fix che cancellasse il campo passerebbe
 * la prima e mentirebbe all'utente).
 */
function assertNeutralizzato(html, contesto) {
  assert.equal(html.includes(XSS), false, `${contesto}: il markup esce intatto ed è eseguibile`);
  assert.equal(html.includes('<img'), false, `${contesto}: nessun tag img deve comparire nel pannello`);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, `${contesto}: il valore va mostrato come testo, non rimosso`);
}

test('lo stato inviato a Jev contiene il nome del bot: esce come testo', () => {
  const { perps } = loadUi();
  // Prima riga di `_jevPrompt`: `Bot "<nome>" sul mercato ...`. Il nome è scritto
  // dall'utente (o da un agente esterno) e salvato in DB.
  const html = perps._jevEntryHtml(evaluation({ state: `Bot "${XSS}" sul mercato BTC-PERP.` }));
  assertNeutralizzato(html, 'state');
  assert.match(html, /<pre>Bot &quot;&lt;img/);
});

test('coin, action e model ostili non escono dall\'intestazione', () => {
  const { perps } = loadUi();
  const html = perps._jevEntryHtml(evaluation({ coin: XSS, action: XSS, model: XSS }));
  assertNeutralizzato(html, 'intestazione');
  assert.equal((html.match(/&lt;img src=x/g) || []).length, 3, 'tre punti di interpolazione, tutti coperti');
});

test('il motivo dell\'errore ostile non esce dalla riga "nessun giudizio"', () => {
  const { perps } = loadUi();
  const html = perps._jevEntryHtml(evaluation({ answers: null, error: `HTTP 500 — ${XSS}` }));
  assertNeutralizzato(html, 'error');
});

test('choice ostile: né come testo del badge né come attributo title', () => {
  const { perps } = loadUi();
  const row = evaluation();
  row.answers.fattore_dominante = { type: 'choice', choice: XSS };
  row.questions.fattore_dominante.criteria = { [XSS]: `descrizione ${XSS}` };
  const html = perps._jevEntryHtml(row);
  assertNeutralizzato(html, 'choice');
  assert.equal((html.match(/&lt;img src=x/g) || []).length, 2, 'badge e title, entrambi escapati');
});

test('una descrizione che chiude il title non inietta un handler', () => {
  const { perps } = loadUi();
  // Contesto attributo: qui l'evasione è la virgoletta, non `<`.
  const row = evaluation();
  row.answers.fattore_dominante = { type: 'choice', choice: 'volatilita' };
  row.questions.fattore_dominante.criteria = { volatilita: '" onmouseover="alert(1)' };
  const html = perps._jevEntryHtml(row);
  assert.equal(html.includes('" onmouseover="'), false,
    'un title che si chiude da solo permette di iniettare un handler');
  assert.match(html, /title="&quot; onmouseover=&quot;alert\(1\)"/);
});

test('etichette di livello ostili (legend e criteri) escono come testo', () => {
  const { perps } = loadUi();
  const row = evaluation();
  row.answers.contesto_sfavorevole = { type: 'score', score: 1, legend: { 0: 'ok', 1: XSS } };
  const html = perps._jevEntryHtml(row);
  assertNeutralizzato(html, 'legend');
});

test('chiave di risposta sconosciuta e ostile: escapata anche come etichetta', () => {
  const { perps } = loadUi();
  const row = evaluation({ answers: { [XSS]: { type: 'choice', choice: XSS } } });
  const html = perps._jevEntryHtml(row);
  assertNeutralizzato(html, 'chiave sconosciuta');
});

test('un\'osservazione normale non viene alterata dall\'escaping', () => {
  const { perps } = loadUi();
  perps.bots = [{ id: 'bot-uuid-1234', name: 'Scalper BTC' }];
  const html = perps._jevEntryHtml(evaluation({ state: 'RSI 28 < 30 sul mercato BTC-PERP.' }));
  assert.match(html, /Scalper BTC/);
  assert.match(html, /RSI 28 &lt; 30/, '`<` in un testo legittimo diventa entity: il browser lo rende come `<`');
  assert.equal(html.includes('&amp;lt;'), false, 'niente doppio escaping');
});
