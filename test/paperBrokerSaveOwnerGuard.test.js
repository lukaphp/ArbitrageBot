/**
 * ISSUE #26 — GUARDIA STRUTTURALE: chi non possiede il tick loop non scrive lo
 * stato simulato.
 * ===========================================================================
 *
 * `paper_broker_state` è UNA riga di `settings` e sul VPS due processi importano
 * il singleton (Express e MCP Stdio). Il reload-and-merge di `_save()` limita il
 * danno ma su una coppia (account, coin) mossa da entrambi resta
 * last-writer-wins. Le scritture note nel processo sbagliato sono state
 * eliminate una per una (#7 parte 1, #27), ma «non c'è più nessuno scrittore»
 * non è «non si può scrivere»: il difetto era stato reso IRRAGGIUNGIBILE, non
 * risolto, e il prossimo tool MCP che chiamasse `placeMarketOrder` lo riapriva
 * senza che niente lo segnalasse.
 *
 * COSA VERIFICA QUESTO FILE:
 *  1. dal ruolo MCP Stdio ogni percorso di scrittura RIFIUTA con un'eccezione
 *     esplicita — non un `return false`, non un log e via;
 *  2. il rifiuto non lascia uno stato fantasma nella memoria del processo
 *     rifiutato (sarebbe un numero inventato nelle sue letture) e non tocca ciò
 *     che il proprietario ha scritto sul disco;
 *  3. `getAccount()` dal ruolo MCP degrada a LETTURA PURA. Era l'ultimo
 *     scrittore rimasto e non figurava fra gli scrittori perché sembra una
 *     query: valuta i trigger, quindi può eseguire un TP/SL simulato in un
 *     processo dove nessun bot lo registrerà mai — e `get_snapshot` la chiama;
 *  4. i due permessi espliciti funzionano e sono stretti: `asLoopOwner()` (la
 *     rotta `/internal/mcp/place-order-paper`, percorso legittimo di #27) e
 *     un'istanza costruita isolata;
 *  5. ogni caso «ruolo MCP» ha il suo gemello nel ruolo Express, dove la
 *     scrittura DEVE avvenire: senza, un test verde potrebbe solo dire che non
 *     si scrive mai niente.
 *
 * COSA NON COPRE: non ci sono due processi veri. Il ruolo è una variabile di
 * modulo, e il file la muove come la muoverebbe il boot dei due processi. Resta
 * fuori la finestra fra l'avvio del processo MCP e `declareProcessRole()`, in cui
 * il ruolo di default è «possiedo il loop» — chiuderla del tutto richiede
 * lanciare il processo con `ARBITRAGEBOT_PROCESS_ROLE=mcp_stdio`, cioè una
 * modifica al supervisore, fuori da questo file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-paperguard-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: paperBroker, PaperBroker } = await import('../src/perps/paperBroker.js');
const { declareProcessRole, ROLE_EXPRESS, ROLE_MCP_STDIO } = await import('../src/utils/processRole.js');

let MID = 100;
client.getMid = async () => MID;
client.roundPx = (px) => Math.round(px * 1e4) / 1e4;

/** Lo stato come lo vedrebbe un TERZO processo che rileggesse il DB adesso. */
const onDisk = () => JSON.parse(db.getSetting('paper_broker_state') || '{}');
const diskPositions = (master) => Object.keys(onDisk()[master.toLowerCase()]?.positions || {});

/** Esegue `fn` con il ruolo indicato, ripristinando SEMPRE Express. */
async function asRole(role, fn) {
  declareProcessRole(role);
  try { return await fn(); } finally { declareProcessRole(ROLE_EXPRESS); }
}

// ===========================================================================
// 1. La guardia su `_save()`
// ===========================================================================

test('ruolo MCP: `_save()` lancia con un codice esplicito; ruolo Express: salva', async () => {
  const MASTER = '0xguard1';
  // Il conto esiste solo se qualcuno lo ha materializzato: lo fa il proprietario.
  await paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G1-PERP', isBuy: true, size: 1 });
  assert.equal(paperBroker._save(paperBroker._key(MASTER)), true, 'nel ruolo Express il salvataggio avviene');

  await asRole(ROLE_MCP_STDIO, () => {
    let err = null;
    try { paperBroker._save(paperBroker._key(MASTER)); } catch (e) { err = e; }
    assert.ok(err, 'un salvataggio da qui deve lanciare, non tornare `false`');
    assert.match(err.message, /RIFIUTATA/);
    assert.equal(err.code, 'PAPER_STATE_NOT_LOOP_OWNER',
      'il chiamante deve poter distinguere il rifiuto da un errore di scrittura: sul primo non deve ritentare qui');
  });
});

test('il rifiuto è un\'ECCEZIONE, non un `return false`: un ordine non eseguito non torna "ok"', async () => {
  const MASTER = '0xguard2';
  await asRole(ROLE_MCP_STDIO, async () => {
    await assert.rejects(
      () => paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G2-PERP', isBuy: true, size: 1 }),
      (e) => e.code === 'PAPER_STATE_NOT_LOOP_OWNER',
      'con un `return false` il chiamante avrebbe restituito un ordine "riuscito" il cui stato non esiste'
    );
  });
  assert.deepEqual(diskPositions(MASTER), [], 'niente sul disco');
});

test('tutti i percorsi di scrittura passano dalla guardia, non solo `placeMarketOrder`', async () => {
  const MASTER = '0xguard3';
  // Il proprietario apre e protegge: è lo stato legittimo da cui si parte.
  await paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G3-PERP', isBuy: true, size: 1 });
  const sl = await paperBroker.placeTriggerOrder({ masterAddress: MASTER, coin: 'G3-PERP', isBuy: false, size: 1, triggerPx: 90, tpsl: 'sl' });
  const primaSulDisco = JSON.stringify(onDisk());

  await asRole(ROLE_MCP_STDIO, async () => {
    const rifiutata = (fn) => assert.rejects(fn, (e) => e.code === 'PAPER_STATE_NOT_LOOP_OWNER');
    await rifiutata(() => paperBroker.placeTriggerOrder({ masterAddress: MASTER, coin: 'G3-PERP', isBuy: false, size: 1, triggerPx: 110, tpsl: 'tp' }));
    await rifiutata(() => paperBroker.cancelOrder({ masterAddress: MASTER, coin: 'G3-PERP', oid: sl.oid }));
    await rifiutata(() => paperBroker.setLeverage(MASTER, 'G3-PERP', 5));
    await rifiutata(() => paperBroker.closePosition({ masterAddress: MASTER, coin: 'G3-PERP' }));
  });

  // PROPRIETÀ CENTRALE: il lavoro del proprietario è intatto. Un rifiuto che
  // corrompesse il blob sarebbe peggio della scrittura che vuole impedire.
  assert.equal(JSON.stringify(onDisk()), primaSulDisco, 'il blob del proprietario non è stato toccato');
  assert.deepEqual(diskPositions(MASTER), ['G3-PERP']);
  const trig = onDisk()[MASTER.toLowerCase()].triggers['G3-PERP'];
  assert.equal(trig.length, 1, 'il trigger del proprietario è ancora uno, ai suoi livelli');
  assert.equal(trig[0].triggerPx, 90);
});

test('dopo un rifiuto il processo non resta con uno stato FANTASMA in memoria', async () => {
  const MASTER = '0xguard4';
  await paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G4-PERP', isBuy: true, size: 1 });

  await asRole(ROLE_MCP_STDIO, async () => {
    await assert.rejects(
      () => paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'FANTASMA-PERP', isBuy: true, size: 1 }),
      (e) => e.code === 'PAPER_STATE_NOT_LOOP_OWNER'
    );
    // La mutazione era già avvenuta in memoria quando `_save()` ha rifiutato: se
    // restasse, `get_snapshot` di questo processo mostrerebbe una posizione che
    // non esiste da nessuna parte, indistinguibile da una misurata.
    const acc = await paperBroker.peekAccount(MASTER, 'testnet');
    const coins = (acc?.positions || []).map(p => p.coin);
    assert.ok(!coins.includes('FANTASMA-PERP'),
      `la posizione rifiutata è rimasta in memoria: ${JSON.stringify(coins)}`);
    // …e la verità del disco resta leggibile: la posizione del proprietario c'è.
    assert.ok(coins.includes('G4-PERP'), 'lo stato vero va riletto dal DB, non buttato via del tutto');
  });
});

// ===========================================================================
// 2. `getAccount()` non è una query: dal ruolo MCP degrada a lettura pura
// ===========================================================================

test('ruolo MCP: `getAccount()` NON fa scattare i trigger — la lettura non esegue', async () => {
  const MASTER = '0xguard5';
  MID = 100;
  await paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G5-PERP', isBuy: true, size: 1 });
  // Stop già in the money: al prossimo `_evaluateTriggers` scatterebbe.
  await paperBroker.placeTriggerOrder({ masterAddress: MASTER, coin: 'G5-PERP', isBuy: false, size: 1, triggerPx: 99, tpsl: 'sl' });
  MID = 90;

  await asRole(ROLE_MCP_STDIO, async () => {
    // Non deve nemmeno LANCIARE: `get_snapshot` chiama `getAccount()` e un
    // rifiuto qui diventerebbe, sotto il suo `.catch()`, un'equity inventata.
    const acc = await paperBroker.getAccount(MASTER, 'testnet');
    assert.equal(acc.positions.length, 1, 'la posizione deve essere ancora aperta: il fill spetta a chi possiede il loop');
    assert.equal(acc.positions[0].coin, 'G5-PERP');
    assert.deepEqual(diskPositions(MASTER), ['G5-PERP'], 'nessuna chiusura persistita da questo processo');
    assert.equal(await paperBroker.getRealizedPnl(MASTER, 'G5-PERP', 0), null, 'nessun fill di chiusura registrato');
  });

  // GEMELLO — nel proprietario il trigger DEVE scattare: senza questo caso il
  // test sopra sarebbe soddisfatto anche da un `_evaluateTriggers` rotto.
  const acc = await paperBroker.getAccount(MASTER, 'testnet');
  assert.equal(acc.positions.length, 0, 'nel ruolo Express lo stop scatta e la posizione si chiude');
  assert.deepEqual(diskPositions(MASTER), []);
  const pnl = await paperBroker.getRealizedPnl(MASTER, 'G5-PERP', 0);
  assert.ok(pnl && pnl.closingFills.length === 1, 'il fill di chiusura esiste e lo ha prodotto il proprietario');
  MID = 100;
});

// ===========================================================================
// 3. I due permessi espliciti
// ===========================================================================

test('`asLoopOwner()` apre la guardia (percorso #27) e la richiude sempre', async () => {
  const MASTER = '0xguard6';
  await asRole(ROLE_MCP_STDIO, async () => {
    // È il percorso della rotta `/internal/mcp/place-order-paper`: il ruolo
    // dichiarato dice MCP, ma chi esegue è la superficie HTTP di Express.
    const res = await paperBroker.asLoopOwner(() =>
      paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G6-PERP', isBuy: true, size: 1 }));
    assert.equal(res.error, null);
    assert.deepEqual(diskPositions(MASTER), ['G6-PERP'], 'dentro lo scope la scrittura è persistita davvero');

    // Lo scope è chiuso: fuori, la guardia rifiuta di nuovo.
    await assert.rejects(
      () => paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G6B-PERP', isBuy: true, size: 1 }),
      (e) => e.code === 'PAPER_STATE_NOT_LOOP_OWNER',
      'uno scope che non si richiude lascia la guardia aperta per il resto della vita del processo'
    );

    // …anche quando `fn` lancia: è il caso in cui un `finally` mancante non si
    // noterebbe fino al primo errore in produzione.
    await assert.rejects(
      () => paperBroker.asLoopOwner(async () => { throw new Error('guasto dentro lo scope'); }),
      /guasto dentro lo scope/
    );
    await assert.rejects(
      () => paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G6C-PERP', isBuy: true, size: 1 }),
      (e) => e.code === 'PAPER_STATE_NOT_LOOP_OWNER'
    );
  });
});

test('un\'istanza ISOLATA può scrivere; il singleton condiviso non ha quel permesso', async () => {
  const MASTER = '0xguard7';
  assert.equal(paperBroker._allowWriteWithoutTickLoop, false,
    'il permesso sul singleton condiviso vanificherebbe l\'intera guardia');

  await asRole(ROLE_MCP_STDIO, async () => {
    const isolato = new PaperBroker({ allowWriteWithoutTickLoop: true });
    const res = await isolato.placeMarketOrder({ masterAddress: MASTER, coin: 'G7-PERP', isBuy: true, size: 1 });
    assert.equal(res.error, null, 'un\'istanza dichiarata isolata resta utilizzabile in qualunque processo');

    // Un\'istanza costruita SENZA il permesso è guardata come il singleton: il
    // default è restrittivo, non permissivo.
    const normale = new PaperBroker();
    await assert.rejects(
      () => normale.placeMarketOrder({ masterAddress: MASTER, coin: 'G7B-PERP', isBuy: true, size: 1 }),
      (e) => e.code === 'PAPER_STATE_NOT_LOOP_OWNER'
    );
  });
});

// ===========================================================================
// 4. Non-regressione nel processo proprietario
// ===========================================================================

test('NON-REGRESSIONE: nel ruolo Express tutto il ciclo di vita funziona come prima', async () => {
  const MASTER = '0xguard8';
  MID = 100;
  await paperBroker.setLeverage(MASTER, 'G8-PERP', 3);
  const open = await paperBroker.placeMarketOrder({ masterAddress: MASTER, coin: 'G8-PERP', isBuy: true, size: 2 });
  assert.equal(open.error, null);
  const tp = await paperBroker.placeTriggerOrder({ masterAddress: MASTER, coin: 'G8-PERP', isBuy: false, size: 2, triggerPx: 110, tpsl: 'tp' });
  assert.ok(tp.oid > 0);
  assert.equal((await paperBroker.getFrontendOpenOrders(MASTER)).filter(o => o.coin === 'G8-PERP').length, 1);
  await paperBroker.cancelOrder({ masterAddress: MASTER, coin: 'G8-PERP', oid: tp.oid });
  const close = await paperBroker.closePosition({ masterAddress: MASTER, coin: 'G8-PERP' }, 'testnet');
  assert.equal(close.error, null);
  assert.deepEqual(diskPositions(MASTER), [], 'la chiusura è persistita');
});
