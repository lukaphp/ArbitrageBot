/**
 * CUR-01: modulo tasso di cambio EUR/USD
 * ======================================
 *
 * Il modulo è solo presentazione, ma il suo unico modo di fare danno è chiaro:
 * mostrare un numero vecchio come se fosse fresco. I test coprono le tre cose che
 * chiede la story — cache, fallback su errore di rete, soglia di staleness — più
 * la garanzia che un valore assente resti `null` e non diventi un numero
 * plausibile.
 *
 * NESSUNA CHIAMATA DI RETE REALE. Si sostituisce l'adapter di axios, che è il
 * punto di estensione previsto dalla libreria: il codice sotto test resta quello
 * di produzione (stessa URL, stesso timeout, stessa lettura del corpo), viene
 * finto solo il trasporto. Un fetch vero renderebbe la suite dipendente da
 * Internet e dal calendario della BCE — il 2026-08-10 il tasso più fresco che
 * esista è quello di venerdì 7, quindi persino l'asserzione "non è stantio"
 * dipenderebbe dal giorno in cui girano i test.
 *
 * Le soglie arrivano dall'ambiente e vengono lette all'import del modulo: per
 * questo l'import è dinamico e successivo a process.env (gli import statici ESM
 * sono valutati prima del corpo del file, quindi vedrebbero i default reali —
 * 6 ore di TTL, insopportabili in un test).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import axios from 'axios';

// Soglie compresse: il TTL e l'età-di-fetch devono poter scadere dentro un test.
process.env.PERPS_FX_TTL_MS = '120';
process.env.PERPS_FX_MAX_FETCH_AGE_MS = '400';
process.env.PERPS_FX_MAX_AGE_MS = String(120 * 60 * 60 * 1000); // 120h, il default
process.env.PERPS_FX_TIMEOUT_MS = '1500';

const fxRate = (await import('../src/perps/fxRate.js')).default;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoDaysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

/** Registro delle richieste passate dall'adapter finto. */
let calls = [];

/**
 * Installa un adapter axios finto. `responder` riceve la config della richiesta e
 * ritorna il corpo da servire, oppure lancia per simulare un guasto di rete.
 */
function stubHttp(responder) {
  calls = [];
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    const data = await responder(config);
    return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
}

/** Corpo di risposta di Frankfurter. */
const body = (rate, date) => ({ amount: 1.0, base: 'EUR', date, rates: { USD: rate } });

beforeEach(() => {
  fxRate._resetForTests();
  calls = [];
});

test('prima chiamata: interroga la sorgente e riporta tasso, data e stato fresco', async () => {
  stubHttp(() => body(1.1535, isoDaysAgo(0)));

  const r = await fxRate.getEurUsd();

  assert.equal(r.rate, 1.1535);
  assert.equal(r.asOf, isoDaysAgo(0));
  assert.equal(r.stale, false);
  assert.equal(r.error, null);
  assert.equal(r.source, 'frankfurter');
  assert.ok(typeof r.fetchedAt === 'string', 'fetchedAt sempre presente per un valore reale');

  // La richiesta è quella dichiarata nel modulo: host .dev/v1 (il vecchio .app
  // risponde 301 su un contratto diverso) e un timeout impostato.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.frankfurter\.dev\/v1\/latest\?base=EUR&symbols=USD$/);
  assert.equal(calls[0].timeout, 1500);
  assert.equal(calls[0].method, 'get');
});

test('cache: dentro il TTL non tocca la rete; `force` la ignora', async () => {
  let served = 0;
  stubHttp(() => { served++; return body(1.10 + served / 100, isoDaysAgo(0)); });

  const first = await fxRate.getEurUsd();
  const second = await fxRate.getEurUsd();

  assert.equal(served, 1, 'la seconda chiamata dentro il TTL non deve interrogare la sorgente');
  assert.deepEqual(second.rate, first.rate);

  const forced = await fxRate.getEurUsd({ force: true });
  assert.equal(served, 2, '`force` deve bypassare la cache');
  assert.notEqual(forced.rate, first.rate);
});

test('cache: scaduto il TTL rilegge la sorgente', async () => {
  let served = 0;
  stubHttp(() => { served++; return body(1.10, isoDaysAgo(0)); });

  await fxRate.getEurUsd();
  await sleep(150);              // TTL = 120ms
  await fxRate.getEurUsd();

  assert.equal(served, 2);
});

test('chiamate concorrenti: una sola richiesta in volo', async () => {
  let served = 0;
  stubHttp(async () => { served++; await sleep(30); return body(1.10, isoDaysAgo(0)); });

  const results = await Promise.all([fxRate.getEurUsd(), fxRate.getEurUsd(), fxRate.getEurUsd()]);

  assert.equal(served, 1, 'tre pannelli che aprono insieme non devono produrre tre GET');
  assert.deepEqual(results.map(r => r.rate), [1.10, 1.10, 1.10]);
});

test('errore di rete SENZA cache: rate null e stale, mai un numero inventato', async () => {
  stubHttp(() => { const e = new Error('getaddrinfo EAI_AGAIN api.frankfurter.dev'); e.code = 'EAI_AGAIN'; throw e; });

  const r = await fxRate.getEurUsd();

  assert.equal(r.rate, null, 'nessun fallback numerico: né 1, né l\'ultimo noto inesistente');
  assert.equal(r.asOf, null);
  assert.equal(r.stale, true, 'senza valore lo stato è sempre stantio');
  assert.match(r.error, /EAI_AGAIN/, 'la causa resta leggibile per la diagnosi');
});

test('errore di rete CON cache: serve l\'ultimo valore noto, etichettato e con l\'errore', async () => {
  stubHttp(() => body(1.1535, isoDaysAgo(0)));
  const good = await fxRate.getEurUsd();

  // La sorgente cade e il TTL scade: si riprova, si fallisce, ma il valore noto
  // non viene buttato — è la ragione per cui esiste una cache.
  stubHttp(() => { throw new Error('socket hang up'); });
  await sleep(150);
  const r = await fxRate.getEurUsd();

  assert.equal(r.rate, good.rate, 'l\'ultimo valore noto resta disponibile');
  assert.equal(r.asOf, good.asOf);
  assert.match(r.error, /socket hang up/, 'l\'errore accompagna sempre il valore servito da cache');
  assert.equal(r.stale, false, 'appena fallito il refresh il valore è ancora recente: non è stantio per definizione');
  assert.ok(r.ageMs >= 0 && r.fetchAgeMs >= 0, 'entrambe le età sono sempre esposte');
});

test('soglia di staleness sull\'età del TASSO: data di riferimento troppo vecchia ⇒ stale', async () => {
  // 6 giorni: oltre i 5 di default. Nessun fine settimana o ponte arriva a tanto,
  // quindi è un tasso che nessuno dovrebbe più mostrare come attuale.
  stubHttp(() => body(1.1535, isoDaysAgo(6)));

  const r = await fxRate.getEurUsd();

  assert.equal(r.rate, 1.1535, 'il valore resta leggibile: è la UI a decidere di nasconderlo');
  assert.equal(r.stale, true);
  assert.ok(r.ageMs > 120 * 60 * 60 * 1000, `età attesa oltre 120h, misurata ${r.ageMs}ms`);
  assert.equal(r.error, null, 'stantio per età non è un errore di chiamata: sono due stati distinti');
});

test('soglia di staleness sull\'età del FETCH: sorgente irraggiungibile da troppo ⇒ stale', async () => {
  // Distingue "la BCE non ha pubblicato" (weekend, tollerato) da "noi non
  // riusciamo più a leggere il tasso" (guasto nostro, da segnalare presto).
  // La data del tasso resta di oggi: solo la nostra ultima lettura invecchia.
  stubHttp(() => body(1.1535, isoDaysAgo(0)));
  await fxRate.getEurUsd();

  stubHttp(() => { throw new Error('ETIMEDOUT'); });
  await sleep(450);              // MAX_FETCH_AGE_MS = 400ms
  const r = await fxRate.getEurUsd();

  assert.equal(r.stale, true, 'la data del tasso è di oggi, ma la nostra ultima lettura è troppo vecchia');
  assert.ok(r.fetchAgeMs > 400, `fetchAgeMs atteso > 400, misurato ${r.fetchAgeMs}`);
  assert.ok(r.ageMs < 120 * 60 * 60 * 1000, 'l\'età del tasso in sé è ancora nei limiti: le due soglie sono indipendenti');
});

test('risposta 200 con corpo inatteso: trattata come guasto, non come tasso valido', async () => {
  // Il caso peggiore è un NaN che arriva fino alla UI come "€NaN": qui il valore
  // non entra nemmeno in cache.
  for (const bad of [
    { amount: 1, base: 'EUR', date: isoDaysAgo(0), rates: {} },
    { amount: 1, base: 'EUR', date: isoDaysAgo(0), rates: { USD: 'n/d' } },
    { amount: 1, base: 'EUR', date: isoDaysAgo(0), rates: { USD: 0 } },
    { amount: 1, base: 'EUR', date: 'non-una-data', rates: { USD: 1.15 } },
    {}
  ]) {
    fxRate._resetForTests();
    stubHttp(() => bad);
    const r = await fxRate.getEurUsd();
    assert.equal(r.rate, null, `corpo inatteso accettato: ${JSON.stringify(bad)}`);
    assert.equal(r.stale, true);
    assert.ok(r.error, 'il motivo del rifiuto va riportato');
  }
});

test('il modulo non importa nulla della catena di rischio (CUR-01: solo presentazione)', async () => {
  // Verifica strutturale dell'invariante di sprint4.md §1: il tasso di cambio non
  // deve poter entrare in un calcolo di sizing o in un cap di rischio. Un import
  // aggiunto qui per comodità sarebbe il primo passo verso un limite convertito.
  const src = await readFile(new URL('../src/perps/fxRate.js', import.meta.url), 'utf8');
  for (const forbidden of ['riskManager', 'portfolio', 'riskAgent', 'botManager', 'bot.js']) {
    assert.doesNotMatch(src, new RegExp(`from\\s+['"][^'"]*${forbidden}`),
      `fxRate.js non deve importare ${forbidden}`);
  }
});

test('la catena di rischio non importa il tasso di cambio (verifica nell\'altro verso)', async () => {
  // L'invariante vale in entrambe le direzioni, e questo è il verso che conta di
  // più: un `import fxRate` comparso in uno di questi file significherebbe che un
  // cap in USD ha iniziato a dipendere da una GET verso Internet.
  for (const f of ['riskManager.js', 'portfolio.js', 'riskAgent.js']) {
    const src = await readFile(new URL(`../src/perps/${f}`, import.meta.url), 'utf8')
      .catch(() => readFile(new URL(`../src/agents/${f}`, import.meta.url), 'utf8'));
    assert.doesNotMatch(src, /fxRate|frankfurter|eurusd/i, `${f} non deve conoscere il tasso di cambio`);
  }
});

test('la route /api/fx/eurusd è dietro il gate cookie e delega al modulo', async () => {
  // Il giro HTTP completo non è coperto qui: farebbe partire il server reale con
  // db e singleton. Quello che si blocca è l'invariante che un refactor può
  // rompere in silenzio — la route deve restare sotto /api/ (quindi protetta dal
  // gate di setupMiddleware) e fuori dall'allowlist pubblica.
  // Il round-trip vero (401 senza cookie, 200 con cookie e contratto rispettato) è
  // stato verificato sul container in esecuzione durante la prova di OBS-01.
  const src = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.match(src, /app\.get\('\/api\/fx\/eurusd'/, 'la route deve stare sotto /api/');
  assert.match(src, /fxRate\.getEurUsd\(\)/, 'la route deve delegare al modulo, non ricalcolare');

  const publicApi = /const publicApi = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(publicApi, 'allowlist delle API pubbliche non trovata: verifica il gate');
  assert.doesNotMatch(publicApi[1], /fx/, 'il tasso di cambio non va nell\'allowlist pubblica');
});
