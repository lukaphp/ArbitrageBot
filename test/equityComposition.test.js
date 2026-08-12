/**
 * CRIT-05 · doppio conteggio dell'equity (Spot hold vs margine perp).
 * ==================================================================
 *
 * `getAccount()` esponeva `equity = accountValue + spotUsdc` dove `spotUsdc` è il
 * `total` del pool Spot. Su account unificato Hyperliquid esiste UN SOLO pool di
 * collaterale: il margine impegnato sta dentro **entrambi** gli addendi, quindi
 * veniva contato due volte, con una sovrastima pari esattamente a `spot.hold`.
 *
 * Il test centrale non confronta un valore atteso ma una **PROPRIETÀ**: aprire
 * una posizione non deve cambiare l'equity, a meno di fee e PnL. Un test su un
 * numero atteso non coglie questa classe di bug — è proprio il motivo per cui il
 * `+ spotUsdc` (commit `9e3a236`) è sopravvissuto a una review: la sua premessa
 * era giusta e a conto piatto la somma è corretta. Il bug è INVISIBILE a conto
 * piatto e si manifesta solo con posizione aperta.
 *
 * Le fixture reali qui sotto NON sono inventate: sono misurate il 2026-08-12
 * sulla demo operativa isolata (testnet, due posizioni concorrenti BTC+AAVE)
 * interrogando gli endpoint `info` PUBBLICI di Hyperliquid in sola lettura.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeEquity } from '../src/perps/riskManager.js';
import riskManager from '../src/perps/riskManager.js';

/**
 * Campione REALE con DUE posizioni concorrenti aperte (BTC long + AAVE short),
 * demo testnet, 2026-08-12. Le tre grandezze sono state lette con richieste
 * emesse in PARALLELO: emesse in sequenza, la deriva del mark price tra le due
 * risposte produce uno scarto apparente di ~$0.01 su `hold - totalMarginUsed` che
 * non è strutturale (verificato: su 6 campioni appaiati lo scarto è 0 esatto).
 */
const DEMO_DUE_POSIZIONI = {
  accountValue: 101.845466,
  spotTotal: 976.641709,
  spotHold: 102.453433,
  totalMarginUsed: 102.453433,
  unrealizedPnl: -1.00564
};

/** Equity della stessa demo PRIMA di qualunque bot (conto piatto). */
const DEMO_EQUITY_INIZIALE = 977.564181;

// ---- La funzione pura ----

test('composeEquity: sottrae dal pool Spot la quota già impegnata come margine', () => {
  const r = composeEquity({ accountValue: 100, spotTotal: 1000, spotHold: 100 });
  assert.equal(r.spotAvailable, 900, 'Spot davvero libero = total - hold');
  assert.equal(r.equity, 1000, 'accountValue + Spot libero');
  assert.equal(r.doubleCounted, 100, 'quanto sovrastimava la formula precedente');
  // La formula vecchia, per contrasto.
  assert.equal(100 + 1000, 1100, 'accountValue + spot.total sovrastimava di 100 = il margine');
});

test('composeEquity: la formula è quella dichiarata, accountValue + (total - hold)', () => {
  const { accountValue, spotTotal, spotHold } = DEMO_DUE_POSIZIONI;
  const r = composeEquity({ accountValue, spotTotal, spotHold });
  assert.ok(Math.abs(r.equity - (accountValue + (spotTotal - spotHold))) < 1e-9);
});

test('REGRESSIONE sul caso che ha originato il `+ spotUsdc` (commit 9e3a236): conto piatto', () => {
  // È il falso "Equity nullo" che quel commit risolveva davvero: tutto il
  // collaterale in Spot, nessun perp aperto, `accountValue` a 0. La premessa era
  // giusta e va conservata — il fix non deve reintrodurre quel bug.
  const r = composeEquity({ accountValue: 0, spotTotal: DEMO_EQUITY_INIZIALE, spotHold: 0 });
  assert.equal(r.equity, DEMO_EQUITY_INIZIALE,
    'a conto piatto l\'equity è tutto il pool Spot, non zero');
  assert.equal(r.doubleCounted, 0, 'senza margine impegnato non c\'è nulla di doppio');
  // E la formula precedente qui dava lo STESSO risultato: ecco perché il bug era
  // invisibile e ha superato una review.
  assert.equal(0 + DEMO_EQUITY_INIZIALE, r.equity);
});

test('composeEquity: mainnet oggi (conto vuoto) resta a zero, senza NaN', () => {
  const r = composeEquity({ accountValue: 0, spotTotal: 0, spotHold: 0 });
  assert.equal(r.equity, 0);
  assert.equal(r.spotAvailable, 0);
  assert.ok(Number.isFinite(r.equity));
});

test('composeEquity: input malformati non producono NaN né Spot libero negativo', () => {
  // `hold` oltre il pool sarebbe una risposta incoerente: non deve diventare un
  // "libero" negativo che abbassa l'equity in silenzio.
  assert.equal(composeEquity({ accountValue: 50, spotTotal: 100, spotHold: 500 }).spotAvailable, 0);
  assert.equal(composeEquity({ accountValue: 50, spotTotal: 100, spotHold: 500 }).equity, 50);
  assert.equal(composeEquity({ accountValue: 10, spotTotal: 100, spotHold: -5 }).spotAvailable, 100);
  for (const bad of [undefined, null, NaN, 'x', {}]) {
    const r = composeEquity({ accountValue: bad, spotTotal: bad, spotHold: bad });
    assert.ok(Number.isFinite(r.equity), `input ${String(bad)} non deve produrre NaN`);
  }
  assert.equal(composeEquity().equity, 0, 'nessun argomento: 0, non un errore');
  assert.equal(riskManager.composeEquity({ accountValue: 1, spotTotal: 2, spotHold: 1 }).equity, 2,
    'disponibile anche come metodo sul singleton');
});

// ---- LA PROPRIETÀ: aprire una posizione non cambia l'equity ----

/**
 * Modella l'apertura di una posizione su account unificato: il collaterale NON
 * esce dal pool Spot (verificato empiricamente: `spot.total` cala solo delle fee),
 * viene BLOCCATO — quindi `hold` sale del margine e `accountValue` sale del
 * margine più il PnL non realizzato.
 */
const apri = (stato, { margine, fee = 0, upnl = 0 }) => ({
  accountValue: stato.accountValue + margine + upnl,
  spotTotal: stato.spotTotal - fee,
  spotHold: stato.spotHold + margine
});

test('PROPRIETÀ · fixture 1 (conto piatto): aprire una posizione non cambia l\'equity', () => {
  const piatto = { accountValue: 0, spotTotal: 1000, spotHold: 0 };
  const dopo = apri(piatto, { margine: 100 });

  const prima = composeEquity(piatto).equity;
  const poi = composeEquity(dopo).equity;
  assert.equal(prima, 1000);
  assert.equal(poi, 1000, 'il collaterale si sposta, la somma resta');
  assert.equal(poi - prima, 0, 'invarianza esatta senza fee');

  // La formula PRECEDENTE viola la proprietà, ed è la misura del bug.
  const vecchiaPrima = piatto.accountValue + piatto.spotTotal;
  const vecchiaDopo = dopo.accountValue + dopo.spotTotal;
  assert.equal(vecchiaDopo - vecchiaPrima, 100,
    'la formula vecchia guadagnava equity dal nulla, esattamente pari al margine');
});

test('PROPRIETÀ · fixture 2 (posizione già aperta): aprirne una SECONDA non cambia l\'equity', () => {
  // È il secondo campione richiesto: il caso multi-posizione, dove il difetto
  // COMPONE tra bot concorrenti.
  const unaAperta = { accountValue: 100, spotTotal: 1000, spotHold: 100 };
  const dueAperte = apri(unaAperta, { margine: 50 });

  assert.equal(composeEquity(unaAperta).equity, 1000);
  assert.equal(composeEquity(dueAperte).equity, 1000, 'invariante anche sul secondo ingresso');

  const vecchiaUna = unaAperta.accountValue + unaAperta.spotTotal;   // 1100
  const vecchiaDue = dueAperte.accountValue + dueAperte.spotTotal;   // 1150
  assert.equal(vecchiaUna, 1100);
  assert.equal(vecchiaDue, 1150);
  assert.equal(vecchiaDue - vecchiaUna, 50, 'ogni apertura gonfiava ancora, in modo cumulativo');
});

test('PROPRIETÀ · con fee e PnL l\'equity si muove SOLO di fee e PnL', () => {
  const piatto = { accountValue: 0, spotTotal: 1000, spotHold: 0 };
  const dopo = apri(piatto, { margine: 200, fee: 0.35, upnl: -1.2 });
  const delta = composeEquity(dopo).equity - composeEquity(piatto).equity;
  assert.ok(Math.abs(delta - (-0.35 - 1.2)) < 1e-9,
    `la variazione (${delta}) è spiegata da fee + PnL, non dal margine impegnato`);
});

test('PROPRIETÀ sui DATI REALI della demo con due posizioni concorrenti', () => {
  const { accountValue, spotTotal, spotHold, unrealizedPnl } = DEMO_DUE_POSIZIONI;
  const nuova = composeEquity({ accountValue, spotTotal, spotHold }).equity;
  const vecchia = accountValue + spotTotal;

  // 1) La sovrastima della formula vecchia è ESATTAMENTE il margine impegnato.
  assert.ok(Math.abs((vecchia - nuova) - spotHold) < 1e-9);
  assert.ok(Math.abs((vecchia - nuova) - DEMO_DUE_POSIZIONI.totalMarginUsed) < 1e-9,
    'e il margine impegnato coincide con spot.hold: è la stessa grandezza contata due volte');

  // 2) La formula nuova resta vicina all'equity iniziale, e lo scarto è
  //    spiegato: PnL non realizzato + fee/PnL realizzato. Nessun salto da $100.
  const derivaNuova = nuova - DEMO_EQUITY_INIZIALE;
  assert.ok(derivaNuova < 0 && derivaNuova > -3,
    `deriva reale ${derivaNuova.toFixed(6)}: piccola e negativa, coerente con fee+PnL`);
  assert.ok(Math.abs(derivaNuova - unrealizedPnl) < 1,
    'la parte dominante della deriva è il PnL non realizzato misurato');

  // 3) La formula vecchia invece si allontanava di ~+$100 dal nulla.
  const derivaVecchia = vecchia - DEMO_EQUITY_INIZIALE;
  assert.ok(derivaVecchia > 100,
    `la formula vecchia derivava di +${derivaVecchia.toFixed(2)}: equity inventata`);
});

// ---- I falsi positivi a valle (sizing, marginPct, drawdown) ----

test('marginPct: la formula vecchia SOTTOSTIMAVA il margine, cioè ritardava l\'allarme di leva', () => {
  const { spotTotal, spotHold, accountValue, totalMarginUsed } = DEMO_DUE_POSIZIONI;
  const nuova = composeEquity({ accountValue, spotTotal, spotHold }).equity;
  const vecchia = accountValue + spotTotal;

  // Stessa formula di riskSnapshot.js: (margine / equity) * 100.
  const pctVecchia = (totalMarginUsed / vecchia) * 100;
  const pctNuova = (totalMarginUsed / nuova) * 100;

  assert.ok(pctNuova > pctVecchia,
    `margine reale ${pctNuova.toFixed(2)}% vs riportato ${pctVecchia.toFixed(2)}%`);
  // Un'equity gonfiata fa sembrare il conto meno carico di quanto sia: le soglie
  // di warning (60%) e critical (80%) scattano più tardi del dovuto.
  assert.ok(pctNuova - pctVecchia > 0.9, 'sottostima di circa un punto percentuale su questo campione');
});

test('marginPct: a leva alta la sottostima ritarda l\'allarme oltre la soglia di warning', () => {
  // Caso costruito per mostrare l'effetto dove conta: la soglia di warning è 60%.
  // Conto con $1000 di collaterale e $600 di margine impegnato.
  const stato = { accountValue: 600, spotTotal: 1000, spotHold: 600 };
  const margine = 600;
  const nuova = composeEquity(stato).equity;                 // 1000
  const vecchia = stato.accountValue + stato.spotTotal;       // 1600

  const pctNuova = (margine / nuova) * 100;      // 60% → warning
  const pctVecchia = (margine / vecchia) * 100;  // 37.5% → nessun allarme

  assert.equal(Math.round(pctNuova), 60);
  assert.ok(pctVecchia < 60);
  assert.ok(pctNuova >= 60 && pctVecchia < 60,
    'con la formula vecchia il warning di margine NON sarebbe scattato affatto');
});

test('sizing: l\'equity gonfiata sovradimensiona, e il difetto COMPONE tra bot concorrenti', () => {
  // `sizePosition` applica la percentuale all'equity: se l'equity cresce a ogni
  // margine impegnato, ogni bot successivo apre più grande del dovuto.
  const cfg = { sizing: { mode: 'percent', value: 10 }, leverage: 2 };
  const price = 100;

  const piatto = { accountValue: 0, spotTotal: 1000, spotHold: 0 };
  const primo = riskManager.sizePosition(cfg, composeEquity(piatto).equity, price);

  // Dopo l'apertura del primo bot, il secondo valuta la size.
  const dopoUno = apri(piatto, { margine: primo.marginUsd });
  const secondoCorretto = riskManager.sizePosition(cfg, composeEquity(dopoUno).equity, price);
  const secondoGonfiato = riskManager.sizePosition(cfg, dopoUno.accountValue + dopoUno.spotTotal, price);

  assert.equal(secondoCorretto.notionalUsd, primo.notionalUsd,
    'con l\'equity corretta il secondo bot apre come il primo');
  assert.ok(secondoGonfiato.notionalUsd > secondoCorretto.notionalUsd,
    `il secondo bot apriva ${secondoGonfiato.notionalUsd} invece di ${secondoCorretto.notionalUsd}`);
});

test('drawdown: alla chiusura delle posizioni la formula vecchia produceva un calo fittizio', () => {
  // L'equity è persistita in `risk_equity_history` e alimenta il drawdown. Con la
  // formula vecchia l'equity SALE all'apertura e TORNA GIÙ alla chiusura senza
  // che sia stato perso un centesimo: un drawdown che non è mai avvenuto.
  const piatto = { accountValue: 0, spotTotal: 1000, spotHold: 0 };
  const aperto = apri(piatto, { margine: 300 });
  const richiuso = piatto; // chiusa in pari, nessuna fee per isolare l'effetto

  const serieVecchia = [piatto, aperto, richiuso].map(s => s.accountValue + s.spotTotal);
  const serieNuova = [piatto, aperto, richiuso].map(s => composeEquity(s).equity);

  const picco = Math.max(...serieVecchia);
  const cadutaVecchia = (picco - serieVecchia[serieVecchia.length - 1]) / picco;
  assert.ok(cadutaVecchia > 0.2,
    `drawdown fittizio del ${(cadutaVecchia * 100).toFixed(0)}% su un conto che non ha perso nulla`);

  const piccoNuovo = Math.max(...serieNuova);
  assert.equal(piccoNuovo, serieNuova[serieNuova.length - 1],
    'con l\'equity corretta la serie è piatta: nessun drawdown inventato');
});
