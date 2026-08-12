/**
 * CRIT-05 · il contratto di `getAccount()` dopo il fix.
 * ====================================================
 *
 * Il criterio della storia è preciso su un punto: il campo nuovo per lo Spot
 * disponibile va AGGIUNTO, e il significato di `spotUsdc` **non** va ridefinito —
 * lo consumano `telegramControl.js`, `public/perps.js` e
 * `agents/analyst/tools.js`, e cambiarglielo sotto sarebbe una regressione
 * silenziosa in tre punti diversi (è già capitato: vedi la mia nota "leggi il
 * consumer").
 *
 * Qui si verifica il contratto, non la matematica (quella è in
 * `equityComposition.test.js`): `spotUsdc` resta il pool INTERO, `spotAvailable`
 * e `spotHold` sono nuovi, e `equity` usa il disponibile.
 *
 * Seam: `getReadSdk` e `axios.post` sostituiti — nessuna rete, nessun account
 * reale contattato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import axios from 'axios';
import client from '../src/perps/hyperliquidClient.js';
import paperBroker from '../src/perps/paperBroker.js';

const ADDR = '0xtest';

/** Stato perp finto, con due posizioni concorrenti come sulla demo. */
function stubExchange({ accountValue, totalMarginUsed, spotTotal, spotHold, positions = [] }) {
  client.getReadSdk = async () => ({
    info: {
      perpetuals: {
        getClearinghouseState: async () => ({
          marginSummary: {
            accountValue: String(accountValue),
            totalMarginUsed: String(totalMarginUsed),
            totalNtlPos: '0'
          },
          withdrawable: '0',
          assetPositions: positions.map(p => ({ position: p }))
        })
      }
    }
  });
  axios.post = async (_url, body) => {
    assert.equal(body.type, 'spotClearinghouseState', 'lo Spot si legge da spotClearinghouseState');
    return { data: { balances: [{ coin: 'USDC', total: String(spotTotal), hold: String(spotHold) }] } };
  };
}

test('getAccount: `spotUsdc` resta il pool INTERO — nessun consumatore esistente cambia lettura', async () => {
  stubExchange({ accountValue: 101.845466, totalMarginUsed: 102.453433, spotTotal: 976.641709, spotHold: 102.453433 });

  const acc = await client.getAccount(ADDR);

  assert.equal(acc.spotUsdc, 976.641709,
    'è il `total` del pool, come prima: telegramControl mostra "Spot USDC", la UI ci pre-compila il trasferimento');
  assert.notEqual(acc.spotUsdc, acc.spotAvailable,
    'con margine impegnato i due campi sono diversi: è tutto il punto della storia');
});

test('getAccount: campi NUOVI espliciti, e l\'equity usa il disponibile', async () => {
  stubExchange({ accountValue: 101.845466, totalMarginUsed: 102.453433, spotTotal: 976.641709, spotHold: 102.453433 });

  const acc = await client.getAccount(ADDR);

  assert.equal(acc.spotHold, 102.453433);
  assert.ok(Math.abs(acc.spotAvailable - (976.641709 - 102.453433)) < 1e-9);
  assert.ok(Math.abs(acc.equity - (101.845466 + acc.spotAvailable)) < 1e-9);
  // Il numero che contava: non più 1078.49.
  assert.ok(acc.equity < 977, `equity ${acc.equity}: non più gonfiata del margine`);
  assert.ok(Math.abs(acc.equity - 976.033742) < 1e-6, 'coincide col valore calcolato sui dati reali');
});

test('getAccount: a conto piatto il comportamento del commit 9e3a236 è preservato', async () => {
  // Tutto in Spot, nessun perp: l'equity deve essere il pool intero, non zero.
  stubExchange({ accountValue: 0, totalMarginUsed: 0, spotTotal: 977.564181, spotHold: 0 });

  const acc = await client.getAccount(ADDR);

  assert.equal(acc.equity, 977.564181, 'nessun falso "Equity nullo" reintrodotto');
  assert.equal(acc.spotAvailable, 977.564181);
  assert.equal(acc.spotHold, 0);
});

test('getAccount: mainnet come è oggi (conto vuoto) resta a zero senza NaN', async () => {
  stubExchange({ accountValue: 0, totalMarginUsed: 0, spotTotal: 0, spotHold: 0 });

  const acc = await client.getAccount(ADDR);

  assert.equal(acc.equity, 0);
  assert.equal(acc.spotAvailable, 0);
  for (const k of ['equity', 'accountValue', 'spotUsdc', 'spotAvailable', 'spotHold']) {
    assert.ok(Number.isFinite(acc[k]), `${k} deve essere finito, non NaN`);
  }
});

test('getAccount: se lo Spot non è leggibile l\'equity degrada ad accountValue, e NON in silenzio', async () => {
  client.getReadSdk = async () => ({
    info: { perpetuals: { getClearinghouseState: async () => ({
      marginSummary: { accountValue: '50', totalMarginUsed: '50', totalNtlPos: '0' },
      withdrawable: '0', assetPositions: []
    }) } }
  });
  axios.post = async () => { throw new Error('spot non raggiungibile'); };

  const acc = await client.getAccount(ADDR);

  assert.equal(acc.equity, 50, 'senza Spot resta il solo accountValue');
  assert.equal(acc.spotUsdc, 0);
  assert.equal(acc.spotAvailable, 0);
  assert.ok(Number.isFinite(acc.equity), 'un fallimento dello Spot non propaga NaN nel sizing');
});

test('paperBroker: coerente SENZA modifiche — nessun pool Spot, nessun doppio conteggio', async () => {
  // Il criterio chiede di verificarlo, non di cambiarlo. Il broker di carta non
  // modella un account unificato: tiene un solo saldo simulato, quindi `spotUsdc: 0`
  // e l'equity è calcolata direttamente. Non c'è nulla che possa essere contato due volte.
  const acc = await paperBroker.getAccount('0xpaper', 'testnet');

  assert.equal(acc.spotUsdc, 0, 'nessun collaterale Spot da sommare');
  assert.ok(Number.isFinite(acc.equity));
  assert.equal(acc.equity, acc.accountValue,
    'senza posizioni aperte equity e accountValue coincidono: la somma non gonfia nulla');
  // Con spotUsdc a 0 la formula vecchia e quella nuova coincidono per costruzione:
  // è la ragione per cui il paper trading non ha mai mostrato il difetto.
  assert.equal(acc.accountValue + acc.spotUsdc, acc.equity);
});
