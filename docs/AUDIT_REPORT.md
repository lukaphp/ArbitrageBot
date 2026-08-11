# 🔍 Audit Critico — ArbitrageBot (Perps System)

**Ruolo:** Lead Software Architect · Revisione Indipendente  
**Data:** 10 agosto 2026  
**Sprint di riferimento:** Sprint 4 completato (28/28 SP approvati)  
**Scope:** Analisi completa di tutti i moduli del sottosistema Perps Hyperliquid  
**Ambiente target:** Testnet (deployment attuale) → Mainnet (prossima fase)

---

## Indice

1. [Executive Summary](#1-executive-summary)
2. [Metodologia](#2-metodologia)
3. [Architettura Analizzata](#3-architettura-analizzata)
4. [CRITICI — Blocanti per il Mainnet](#4-critici--blocanti-per-il-mainnet)
5. [IMPORTANTI — Da risolvere prima del Mainnet](#5-importanti--da-risolvere-prima-del-mainnet)
6. [MINORI — Quality Improvements](#6-minori--quality-improvements)
7. [Punti di Forza da Preservare](#7-punti-di-forza-da-preservare)
8. [Piano di Priorità per il Mainnet](#8-piano-di-priorità-per-il-mainnet)
9. [Mappa Completa dei File Analizzati](#9-mappa-completa-dei-file-analizzati)

---

## 1. Executive Summary

Il sistema è **architetturalmente solido per un ambiente testnet con capitale virtuale**. I pattern fondamentali sono corretti e riflettono scelte di design mature: serializzazione per wallet tramite `execQueue`, cifratura a riposo AES-256-GCM con key-rotation, validazione fail-fast all'avvio in produzione, watchdog multi-livello, riconciliazione periodica dallo stato reale dell'exchange.

Tuttavia esistono **4 vulnerabilità critiche e 5 finding importanti** che devono essere indirizzati prima di qualsiasi operazione con denaro reale su mainnet. Nessuno di essi è un difetto di design fondamentale: sono lacune di implementazione risolvibili con interventi chirurgici e mirati.

**Il rischio attuale su testnet è basso** — i meccanismi di safety sono presenti e funzionanti. Il rischio su mainnet con i finding correnti sarebbe **medio-alto**, principalmente a causa di CRIT-01 (fill parziali) e CRIT-02 (cooldown volatile).

### Rating per Area

| Area | Rating | Motivazione |
|:---|:---:|:---|
| Architettura generale | **B+** | Modulare, event-driven, chiara separazione delle responsabilità |
| Gestione errori / resilienza | **B** | Buona copertura, ma gap critici su fill parziali e SL assente |
| Risk management | **B** | Logica corretta; cooldown portfolio non persistito ai riavvii |
| Sicurezza credenziali | **A-** | `secretBox` eccellente; un edge case in staging identificato |
| Concorrenza / ordering | **B+** | `execQueue` serializza correttamente; una race window residua |
| Logging & Observability | **B-** | Struttura buona; `console.log` debug mai rimosso |
| Testing & Verificabilità | **B** | Backtest event-driven maturo; paper broker coerente |

---

## 2. Metodologia

### File analizzati (20 moduli)

Tutti i file del sottosistema `src/perps/` sono stati letti integralmente, inclusi:
- Entry point (`src/index.js`)
- Core logic completa (`src/perps/bot.js`, ~1.148 righe)
- Tutti i moduli di supporto (broker, market data, strategy engine, risk, indicators, execQueue, portfolio, paper broker, agent wallet, secret box, notifier, metrics, risk snapshot)
- Configurazione e validazione (`src/config/config.js`)
- Persistenza (`src/db/database.js`)
- Middleware di autenticazione (`src/middleware/auth.js`)
- Logger (`src/utils/logger.js`)
- Backlog Sprint 4 (`docs/KB/BACKLOG/release1/sprint4.md`)

### Approccio

L'audit ha seguito un approccio **threat-model-driven**: per ogni componente è stata verificata la correttezza in scenari di errore (connessione persa a metà, fill parziale, crash del processo, doppio avvio), non solo nel caso nominale.

---

## 3. Architettura Analizzata

### Flusso del Tick (ogni 10 secondi per bot)

```
setInterval → tick()
  └── [guard: busy?] → _runTick()
        ├── marketData.getSnapshot()     ← prezzi, candele, funding
        ├── broker.getAccount()          ← stato reale dall'exchange
        ├── _reconcile(livePos)          ← FONTE DI VERITÀ: exchange
        │     ├── [no live, local] → _registerClose()
        │     ├── [live + local]   → sync size/unrealizedPnl
        │     └── [live, no local] → adotta posizione, piazza TP/SL
        ├── strategyEngine.evaluate()    ← segnale: open_long|open_short|close|hold
        ├── [in posizione] → _manageOpen()
        │     ├── _ensureStopLoss()      ← verifica/rimpiazza SL ogni tick
        │     ├── _ensureTakeProfits()   ← verifica/rimpiazza TP ogni tick
        │     ├── _checkTrailing()       ← trailing stop adattivo
        │     └── _checkDca()            ← DCA se configurato
        ├── [close] → _closePosition()
        └── [open_long|open_short] → _openPosition()
              ├── riskManager.sizePosition()
              ├── portfolio.canOpen()      ← limiti globali
              ├── broker.setLeverage()
              ├── broker.placeMarketOrder()
              └── _placeTpSl() → _ensureStopLoss()
```

### Serializzazione e Concorrenza

```
Bot A (ETH) ─┐
Bot B (BTC) ─┤──► execQueue.run(masterAddress, fn) ──► exchange
Bot C (ETH) ─┘    [serializzato per wallet, non per coin]
```

Tutte le azioni firmate verso Hyperliquid vengono accodate per `masterAddress`. Questo garantisce che il nonce sia sempre crescente e che non ci siano due ordini firmati in parallelo per lo stesso wallet.

### Strati di Protezione del Capitale

```
L1: riskManager.checkLimits()      ← leva max, size max, daily loss
L2: portfolio.canOpen()            ← posizioni concorrenti, esposizione totale, cooldown
L3: _ensureStopLoss()              ← ogni tick: SL presente? altrimenti chiude
L4: _reconcile()                   ← exchange è la fonte di verità (10s lag massimo)
L5: botManager.watchdog            ← bot fermo? alert Telegram
L6: telegramControl /killswitch    ← override manuale umano
```

---

## 4. CRITICI — Blocanti per il Mainnet

### [CRIT-01] Fill Parziali Non Gestiti

**Severità:** 🔴 Critico  
**File:** `src/perps/bot.js` — `_openPosition()` (linee 380–411)

#### Descrizione

Il bot invia ordini market e usa la **size pianificata** (`plan.size`) come size della posizione, indipendentemente da quanta ne sia stata effettivamente riempita dall'exchange.

```javascript
// bot.js — codice attuale (linee 381–411, semplificato)
const order = await this.broker.placeMarketOrder({
  size: plan.size,   // ← size pianificata
  ...
}, this.network);

// BUG: usa plan.size, non order.totalSz (la size effettivamente riempita)
this.position = {
  size: plan.size,   // ← se il fill è parziale, questo è sbagliato
  ...
};
```

#### Scenario di Rischio Concreto

Hyperliquid può produrre fill parziali in condizioni di liquidità insufficiente nel book, slippage estremo, o errori di arrotondamento sulla size minima:

```
1. Bot ordina:    size = 1.5 ETH  (plan.size)
2. Exchange fill: size = 0.8 ETH  (order.totalSz)
3. Bot registra:  position.size = 1.5 ETH  ← SBAGLIATO
4. SL piazzato:   per 1.5 ETH  ← dimensionato male rispetto alla posizione reale
5. _reconcile():  corregge dopo 10 secondi
```

Durante i 10 secondi di finestra, il bot ha uno stop-loss dimensionato per 1.5 ETH su una posizione reale di 0.8 ETH. Se il SL scatta in quel lasso di tempo, `_registerClose()` tenterà di chiudere 1.5 ETH ma trova solo 0.8 ETH.

#### Fix Proposto

```javascript
// In _openPosition(), dopo il fill:
const order = await this.broker.placeMarketOrder({ size: plan.size, ... }, this.network);

if (order.error) { /* gestione esistente */ }

// AGGIUNTA: verifica che il fill corrisponda al pianificato
const actualSize = order.totalSz || plan.size;
const fillRatio = actualSize / plan.size;
if (fillRatio < 0.99) {
  logger.warn(`Bot ${this.name}: fill parziale su ${this.coin}`, {
    planned: plan.size, filled: actualSize, ratio: fillRatio.toFixed(3)
  });
  notifier.notify(`⚠️ <b>${this.name}</b>: fill parziale su ${this.coin} — pianificato ${plan.size}, riempito ${actualSize}.`);
}

// Usa actualSize (il fill reale) per tutto ciò che segue
this.position = {
  size: actualSize,   // ← corretto: fill reale, non pianificato
  entryPx,
  ...
};
```

---

### [CRIT-02] Cooldown Portfolio Non Persiste ai Riavvii

**Severità:** 🔴 Critico  
**File:** `src/perps/portfolio.js` — linea 26

#### Codice Attuale

```javascript
class Portfolio {
  constructor() {
    this.cooldowns = new Map(); // botId -> timestamp di fine cooldown
    // ⚠️ VOLATILE: un crash/riavvio azzera tutti i cooldown attivi
  }
```

#### Scenario di Rischio

```
1. Bot perde 3 volte consecutive (soglia maxConsecutiveLosses)
2. Cooldown attivato: "pausa 60 minuti"
3. Il mercato continua ad andare nella direzione sbagliata
4. Server crasha (OOM killer, deploy, errore Node.js)
5. Bot riavvia → cooldowns = new Map() → cooldown scomparso
6. Bot riprende a tradare immediatamente
7. Quarta, quinta, sesta perdita consecutiva senza protezione
```

#### Fix Proposto

```javascript
// portfolio.js — persistenza del cooldown in SQLite

class Portfolio {
  constructor() {
    this.cooldowns = new Map();      // cache in-memory (performance)
    this._loadPersistedCooldowns();  // ripristino da DB all'avvio
  }

  _loadPersistedCooldowns() {
    try {
      const raw = db.getSetting('portfolio_cooldowns');
      if (!raw) return;
      const stored = JSON.parse(raw);
      const now = Date.now();
      for (const [botId, until] of Object.entries(stored)) {
        if (until > now) this.cooldowns.set(botId, until); // ignora quelli scaduti
      }
      if (this.cooldowns.size) {
        logger.info(`Portfolio: ripristinati ${this.cooldowns.size} cooldown dal DB`);
      }
    } catch { /* noop — se il DB fallisce, si parte senza cooldown */ }
  }

  _persistCooldowns() {
    try {
      const obj = Object.fromEntries(this.cooldowns);
      db.setSetting('portfolio_cooldowns', JSON.stringify(obj));
    } catch { /* noop — l'in-memory resta la fonte operativa */ }
  }

  canOpen({ account, plannedNotional = 0, botId, consecutiveLosses = 0 }) {
    const L = this.getLimits();
    // ...
    if (consecutiveLosses >= L.maxConsecutiveLosses) {
      this.cooldowns.set(botId, Date.now() + L.cooldownMinutes * 60000);
      this._persistCooldowns(); // ← AGGIUNTA: persisti subito
      return { ok: false, reason: `${consecutiveLosses} perdite consecutive → cooldown ${L.cooldownMinutes} min` };
    }
    // ...
  }
}
```

---

### [CRIT-03] Race Window su Multi-Bot Stesso Coin

**Severità:** 🔴 Critico (scenario multi-bot)  
**File:** `src/perps/bot.js` — `_openPosition()` (linee 370–403)

#### Descrizione

Con due bot configurati sullo stesso `(masterAddress, coin)`, la protezione `insertPositionIfNoneOpen` cattura il doppione in DB, ma non impedisce che entrambi i bot abbiano già **inviato l'ordine all'exchange**. Il check sul DB avviene dopo che gli ordini sono già stati piazzati.

```
Tempo T+0ms: Bot A legge DB → nessuna posizione → canOpen = true
Tempo T+1ms:                   Bot B legge DB → nessuna posizione → canOpen = true
Tempo T+100ms: Bot A entra in execQueue → piazza ordine → scrive DB
Tempo T+200ms:                 Bot B entra in execQueue → piazza ordine (exchange eseguito!)
                                              → insertPositionIfNoneOpen: rileva doppione in DB
                                              → logga warning, riusa riga
                                              → ma il secondo ordine è già sul mercato
```

#### Mitigazioni Parziali Esistenti

- `portfolio.canOpen()` conta le posizioni sull'account HL reale — se Bot A ha già aperto, Bot B trova la posizione nella lista. **Ma questo arriva dal broker**, non prima dell'invio dell'ordine.
- `insertPositionIfNoneOpen` evita righe duplicate in DB.

#### Fix Proposto

```javascript
// execQueue.js — aggiungere lock per apertura per (masterAddress, coin)

class ExecQueue {
  constructor() {
    this.chains = new Map();
    this._lastNonce = null;
    this._openLocks = new Set(); // 'masterAddress:coin'
  }

  tryLockOpen(masterAddress, coin) {
    const key = `${masterAddress.toLowerCase()}:${coin}`;
    if (this._openLocks.has(key)) return false;
    this._openLocks.add(key);
    return true;
  }

  unlockOpen(masterAddress, coin) {
    this._openLocks.delete(`${masterAddress.toLowerCase()}:${coin}`);
  }
}

// In bot.js _openPosition():
if (!execQueue.tryLockOpen(this.masterAddress, this.coin)) {
  logger.warn(`Bot ${this.name}: apertura bloccata — apertura già in corso su ${this.coin}`);
  return;
}
this._opening = true;
try {
  // ... logica esistente invariata ...
} finally {
  this._opening = false;
  execQueue.unlockOpen(this.masterAddress, this.coin);
}
```

---

### [CRIT-04] Stop Loss Assente: Notifica Non Urgente

**Severità:** 🔴 Critico  
**File:** `src/perps/bot.js` — `_ensureStopLoss()` (linee 607–661)

#### Descrizione

La logica di recovery dello SL è eccellente nella struttura, ma c'è un percorso in cui il piazzamento fallisce senza eccezione (es. Hyperliquid risponde `{oid: null, error: 'price too close to mark'}`) e il bot aspetta il tick successivo (10s) prima di reagire.

```javascript
// _ensureStopLoss() linee 638–652 (semplificato)
const res = await this.broker.placeTriggerOrder({
  triggerPx: this.position.slPx, tpsl: 'sl', ...
}, this.network);
this.position.slOid = res.oid;  // ← res.oid può essere null senza eccezione!

// Questo controllo c'è, ma richiede un'altra chiamata API:
const stop = await this._findStopOrder();
if (!stop && !res.oid) {
  await this._closeNow('SL non garantito');
}
// Se _findStopOrder() ha anche lui un timeout, si perde ulteriore tempo
```

#### Fix Proposto

```javascript
// Aggiungere check immediato su res.oid senza attendere la verifica:
const res = await this.broker.placeTriggerOrder({ ... }, this.network);

if (!res.oid) {
  // Piazzamento fallito immediatamente — azione urgente PRIMA di verificare
  logger.error(`Bot ${this.name}: SL non piazzato su ${this.coin} (oid null)`, res.error);
  notifier.notify(`🚨 <b>${this.name}</b>: STOP LOSS non piazzabile su ${this.coin} (${res.error || 'oid null'}) — chiudo per sicurezza.`);
  await this._closeNow('SL non piazzabile (oid null)');
  return;
}

// Solo se il piazzamento ha restituito un oid, procede con la verifica esistente
this.position.slOid = res.oid;
const stop = await this._findStopOrder();
if (!stop) {
  logger.error(`Bot ${this.name}: SL piazzato (oid ${res.oid}) non trovato in book`);
  await this._closeNow('SL non verificato in book');
}
```

---

## 5. IMPORTANTI — Da risolvere prima del Mainnet

### [WARN-01] `console.log` di Debug Hardcoded nel Logger

**Severità:** 🟠 Importante  
**File:** `src/utils/logger.js` — linea 29

```javascript
// Debug temporaneo per verificare il livello di log  ← mai rimosso
console.log(`🔧 Logger initialized - Level: ${LOGGING_CONFIG.level}, CurrentLevel: ${this.currentLevel}...`);
```

Ogni avvio del server stampa su stdout configurazione interna. Inquina il parsing automatico dei log strutturati (il resto del logger scrive JSON strutturato, questa riga no). **Fix:** rimuovere la riga 29. Intervento 30 secondi.

---

### [WARN-02] ExecQueue Senza Limite di Dimensione

**Severità:** 🟠 Importante  
**File:** `src/perps/execQueue.js`

La coda è una chain di Promise senza bounds. Con 5 bot sullo stesso master in attività simultanea, ordini di chiusura urgenti (SL) devono aspettare in coda dietro aperture di nuove posizioni. Nessuna prioritizzazione.

**Fix:** aggiungere un counter per queue depth e un warning quando supera una soglia (es. 10). In una seconda fase, aggiungere priorità per ordini di chiusura.

---

### [WARN-03] Slippage Reale Non Monitorato Post-Fill

**Severità:** 🟠 Importante  
**File:** `src/perps/bot.js` — linea 391

```javascript
const entryPx = order.avgPx || snapshot.price;
// ← differenza tra avgPx e snapshot.price = slippage reale, mai calcolata
```

Su mainnet in momenti di alta volatilità, lo slippage reale può essere multiplo di quello pianificato. Senza monitoraggio, l'operatore non ha visibilità sul costo reale delle aperture in termini di slippage.

**Fix:** calcolare `realSlippage = |avgPx - midAtOrder| / midAtOrder`, loggarlo, e includerlo nel record del trade per le analytics (ANA-01 futuro).

---

### [WARN-04] `DEV_FALLBACK` Noto nel Sorgente Pubblico

**Severità:** 🟠 Importante (rischio staging, non produzione)  
**File:** `src/perps/secretBox.js` — linea 55

```javascript
const DEV_FALLBACK = 'arbitragebot-perps-dev-key';
```

La protezione fail-fast in `NODE_ENV=production` è corretta. Il rischio è un ambiente staging con dati reali (agent wallet approvati, token Telegram reali) avviato senza `NODE_ENV=production`: il DEV_FALLBACK è attivo silenziosamente, e la chiave è nota a chiunque acceda al repository.

**Fix:** aggiungere un `console.warn` esplicito e ben visibile quando il DEV_FALLBACK è attivo, non solo un silenzio. Il warning non blocca, ma rende impossibile non accorgersi della condizione.

---

### [WARN-05] Reconnect WebSocket Senza Circuit Breaker

**Severità:** 🟠 Importante  
**File:** `src/perps/hyperliquidClient.js` + `src/perps/marketData.js`

Il watchdog WS rileva connessioni silenti e forza la riconnessione con backoff. Non esiste un circuit breaker che fermi i tentativi dopo N fallimenti e passi in stato `degraded` esplicito. In caso di manutenzione dell'exchange, il bot genera log di retry senza fine e l'operatore riceve alert ripetuti invece di un singolo "entrato in stato degraded".

**Fix:** implementare un circuit breaker con tre stati (`closed/open/half-open`) e un singolo alert all'apertura del circuito.

---

## 6. MINORI — Quality Improvements

### [MINOR-01] `_consumeExternal()` Ha Side Effect nel Contesto di Valutazione

**File:** `src/perps/strategyEngine.js` — linea 118

`_consumeExternal(coin)` rimuove il segnale esterno (side effect) quando viene chiamata nella costruzione del contesto di `evaluate()`. Se `evaluate()` viene invocata due volte sullo stesso snapshot (loop + diagnostica), la seconda non trova il segnale. Separare in `_checkExternal()` (puro) + `_consumeExternal()` (con side effect, chiamato solo nel loop).

### [MINOR-02] `portfolio.canOpen()` Attiva il Cooldown Come Side Effect

**File:** `src/perps/portfolio.js` — linee 72–74

Una funzione nominata `canOpen` non dovrebbe modificare lo stato interno. Separarla in `canOpen()` (puro, solo verifica) + `recordLoss(botId)` (esplicito, chiamato quando la perdita è confermata).

### [MINOR-03] PaperBroker: Stato Non Persistito ai Riavvii

**File:** `src/perps/paperBroker.js` — linea 29

Lo stato del forward-test (posizioni simulate, equity, fills) è volatile. Un riavvio azzera il test in corso. Serializzare `state` in SQLite per continuità del forward-test su più sessioni.

### [MINOR-04] Nessun Avviso se le Candele Sono Insufficienti per il Warmup

**File:** `src/perps/bot.js` + `src/perps/indicators.js`

Un bot appena avviato con meno candele del periodo di warmup dell'indicatore (es. RSI(14) richiede 15 candele) restituisce sempre `hold` silenziosamente. Aggiungere in `getMonitor()` un campo `warmingUp: { candlesHave, candlesNeed }` per rendere la condizione visibile all'operatore.

### [MINOR-05] Notifiche Telegram Senza Retry

**File:** `src/perps/notifier.js` — linee 57–64

Le notifiche critiche vengono inviate una volta sola. Un rate limit 429 di Telegram causa la perdita silente della notifica. Aggiungere 1–2 retry con backoff breve per notifiche urgenti.

---

## 7. Punti di Forza da Preservare

### ✅ Cifratura a Riposo AES-256-GCM con Key Rotation (`secretBox.js`)

Implementazione di qualità professionale: IV casuale per ogni cifratura, autenticazione GCM (tampering detection), versioning con prefisso `v<id>:`, fail-fast in produzione, script di rotazione già presente. **Non modificare senza review di sicurezza dedicata.**

### ✅ `execQueue`: Chain di Promise Senza Deadlock

Il pattern `prev.then(fn, fn)` — la seconda `fn` nel `.then()` — garantisce che la coda avanzi sempre anche in caso di eccezioni. Il nonce monotono persistito in SQLite è immune a clock skew e riavvii. Pattern non ovvio e corretto.

### ✅ Riconciliazione Dall'Exchange Come Fonte di Verità (`_reconcile()`)

Il bot non si fida del proprio stato interno ma lo verifica ad ogni tick contro l'exchange. Copre: posizioni aperte a mano, chiusure per liquidazione, fill parziali (con 10s di lag), stato perso dopo un crash. Pattern istituzionale corretto.

### ✅ Watchdog Multi-Livello

Tre livelli indipendenti: watchdog WebSocket (connessioni silenti), watchdog tick (bot running ma fermo), derivazione centralizzata degli alert di rischio con soglie condivise tra UI e advisor AI.

### ✅ `botManager.updateBot()` con `whenIdle()`

Attende il completamento del tick in volo prima di sostituire l'istanza (DEBT-01). Elimina la finestra in cui due istanze dello stesso bot erano contemporaneamente attive sullo stesso mercato.

### ✅ Validazione Fail-Fast + Guard Mainnet

`validateConfig()` chiama `process.exit(1)` se i segreti critici mancano in produzione. `isMainnetAllowed()` richiede `ALLOW_MAINNET=true` come conferma esplicita separata — una variabile non impostata per sbaglio non porta il bot sul mainnet.

### ✅ Paper Broker con Stessa Interfaccia del Client Reale

```javascript
this.broker = this.paper ? paperBroker : client;
// Zero duplicazione: bot.js non sa mai se sta parlando con HL reale o con il simulatore
```

Slippage e fee modellate realisticamente. Il forward-test è un test di integrazione puro della logica di trading. Design pattern eccellente.

### ✅ `_ensureStopLoss()` con Pulizia SL Orfani (SEC-08)

Logica di auto-healing robusta: conta tutti gli SL attivi sull'exchange, tiene quello tracciato, cancella gli extra, e se manca tutto chiude la posizione per sicurezza. Gira ad ogni tick.

---

## 8. Piano di Priorità per il Mainnet

### Fase 1 — Prima di qualsiasi ordine reale (stima: 1 giorno)

| # | Finding | File | Stima |
|:--|:---|:---|:---|
| 1 | **[CRIT-02]** Persiste cooldown portfolio in SQLite | `portfolio.js` | 1–2h |
| 2 | **[CRIT-04]** Chiusura + notifica urgente se SL manca immediatamente | `bot.js` | 2h |
| 3 | **[WARN-01]** Rimuovi `console.log` debug dal logger | `logger.js` | 5min |
| 4 | **[WARN-04]** Warning esplicito su DEV_FALLBACK attivo | `secretBox.js` | 30min |

### Fase 2 — Primo sprint mainnet (stima: 3–5 giorni)

| # | Finding | File | Stima |
|:--|:---|:---|:---|
| 5 | **[CRIT-01]** Gestione fill parziali con size reale dal fill | `bot.js` | 3h |
| 6 | **[CRIT-03]** Lock esplicito multi-bot per stesso coin | `execQueue.js`, `bot.js` | 4h |
| 7 | **[WARN-02]** Bounds e monitoring sulla coda execQueue | `execQueue.js` | 2h |
| 8 | **[WARN-03]** Verifica + logging slippage post-fill | `bot.js` | 2h |
| 9 | **[MINOR-05]** Retry su notifiche critiche Telegram | `notifier.js` | 2h |

### Fase 3 — Quality improvements continui

| # | Finding | File | Stima |
|:--|:---|:---|:---|
| 10 | **[WARN-05]** Circuit breaker WebSocket | `hyperliquidClient.js` | 4h |
| 11 | **[MINOR-01]** Separare consume da check in StrategyEngine | `strategyEngine.js` | 1h |
| 12 | **[MINOR-02]** Refactor `canOpen()` side-effect-free | `portfolio.js` | 2h |
| 13 | **[MINOR-03]** Persistenza PaperBroker in SQLite | `paperBroker.js` | 3h |
| 14 | **[MINOR-04]** Avviso warmup indicatori in `getMonitor()` | `bot.js` | 1h |

---

## 9. Mappa Completa dei File Analizzati

| File | Ruolo | Finding | Stato |
|:---|:---|:---|:---|
| `src/index.js` | Entry point, lifecycle, signal handlers | — | ✅ Solido |
| `src/perps/bot.js` | Core logic, posizioni, DCA, TP/SL, riconciliazione | CRIT-01, CRIT-03, CRIT-04, MINOR-04 | 🔴 |
| `src/perps/botManager.js` | Lifecycle bot, watchdog, `whenIdle` | — | ✅ Solido |
| `src/perps/riskManager.js` | Sizing posizione, calcolo TP/SL, limiti | — | ✅ Solido |
| `src/perps/hyperliquidClient.js` | Client API HL, WebSocket, ordini | WARN-05 | 🟠 |
| `src/perps/marketData.js` | Dati real-time, candele, funding, watchdog WS | — | ✅ Solido |
| `src/perps/retry.js` | Helper retry con backoff esponenziale | — | ✅ Solido |
| `src/perps/execQueue.js` | Serializzazione per wallet, nonce monotono | WARN-02, (CRIT-03) | 🟠 |
| `src/perps/portfolio.js` | Limiti globali, cooldown consecutive losses | CRIT-02, MINOR-02 | 🔴 |
| `src/perps/strategyEngine.js` | Valutazione regole, segnali entry/exit | MINOR-01 | 🟡 |
| `src/perps/indicators.js` | RSI, EMA, SMA, MACD, Bollinger, ADX, ATR | — | ✅ Solido |
| `src/perps/secretBox.js` | Cifratura AES-256-GCM, key rotation | WARN-04 | 🟠 |
| `src/perps/agentWallet.js` | Agent wallet HL, EIP-712, approve flow | — | ✅ Solido |
| `src/perps/paperBroker.js` | Forward-test simulato, stessa interfaccia client | MINOR-03 | 🟡 |
| `src/perps/notifier.js` | Notifiche Telegram, token cifrato | MINOR-05 | 🟡 |
| `src/perps/riskSnapshot.js` | Alert derivati, drawdown, stato risk | — | ✅ Solido |
| `src/db/database.js` | SQLite, schema, migrazioni versionate | — | ✅ Solido |
| `src/config/config.js` | Configurazione, validazione, guard mainnet | — | ✅ Solido |
| `src/middleware/auth.js` | Auth single-user, scrypt, token HMAC | — | ✅ Solido |
| `src/utils/logger.js` | Logging sicuro, sanitizzazione, file logging | WARN-01 | 🟠 |

### Legenda

| Simbolo | Significato |
|:---:|:---|
| ✅ Solido | Nessun finding significativo. Da preservare. |
| 🟡 Minore | Finding di qualità, non impattanti sulla sicurezza operativa. |
| 🟠 Importante | Da risolvere prima del mainnet, rischio medio. |
| 🔴 Critico | Blocante per il mainnet con capitale reale. |

---

*Report generato da revisione indipendente — Sprint 4 completato · 10 agosto 2026*
