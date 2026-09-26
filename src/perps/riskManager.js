/**
 * RISK MANAGER (Perps)
 * ====================
 *
 * Sizing delle posizioni, calcolo TP/SL e trailing stop, e controllo dei limiti
 * di rischio applicato lato server PRIMA di ogni ordine.
 *
 * Tutti i valori monetari sono in USD (collateral Hyperliquid = USDC).
 */

import { HYPERLIQUID_CONFIG } from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * CRIT-05 — composizione dell'equity su account unificato Hyperliquid.
 *
 * Il problema che risolve. Con account unificato esiste **un solo** pool di
 * collaterale USDC, non due: `spotClearinghouseState.balances[USDC].total` è il
 * pool INTERO e `…hold` è la porzione già bloccata come margine dei perpetual,
 * mentre `marginSummary.accountValue` non è un pool indipendente — è la vista
 * mark-to-market della fetta di collaterale impegnata nei perp (≈ margine
 * impegnato + PnL non realizzato + funding). Sommare `accountValue + spot.total`
 * conta quindi il margine impegnato **due volte**.
 *
 * La premessa del `+ spotUsdc` originale (commit `9e3a236`, "supporto account
 * unificati") era giusta e risolveva un vero falso "Equity nullo" a conto piatto:
 * sbagliato era solo l'addendo — serviva lo Spot **libero**, non il `total`. Per
 * questo è sopravvissuto a una review, ed è invisibile a conto piatto
 * (`accountValue = 0` → la somma è corretta): si manifesta solo con posizione
 * aperta.
 *
 * La proprietà che rende la formula giusta, e che il test verifica: **aprire una
 * posizione non cambia l'equity** (a meno di fee e PnL). Il collaterale si sposta
 * da `spot` libero a `accountValue`, e la somma resta.
 *
 * Nota sulla robustezza: la correttezza NON dipende dall'identità empirica
 * `spot.hold == totalMarginUsed` (verificata sulla demo, ma che potrebbe non
 * reggere con ordini di apertura pendenti, che bloccano collaterale senza essere
 * ancora margine di posizione). Qui si calcola lo Spot **davvero libero** come
 * `total - hold`: qualunque cosa `hold` includa, quel che resta è disponibile, e
 * la somma non conta niente due volte.
 *
 * Funzione PURA e fuori dalla classe: la usano `hyperliquidClient.getAccount()`
 * (che è I/O) e i test in isolamento, senza dover costruire un client.
 *
 * @returns { equity, spotAvailable, spotTotal, spotHold, doubleCounted }
 */
export function composeEquity({ accountValue = 0, spotTotal = 0, spotHold = 0 } = {}) {
  const av = Number.isFinite(Number(accountValue)) ? Number(accountValue) : 0;
  const total = Number.isFinite(Number(spotTotal)) ? Number(spotTotal) : 0;
  // `hold` non può eccedere il pool né essere negativo: un dato fuori range
  // sarebbe una risposta malformata, e lasciarlo passare produrrebbe uno Spot
  // "libero" negativo che gonfierebbe o azzererebbe l'equity in silenzio.
  const holdRaw = Number.isFinite(Number(spotHold)) ? Number(spotHold) : 0;
  const hold = Math.min(Math.max(holdRaw, 0), Math.max(total, 0));
  const spotAvailable = Math.max(0, total - hold);
  return {
    equity: av + spotAvailable,
    spotAvailable,
    spotTotal: total,
    spotHold: hold,
    // Quanto la formula precedente (`accountValue + spot.total`) sovrastimava.
    // Esposto perché è la grandezza da guardare per capire se un'equity storica
    // in `risk_equity_history` è gonfiata, e di quanto.
    doubleCounted: hold
  };
}

/**
 * Totali di UNA fonte (exchange reale o broker paper), nella stessa forma.
 *
 * `totalNtlPos`/`totalMarginUsed` sono il `marginSummary` dell'exchange: il
 * paper broker non ne tiene uno e riporta `0`. Con posizioni aperte quello zero
 * non è una misura, è un campo **assente** — e passarlo a valle darebbe "margine
 * utilizzato 0%" su una flotta a leva 3x, cioè un rischio dichiarato nullo
 * mentre esiste. Quando il totale dichiarato è 0 lo si ricava quindi dalle
 * posizioni: sul conto reale l'identità `totalMarginUsed == Σ marginUsed` è
 * verificata sull'account unificato, quindi la derivazione non contraddice mai
 * la fonte che dichiara il totale.
 */
function sourceTotals(account) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const positions = Array.isArray(account?.positions) ? account.positions : [];
  // `totalNtlPos` è la somma dei notional in VALORE ASSOLUTO (una short non
  // riduce l'esposizione lorda): stessa convenzione di Hyperliquid.
  const derivedNtl = positions.reduce((sum, p) => sum + Math.abs(num(p.positionValue)), 0);
  const derivedMargin = positions.reduce((sum, p) => sum + num(p.marginUsed), 0);
  return {
    accountValue: num(account?.accountValue),
    equity: num(account?.equity ?? account?.accountValue),
    withdrawable: num(account?.withdrawable),
    spotUsdc: num(account?.spotUsdc),
    totalNtlPos: num(account?.totalNtlPos) || derivedNtl,
    totalMarginUsed: num(account?.totalMarginUsed) || derivedMargin,
    unrealizedPnl: positions.reduce((sum, p) => sum + num(p.unrealizedPnl), 0),
    positionsCount: positions.length
  };
}

/**
 * Unisce la vista dell'account REALE e quella del broker PAPER in un'unica
 * vista coerente per le rotte aggregate (`/api/perps/account`, `/api/perps/risk`).
 *
 * IL PROBLEMA CHE RISOLVE. Le due rotte leggevano solo `hyperliquid.getAccount()`:
 * con una flotta interamente `paper: true` l'account reale ha zero posizioni, e
 * quindi il pannello "Posizioni attive" restava vuoto e il tab Rischio
 * descriveva un wallet fermo invece della flotta che stava davvero producendo
 * esposizione. Le card dei singoli bot non erano toccate perché passano da
 * `PerpsBot.position`, cioè dal broker giusto per quel bot.
 *
 * TRE DECISIONI, tutte sul "non affermare cose false":
 *
 *  1. **Niente fusione delle posizioni.** Le liste si concatenano e ogni riga
 *     porta `source`/`isPaper`. Una posizione reale e una paper sulla stessa
 *     coin sono due esposizioni distinte: sommarle conterebbe due volte una size
 *     che non esiste, e tenerne una sola ne nasconderebbe un'altra. È anche la
 *     sola forma che regge il giorno in cui sullo stesso indirizzo convivranno
 *     bot live e bot paper.
 *  2. **`equity`, `totalMarginUsed`, `totalNtlPos`, `unrealizedPnl` sono
 *     l'AGGREGATO.** Non è cosmesi: `deriveRiskAlerts` calcola RAPPORTI
 *     (margine/equity, esposizione/cap, numero posizioni/cap). Prendere le
 *     posizioni da una fonte e l'equity da un'altra produce percentuali
 *     inventate — un margine del 76% su un'equity che non regge quelle
 *     posizioni, o uno 0% con la flotta a mercato.
 *  3. **I fatti del WALLET restano reali**: `accountValue`, `withdrawable`,
 *     `spotUsdc`, `spotAvailable`, `spotHold` descrivono denaro che si può
 *     davvero muovere (badge del faucet, trasferimento Spot→Perp, prelievo).
 *     Sommarci dentro equity simulata direbbe all'utente che ha fondi che non
 *     esistono.
 *
 * La scomposizione resta sempre leggibile in `sources.real` / `sources.paper`
 * (`null` = fonte assente, non "fonte a zero"), e `mode` dice in una parola di
 * cosa si sta guardando il rischio.
 *
 * Funzione PURA: nessun I/O, nessun singleton. L'orchestrazione (chi interroga
 * l'exchange, chi il broker paper) resta nel guscio che la chiama.
 *
 * @param real  vista di `hyperliquidClient.getAccount()`, o `null`
 * @param paper vista di `paperBroker.peekAccount()`, o `null`
 */
export function mergeAccountViews({ real = null, paper = null } = {}) {
  const tag = (account, source) => (Array.isArray(account?.positions) ? account.positions : [])
    .map(p => ({ ...p, source, isPaper: source === 'paper' }));

  const realTotals = real ? sourceTotals(real) : null;
  const paperTotals = paper ? sourceTotals(paper) : null;
  const sum = (field) => (realTotals?.[field] || 0) + (paperTotals?.[field] || 0);

  let mode = 'none';
  if (realTotals && paperTotals) mode = 'mixed';
  else if (realTotals) mode = 'real';
  else if (paperTotals) mode = 'paper';

  return {
    mode,
    // Fatti del wallet reale: mai gonfiati dal simulato.
    accountValue: realTotals?.accountValue ?? 0,
    withdrawable: realTotals?.withdrawable ?? 0,
    spotUsdc: realTotals?.spotUsdc ?? 0,
    spotAvailable: Number.isFinite(Number(real?.spotAvailable)) ? Number(real.spotAvailable) : 0,
    spotHold: Number.isFinite(Number(real?.spotHold)) ? Number(real.spotHold) : 0,
    // Grandezze di rischio: aggregate, perché è su queste che si fanno i rapporti.
    equity: sum('equity'),
    totalMarginUsed: sum('totalMarginUsed'),
    totalNtlPos: sum('totalNtlPos'),
    unrealizedPnl: sum('unrealizedPnl'),
    positions: [...tag(real, 'real'), ...tag(paper, 'paper')],
    sources: { real: realTotals, paper: paperTotals }
  };
}

/**
 * Default del sizing dinamico ATR. Esportati perché il valore è un contratto
 * condiviso: `bot.js` risolve lo stesso periodo per il warmup delle candele, e
 * la UI/gli agenti devono poter mostrare cosa succede quando il campo è omesso,
 * invece di ricopiare i numeri a mano in tre posti.
 */
export const DYNAMIC_SIZING_DEFAULTS = {
  riskPerTradePct: 1.0,
  atrMultiplier: 1.5,
  atrPeriod: 14
};

/**
 * BUG-SIZECAP-01 — DOVE si legge il tetto di notional per bot.
 *
 * Il problema che risolve. `maxPositionUsd` ha DUE percorsi legittimi nella
 * config di un bot, scritti da due sorgenti diverse:
 *  - `config.risk.maxPositionUsd` — la forma prodotta dalla UI (`public/perps.js`);
 *  - `config.maxPositionUsd` (radice) — la forma documentata e validata sul
 *    percorso MCP/agenti (`register_bot`, `update_strategy_params`, e la
 *    skill di Hermes), ed è anche quella che finisce in `bots.max_allocation_usd`.
 * Il sizing leggeva SOLO la prima. Un bot creato da un agente con
 * `maxPositionUsd: 500` veniva quindi dimensionato con il solo cap GLOBALE
 * (`HYPERLIQUID_CONFIG.risk.maxPositionUsd`, 5.000$ di default): il 23/09/2026
 * quattro bot della flotta hanno proposto aperture da 2.700$ a 5.000$ — tre
 * delle quali incollate al cap globale al centesimo — con un tetto dichiarato
 * di 500$. Nessuna è stata eseguita, perché il Budget Ceiling di `bot.js` legge
 * la colonna `max_allocation_usd` (cioè l'altro percorso) e le ha bloccate
 * tutte; ma bloccare a valle significa ricalcolare e ritentare a ogni tick.
 *
 * Perché il più restrittivo e non "il primo che trovo": un tetto di rischio non
 * si rilassa per una divergenza di formato. Se le due forme dicono numeri
 * diversi, l'unica lettura sicura è la più prudente — e la divergenza viene
 * comunque segnalata da `auditRiskConfig`, non nascosta dalla scelta.
 *
 * Un valore inservibile (stringa, 0, negativo) NON vale come "nessun tetto":
 * viene ignorato e riportato in `ignored`, restando il cap globale. Prima
 * `notionalUsd > 'abc'` era semplicemente falso, cioè il cap spariva.
 *
 * Funzione PURA ed esportata: la usano `sizePosition` e `checkLimits` — che
 * devono per forza applicare lo stesso numero, altrimenti il controllo a valle
 * approva ciò che il calcolo a monte non avrebbe dovuto produrre.
 *
 * @returns {{ maxPositionUsd: number, sources: object, ignored: string[] }}
 */
export function resolveMaxPositionUsd(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const ignored = [];
  const sources = {};

  const leggi = (valore, percorso) => {
    if (valore === undefined || valore === null) return null;
    const n = Number(valore);
    if (!Number.isFinite(n) || n <= 0) {
      ignored.push(`${percorso}: valore non utilizzabile (${JSON.stringify(valore)}), ignorato — resta il cap globale`);
      return null;
    }
    sources[percorso] = n;
    return n;
  };

  const dichiarati = [
    leggi(cfg.maxPositionUsd, 'maxPositionUsd'),
    leggi(cfg.risk?.maxPositionUsd, 'risk.maxPositionUsd')
  ].filter(v => v !== null);

  const globale = Number(HYPERLIQUID_CONFIG.risk.maxPositionUsd);
  const maxPositionUsd = Math.min(
    Number.isFinite(globale) && globale > 0 ? globale : Infinity,
    ...(dichiarati.length ? dichiarati : [Infinity])
  );

  return { maxPositionUsd, sources, ignored };
}

/**
 * BUG-SIZECAP-01 — campi di rischio che il motore NON legge.
 *
 * Stessa disciplina di `normalizeStrategyConfig` per le regole non canoniche
 * (BUG-RULESHAPE-01): ciò che è ambiguo si SEGNALA, non si indovina. Qui però
 * non si corregge nulla, perché non c'è una lettura univoca — `sizing.maxPositionUsd`
 * potrebbe voler dire "tetto del sizing" o essere un doppione del tetto di
 * rischio, e `strategyParams.leverage` contraddice `config.leverage` senza che
 * si sappia quale delle due l'operatore considerava viva. Indovinare qui
 * significherebbe far operare il bot con una leva o un tetto che nessuno ha
 * scritto in quel campo.
 *
 * Sono nati da `update_strategy_params` (merge di un livello, commit 39fec01):
 * un agente che passa `{ sizing: { maxPositionUsd } }` crea un percorso nuovo
 * invece di aggiornare quello canonico, e la config risultante DICHIARA un
 * parametro che nessuno applica. Il sintomo è muto per costruzione, quindi
 * l'unico rimedio è dirlo all'avvio del bot (`PerpsBot._reportConfigIssues`).
 *
 * Funzione PURA: nessun log, nessuna notifica — restituisce le righe e lascia
 * al chiamante I/O il compito di dirle.
 */
export function auditRiskConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const avvisi = [];

  const { sources, ignored } = resolveMaxPositionUsd(cfg);
  avvisi.push(...ignored);

  const radice = sources['maxPositionUsd'];
  const annidato = sources['risk.maxPositionUsd'];
  if (radice != null && annidato != null && radice !== annidato) {
    avvisi.push(`maxPositionUsd dichiarato due volte con valori diversi (maxPositionUsd=${radice}, risk.maxPositionUsd=${annidato}): si applica il più restrittivo (${Math.min(radice, annidato)}$).`);
  }

  if (cfg.sizing && typeof cfg.sizing === 'object' && cfg.sizing.maxPositionUsd !== undefined) {
    avvisi.push(`sizing.maxPositionUsd=${JSON.stringify(cfg.sizing.maxPositionUsd)} NON è letto da nessun controllo di rischio: il tetto applicato è maxPositionUsd/risk.maxPositionUsd.`);
  }

  const levAnnidata = cfg.strategyParams && typeof cfg.strategyParams === 'object'
    ? cfg.strategyParams.leverage : undefined;
  if (levAnnidata !== undefined && Number(levAnnidata) !== Number(cfg.leverage ?? HYPERLIQUID_CONFIG.risk.defaultLeverage)) {
    avvisi.push(`strategyParams.leverage=${JSON.stringify(levAnnidata)} NON è la leva usata: il motore applica leverage=${cfg.leverage ?? HYPERLIQUID_CONFIG.risk.defaultLeverage}.`);
  }

  return avvisi;
}

/**
 * OVERTRADING — limiti di FREQUENZA di apertura, di default per tutti i bot.
 *
 * 4 aperture in 30 minuti è il ritmo oltre il quale una strategia a candele
 * (l'intervallo tipico qui è 15m) non sta più seguendo il suo segnale: sta
 * rientrando sullo stesso movimento. Ogni giro costa due fee e due slippage,
 * quindi il danno si accumula anche quando le operazioni chiudono in pari —
 * che è esattamente il caso che i due cooldown esistenti NON vedono, perché
 * guardano entrambi le perdite.
 */
export const OVERTRADING_DEFAULTS = {
  maxOpensPerWindow: 4,
  windowMinutes: 30
};

/**
 * Limiti di overtrading effettivi per un bot: default globali, sovrascrivibili
 * con `config.overtrading` (stesso pattern di `config.cooldown`).
 *
 * Attivo di default, con opt-out ESPLICITO (`overtrading.enabled: false`): un
 * freno di rischio che si attiva solo per chi lo configura protegge proprio i
 * bot che nessuno ha guardato, cioè quelli che ne hanno più bisogno.
 *
 * Un valore inservibile (stringa, 0, negativo) NON vale come "nessun limite":
 * si ricade sul default e la cosa viene riportata in `ignored`, mai ingoiata.
 * Stessa disciplina di `resolveMaxPositionUsd` — e stessa ragione per cui un
 * NaN qui sarebbe peggio del silenzio: `opens >= NaN` è sempre falso, cioè il
 * freno sparirebbe senza che nulla lo dica.
 *
 * Funzione PURA: niente DB, niente orologio. Il conteggio lo fa il chiamante.
 */
export function resolveOvertradingLimits(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const raw = cfg.overtrading && typeof cfg.overtrading === 'object' ? cfg.overtrading : {};
  const ignored = [];

  const leggi = (valore, percorso, predefinito) => {
    if (valore === undefined || valore === null) return predefinito;
    const n = Number(valore);
    if (!Number.isFinite(n) || n < 1) {
      ignored.push(`overtrading.${percorso}: valore non utilizzabile (${JSON.stringify(valore)}), ignorato — resta il default (${predefinito})`);
      return predefinito;
    }
    return n;
  };

  return {
    enabled: raw.enabled !== false,
    // Floor sulla soglia: una soglia frazionaria si arrotonda verso il basso,
    // cioè verso il comportamento più prudente.
    maxOpensPerWindow: Math.floor(leggi(raw.maxOpensPerWindow, 'maxOpensPerWindow', OVERTRADING_DEFAULTS.maxOpensPerWindow)),
    windowMinutes: leggi(raw.windowMinutes, 'windowMinutes', OVERTRADING_DEFAULTS.windowMinutes),
    ignored
  };
}

/**
 * Verdetto sul ritmo di apertura. Blocca quando il conteggio RAGGIUNGE la
 * soglia (con `maxOpensPerWindow: 4` la quinta apertura nella finestra non
 * parte).
 *
 * `retryAt` è derivato, non memorizzato: la finestra è scorrevole, quindi
 * l'apertura più vecchia ancora dentro ne esce a `oldestOpenedAt + finestra`
 * e da quell'istante il conteggio è sceso da solo. Se il chiamante non sa
 * indicare la più vecchia, `retryAt` resta `null` — "non so quando" non
 * diventa un orario inventato, e il blocco resta comunque valido perché a
 * deciderlo è il conteggio.
 *
 * Funzione PURA: stessi ingressi, stesso verdetto. Nessuno stato da
 * risincronizzare, nessun timer da tenere allineato.
 */
export function checkOvertrading(limits, { opens = 0, oldestOpenedAt = null, now = Date.now() } = {}) {
  const lim = limits && typeof limits === 'object' ? limits : resolveOvertradingLimits({});
  const conteggio = Number(opens);
  const soglia = Number(lim.maxOpensPerWindow);
  const finestra = Number(lim.windowMinutes);

  if (lim.enabled === false) return { ok: true, opens: conteggio, reason: null, retryAt: null };

  // Ingressi non utilizzabili: non si passa per default. Un conteggio o una
  // soglia NaN renderebbero falso qualunque confronto, cioè disattiverebbero
  // il freno proprio quando lo stato è incerto.
  if (!Number.isFinite(conteggio) || !Number.isFinite(soglia) || !Number.isFinite(finestra)) {
    return {
      ok: false, opens: conteggio, retryAt: null,
      reason: `Overtrading: frequenza di apertura non verificabile (aperture ${JSON.stringify(opens)}, soglia ${JSON.stringify(lim.maxOpensPerWindow)}, finestra ${JSON.stringify(lim.windowMinutes)})`
    };
  }

  if (conteggio < soglia) return { ok: true, opens: conteggio, reason: null, retryAt: null };

  // `oldestOpenedAt` assente resta assente: `Number(null)` è 0, e uno 0 preso
  // per buono qui produrrebbe un orario di sblocco nel 1970 — cioè "riprova
  // subito" proprio nel caso in cui non si sa nulla.
  const oldest = oldestOpenedAt == null ? null : Number(oldestOpenedAt);
  const retryAt = oldest != null && Number.isFinite(oldest) && oldest > 0
    ? oldest + finestra * 60000
    : null;
  const attesa = retryAt != null && retryAt > now
    ? ` — nuove aperture sospese per ~${Math.ceil((retryAt - now) / 60000)} min`
    : ' — nuove aperture sospese';

  return {
    ok: false,
    opens: conteggio,
    retryAt,
    reason: `Overtrading: ${conteggio} aperture negli ultimi ${finestra} min (max ${soglia})${attesa}`
  };
}

/**
 * CRIT-SLSTALE-25 — lo stop loss è GIÀ STATO SUPERATO dal mercato?
 *
 * Nasce da un caso reale (NEAR-PERP, 25/09/2026): uno stop market su book
 * sottile TRIGGERA correttamente ma riempie solo una frazione della size (2,1
 * su 99,9 unità); il resto dell'ordine viene scartato, la posizione resta
 * aperta e senza protezione. La guardia SL al tick successivo non trova nessuno
 * stop sul book e lo RI-PIAZZA allo stesso `slPx` — che ormai il prezzo si è
 * lasciato alle spalle. Un trigger dietro al mercato non è una protezione: è
 * rimasto inerte per 4 ore con il mark a +6% oltre la soglia, mentre la guardia
 * lo contava come "protezione ripristinata".
 *
 * Qui si risponde solo alla domanda pura — «a questo prezzo, la condizione di
 * stop è già soddisfatta?» — perché la risposta è la stessa per il bot e per il
 * backtester. Cosa farne (chiudere a mercato invece di piazzare un trigger
 * inerte) è orchestrazione, e sta in `bot.js`.
 *
 * FAIL-CLOSED sugli ingressi: con un prezzo o una soglia non finiti non si
 * dichiara "non superato". Un NaN rende falso ogni confronto, e qui "falso"
 * significherebbe piazzare comunque il trigger inerte — cioè il difetto.
 *
 * @param {object} p { side ('long'|'short'), price (mark/mid corrente), slPx }
 * @returns { breached: boolean, known: boolean, reason: string|null }
 */
export function isStopBreached({ side, price, slPx } = {}) {
  const px = Number(price);
  const sl = Number(slPx);
  const lato = side === 'short' ? 'short' : side === 'long' ? 'long' : null;

  if (lato == null || !Number.isFinite(px) || px <= 0 || !Number.isFinite(sl) || sl <= 0) {
    return {
      breached: false,
      known: false,
      reason: `Superamento dello stop non verificabile (lato ${JSON.stringify(side)}, prezzo ${JSON.stringify(price)}, soglia ${JSON.stringify(slPx)})`
    };
  }

  // Stessa direzione dei trigger su Hyperliquid: lo stop di uno short scatta
  // "price above", quello di un long "price below".
  const breached = lato === 'short' ? px >= sl : px <= sl;
  return {
    breached,
    known: true,
    reason: breached
      ? `Stop loss già superato: ${lato} con prezzo ${px} ${lato === 'short' ? '≥' : '≤'} soglia ${sl}`
      : null
  };
}

/**
 * CRIT-CLOSEFAKE-25 — la risposta a un ordine di CHIUSURA ha davvero chiuso?
 *
 * Caso reale (NEAR-PERP, 25/09/2026). `closePosition` → `placeMarketOrder` è un
 * limit IoC: su un book sottile Hyperliquid non lancia nessuna eccezione, RISOLVE
 * con l'ordine rifiutato —
 *
 *   { status: "ok", oid: null, avgPx: null, totalSz: null,
 *     error: "Order could not immediately match against any resting orders" }
 *
 * — e `bot._closeNow`, che guardava solo l'assenza di eccezioni, registrava la
 * chiusura con un PnL preso dall'ultimo unrealized noto e azzerava la posizione
 * in memoria. Quattro chiusure FITTIZIE in circa un minuto, con la posizione
 * intatta sull'exchange.
 *
 * I tre esiti richiedono azioni diverse, quindi vanno distinti qui, una volta
 * sola, invece di essere dedotti caso per caso dal chiamante:
 *
 *  - `rejected`: niente è stato chiuso. `oid` nullo è già CONCLUSIVO (stesso
 *    principio di WARN-06 su `placeTriggerOrder`: il broker ha risposto, e la
 *    risposta è no), così come un `totalSz` esplicitamente 0.
 *  - `partial`: la posizione si è ridotta ma esiste ancora — è il meccanismo dei
 *    trigger a riempimento parziale già misurato lo stesso giorno (2,1 unità
 *    chiuse su 99,9). Va tracciata sulla size RESIDUA, non data per chiusa.
 *  - `closed`: chiusura piena, comportamento storico.
 *
 * Perché `totalSz` ASSENTE vale come chiusura piena e non come rifiuto: è la
 * forma che restituisce `paperBroker.closePosition` ({ oid, avgPx, error })
 * e quella di un ordine `resting` senza fill riportato. In presenza di un `oid`
 * valido l'informazione mancante è la size, non l'esito; il campo `sizeKnown`
 * lo dichiara al chiamante, e `bot._reconcile` riallinea comunque la size vera
 * al tick successivo. È il motivo per cui questa funzione NON è
 * `resolveFillSize`, che invece tratta correttamente `totalSz` assente come
 * "nessun fill": lì la domanda è quanto si è APERTO (e il dubbio va risolto al
 * ribasso), qui è se si è CHIUSO (e il dubbio va risolto sull'oid).
 *
 * @param result       risposta del broker, così com'è (`_parseOrderResult`)
 * @param positionSize size della posizione che si sta tentando di chiudere
 * @returns { outcome: 'rejected'|'partial'|'closed', filled, remaining, sizeKnown, reason }
 */
export function interpretCloseResult(result, positionSize) {
  // Tolleranza relativa sul confronto fra due size già arrotondate a
  // `szDecimals`: senza, un fill pieno restituito come 99.89999999 su 99.9
  // verrebbe classificato parziale e la posizione resterebbe "aperta" su un
  // residuo di polvere che nessun ordine potrebbe più chiudere.
  const REL_EPS = 1e-6;
  const res = result && typeof result === 'object' ? result : null;
  const expectedRaw = Number(positionSize);
  const expected = Number.isFinite(expectedRaw) && expectedRaw > 0 ? expectedRaw : null;

  if (!res) {
    return { outcome: 'rejected', filled: 0, remaining: expected, sizeKnown: false, reason: 'nessuna risposta dal broker' };
  }

  const err = res.error != null && res.error !== '' ? String(res.error) : null;
  const szRaw = Number(res.totalSz);
  const sizeKnown = res.totalSz != null && Number.isFinite(szRaw);
  const filled = sizeKnown && szRaw > 0 ? szRaw : 0;

  // Un errore dichiarato senza alcuna size riempita: rifiuto, con il motivo vero.
  if (err && filled <= 0) {
    return { outcome: 'rejected', filled: 0, remaining: expected, sizeKnown, reason: err };
  }
  if (res.oid == null && filled <= 0) {
    return { outcome: 'rejected', filled: 0, remaining: expected, sizeKnown, reason: 'oid nullo: ordine non accettato dall\'exchange' };
  }
  if (sizeKnown && filled <= 0) {
    return { outcome: 'rejected', filled: 0, remaining: expected, sizeKnown, reason: 'ordine accettato ma nessuna size riempita (totalSz 0)' };
  }

  if (!sizeKnown) {
    return {
      outcome: 'closed', filled: expected, remaining: 0, sizeKnown: false,
      reason: 'size riempita non riportata dal broker, oid valido'
    };
  }
  if (expected == null) {
    return {
      outcome: 'closed', filled, remaining: 0, sizeKnown: true,
      reason: 'size della posizione non nota: impossibile riconoscere un riempimento parziale'
    };
  }

  const residuo = expected - filled;
  if (residuo > expected * REL_EPS) {
    return {
      outcome: 'partial',
      filled,
      // Arrotondato: senza, 99.9 − 2.1 diventa 97.80000000000001 e quel numero
      // finirebbe tale e quale in DB, nella notifica e nella size dei trigger.
      remaining: Math.round(residuo * 1e10) / 1e10,
      sizeKnown: true,
      reason: `riempiti ${filled} su ${expected}`
    };
  }
  return { outcome: 'closed', filled, remaining: 0, sizeKnown: true, reason: null };
}

/**
 * Confronto di coin tollerante al suffisso `-PERP`, come già altrove nel modulo:
 * l'exchange e il DB non sono sempre d'accordo sulla forma del nome.
 */
function sameCoin(a, b) {
  if (a == null || b == null) return false;
  const norm = (c) => String(c).toUpperCase().replace(/-PERP$/, '');
  return norm(a) === norm(b);
}

/**
 * ISSUE #35 — A QUALE BROKER va la richiesta di chiudere (wallet, coin).
 *
 * IL DIFETTO. `POST /api/perps/positions/:coin/close` chiamava SEMPRE
 * `hyperliquid.closePosition`. Dopo PR #33 il pannello "Posizioni attive" mostra
 * anche le righe PAPER (con il loro pulsante "Chiudi"), e nello scenario misto —
 * un bot reale e un bot paper sullo stesso wallet e sulla stessa coin — cliccare
 * "Chiudi" su una riga che l'utente vede come simulata avrebbe chiuso quella
 * VERA. Oggi è innocuo solo perché l'account reale è vuoto e
 * `hyperliquid.closePosition` lancia «Nessuna posizione aperta»: fail-closed per
 * struttura, non per disegno.
 *
 * LA DESTINAZIONE SI DERIVA, NON SI DICHIARA. L'instradamento è deciso da ciò che
 * il server VEDE (posizioni lette dal broker reale e dal paperBroker per quel
 * wallet), mai da un flag `isPaper` nel corpo della richiesta: un client che
 * dichiarasse `isPaper` in modo sbagliato — per errore o di proposito — farebbe
 * partire un ordine sul broker sbagliato, cioè muoverebbe denaro vero al posto di
 * denaro simulato. È la stessa fonte già usata in lettura per esporre `isPaper`
 * (`mergeAccountViews`), così le due viste non possono divergere.
 *
 * `requestedSource` HA UN SOLO POTERE: scegliere fra i candidati che esistono
 * DAVVERO. Non può crearne uno. Se chiede `paper` e una posizione paper non c'è,
 * la risposta è un rifiuto — non un ripiego sul broker reale.
 *
 * AMBIGUITÀ = RIFIUTO. Se su quella coppia esistono ENTRAMBE le posizioni e il
 * chiamante non dice quale, non si indovina: l'issue stessa osserva che
 * l'endpoint «non ha modo di sapere quale delle due l'utente intendeva», e su un
 * percorso che muove denaro l'unica risposta corretta a una domanda ambigua è
 * chiedere di riformularla. Chiudere quella sbagliata non è recuperabile.
 *
 * Funzione PURA: nessun I/O, nessuna dipendenza da singleton. Il guscio che legge
 * i due account sta in `server.js`.
 *
 * @param {object} p
 * @param {string} p.coin coin richiesta (con o senza `-PERP`)
 * @param {Array}  p.paperPositions posizioni lette dal paperBroker per il wallet
 * @param {Array}  p.realPositions  posizioni lette dall'exchange per il wallet
 * @param {string|null} p.requestedSource `'paper'`/`'real'` se il chiamante lo
 *   specifica, altrimenti `null`
 * @returns {{target: 'paper'|'real'|null, candidates: string[], reason: string|null}}
 */
export function resolveCloseTarget({ coin, paperPositions = [], realPositions = [], requestedSource = null } = {}) {
  const has = (list) => (Array.isArray(list) ? list : []).some(p => sameCoin(p?.coin, coin));
  const candidates = [];
  if (has(realPositions)) candidates.push('real');
  if (has(paperPositions)) candidates.push('paper');

  const wanted = requestedSource === 'paper' || requestedSource === 'real' ? requestedSource : null;

  if (wanted) {
    if (candidates.includes(wanted)) return { target: wanted, candidates, reason: null };
    return {
      target: null,
      candidates,
      reason: candidates.length
        ? `nessuna posizione ${wanted === 'paper' ? 'simulata' : 'reale'} aperta su ${coin} (trovata invece: ${candidates.join(', ')})`
        : `nessuna posizione ${wanted === 'paper' ? 'simulata' : 'reale'} aperta su ${coin}`
    };
  }

  if (candidates.length === 1) return { target: candidates[0], candidates, reason: null };
  if (candidates.length === 0) {
    return { target: null, candidates, reason: `nessuna posizione aperta su ${coin}, né reale né simulata` };
  }
  return {
    target: null,
    candidates,
    reason: `su ${coin} esistono sia una posizione REALE sia una SIMULATA: indicare quale chiudere (campo "source": "real" o "paper"). Nessun ordine è stato inviato.`
  };
}

class RiskManager {
  /** Arrotonda la size al numero di decimali consentito dal mercato. */
  roundSize(size, szDecimals = 3) {
    const f = Math.pow(10, szDecimals);
    return Math.floor(size * f) / f;
  }

  /** CRIT-05 — anche come metodo, per i chiamanti che hanno già il singleton. */
  composeEquity(input) { return composeEquity(input); }

  /** Vista reale + paper unificata, anche come metodo (vedi `mergeAccountViews`). */
  mergeAccountViews(input) { return mergeAccountViews(input); }

  /** BUG-SIZECAP-01 — anche come metodi, per i chiamanti che hanno il singleton. */
  resolveMaxPositionUsd(config) { return resolveMaxPositionUsd(config); }
  auditRiskConfig(config) { return auditRiskConfig(config); }

  /** OVERTRADING — anche come metodi, per i chiamanti che hanno il singleton. */
  resolveOvertradingLimits(config) { return resolveOvertradingLimits(config); }
  checkOvertrading(limits, input) { return checkOvertrading(limits, input); }

  /** CRIT-SLSTALE-25 — anche come metodo, per i chiamanti che hanno il singleton. */
  isStopBreached(input) { return isStopBreached(input); }

  /** CRIT-CLOSEFAKE-25 — anche come metodo, per i chiamanti che hanno il singleton. */
  interpretCloseResult(result, positionSize) { return interpretCloseResult(result, positionSize); }

  /** ISSUE #35 — anche come metodo, per i chiamanti che hanno il singleton. */
  resolveCloseTarget(input) { return resolveCloseTarget(input); }

  /**
   * Calcola la size (in unità di coin) da aprire.
   *
   * IMPORTANTE: `equity` deve essere l'ACCOUNT VALUE TOTALE del conto
   * (depositi + PnL non realizzato), MAI il solo margine libero/disponibile —
   * la percentuale di sizing va applicata all'equity complessivo, altrimenti
   * il sizing si riduce progressivamente man mano che il margine viene
   * impegnato da altre posizioni.
   *
   * GUARD DIFENSIVO (SEC-05): un `equity`/`price` non finito o non positivo
   * non è un caso limite normale — è quasi sempre sintomo di un bug a monte
   * (account non ancora caricato, risposta di rete malformata, ecc.). Senza
   * questo controllo un NaN si propagherebbe silenziosamente fino a
   * `roundSize`, e il cap di sicurezza (`notionalUsd > maxPos`) non
   * scatterebbe MAI perché ogni confronto con NaN è falso: l'ordine
   * verrebbe comunque respinto dall'exchange, ma senza nessun segnale
   * chiaro nei log fino a quel punto. Meglio fallire rumorosamente qui.
   *
   * SIZING DINAMICO (ATR-based), opt-in per bot con `config.risk.useDynamicSizing`.
   * Risponde a una domanda diversa da quella statica: non «quanta parte
   * dell'equity impegno» ma «quanto perdo se il prezzo si muove contro di me
   * quanto si muove normalmente». Il rischio in USD (`equity ×
   * riskPerTradePct%`) diviso per la distanza di stop (`atr × atrMultiplier`)
   * dà direttamente le unità di coin — quindi in regime volatile la posizione
   * si riduce da sola, a parità di rischio accettato.
   *
   * Due proprietà volute, che il ramo statico non ha: la leva NON entra nella
   * size (incide solo sul margine impegnato), e il cap `maxPositionUsd` resta
   * sovrano identico per entrambi i rami — è l'ultimo controllo, non uno dei due.
   *
   * L'ATR arriva dal chiamante (`bot.js`) e non viene calcolato qui: questa
   * funzione resta pura e condivisa col backtester. Se non è disponibile —
   * caso ATTESO, il warmup delle candele — si degrada al sizing statico con un
   * `logger.warn`: mai un'eccezione, ma nemmeno un silenzio, perché la
   * posizione finirebbe dimensionata con una regola diversa da quella
   * configurata senza che nulla lo dica.
   *
   * @param opts.atr ATR corrente sul periodo risolto dal chiamante (opzionale)
   * @returns { size, notionalUsd, marginUsd }
   */
  sizePosition(config, equity, price, szDecimals = 3, { atr } = {}) {
    if (!Number.isFinite(equity) || equity <= 0) {
      throw new Error(`sizePosition: equity non valido (${equity}) — deve essere l'account value totale (depositi + PnL non realizzato), non il margine libero`);
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`sizePosition: price non valido (${price})`);
    }
    const leverage = Math.max(1, config.leverage || HYPERLIQUID_CONFIG.risk.defaultLeverage);
    const sizing = config.sizing || { mode: 'percent', value: 10 };

    let notionalUsd = null;
    if (config.risk?.useDynamicSizing === true) {
      const riskPct = config.risk.riskPerTradePct ?? DYNAMIC_SIZING_DEFAULTS.riskPerTradePct;
      const atrMult = config.risk.atrMultiplier ?? DYNAMIC_SIZING_DEFAULTS.atrMultiplier;
      const atrVal = Number(atr);
      const motivo = !Number.isFinite(atrVal) || atrVal <= 0
        ? `ATR non disponibile (${atr}) — probabile warmup candele insufficiente`
        : (!Number.isFinite(riskPct) || riskPct <= 0
          ? `riskPerTradePct non valido (${config.risk.riskPerTradePct})`
          : (!Number.isFinite(atrMult) || atrMult <= 0
            ? `atrMultiplier non valido (${config.risk.atrMultiplier})`
            : null));

      if (motivo) {
        logger.warn(`sizePosition: dynamic sizing richiesto ma non applicabile — ${motivo}. Fallback al sizing statico (${sizing.mode} ${sizing.value}).`);
      } else {
        // Rischio in USD accettato su questo trade / distanza di stop = coin.
        notionalUsd = (equity * (riskPct / 100) / (atrVal * atrMult)) * price;
      }
    }

    if (notionalUsd === null) {
      // BUG-SIZECAP-01 — un blocco `sizing` senza `value` utilizzabile dava
      // `equity × (undefined/100)` = NaN, e un NaN attraversa OGNI guardia a
      // valle (ogni confronto con NaN è falso: `size <= 0`, `notional > cap`,
      // Budget Ceiling) fino ad arrivare a `placeMarketOrder`. È il caso reale
      // dei bot con `sizing: { maxPositionUsd: … }` scritto da un agente.
      // Fail-closed e rumoroso: size 0, motivo nel piano e nei log.
      const valore = Number(sizing.value);
      if (!Number.isFinite(valore) || valore <= 0) {
        const blocked = `sizing non utilizzabile (mode=${JSON.stringify(sizing.mode)}, value=${JSON.stringify(sizing.value)}): impossibile calcolare una size, nessuna apertura`;
        logger.error(`sizePosition: ${blocked}`);
        return { size: 0, notionalUsd: 0, marginUsd: 0, maxPositionUsd: null, blocked };
      }
      const marginUsd = sizing.mode === 'fixed'
        ? valore                    // margine fisso in USD
        : equity * (valore / 100);  // % dell'equity
      notionalUsd = marginUsd * leverage;
    }

    // Cap di sicurezza. Il tetto si risolve da ENTRAMBI i percorsi legittimi
    // (radice e `risk`), prendendo il più restrittivo: vedi resolveMaxPositionUsd.
    const { maxPositionUsd: maxPos, ignored } = resolveMaxPositionUsd(config);
    for (const riga of ignored) logger.warn(`sizePosition: ${riga}`);
    if (notionalUsd > maxPos) notionalUsd = maxPos;

    const size = this.roundSize(notionalUsd / price, szDecimals);
    // `maxPositionUsd` è additivo nel ritorno: serve al chiamante I/O per dire
    // NEL messaggio quale tetto ha agito, senza ricalcolarlo per conto suo.
    return { size, notionalUsd: size * price, marginUsd: (size * price) / leverage, maxPositionUsd: maxPos };
  }

  /**
   * CRIT-01 — interpreta QUANTA size un ordine market ha davvero riempito.
   *
   * Su Hyperliquid un "market" è un limit IoC: può riempirsi del tutto, in parte,
   * o per niente. `_parseOrderResult` espone già `totalSz` (la size eseguita) ma
   * nessuno la leggeva: il bot registrava sempre la size PIANIFICATA. I tre esiti
   * richiedono trattamenti diversi, non una sfumatura dello stesso caso:
   *
   *  - `none` (totalSz null/0/non numerico): nessuna posizione esiste
   *    sull'exchange. Il capitale non è mai stato impegnato: non c'è niente da
   *    correggere più tardi, c'è solo da NON scrivere nulla.
   *  - `partial`: la posizione esiste, più piccola del previsto. Ogni numero a
   *    valle (riga DB, TP/SL, DCA, statistiche) deve usare `filled`.
   *  - `full`: comportamento storico, invariato.
   *
   * Vive qui e non in `bot.js` per la stessa ragione di `applyDcaFill`: è
   * aritmetica sul denaro, va verificabile in isolamento e condivisa con
   * chiunque altro legga un fill (percorso di apertura e percorso DCA).
   *
   * La tolleranza serve al confronto tra due numeri già arrotondati a
   * `szDecimals`: senza, un fill pieno restituito come 0.9999999999 verrebbe
   * classificato parziale e notificato come anomalia a ogni apertura.
   *
   * @param plannedSize size richiesta all'exchange
   * @param totalSz     `order.totalSz` come arriva dal broker (può essere null)
   * @returns { filled, planned, ratio, none, partial, full }
   */
  resolveFillSize(plannedSize, totalSz) {
    const EPS = 1e-9;
    const planned = Number.isFinite(Number(plannedSize)) ? Number(plannedSize) : 0;
    const raw = Number(totalSz);
    const filled = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const none = filled <= 0;
    const partial = !none && planned > 0 && filled + Math.max(EPS, planned * EPS) < planned;
    return {
      filled,
      planned,
      ratio: planned > 0 ? filled / planned : 0,
      none,
      partial,
      full: !none && !partial
    };
  }

  /**
   * WARN-03 — slippage REALE di un'esecuzione: quanto il prezzo medio ottenuto si
   * discosta dal prezzo di riferimento su cui la decisione è stata presa.
   *
   * Entrambi i valori erano già nello stesso scope di `bot._openPosition`
   * (`order.avgPx` e `snapshot.price`) e la differenza non veniva mai calcolata.
   * Ritorna una FRAZIONE (0.001 = 0.1%), non una percentuale, coerentemente con
   * il resto dei rapporti del modulo; `null` quando uno dei due prezzi non è
   * utilizzabile — nessun valore inventato per un dato che non c'è (una posizione
   * adottata da `_reconcile` non ha alcun ordine di riferimento).
   */
  computeSlippage(avgPx, referencePx) {
    const avg = Number(avgPx);
    const ref = Number(referencePx);
    if (!Number.isFinite(avg) || !Number.isFinite(ref) || avg <= 0 || ref <= 0) return null;
    return Math.abs(avg - ref) / ref;
  }

  /**
   * Calcola i prezzi di TP e SL per una posizione.
   * @param side 'long' | 'short'
   * @returns { tpPx, slPx }
   */
  computeTpSl(entryPx, side, config, ctx = {}) {
    const out = { tpPx: null, slPx: null };
    const isLong = side === 'long';
    const atr = ctx.atr; // ATR corrente, per gli stop adattivi alla volatilità

    const tp = config.tp;
    if (tp?.enabled) {
      if (tp.mode === 'absolute') out.tpPx = tp.value;
      else if (tp.mode === 'atr') out.tpPx = atr ? (isLong ? entryPx + tp.value * atr : entryPx - tp.value * atr) : null;
      else out.tpPx = isLong ? entryPx * (1 + tp.value / 100) : entryPx * (1 - tp.value / 100);
    }

    const sl = config.sl;
    if (sl?.enabled) {
      if (sl.mode === 'absolute') out.slPx = sl.value;
      else if (sl.mode === 'atr') out.slPx = atr ? (isLong ? entryPx - sl.value * atr : entryPx + sl.value * atr) : null;
      else out.slPx = isLong ? entryPx * (1 - sl.value / 100) : entryPx * (1 + sl.value / 100);
    }

    return out;
  }

  /**
   * SEC-01: aggiorna una posizione dopo un fill di aggiunta DCA (mediazione).
   * Calcola il nuovo prezzo medio ponderato ed i nuovi TP/SL su quel prezzo,
   * con la STESSA configurazione (percent/atr/absolute) usata all'apertura —
   * mai valori "a occhio", altrimenti TP/SL post-DCA sarebbero incoerenti
   * con la strategia configurata.
   *
   * Funzione pura (nessuna I/O): il chiamante (bot.js) si occupa di
   * piazzare/cancellare i trigger e persistere lo stato; qui viene solo
   * calcolato COSA piazzare. Separare il calcolo dall'orchestrazione I/O la
   * rende testabile in isolamento, senza dover far girare un PerpsBot intero.
   *
   * @param position { side, entryPx, size } — posizione PRIMA di questo fill
   * @param fillPx prezzo medio a cui è stato eseguito il fill di aggiunta
   * @param addSize size aggiunta con questo fill (unità di coin)
   * @returns { entryPx, size, tpPx, slPx }
   */
  applyDcaFill(position, fillPx, addSize, config, ctx = {}) {
    const size = position.size + addSize;
    // Media ponderata: nuovoEntry = (vecchioEntry×vecchiaSize + fillPx×addSize) / sizeTotale
    const entryPx = (position.entryPx * position.size + fillPx * addSize) / size;
    const { tpPx, slPx } = this.computeTpSl(entryPx, position.side, config, ctx);
    return { entryPx, size, tpPx, slPx };
  }

  /**
   * Calcola una scala di take profit parziali.
   * @param ladder lista di { portion (0..1), atPercent }
   * @returns [{ portion, px }]
   */
  computeTpLadder(entryPx, side, ladder) {
    const isLong = side === 'long';
    return (ladder || [])
      .filter(s => s && s.portion > 0 && s.atPercent > 0)
      .map(s => ({
        portion: s.portion,
        px: isLong ? entryPx * (1 + s.atPercent / 100) : entryPx * (1 - s.atPercent / 100)
      }));
  }

  /**
   * Nuovo stop trailing se il prezzo si è mosso a favore. Ritorna null se invariato.
   * @param position { side, slPx }
   */
  computeTrailing(position, currentPx, config, ctx = {}) {
    const tr = config.trailing;
    if (!tr?.enabled) return null;
    let dist;
    if (tr.mode === 'absolute') dist = tr.value;
    else if (tr.mode === 'atr') { if (!ctx.atr) return null; dist = tr.value * ctx.atr; }
    else dist = currentPx * (tr.value / 100);
    const isLong = position.side === 'long';
    const candidate = isLong ? currentPx - dist : currentPx + dist;

    if (position.slPx == null) return candidate;
    if (isLong && candidate > position.slPx) return candidate;
    if (!isLong && candidate < position.slPx) return candidate;
    return null;
  }

  /**
   * Controlla i limiti di rischio prima di aprire. Ritorna { ok, reason }.
   * @param account { accountValue }
   * @param plan    { notionalUsd, leverage }
   * @param dailyPnl perdita/profitto realizzato oggi (USD)
   */
  checkLimits(config, account, plan, dailyPnl = 0) {
    const maxLev = config.risk?.maxLeverage ?? HYPERLIQUID_CONFIG.risk.maxLeverage;
    if ((plan.leverage || 0) > maxLev) {
      return { ok: false, reason: `Leva ${plan.leverage}x oltre il massimo (${maxLev}x)` };
    }
    const equity = account.equity ?? account.accountValue;
    if (equity <= 0) {
      return { ok: false, reason: 'Equity nullo o insufficiente' };
    }
    // BUG-SIZECAP-01 — stesso tetto di `sizePosition`, risolto dalla stessa
    // funzione: due letture diverse significherebbero che il controllo approva
    // ciò che il calcolo non avrebbe dovuto produrre (ed è esattamente quello
    // che succedeva con il tetto scritto alla radice).
    const { maxPositionUsd: maxPos } = resolveMaxPositionUsd(config);
    if (plan.notionalUsd > maxPos * 1.001) {
      return { ok: false, reason: `Notional ${plan.notionalUsd.toFixed(0)}$ oltre il massimo (${maxPos}$)` };
    }
    const maxDailyLoss = config.risk?.maxDailyLossUsd ?? HYPERLIQUID_CONFIG.risk.maxDailyLossUsd;
    if (dailyPnl <= -Math.abs(maxDailyLoss)) {
      return { ok: false, reason: `Limite di perdita giornaliera raggiunto (${maxDailyLoss}$)` };
    }
    return { ok: true, reason: 'OK' };
  }
}

export default new RiskManager();
