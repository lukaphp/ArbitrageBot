/**
 * LETTURE "PESANTI" VERSO HYPERLIQUID (peso 20) — isolamento e timeout
 * ====================================================================
 *
 * Contesto (bug di produzione del 17/09/2026): `GET /api/perps/fills` e
 * `GET /api/perps/orders` restavano appese per sempre, senza errore né timeout,
 * mentre `/api/perps/account` rispondeva normalmente nello stesso istante.
 *
 * Causa: il rate limiter interno dell'SDK Hyperliquid è un token bucket SENZA
 * coda (capacity 100, refill 10/s). `getUserFills` e `getFrontendOpenOrders`
 * costano 20 token, tutte le altre nostre letture ne costano 2. Chi chiede 2
 * token li prende nell'istante in cui arriva; chi ne chiede 20 si addormenta e
 * al risveglio trova il secchiello di nuovo vuoto. Con il traffico continuo dei
 * bot il contatore misurato in produzione stava fisso a 0.02/100: la richiesta
 * da 20 non passava MAI, e nessuno se ne accorgeva perché la promise non si
 * risolve e non si rigetta.
 *
 * Due difese, testate qui senza toccare la rete:
 *  1) le letture pesanti hanno la LORO SDK (quindi il loro secchiello), separata
 *     da quella usata dalle letture frequenti dei bot;
 *  2) ogni chiamata REST ha un timeout esplicito: se non risponde diventa un
 *     errore ritentato e loggato, mai un blocco infinito.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import client from '../src/perps/hyperliquidClient.js';

const ADDR = '0x0000000000000000000000000000000000000001';
const NET = 'testnet';

// Nessuna chiamata di rete: costruire un'istanza SDK non parla con nessuno (la
// mappa dei simboli è pigra), ma va comunque chiusa o il suo refresh periodico
// terrebbe vivo il processo di test.
after(async () => { await client.closeAllSdks(); });

test('le letture pesanti usano una SDK diversa da quella delle letture frequenti', async () => {
  const frequenti = await client.getReadSdk(NET);
  const pesanti = await client.getHeavyReadSdk(NET);

  assert.notEqual(frequenti, pesanti, 'devono essere due istanze distinte');
  assert.notEqual(
    frequenti.getRateLimiter(), pesanti.getRateLimiter(),
    'due istanze SDK devono avere due token bucket distinti: è tutto il punto del fix'
  );
  // Stabili in cache: nessuna delle due va ricreata a ogni chiamata.
  assert.equal(await client.getReadSdk(NET), frequenti);
  assert.equal(await client.getHeavyReadSdk(NET), pesanti);
});

test('closeAllSdks chiude anche la SDK delle letture pesanti', async () => {
  await client.getHeavyReadSdk(NET);
  await client.closeAllSdks();
  assert.equal(client.readSdks.size, 0, 'nessuna istanza deve restare in cache');
});

test('getUserFills e getFrontendOpenOrders passano dalla SDK pesante, getAllMids no', async () => {
  await client.closeAllSdks();
  const usate = [];
  const fakeSdk = (etichetta) => ({
    info: {
      getUserFills: async () => { usate.push(`${etichetta}:fills`); return []; },
      getFrontendOpenOrders: async () => { usate.push(`${etichetta}:orders`); return []; },
      getAllMids: async () => { usate.push(`${etichetta}:mids`); return {}; }
    },
    disconnect() { }
  });
  client.readSdks.set(NET, fakeSdk('frequente'));
  client.readSdks.set(`${NET}:heavy`, fakeSdk('pesante'));

  await client.getUserFills(ADDR, NET);
  await client.getFrontendOpenOrders(ADDR, NET);
  await client.getAllMids(NET);

  assert.deepEqual(usate, ['pesante:fills', 'pesante:orders', 'frequente:mids']);
  client.readSdks.clear();
});

test('una lettura che non si risolve mai diventa un errore, non un blocco infinito', async () => {
  await client.closeAllSdks();
  const timeoutOriginale = client.restTimeoutMs;
  const retryOriginali = client.restRetries;
  client.restTimeoutMs = 40;
  client.restRetries = 0;

  let tentativi = 0;
  client.readSdks.set(`${NET}:heavy`, {
    info: {
      // Esattamente il comportamento osservato in produzione: né risolve né rigetta.
      getUserFills: () => { tentativi++; return new Promise(() => { }); },
      getFrontendOpenOrders: () => { tentativi++; return new Promise(() => { }); }
    },
    disconnect() { }
  });

  const partito = Date.now();
  await assert.rejects(() => client.getUserFills(ADDR, NET), /timeout/i);
  await assert.rejects(() => client.getFrontendOpenOrders(ADDR, NET), /timeout/i);
  assert.equal(tentativi, 2);
  assert.ok(Date.now() - partito < 5000, 'deve fallire in fretta, non restare appesa');

  client.readSdks.clear();
  client.restTimeoutMs = timeoutOriginale;
  client.restRetries = retryOriginali;
});

/**
 * P0 24/09/2026 — capacità. Il secchiello dedicato produce 10 token/s e ogni
 * lettura pesante ne costa 20: mezza chiamata al secondo. Sei bot sullo stesso
 * wallet che ticchettano ogni 10s chiedono la STESSA identica risposta sei
 * volte (`getFrontendOpenOrders` è per wallet, non per mercato). Unire le
 * richieste in volo è l'unico modo di rientrare nel budget senza alzare un
 * limite che approssima quello vero di Hyperliquid.
 */
test('richieste pesanti identiche e contemporanee diventano UNA sola chiamata', async () => {
  await client.closeAllSdks();
  client.heavyReadsInFlight.clear();
  let chiamate = 0;
  let sblocca;
  const attesa = new Promise(r => { sblocca = r; });
  client.readSdks.set(`${NET}:heavy`, {
    info: {
      getFrontendOpenOrders: async () => { chiamate++; await attesa; return []; },
      getUserFills: async () => { chiamate++; await attesa; return []; }
    },
    disconnect() { }
  });

  const sei = Array.from({ length: 6 }, () => client.getFrontendOpenOrders(ADDR, NET));
  sblocca();
  const risposte = await Promise.all(sei);

  assert.equal(chiamate, 1, 'sei bot dello stesso wallet = una sola lettura di peso 20');
  assert.equal(risposte.length, 6, 'e tutti e sei ricevono comunque la risposta');
  // Nessuno riceve l'array di un altro: la rimappatura è per chiamante, quindi
  // un consumatore non può mutare sotto i piedi di un altro un dato che decide
  // se una posizione è protetta.
  assert.notEqual(risposte[0], risposte[1], 'ogni chiamante ha il suo array');

  client.readSdks.clear();
  client.heavyReadsInFlight.clear();
});

test('NON è una cache: finita la richiesta, la successiva riparte davvero', async () => {
  await client.closeAllSdks();
  client.heavyReadsInFlight.clear();
  let chiamate = 0;
  client.readSdks.set(`${NET}:heavy`, {
    info: { getFrontendOpenOrders: async () => { chiamate++; return []; } },
    disconnect() { }
  });

  await client.getFrontendOpenOrders(ADDR, NET);
  await client.getFrontendOpenOrders(ADDR, NET);

  assert.equal(chiamate, 2,
    'due letture sequenziali restano due: un book vecchio anche di un istante potrebbe dire vivo uno stop loss appena cancellato');
  assert.equal(client.heavyReadsInFlight.size, 0, 'nessuna chiave resta appesa dopo la risposta');

  client.readSdks.clear();
});

test('wallet diversi non si uniscono, e un fallimento non lascia la chiave bloccata', async () => {
  await client.closeAllSdks();
  client.heavyReadsInFlight.clear();
  const visti = [];
  client.readSdks.set(`${NET}:heavy`, {
    info: {
      getFrontendOpenOrders: async (addr) => {
        visti.push(addr);
        if (addr.endsWith('9')) throw Object.assign(new Error('boom'), { status: 400 });
        return [];
      }
    },
    disconnect() { }
  });
  const ALTRO = '0x0000000000000000000000000000000000000002';
  const ROTTO = '0x0000000000000000000000000000000000000009';

  await Promise.all([client.getFrontendOpenOrders(ADDR, NET), client.getFrontendOpenOrders(ALTRO, NET)]);
  assert.deepEqual(visti.sort(), [ADDR, ALTRO].sort(), 'due wallet = due risposte diverse = due chiamate');

  await assert.rejects(() => client.getFrontendOpenOrders(ROTTO, NET), /boom/);
  assert.equal(client.heavyReadsInFlight.size, 0,
    'una richiesta fallita deve liberare la chiave, altrimenti il wallet resterebbe illeggibile per sempre');
  await assert.rejects(() => client.getFrontendOpenOrders(ROTTO, NET), /boom/, 'e la successiva riparte');

  client.readSdks.clear();
  client.heavyReadsInFlight.clear();
});

test('anche una chiamata di esecuzione appesa fallisce invece di bloccare la coda', async () => {
  const timeoutOriginale = client.execTimeoutMs;
  client.execTimeoutMs = 40;
  client.signSdks.set(`${NET}:${ADDR.toLowerCase()}`, {
    exchange: {
      // Un ordine appeso per sempre terrebbe bloccata la coda di esecuzione di
      // quel master: anche il successivo piazzamento dello STOP LOSS.
      placeOrder: () => new Promise(() => { }),
      cancelOrder: () => new Promise(() => { })
    },
    disconnect() { }
  });

  await assert.rejects(
    () => client.placeTriggerOrder({
      masterAddress: ADDR, coin: 'BTC-PERP', isBuy: false, size: 0.01, triggerPx: 50000, tpsl: 'sl'
    }, NET),
    /timeout/i
  );
  await assert.rejects(
    () => client.cancelOrder({ masterAddress: ADDR, coin: 'BTC-PERP', oid: 1 }, NET),
    /timeout/i
  );

  client.signSdks.clear();
  client.execTimeoutMs = timeoutOriginale;
});
