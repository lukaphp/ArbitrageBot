/**
 * JEV-OBS-01 · l'osservatore non è MAI sulla catena che porta all'ordine.
 * ======================================================================
 *
 * Il vincolo di progetto approvato dal PO è che il giudizio di Jev non possa
 * ritardare, bloccare o influenzare un'apertura/chiusura. Un timeout stretto non
 * basterebbe: se la chiamata fosse awaitata prima di procedere, il trade
 * aspetterebbe comunque fino al tetto. Qui si prova il contrario, in modo
 * strutturale e non a tempo:
 *
 *  - l'osservazione viene invocata con un trasporto che **non si risolve mai**
 *    (cancello mai aperto) e il tick arriva **lo stesso** in fondo, con la
 *    posizione aperta e i trigger piazzati. Se qualcuno mettesse un `await`
 *    davanti a `askJev`, questo test non finirebbe (e il runner lo direbbe);
 *  - l'osservazione parte **solo** su un segnale vero: `hold` — che è lo stato
 *    della stragrande maggioranza dei tick — non produce nessuna chiamata;
 *  - un rigetto dell'osservatore non diventa un `unhandledRejection`: nel server
 *    quello **arresta il processo**, cioè il supervisore spegnerebbe il sistema
 *    che dovrebbe sorvegliare;
 *  - lo `state` e le `questions` inviate sono composte dopo l'esecuzione e
 *    contengono i fatti che servono a giudicare (mercato, segnale, prezzo, esito).
 *
 * Seam: `PerpsBot` reale + `paperBroker`, `marketData.getSnapshot` sostituito,
 * DB temporaneo. L'unico doppio è `jev.askJev`, perché qui l'oggetto sotto test
 * è il PUNTO DI INNESCO in `bot.js`, non il client (coperto da
 * `jevObserver.test.js`, che ha il suo timeout vero).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import client from '../src/perps/hyperliquidClient.js';
import marketData from '../src/perps/marketData.js';
import notifier from '../src/perps/notifier.js';
import jev from '../src/agents/jev.js';
import db from '../src/db/database.js';
import { PerpsBot } from '../src/perps/bot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-jevbot-'));
db.dbPath = path.join(tempDir, 'perps.db');

client.getMid = async () => 100;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;
notifier.notify = async () => true;
marketData.getMarkets = () => [];
marketData.getSnapshot = async () => ({
  coin: 'JEV-PERP', price: 100,
  candles: Array.from({ length: 30 }, (_, i) => ({ t: i, o: '100', h: '101', l: '99', c: '100', v: '1' })),
  funding: 0.0001
});

const realAskJev = jev.askJev;

function makeBot(id, config) {
  return new PerpsBot({
    id, name: `Jev ${id}`, coin: 'JEV-PERP', network: 'testnet',
    master_address: `0xJEV${id}`,
    config_json: JSON.stringify({
      paper: true, leverage: 2, direction: 'both',
      sizing: { mode: 'fixed', value: 200 },
      tp: { enabled: true, mode: 'percent', value: 3 },
      sl: { enabled: true, mode: 'percent', value: 2 },
      ...config
    })
  }, () => {});
}

const OPEN_RULES = { entryRules: [{ type: 'price', op: '>', value: 1, signal: 'long' }] };
const HOLD_RULES = { entryRules: [{ type: 'price', op: '<', value: 1, signal: 'long' }] };

test('Jev che non risponde MAI non ritarda né impedisce l\'apertura', async () => {
  const calls = [];
  let released = false;
  jev.askJev = (args) => {
    calls.push(args);
    // Cancello mai aperto: l'osservatore resta appeso per tutta la durata del test.
    return new Promise(() => { released = false; });
  };
  try {
    const bot = makeBot('block', OPEN_RULES);
    await bot.tick();

    assert.equal(calls.length, 1, 'l\'osservazione è partita');
    assert.equal(released, false, 'e non si è mai risolta');
    assert.ok(bot.position, 'la posizione è stata aperta comunque');
    assert.equal(bot.position.side, 'long');
    assert.ok(bot.position.size > 0);
    assert.ok(bot.position.slPx, 'con lo stop loss calcolato');
    assert.equal(bot.lastError, null, 'e il tick non è andato in errore');

    // I trigger sono davvero sull'exchange simulato: l'apertura è completa, non
    // interrotta a metà da un osservatore appeso.
    const orders = await bot.broker.getFrontendOpenOrders(bot.masterAddress, 'testnet');
    assert.ok(orders.length >= 1, 'i trigger di protezione sono stati piazzati');
  } finally {
    jev.askJev = realAskJev;
  }
});

test('nessuna osservazione sui tick in `hold` (che sono la quasi totalità)', async () => {
  const calls = [];
  jev.askJev = (args) => { calls.push(args); return Promise.resolve({ ok: false, code: 'x' }); };
  try {
    const bot = makeBot('hold', HOLD_RULES);
    await bot.tick();
    assert.equal(bot.lastEval.action, 'hold');
    assert.equal(bot.position, null);
    assert.equal(calls.length, 0, 'un bot che non fa niente non paga niente');
  } finally {
    jev.askJev = realAskJev;
  }
});

test('un rigetto dell\'osservatore non diventa un unhandledRejection', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  jev.askJev = () => Promise.reject(new Error('osservatore esploso'));
  try {
    const bot = makeBot('reject', OPEN_RULES);
    await bot.tick();
    // Lascia girare l'event loop: un rigetto non gestito si manifesta dopo il tick.
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

    assert.ok(bot.position, 'la posizione è aperta lo stesso');
    assert.equal(bot.lastError, null, 'e il tick non ha visto nessun errore');
    assert.equal(unhandled.length, 0, 'nessuna promise lasciata scoperta');
  } finally {
    jev.askJev = realAskJev;
    process.off('unhandledRejection', onUnhandled);
  }
});

test('lo state descrive il fatto, le questions sono valide per il contratto API', async () => {
  const calls = [];
  jev.askJev = (args) => { calls.push(args); return Promise.resolve({ ok: true, answers: {} }); };
  try {
    const bot = makeBot('shape', OPEN_RULES);
    await bot.tick();

    assert.equal(calls.length, 1);
    const { state, questions, botId, coin, action } = calls[0];

    assert.equal(botId, bot.id);
    assert.equal(coin, 'JEV-PERP');
    assert.equal(action, 'open_long');

    assert.match(state, /JEV-PERP/, 'dice su quale mercato');
    assert.match(state, /open_long/, 'dice quale segnale');
    assert.match(state, /100/, 'dice a che prezzo');
    assert.match(state, /leva 2/i, 'dice con quale leva');

    // La prova che l'osservazione è POSTERIORE all'esecuzione: lo stato riporta
    // la posizione realmente aperta, con la size e il prezzo di ingresso che
    // esistono solo DOPO il fill. Attenzione al falso verde: un generico
    // /aperta/i sarebbe soddisfatto anche da "nessuna posizione aperta", cioè
    // proprio dal caso in cui l'osservazione fosse stata anticipata (verificato:
    // con la chiamata spostata prima del blocco di esecuzione quell'assert
    // restava verde).
    assert.match(state, new RegExp(`Esito dell'esecuzione: posizione long ${bot.position.size} JEV-PERP aperta a ${bot.position.entryPx}`),
      'lo stato riporta la posizione REALE, che prima dell\'esecuzione non esisteva');
    assert.ok(!/nessuna posizione aperta/.test(state), 'e non il caso "non ha aperto"');

    const ids = Object.keys(questions);
    assert.ok(ids.length >= 2 && ids.length <= 4, 'poche domande: ogni domanda è output token pagato');
    for (const [id, q] of Object.entries(questions)) {
      assert.ok(['noul', 'choice', 'score'].includes(q.type), `${id}: tipo ammesso dall'API`);
      assert.ok(typeof q.instructions === 'string' && q.instructions.length > 10, `${id}: istruzioni leggibili`);
      // La forma di `criteria` è l'errore da 422 più facile da fare: oggetto per
      // `choice`, lista ordinata di stringhe per `score`.
      if (q.type === 'choice') {
        assert.ok(q.criteria && !Array.isArray(q.criteria) && typeof q.criteria === 'object',
          `${id}: choice.criteria è un oggetto {opzione: descrizione}`);
        assert.ok(Object.values(q.criteria).every(v => typeof v === 'string'));
      }
      if (q.type === 'score') {
        assert.ok(Array.isArray(q.criteria) && q.criteria.every(v => typeof v === 'string'),
          `${id}: score.criteria è una lista ordinata di livelli`);
      }
      if (q.type === 'noul') {
        assert.equal(q.criteria, undefined, `${id}: noul senza criteria, come sull'API reale`);
      }
    }

    // Nessuna domanda che chieda a Jev di DECIDERE: è un osservatore. Una domanda
    // direttiva inviterebbe, fra sei mesi, a collegarne la risposta al percorso
    // di trading — che è esattamente ciò che il design vieta.
    const testo = JSON.stringify(questions).toLowerCase();
    for (const vietata of ['devo aprire', 'devo chiudere', 'conviene aprire', 'apri ', 'blocca']) {
      assert.ok(!testo.includes(vietata), `nessuna domanda direttiva ("${vietata}")`);
    }
  } finally {
    jev.askJev = realAskJev;
  }
});

test('anche la chiusura per segnale è osservata', async () => {
  const calls = [];
  jev.askJev = (args) => { calls.push(args); return Promise.resolve({ ok: true, answers: {} }); };
  try {
    const bot = makeBot('close', OPEN_RULES);
    await bot.tick();
    assert.ok(bot.position, 'prima apre');
    assert.equal(calls.length, 1);

    // Ora la regola d'uscita è sempre vera: il tick successivo chiude.
    bot.config.exitRules = [{ type: 'price', op: '>', value: 1, signal: 'close' }];
    await bot.tick();

    assert.equal(bot.position, null, 'posizione chiusa');
    assert.equal(calls.length, 2, 'e la chiusura è stata osservata');
    assert.equal(calls[1].action, 'close');
    // Anche qui il generico /chius/i sarebbe un falso verde: "chiusura richiesta
    // ma la posizione risulta ancora aperta" lo soddisfa, ed è il testo che
    // uscirebbe osservando PRIMA dell'esecuzione.
    assert.match(calls[1].state, /Esito dell'esecuzione: posizione chiusa/);
    assert.ok(!/ancora aperta/.test(calls[1].state));
  } finally {
    jev.askJev = realAskJev;
  }
});

test('un errore nel comporre lo state non può rompere il tick', async () => {
  // `askJev` è sostituita da una funzione che lancia SINCRONAMENTE: è il caso in
  // cui la chiamata non restituisce nemmeno una promise.
  jev.askJev = () => { throw new Error('esplosione sincrona'); };
  try {
    const bot = makeBot('sync-throw', OPEN_RULES);
    await bot.tick();
    assert.ok(bot.position, 'la posizione è aperta');
    assert.equal(bot.lastError, null, 'il tick non ha registrato errori');
  } finally {
    jev.askJev = realAskJev;
  }
});
