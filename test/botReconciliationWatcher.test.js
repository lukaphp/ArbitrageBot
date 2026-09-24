/**
 * RECONCILIATION WATCHER · il DB dice `running`, in memoria non ticchetta nessuno.
 * ================================================================================
 *
 * IL GAP. `loadFromDb()` riavvia i bot `running` SOLO all'avvio del processo.
 * `startWatchdog()` vede i bot fermi ma si limita ad ALLERTARE. `reconciler.js`
 * lavora nel verso opposto (chiude in DB le posizioni orfane di bot fermi).
 * Nel mezzo resta scoperto il caso peggiore: intento `running` a DB e nessun
 * loop vivo — il bot "esiste" nella UI, non valuta niente, e una posizione
 * aperta non viene più gestita da nessuno finché qualcuno non riavvia a mano.
 *
 * COSA VERIFICA QUESTO FILE. Gli osservabili sono quelli di CRIT #7, cioè lo
 * stato REALE del loop locale (`bot.status` + `bot.timer` + `lastTickAt`), mai
 * «la funzione X è stata chiamata»: un bot si considera riparato solo se il suo
 * tick è davvero partito.
 *
 * IL TEST PIÙ IMPORTANTE È QUELLO CHE NON FA NULLA. La direzione è UNA SOLA:
 * DB `running` → riavvia. Un bot `stopped` a DB non va toccato NEMMENO se ha
 * una posizione aperta — è la situazione in cui un operatore ferma il bot
 * apposta per gestire l'uscita a mano, e riavviarglielo sotto le mani
 * significa piazzare trigger che nessuno ha chiesto su una posizione vera.
 * Quel caso resta di `reconciler.js` o di un'azione manuale.
 *
 * COSA NON COPRE. Non ci sono due processi veri: il ruolo si dichiara con
 * `declareProcessRole`. Il tick fallisce per mancanza di mercato (è voluto:
 * conta che il loop ESISTA, non cosa valuta).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERPS_LOOPBACK_PUSH = '0'; // nessuna POST vera verso la dashboard locale

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-reconwatch-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: botManager } = await import('../src/perps/botManager.js');
const { default: marketData } = await import('../src/perps/marketData.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { declareProcessRole } = await import('../src/utils/processRole.js');

// Nessuna rete dentro il tick: `_runTick` si ferma alla prima await e finisce
// nel suo catch — ma passa comunque dal `finally` che scrive `lastTickAt`,
// che è l'unica prova che il loop è partito davvero.
let snapshots = 0;
marketData.getSnapshot = async () => { snapshots++; throw new Error('mercato non disponibile nel test'); };

// Telegram: si cattura il testo, non si manda niente.
const notifiche = [];
notifier.notify = async (text) => { notifiche.push(String(text)); };

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

let seq = 0;
function makeBot({ status = 'stopped' } = {}) {
  const id = `recon-test-${Date.now()}-${seq++}`;
  db.insertBot({
    id, name: `Bot ${id}`, coin: 'SOL-PERP', network: 'testnet',
    masterAddress: '0x000000000000000000000000000000000000dEaD',
    config: { paper: true, loopInterval: 3600000 },
    status, linked_agent_id: 'user_manual', actor_label: null,
    actor_id: null, is_managed_by_agent: 0
  });
  return id;
}

/** Il bot sta davvero ticcando IN QUESTO processo? */
function localLoop(id) {
  const bot = botManager.bots.get(id);
  return {
    present: !!bot,
    status: bot?.status ?? null,
    timer: !!bot?.timer,
    ticked: (bot?.lastTickAt || 0) > 0
  };
}

test.beforeEach(() => {
  declareProcessRole('express');
  notifiche.length = 0;
  snapshots = 0;
  botManager.lastReconciliationAlert?.clear();
});

test.afterEach(async () => {
  declareProcessRole('express');
  for (const bot of botManager.bots.values()) bot.stop();
  await flush();
  botManager.bots.clear();
  if (botManager.reconciliationTimer) {
    clearInterval(botManager.reconciliationTimer);
    botManager.reconciliationTimer = null;
  }
});

// ---------------------------------------------------------------------------
// Riparazione: DB `running`, loop assente o divergente.
// ---------------------------------------------------------------------------

test('bot running a DB ma ASSENTE dalla Map: viene ricostruito e avviato davvero', async () => {
  const id = makeBot({ status: 'running' });
  assert.equal(botManager.bots.has(id), false, 'il presupposto del caso: in memoria non c\'è nessuna istanza');

  const esito = botManager.reconcileRunningBotsOnce();
  await flush();

  const loop = localLoop(id);
  assert.equal(loop.present, true, 'l\'istanza va ricostruita dal DB (ensureLoaded), non ignorata');
  assert.equal(loop.status, 'running');
  assert.equal(loop.timer, true, 'senza timer il bot è "running" solo sulla carta: è esattamente il bug');
  assert.equal(loop.ticked, true, 'il primo giro parte subito: la riparazione si misura sul tick, non sul flag');
  assert.ok(snapshots >= 1, 'il tick ha davvero interrogato il mercato');

  assert.deepEqual(esito.repaired, [id]);
  assert.deepEqual(esito.failed, []);
  assert.equal(db.getBot(id).status, 'running', 'il DB resta la fonte di verità sull\'intento: non va riscritto');

  assert.equal(notifiche.length, 1, 'un riavvio automatico non è mai silenzioso');
  assert.match(notifiche[0], /riavv|riallinea/i);
});

test('bot running a DB, presente in Map ma ISTANZA DIVERGENTE (stopped in memoria): stesso esito', async () => {
  const id = makeBot({ status: 'running' });
  botManager.loadFromDb();
  await flush();
  const istanza = botManager.bots.get(id);
  assert.equal(istanza.status, 'running');

  // Divergenza: il loop muore senza che il DB lo sappia (crash del timer,
  // stop applicato a un'istanza sostituita, ...). `stop()` riscriverebbe il DB,
  // quindi si simula lo stato anomalo direttamente sull'istanza.
  clearInterval(istanza.timer);
  istanza.timer = null;
  istanza.status = 'stopped';
  istanza.lastTickAt = 0;
  snapshots = 0;
  notifiche.length = 0;

  const esito = botManager.reconcileRunningBotsOnce();
  await flush();

  assert.equal(botManager.bots.get(id), istanza, 'si riavvia l\'istanza esistente: sostituirla abbandonerebbe il suo stato');
  const loop = localLoop(id);
  assert.equal(loop.status, 'running');
  assert.equal(loop.timer, true);
  assert.equal(loop.ticked, true);
  assert.deepEqual(esito.repaired, [id]);
  assert.equal(notifiche.length, 1);
});

test('bot running a DB, presente e running in memoria ma SENZA timer: è fermo, va riavviato', async () => {
  const id = makeBot({ status: 'running' });
  botManager.loadFromDb();
  await flush();
  const istanza = botManager.bots.get(id);

  // Il caso più insidioso: `status` dice running ovunque, ma il timer non c'è
  // più (è quello che lascia `shutdown()` se il processo non muore davvero).
  istanza.shutdown();
  assert.equal(istanza.status, 'running');
  assert.equal(istanza.timer, null);
  snapshots = 0;
  notifiche.length = 0;

  const esito = botManager.reconcileRunningBotsOnce();
  await flush();

  assert.deepEqual(esito.repaired, [id], 'un `status` running senza timer è la forma muta del bug, non uno stato sano');
  assert.equal(localLoop(id).timer, true);
});

// ---------------------------------------------------------------------------
// VINCOLO DI SICUREZZA: una sola direzione.
// ---------------------------------------------------------------------------

test('SICUREZZA · bot STOPPED a DB con una posizione APERTA: il watcher non lo tocca', async () => {
  const id = makeBot({ status: 'stopped' });
  botManager.loadFromDb();
  await flush();
  const istanza = botManager.bots.get(id);

  db.insertPosition({
    botId: id, coin: 'SOL-PERP', side: 'long', size: 12,
    entryPx: 150, leverage: 5, tpPx: 165, slPx: 142
  });
  const aperta = db.getOpenPositionByBotCoin(id, 'SOL-PERP');
  assert.ok(aperta, 'presupposto del caso: c\'è davvero una posizione aperta collegata');

  // Spia sull'istanza: se qualcuno chiama start(), lo si vede anche se
  // l'effetto venisse poi annullato.
  let avvii = 0;
  const startReale = istanza.start.bind(istanza);
  istanza.start = (...a) => { avvii++; return startReale(...a); };

  snapshots = 0;
  const esito = botManager.reconcileRunningBotsOnce();
  await flush();

  assert.equal(avvii, 0, 'fermare un bot con una posizione aperta è una decisione esplicita dell\'operatore: riavviarlo la scavalca');
  assert.equal(istanza.status, 'stopped');
  assert.equal(istanza.timer, null);
  assert.equal(snapshots, 0, 'nessun tick: il bot non deve nemmeno guardare il mercato');
  assert.equal(db.getBot(id).status, 'stopped', 'e il DB non cambia intento da solo');
  assert.equal(db.getOpenPositionByBotCoin(id, 'SOL-PERP').status, 'open',
    'la posizione resta com\'è: chiuderla è di reconciler.js, non di qui');
  assert.deepEqual(esito.repaired, []);
  assert.equal(notifiche.length, 0, 'e nessun messaggio: non è successo niente di cui avvisare');
});

test('SICUREZZA · bot stopped a DB e assente dalla Map: non viene nemmeno istanziato', async () => {
  const id = makeBot({ status: 'stopped' });
  assert.equal(botManager.bots.has(id), false);

  botManager.reconcileRunningBotsOnce();
  await flush();

  assert.equal(botManager.bots.has(id), false,
    'il watcher legge l\'intento dal DB e si ferma lì: un bot fermo non lo riguarda');
  assert.equal(db.getBot(id).status, 'stopped');
});

// ---------------------------------------------------------------------------
// Caso sano e rumore.
// ---------------------------------------------------------------------------

test('bot allineato (running a DB, running e ticchettante in memoria): nessuna azione, nessuna notifica', async () => {
  const id = makeBot({ status: 'running' });
  botManager.loadFromDb();
  await flush();
  const istanza = botManager.bots.get(id);
  const timerPrima = istanza.timer;
  assert.equal(localLoop(id).timer, true, 'controllo di riferimento: qui il loop c\'è davvero');

  let avvii = 0;
  const startReale = istanza.start.bind(istanza);
  istanza.start = (...a) => { avvii++; return startReale(...a); };
  notifiche.length = 0;
  const tickPrima = snapshots;

  const esito = botManager.reconcileRunningBotsOnce();
  await flush();

  assert.equal(avvii, 0, 'un bot sano non si tocca: `start()` è idempotente, ma chiamarlo comunque sarebbe rumore e un tick in più');
  assert.equal(botManager.bots.get(id), istanza);
  assert.equal(istanza.timer, timerPrima, 'nemmeno il timer va sostituito');
  assert.equal(snapshots, tickPrima, 'nessun tick aggiuntivo provocato dal controllo');
  assert.deepEqual(esito.repaired, []);
  assert.equal(esito.checked, 1);
  assert.equal(notifiche.length, 0);
});

test('riparazione che continua a fallire: un messaggio per episodio, non uno ogni 60s', async () => {
  const id = makeBot({ status: 'running' });
  botManager.loadFromDb();
  await flush();
  const istanza = botManager.bots.get(id);
  istanza.shutdown();
  istanza.status = 'stopped';
  // Il riavvio fallisce sempre: è il caso in cui il watcher diventerebbe uno
  // spammer (un alert ogni giro, per sempre).
  istanza.start = () => { throw new Error('avvio impossibile nel test'); };
  notifiche.length = 0;

  const primo = botManager.reconcileRunningBotsOnce();
  const secondo = botManager.reconcileRunningBotsOnce();
  const terzo = botManager.reconcileRunningBotsOnce();
  await flush();

  assert.deepEqual(primo.failed, [id], 'un fallimento sul percorso di riparazione non è mai silenzioso');
  assert.deepEqual(secondo.failed, [id], 'e il watcher continua a provarci: è il tentativo che si ripete, non il messaggio');
  assert.deepEqual(terzo.failed, [id]);
  assert.equal(notifiche.length, 1, `tre giri, una notifica — ricevute: ${notifiche.length}`);
  assert.match(notifiche[0], /avvio impossibile nel test/, 'e dice cosa è andato storto, non solo che è andato storto');
});

test('il throttle del watcher è separato da quello del watchdog', async () => {
  const id = makeBot({ status: 'running' });
  botManager.loadFromDb();
  await flush();
  const istanza = botManager.bots.get(id);
  istanza.shutdown();
  istanza.status = 'stopped';
  notifiche.length = 0;

  botManager.reconcileRunningBotsOnce();
  await flush();

  assert.ok(botManager.lastReconciliationAlert.has(id), 'il watcher marca il proprio episodio');
  assert.equal(botManager.lastWatchdogAlert.has(id), false,
    '«sto per riavviarlo» e «è fermo da troppo» sono eventi diversi: condividere la chiave ne farebbe sparire uno');
});

// ---------------------------------------------------------------------------
// Il timer e il cancello di processo.
// ---------------------------------------------------------------------------

test('il watcher non parte nel processo che non possiede il tick loop', () => {
  declareProcessRole('mcp_stdio');
  botManager.reconciliationTimer = null;
  botManager.startReconciliationWatcher();
  assert.equal(botManager.reconciliationTimer, null,
    'riavviare da qui ricrea il doppio esecutore di CRIT #7, questa volta senza che nessuno lo chieda');

  declareProcessRole('express');
  botManager.startReconciliationWatcher();
  assert.ok(botManager.reconciliationTimer, 'in Express il watcher resta acceso');

  const primo = botManager.reconciliationTimer;
  botManager.startReconciliationWatcher();
  assert.equal(botManager.reconciliationTimer, primo, 'due chiamate non fanno due timer');

  clearInterval(botManager.reconciliationTimer);
  botManager.reconciliationTimer = null;
});

test('il timer da 60s esegue davvero il giro di riallineamento', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const id = makeBot({ status: 'running' });
    botManager.reconciliationTimer = null;
    botManager.startReconciliationWatcher();
    assert.ok(botManager.reconciliationTimer, 'presupposto: il timer esiste');
    assert.equal(botManager.bots.has(id), false, 'prima del primo giro nessuno ha ancora riparato niente');

    mock.timers.tick(59000);
    assert.equal(botManager.bots.has(id), false, 'la cadenza è 60s, non "appena possibile"');

    mock.timers.tick(1000);
    assert.equal(localLoop(id).status, 'running', 'al primo scatto il bot disallineato viene ripreso');
    assert.equal(localLoop(id).timer, true);
  } finally {
    if (botManager.reconciliationTimer) {
      clearInterval(botManager.reconciliationTimer);
      botManager.reconciliationTimer = null;
    }
    mock.timers.reset();
  }
  await flush();
});

test('stopAll() spegne anche il timer del watcher', () => {
  botManager.reconciliationTimer = null;
  botManager.startReconciliationWatcher();
  assert.ok(botManager.reconciliationTimer);
  botManager.stopAll();
  assert.equal(botManager.reconciliationTimer, null,
    'un timer lasciato vivo tiene in piedi il processo e riavvia bot durante lo shutdown');
});

test.after(() => {
  declareProcessRole('express');
  try { botManager.stopAll(); } catch { /* noop */ }
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
