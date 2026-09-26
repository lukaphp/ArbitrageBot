/**
 * ISSUE #58 — posizione REALE aperta e nessun bot che la gestisce.
 * ===============================================================
 *
 * Fermare un bot non chiude mai la sua posizione, ed è voluto (principio
 * "one-way", lo stesso di kill-switch e guardia SL). La conseguenza è che finché
 * resta fermo NESSUN componente sorveglia quella posizione: niente
 * `_ensureStopLoss`, niente `_closeNow`, niente TP/SL dinamico. L'unica
 * protezione residua sono i trigger già sul book, che possono non scattare — è il
 * caso NEAR-PERP del 25/09/2026. Il riconciliatore non aiuta: agisce solo DOPO
 * che la posizione è sparita. Finora la condizione è stata notata solo perché una
 * persona ha guardato la dashboard.
 *
 * TRE LIVELLI, e il primo è quello che porta il peso:
 *
 *  1. `reconciler.findUnmanagedLivePositions` PURA — chi è "non sorvegliata".
 *     Qui si provano i casi scomodi: bot running sulla coin, wallet non gestito,
 *     coin con e senza `-PERP`, posizione di una coin che nessun bot presidia.
 *  2. `botManager.checkUnmanagedPositionsOnce` — il giro periodico, con
 *     l'ANTI-SPAM: un avviso a inizio episodio, riescalation solo dopo un'ora,
 *     e reset quando la condizione rientra. L'osservabile è il numero di
 *     notifiche, non "la funzione è stata chiamata".
 *  3. `riskSnapshot.deriveRiskAlerts` — la superficie dashboard, perché una
 *     notifica Telegram si perde e il pannello Rischio è dove si va a guardare.
 *
 * COSA IL TESTO DELL'ALERT DEVE DIRE, ed è un requisito esplicito dell'issue:
 * che NON è auto-recuperabile. Un avviso che non lo dice viene letto come un
 * transitorio e si aspetta che passi da sé. Non passa.
 *
 * COSA NON COPRE. Non c'è nessun exchange vero: `client.getAccount` è sostituito.
 * E non copre il timer (60s): si esercita `checkUnmanagedPositionsOnce`, che è
 * separata dal `setInterval` proprio per questo — stessa scelta di
 * `reconcileRunningBotsOnce`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERPS_LOOPBACK_PUSH = '0';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-unmanaged-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { findUnmanagedLivePositions } = await import('../src/perps/reconciler.js');
const { deriveRiskAlerts } = await import('../src/perps/riskSnapshot.js');
const { default: botManager } = await import('../src/perps/botManager.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { default: metrics } = await import('../src/perps/metrics.js');

const WALLET = '0x1111111111111111111111111111111111111111';
const ALTRO = '0x2222222222222222222222222222222222222222';

const notified = [];
notifier.notify = async (text) => { notified.push(text); return true; };

// ---------------------------------------------------------------------------
// 1. LIVELLO PURO
// ---------------------------------------------------------------------------

const bot = (id, coin, master = WALLET) => ({ id, name: `bot ${id}`, coin, master_address: master });

test('PURA: posizione viva e bot della coin FERMO → non sorvegliata', () => {
  const out = findUnmanagedLivePositions({
    livePositions: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }],
    bots: [bot('b1', 'NEAR-PERP')],
    runningBotIds: new Set(),
    address: WALLET
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].coin, 'NEAR-PERP');
  assert.deepEqual(out[0].bots.map(b => b.id), ['b1'], 'il bot fermo va riportato: serve a chi deve decidere');
});

test('PURA: un bot RUNNING su quella coin la sorveglia → nessun allarme', () => {
  const out = findUnmanagedLivePositions({
    livePositions: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }],
    bots: [bot('b1', 'NEAR-PERP')],
    runningBotIds: new Set(['b1']),
    address: WALLET
  });
  assert.equal(out.length, 0);
});

test('PURA: basta UN bot running fra quelli della coin', () => {
  const out = findUnmanagedLivePositions({
    livePositions: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }],
    bots: [bot('b1', 'NEAR-PERP'), bot('b2', 'NEAR-PERP')],
    runningBotIds: new Set(['b2']),
    address: WALLET
  });
  assert.equal(out.length, 0, 'un solo guardiano attivo è sufficiente');
});

test('PURA: il LATO non conta — un bot running adotta la posizione al tick dopo', () => {
  // Confrontare anche il lato produrrebbe un falso allarme per tutta la finestra
  // di adozione di `_reconcile`, e un alert che grida al lupo viene poi ignorato.
  const out = findUnmanagedLivePositions({
    livePositions: [{ coin: 'NEAR-PERP', side: 'long', size: 1 }],
    bots: [bot('b1', 'NEAR-PERP')],
    runningBotIds: new Set(['b1']),
    address: WALLET
  });
  assert.equal(out.length, 0);
});

test('PURA: posizione su una coin che NESSUN bot presidia → non sorvegliata, e si dice', () => {
  const out = findUnmanagedLivePositions({
    livePositions: [{ coin: 'DOGE-PERP', side: 'long', size: 100 }],
    bots: [bot('b1', 'NEAR-PERP')],
    runningBotIds: new Set(['b1']),
    address: WALLET
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].bots, [], 'nessun bot su quella coin: il messaggio deve poterlo dire');
});

test('PURA: wallet che la piattaforma non gestisce → nessuna aspettativa, nessun allarme', () => {
  const out = findUnmanagedLivePositions({
    livePositions: [{ coin: 'NEAR-PERP', side: 'short', size: 1 }],
    bots: [bot('b1', 'NEAR-PERP', ALTRO)],
    runningBotIds: new Set(),
    address: WALLET
  });
  assert.equal(out.length, 0, 'nessuno si è mai impegnato a sorvegliare questo wallet');
});

test('PURA: i bot di un ALTRO wallet non rendono sorvegliata questa posizione', () => {
  const out = findUnmanagedLivePositions({
    livePositions: [{ coin: 'NEAR-PERP', side: 'short', size: 1 }],
    bots: [bot('b1', 'NEAR-PERP', WALLET), bot('b2', 'NEAR-PERP', ALTRO)],
    runningBotIds: new Set(['b2']),
    address: WALLET
  });
  assert.equal(out.length, 1, 'il bot running è su un altro wallet: non tocca questa posizione');
});

test('PURA: coin con e senza `-PERP` sono la stessa coin', () => {
  assert.equal(findUnmanagedLivePositions({
    livePositions: [{ coin: 'NEAR', side: 'short', size: 1 }],
    bots: [bot('b1', 'NEAR-PERP')], runningBotIds: new Set(['b1']), address: WALLET
  }).length, 0);
});

test('PURA: address assente → nessuna conclusione', () => {
  assert.deepEqual(findUnmanagedLivePositions({
    livePositions: [{ coin: 'NEAR-PERP' }], bots: [bot('b1', 'NEAR-PERP')], address: null
  }), []);
  assert.deepEqual(findUnmanagedLivePositions({}), []);
});

// ---------------------------------------------------------------------------
// 2. IL GIRO PERIODICO + ANTI-SPAM
// ---------------------------------------------------------------------------

function seedBot(id, coin, master, status = 'stopped') {
  db.insertBot({
    id, name: `bot ${id}`, coin, network: 'testnet', masterAddress: master,
    config: {}, status, maxAllocationUsd: 100, actorLabel: 'test', actorId: 'test'
  });
}

function setLive(positionsByAddress, { throwFor = null } = {}) {
  client.getAccount = async (addr) => {
    if (throwFor && String(addr).toLowerCase() === throwFor.toLowerCase()) throw new Error('rate limit');
    return { positions: positionsByAddress[String(addr).toLowerCase()] || [] };
  };
  client.getNetwork = () => 'testnet';
}

function resetWatcher() {
  notified.length = 0;
  botManager.unmanagedEpisodes.clear();
  botManager.bots.clear();
  for (const row of db.listBots()) db.deleteBot(row.id);
}

test('GIRO: prima rilevazione → un avviso, e dice che NON è auto-recuperabile', async () => {
  resetWatcher();
  seedBot('u1', 'NEAR-PERP', WALLET);
  setLive({ [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }] });

  const before = metrics.get('unmanaged_position_episodes_total');
  const out = await botManager.checkUnmanagedPositionsOnce();

  assert.equal(out.unmanaged.length, 1, `nessuna posizione rilevata: ${JSON.stringify(out)}`);
  assert.equal(notified.length, 1, 'un avviso all\'inizio dell\'episodio');
  assert.match(notified[0], /NEAR-PERP/);
  assert.match(notified[0], /nessun bot in esecuzione/i);
  // Requisito esplicito dell'issue: il testo non deve poter essere letto come un
  // transitorio che si risolve da sé.
  assert.match(notified[0], /NON si risolve da sé/i);
  assert.match(notified[0], /non la chiuderà automaticamente/i);
  // …e le tre scelte possibili, perché l'alert chiede una decisione.
  assert.match(notified[0], /riavviare il bot/i);
  assert.match(notified[0], /chiudere la posizione a mano/i);
  assert.match(notified[0], /lasciarla così consapevolmente/i);

  assert.equal(metrics.get('unmanaged_position_episodes_total'), before + 1,
    'il contatore conta gli EPISODI');
});

test('ANTI-SPAM: giri successivi entro l\'ora NON rinotificano', async () => {
  resetWatcher();
  seedBot('u2', 'NEAR-PERP', WALLET);
  setLive({ [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }] });

  await botManager.checkUnmanagedPositionsOnce();
  assert.equal(notified.length, 1);
  await botManager.checkUnmanagedPositionsOnce();
  await botManager.checkUnmanagedPositionsOnce();
  assert.equal(notified.length, 1,
    'un Telegram al minuto per ore è rumore proprio quando conta: una notifica per episodio');
  // Ma la condizione resta RILEVATA a ogni giro: non notificare non è non vedere.
  const out = await botManager.checkUnmanagedPositionsOnce();
  assert.equal(out.unmanaged.length, 1);
  assert.equal(out.alerted.length, 0);
  assert.equal(metrics.get('unmanaged_position_episodes_total') >= 1, true);
});

test('ANTI-SPAM: oltre l\'ora RIESCALA, perché la condizione va risolta non solo saputa', async () => {
  resetWatcher();
  seedBot('u3', 'NEAR-PERP', WALLET);
  setLive({ [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }] });

  await botManager.checkUnmanagedPositionsOnce();
  assert.equal(notified.length, 1);

  // Retrodata l'episodio di oltre un'ora, come farebbe il tempo reale.
  const key = `${WALLET}|NEAR-PERP`;
  const ep = botManager.unmanagedEpisodes.get(key);
  assert.ok(ep, 'l\'episodio deve essere tracciato, altrimenti non c\'è anti-spam da provare');
  botManager.unmanagedEpisodes.set(key, { since: ep.since - 4 * 3600_000, lastAlertAt: ep.lastAlertAt - 4 * 3600_000 });

  const out = await botManager.checkUnmanagedPositionsOnce();
  assert.equal(notified.length, 2, 'dopo un\'ora l\'avviso si ripete');
  assert.equal(out.alerted[0].escalation, true);
  assert.match(notified[1], /\d+ min/, 'la riescalation deve dire da quanto dura: è ciò che la distingue da un transitorio');
  assert.ok(out.alerted[0].durataMin >= 240, `durata riportata ${out.alerted[0].durataMin} min`);
});

test('ANTI-SPAM: episodio RIENTRATO → lo stato si azzera e il prossimo avvisa di nuovo', async () => {
  // Uno stato che non si resetta spegne proprio l'allarme che serviva al giro
  // dopo: è il difetto da cui viene questa verifica.
  resetWatcher();
  seedBot('u4', 'NEAR-PERP', WALLET);
  setLive({ [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }] });
  await botManager.checkUnmanagedPositionsOnce();
  assert.equal(notified.length, 1);

  // La posizione viene chiusa a mano: condizione rientrata.
  setLive({ [WALLET]: [] });
  await botManager.checkUnmanagedPositionsOnce();
  assert.equal(botManager.unmanagedEpisodes.size, 0, 'lo stato dell\'episodio deve essere cancellato');
  assert.equal(notified.length, 1, 'il rientro non produce un allarme');

  // Si ripresenta: è un episodio NUOVO e va annunciato subito.
  setLive({ [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }] });
  await botManager.checkUnmanagedPositionsOnce();
  assert.equal(notified.length, 2, 'un episodio nuovo non deve restare zittito da uno stato stantio');
});

test('GIRO: bot RUNNING che ticca → nessun allarme (controllo di riferimento)', async () => {
  resetWatcher();
  seedBot('u5', 'NEAR-PERP', WALLET, 'running');
  botManager.bots.set('u5', { id: 'u5', name: 'bot u5', coin: 'NEAR-PERP', isTicking: () => true });
  setLive({ [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }] });

  const out = await botManager.checkUnmanagedPositionsOnce();
  assert.equal(out.unmanaged.length, 0, 'senza questo caso il fix potrebbe allarmare su tutto');
  assert.equal(notified.length, 0);
});

test('GIRO: `status running` in DB ma l\'istanza NON ticca → allarme comunque', async () => {
  // Il DB è la fonte dell'INTENTO, la memoria del FATTO. Fidarsi dello status
  // significherebbe tacere esattamente nel caso peggiore.
  resetWatcher();
  seedBot('u6', 'NEAR-PERP', WALLET, 'running');
  botManager.bots.set('u6', { id: 'u6', name: 'bot u6', coin: 'NEAR-PERP', isTicking: () => false });
  setLive({ [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }] });

  const out = await botManager.checkUnmanagedPositionsOnce();
  assert.equal(out.unmanaged.length, 1, '`status` da solo mentirebbe: conta chi ticca davvero');
  assert.equal(notified.length, 1);
});

test('GIRO: il conto simulato non è un indirizzo → nessuna chiamata, nessun allarme', async () => {
  resetWatcher();
  seedBot('u7', 'NEAR-PERP', 'paper_hermes');
  const asked = [];
  client.getAccount = async (addr) => { asked.push(addr); return { positions: [{ coin: 'NEAR-PERP' }] }; };

  const out = await botManager.checkUnmanagedPositionsOnce();
  assert.equal(out.checked, 0, 'nessun wallet reale da controllare');
  assert.equal(asked.length, 0, 'una chiamata su `paper_hermes` sarebbe sprecata e fuori tema');
  assert.equal(notified.length, 0);
});

test('GIRO: account illeggibile → NON si conclude "tutto sorvegliato" e l\'episodio non si chiude', async () => {
  resetWatcher();
  seedBot('u8', 'NEAR-PERP', WALLET);
  setLive({ [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 99.9 }] });
  await botManager.checkUnmanagedPositionsOnce();
  assert.equal(notified.length, 1);
  assert.equal(botManager.unmanagedEpisodes.size, 1);

  // Ora la lettura fallisce: silenzio sul dato, ma l'episodio resta aperto.
  setLive({}, { throwFor: WALLET });
  const out = await botManager.checkUnmanagedPositionsOnce();
  assert.equal(out.errors.length, 1);
  assert.equal(out.unmanaged.length, 0, 'non si può affermare niente su un account che non si è letto');
  assert.equal(botManager.unmanagedEpisodes.size, 1,
    'chiudere l\'episodio qui vorrebbe dire rinotificare da zero al primo giro riuscito');
});

test('GIRO: due wallet reali sono indipendenti', async () => {
  resetWatcher();
  seedBot('u9', 'NEAR-PERP', WALLET);
  seedBot('u10', 'SOL-PERP', ALTRO);
  setLive({
    [WALLET]: [{ coin: 'NEAR-PERP', side: 'short', size: 1 }],
    [ALTRO]: []
  });
  const out = await botManager.checkUnmanagedPositionsOnce();
  assert.equal(out.checked, 2);
  assert.equal(out.unmanaged.length, 1);
  assert.equal(out.unmanaged[0].address, WALLET);
});

// ---------------------------------------------------------------------------
// 3. SUPERFICIE DASHBOARD
// ---------------------------------------------------------------------------

test('DASHBOARD: l\'alert è `critical` e dice che non si risolve da sé', () => {
  const alerts = deriveRiskAlerts({
    address: WALLET,
    account: { equity: 1000, accountValue: 1000, positions: [{ coin: 'NEAR-PERP', positionValue: 400 }] },
    limits: { maxConcurrentPositions: 0, maxTotalExposureUsd: 0 },
    unmanagedPositions: [{ coin: 'NEAR-PERP', position: { side: 'short', size: 99.9 }, bots: [] }]
  });
  const a = alerts.find(x => x.id === 'position-unmanaged');
  assert.ok(a, `alert assente: ${JSON.stringify(alerts.map(x => x.id))}`);
  assert.equal(a.severity, 'critical', 'nessuna protezione attiva su denaro vero non è un warning');
  assert.match(a.body, /NON si risolve da sé/i);
  assert.match(a.body, /non le chiuderà automaticamente/i);
  assert.match(a.body, /SHORT NEAR-PERP/);
});

test('DASHBOARD: nessuna posizione non sorvegliata → nessun alert (e il default non lo inventa)', () => {
  const base = {
    address: WALLET,
    account: { equity: 1000, accountValue: 1000, positions: [] },
    limits: { maxConcurrentPositions: 0, maxTotalExposureUsd: 0 }
  };
  assert.equal(deriveRiskAlerts({ ...base, unmanagedPositions: [] })
    .filter(a => a.id === 'position-unmanaged').length, 0);
  // Chiamanti che non passano il parametro (backtester, test esistenti) invariati.
  assert.equal(deriveRiskAlerts(base).filter(a => a.id === 'position-unmanaged').length, 0);
});

test('DASHBOARD: il titolo si accorda al numero di posizioni', () => {
  const mk = (n) => deriveRiskAlerts({
    address: WALLET,
    account: { equity: 1000, accountValue: 1000, positions: [] },
    limits: { maxConcurrentPositions: 0, maxTotalExposureUsd: 0 },
    unmanagedPositions: Array.from({ length: n }, (_, i) => ({
      coin: `C${i}-PERP`, position: { side: 'long', size: 1 }, bots: []
    }))
  }).find(a => a.id === 'position-unmanaged');
  assert.match(mk(1).title, /^Posizione reale senza/);
  assert.match(mk(3).title, /^3 posizioni reali senza/);
});
