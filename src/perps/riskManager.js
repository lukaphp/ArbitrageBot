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
