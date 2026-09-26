/**
 * ISSUE #19 · `handleGetSystemSnapshot` leggeva l'account paper con la rete scritta a mano.
 * ========================================================================================
 *
 * `paperBroker.getAccount(master, network)` usa `network` per UNA cosa sola, ma è
 * quella che conta: i mid con cui marca a mercato le posizioni e valuta i trigger
 * simulati (`client.getMid(coin, network)`). Lo stato dell'account (`_acc(master)`)
 * è invece indicizzato sul solo master, quindi una rete sbagliata non sposta il
 * conto: produce un uPnL e dei trigger calcolati sui prezzi di UN'ALTRA rete.
 *
 * Il valore era `'testnet'` letterale. Oggi non fa danno (la flotta è tutta
 * testnet) ma non c'è nulla che lo tenga allineato alla configurazione dei bot:
 * il primo bot paper su mainnet avrebbe il suo snapshot valutato su prezzi
 * testnet, senza nessun segnale.
 *
 * COSA VERIFICA QUESTO FILE. Due livelli, come da convenzione del repo:
 *  - `resolvePaperNetwork` PURA (nessun I/O): è lei a decidere, e quindi è lei che
 *    si testa per i casi scomodi (nessun bot, reti discordanti, master diversi);
 *  - `handleGetSystemSnapshot` come orchestrazione: l'osservabile NON è "la
 *    funzione è stata chiamata" ma la rete effettivamente arrivata a
 *    `client.getMid`, catturata sostituendo il solo `getMid` del client. È l'unico
 *    punto in cui la rete produce un effetto, quindi è lì che va misurata.
 *
 * COSA NON COPRE. Non verifica che i prezzi mainnet siano diversi da quelli
 * testnet (sarebbe rete vera). Verifica che la rete CHIESTA sia quella dichiarata
 * dal bot, che è la proprietà rotta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERPS_LOOPBACK_PUSH = '0';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-snapnet-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: paperBroker } = await import('../src/perps/paperBroker.js');
const { default: client } = await import('../src/perps/hyperliquidClient.js');
const { handleGetSystemSnapshot, resolvePaperNetwork, PAPER_MASTER } = await import('../src/mcp/tools.js');

function seedBot({ id, coin, network, masterAddress = PAPER_MASTER }) {
  db.insertBot({
    id,
    name: `bot ${id}`,
    coin,
    network,
    masterAddress,
    config: {},
    status: 'stopped',
    maxAllocationUsd: 100,
    actorLabel: 'test',
    actorId: 'test'
  });
}

// ---------------------------------------------------------------------------
// LIVELLO PURO — `resolvePaperNetwork`
// ---------------------------------------------------------------------------

test('resolvePaperNetwork: nessun bot → default testnet, dichiarato come default', () => {
  const r = resolvePaperNetwork([], PAPER_MASTER);
  assert.equal(r.network, 'testnet');
  assert.equal(r.mixed, false);
  assert.deepEqual(r.networks, []);
});

test('resolvePaperNetwork: un solo bot su mainnet → mainnet, NON il default', () => {
  const r = resolvePaperNetwork(
    [{ master_address: PAPER_MASTER, network: 'mainnet' }],
    PAPER_MASTER
  );
  assert.equal(r.network, 'mainnet');
  assert.equal(r.mixed, false);
});

test('resolvePaperNetwork: guarda SOLO i bot del master paper, ignora gli altri wallet', () => {
  const r = resolvePaperNetwork(
    [
      { master_address: '0xdeadbeef', network: 'mainnet' },
      { master_address: PAPER_MASTER, network: 'testnet' }
    ],
    PAPER_MASTER
  );
  assert.equal(r.network, 'testnet', 'la mainnet del wallet reale non deve contaminare il conto paper');
  assert.equal(r.mixed, false);
});

test('resolvePaperNetwork: reti discordanti sullo STESSO conto simulato → mixed, scelta deterministica', () => {
  const rows = [
    { master_address: PAPER_MASTER, network: 'mainnet' },
    { master_address: PAPER_MASTER, network: 'testnet' },
    { master_address: PAPER_MASTER, network: 'mainnet' }
  ];
  const r = resolvePaperNetwork(rows, PAPER_MASTER);
  assert.equal(r.mixed, true, 'la discordanza va dichiarata, non appianata in silenzio');
  assert.deepEqual([...r.networks].sort(), ['mainnet', 'testnet']);
  assert.equal(r.network, 'mainnet', 'maggioranza (2 mainnet su 3)');
  // Determinismo: l'ordine delle righe non cambia l'esito.
  assert.equal(resolvePaperNetwork([...rows].reverse(), PAPER_MASTER).network, 'mainnet');
});

test('resolvePaperNetwork: master assente sulla riga → conta come conto paper (stesso default di place_order_paper)', () => {
  const r = resolvePaperNetwork([{ network: 'mainnet' }], PAPER_MASTER);
  assert.equal(r.network, 'mainnet');
});

test('resolvePaperNetwork: rete assente o non valida sulla riga non inventa una rete', () => {
  const r = resolvePaperNetwork(
    [{ master_address: PAPER_MASTER, network: null }, { master_address: PAPER_MASTER, network: 'nonsense' }],
    PAPER_MASTER
  );
  assert.equal(r.network, 'testnet');
  assert.equal(r.mixed, false, 'una rete illeggibile non è una rete discordante');
});

// ---------------------------------------------------------------------------
// ORCHESTRAZIONE — quale rete arriva davvero a `client.getMid`
// ---------------------------------------------------------------------------

test('handleGetSystemSnapshot usa la rete del bot, non "testnet" a mano', async () => {
  for (const row of db.listBots()) db.deleteBot(row.id);
  seedBot({ id: 'snapnet-main', coin: 'SNAP-PERP', network: 'mainnet' });

  // Una posizione paper aperta, altrimenti `_snapshot` non ha coin su cui
  // chiedere il mid e l'osservabile non esiste: il test passerebbe a vuoto.
  const origGetMid = client.getMid;
  const seen = [];
  client.getMid = async (coin, network) => { seen.push({ coin, network }); return 100; };
  try {
    await paperBroker.placeMarketOrder(
      { masterAddress: PAPER_MASTER, coin: 'SNAP-PERP', isBuy: true, size: 1 },
      'mainnet'
    );
    seen.length = 0;

    const res = await handleGetSystemSnapshot();
    assert.ok(res.success !== false, 'lo snapshot deve rispondere');
    assert.ok(seen.length > 0, 'nessun mid chiesto: il test non sta osservando niente');
    assert.deepEqual(
      [...new Set(seen.map(s => s.network))],
      ['mainnet'],
      `rete chiesta a getMid: ${JSON.stringify(seen)}`
    );
  } finally {
    client.getMid = origGetMid;
  }
});

test('handleGetSystemSnapshot: reti paper discordanti producono un alert esplicito', async () => {
  for (const row of db.listBots()) db.deleteBot(row.id);
  seedBot({ id: 'snapnet-a', coin: 'SNAP-PERP', network: 'mainnet' });
  seedBot({ id: 'snapnet-b', coin: 'SNAP2-PERP', network: 'testnet' });

  const origGetMid = client.getMid;
  client.getMid = async () => 100;
  try {
    const res = await handleGetSystemSnapshot();
    const alerts = res.data?.alerts || [];
    const mixed = alerts.find(a => a.type === 'paper_network_mixed');
    assert.ok(mixed, `alert paper_network_mixed assente: ${JSON.stringify(alerts)}`);
    assert.match(mixed.message, /mainnet/);
    assert.match(mixed.message, /testnet/);
  } finally {
    client.getMid = origGetMid;
  }
});

test('handleGetSystemSnapshot: rete concorde non produce l\'alert di discordanza', async () => {
  for (const row of db.listBots()) db.deleteBot(row.id);
  seedBot({ id: 'snapnet-c', coin: 'SNAP-PERP', network: 'testnet' });

  const origGetMid = client.getMid;
  client.getMid = async () => 100;
  try {
    const res = await handleGetSystemSnapshot();
    const alerts = res.data?.alerts || [];
    assert.equal(alerts.filter(a => a.type === 'paper_network_mixed').length, 0);
  } finally {
    client.getMid = origGetMid;
  }
});
