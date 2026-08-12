# Release 2 — Verso il mainnet: hardening, multi-provider, consulente proattivo

**Team:** Nautilus · **Stato:** Epic A (Sprint 1) chiusa — 21/21 SP, review approvata l'11 agosto
2026 — Epic B/C/D/E ancora da pianificare in dettaglio. Planning tenuto l'11 agosto 2026, subito dopo la
chiusura di Sprint 4 (28/28 SP) e un audit indipendente del sottosistema Perps (`docs/AUDIT_REPORT.md`,
10 agosto 2026, 20 moduli letti integralmente, approccio threat-model-driven).

Questo documento definisce le **epiche** della release, non ancora il dettaglio a livello di singola
storia con criteri di accettazione — quello si fa in fase di refinement, sprint per sprint, con lo
stesso rigore di `sprint3.md`/`sprint4.md`. Qui si decide **cosa entra, in che ordine, e perché**.

---

## 0. Provenienza: quattro fonti, non una lista di desideri

1. **`docs/AUDIT_REPORT.md`** — 4 critici, 5 importanti, 5 minori. **Verificato riga per riga sul codice
   reale prima di trasformarlo in backlog** (§1 sotto): l'audit è risultato accurato, con una sola
   correzione di severità (CRIT-04).
2. **Residui dichiarati di Sprint 4** — item lasciati esplicitamente aperti da chi li ha implementati
   o da chi li ha revisionati (Annie), non dimenticanze: OPS-02/OPS-03r, la misura di costo reale di
   una sessione advisor, la prova di OBS-01 sul VPS reale, la qualità del tool-calling di
   DeepSeek/OpenRouter mai validata su un modello vero, `analyst.js` non migrato all'astrazione
   multi-provider.
3. **`refinementCandidates` di `sprint4-status/aggregate.json`** — 6 item minori raccolti durante la
   review ma non presi: cap sul numero di tool-call per turno advisor, card EXECUTION STATUS ancora
   disonesta, formattazione importi negativi, ordine sezioni MANUAL.md/manual.html, focus trap del
   drawer, riverifica prezzi LLM-01.
4. **Richieste dirette del PO (11 agosto)** — multi-provider anche per la fase di strategia
   (non solo per il consulente), e un ruolo più attivo del consulente nel monitoraggio delle
   operazioni, non solo su richiesta in chat.

**Decisioni di planning prese (AskUserQuestion, 11 agosto):**
1. Multi-LLM strategia: **scelta del provider per l'Analyst esistente** (migrazione all'astrazione
   già costruita in LLM-01), non un confronto parallelo multi-provider — quello resta un candidato
   futuro più grande, non scelto oggi.
2. Consulente proattivo: **entrambi** i meccanismi — digest periodico *e* commento su alert di
   rischio.
3. Advisor fase 2 (proposte dalla chat): **inclusa in questa release**, nonostante lo spike la
   subordinasse esplicitamente a una misura di fase 1 (costo/qualità reale) mai eseguita — decisione
   consapevole del PO, con la misura mancante che resta comunque un prerequisito tecnico dentro
   l'epica stessa (§4).
4. **L'hardening mainnet (Epic A) è la prima epica e blocca le altre**, non procede in parallelo.

---

## 1. Verifica dell'audit — cosa regge, cosa no

Prima di scrivere una sola storia, ogni finding critico è stato riletto sul sorgente reale (non sul
resoconto dell'audit). Risultato:

| Finding | Verificato | Esito |
|:--|:---:|:---|
| CRIT-01 (fill parziali) | ✅ | Confermato: `_openPosition()` usa `plan.size` ovunque, mai la size reale del fill |
| CRIT-02 (cooldown volatile) | ✅ | Confermato: `this.cooldowns = new Map()` in `portfolio.js`, zero persistenza |
| CRIT-03 (race apertura multi-bot) | ✅ | Confermato, causa precisata: `placeMarketOrder` è serializzato per wallet via `execQueue`, ma il *check* di idoneità (`checkLimits`/`canOpen`) avviene **prima** della coda, su uno snapshot account potenzialmente stale — variante di SEC-08 sul lato apertura |
| CRIT-04 (SL non urgente) | ⚠️ **Corretto** | Il claim "aspetta il tick successivo (10s)" è **falso** — il codice reagisce nello stesso tick. Il problema reale è più piccolo: una `_findStopOrder()` ridondante prima di chiudere quando `res.oid` è già `null` (inequivocabile). **Declassato da CRIT a WARN** in questa release. |
| WARN-01, 02, 03, 04, 05 | ✅ | Tutti confermati con spot-check diretto sul codice |
| MINOR-01…05 | — | Non riletti singolarmente (basso rischio, bassa ambiguità) — presi per buoni, verranno comunque scritti test-first come da convenzione |

---

## 2. EPIC A — Hardening mainnet (audit-driven)

**Perché prima e bloccante:** sono bug di correttezza su capitale — fill mal dimensionati, protezioni
che spariscono a un riavvio, due bot che aprono sullo stesso mercato — indipendenti da qualunque
nuova feature. Ha senso chiuderli prima di costruire altro sopra, specialmente con il mainnet
all'orizzonte.

| ID | Storia | File | SP |
|:--|:---|:---|:--:|
| CRIT-01 | Usare la size **reale del fill**, non quella pianificata, per posizione/DB/SL/TP | `bot.js` | 3 |
| CRIT-02 | Persistere il cooldown di portafoglio in SQLite (`settings`), ripristino all'avvio | `portfolio.js` | 2 |
| CRIT-03 | Lock esplicito di apertura per `(masterAddress, coin)`, non solo il dedup DB dopo il fatto | `execQueue.js`, `bot.js` | 3 |
| WARN-06 | *(ex CRIT-04, declassato)* Chiudere subito su `res.oid` nullo, senza il round-trip di verifica ridondante | `bot.js` | 1 |
| WARN-01 | Rimuovere il `console.log` di debug che inquina il logging strutturato | `logger.js` | 1 |
| WARN-02 | Bounds e monitoraggio sulla profondità di `execQueue` (nessuna priorità per ora, solo visibilità) | `execQueue.js` | 2 |
| WARN-03 | Calcolare e loggare lo slippage reale post-fill (`avgPx` vs prezzo di mercato al momento dell'ordine) | `bot.js` | 2 |
| WARN-04 | Warning esplicito e visibile quando `DEV_FALLBACK` è attivo (non blocca, ma non deve passare inosservato) | `secretBox.js` | 1 |
| WARN-05 | Circuit breaker a tre stati (`closed/open/half-open`) sul reconnect WebSocket, un solo alert all'apertura | `hyperliquidClient.js`, `marketData.js` | 3 |
| QUAL-01 | Pacchetto qualità: i 5 MINORI dell'audit (side-effect in `_consumeExternal`/`canOpen`, persistenza PaperBroker, avviso warmup indicatori, retry notifiche Telegram) | vari | 3 |

**Totale Epic A: 21 SP.** Nessuna storia qui tocca una feature nuova — solo correttezza e resilienza
su ciò che già esiste. Owner naturale: Bruno (money-handling code), con QUAL-01 spezzabile con
Joshua dove tocca infrastruttura (notifier retry).

**Nota per il refinement:** CRIT-03 va disegnato con attenzione a non introdurre un secondo punto di
verità sul "chi sta aprendo cosa" — il lock deve vivere accanto a `execQueue`, non duplicarne la
logica di serializzazione.

---

## 3. EPIC B — Completamento Release 1 e debito residuo

Non nuove capacità: chiudere quello che Release 1 (Sprint 1-4) ha lasciato esplicitamente aperto —
inclusi due item più vecchi di Sprint 4, riportati qui in occasione della riorganizzazione della
board in Release 1 (archiviata) / Release 2 (in corso), l'11 agosto.

| ID | Storia | Owner | SP | Note |
|:--|:---|:---|:--:|:---|
| CI-01 | `harden-runner` da audit a block in CI | Joshua | 2 | Da Sprint 2 — differita perché servivano 3-5 run reali in modalità audit prima di poter compilare l'allowlist; quella dipendenza temporale è nel frattempo trascorsa, va solo ripresa in mano |
| CHORE-01 | Verifica igiene `.npmrc` | PO | 1 | Da Sprint 2 — nessun agente ha accesso a `.npmrc` (protezione sandbox), resta ispezione diretta |
| OPS-02 | Verifica reale backup/restore sul VPS | PO/Claude | 1 | Da Sprint 3, mai eseguito |
| OPS-03r | Uptime esterno su `/health` | PO/Claude | 1 | Residuo Sprint 3/4 |
| ADV-OPS-01 | Sessione reale con `AGENTS_ENABLED=true`: misurare il costo vero di una conversazione advisor vs la stima dello spike | PO | 1 | Prerequisito tecnico anche per Epic D/E — farla presto |
| OBS-OPS-01 | Provare OBS-01 (Grafana) sul VPS reale, non solo su Docker locale | PO/Claude | 1 | Nessun agente ha accesso SSH |
| LLM-VAL-01 | Rieseguire la suite avversaria di ADV-02 contro un modello **vero** DeepSeek/OpenRouter (non il client finto) prima di dargli accesso agli strumenti in produzione | Bruno | 2 | Richiede una chiave reale provisionata via Infisical |
| DEBT-02 | Cap sul numero di tool-call per turno advisor (costo CPU locale non contabilizzato dal budget monetario) | Bruno | 1 | Trovato da Annie in review Sprint 4 |
| DEBT-03 | Card EXECUTION STATUS: alimentare `#cockpitFills`/`#cockpitPending`/`#cockpitRejectRate` o rimuoverli; via `LIVE`/`Queue health: Stable` fissi | Maya | 2 | Stessa classe di DEBT-UI-01 |
| DEBT-04 | Formattazione importi negativi dentro `fmtUsd`, via i 3 replace ripetuti a mano | Maya | 1 | |
| DEBT-05 | Riallineare l'ordine delle sezioni tra `MANUAL.md` e `manual.html` | Maya | 1 | Contenuti già allineati, solo l'ordine differisce |
| DEBT-06 | Focus trap nel drawer del consulente | Maya | 1 | Piccolo, isolato |
| LLM-PRICE-01 | Riverificare i prezzi in `pricing.models` (LLM-01) contro i listini pubblici reali | Joshua | 1 | Scritti senza accesso rete al momento di LLM-01 |
| CRIT-05 | `equity` conta due volte il margine impegnato in posizioni perp aperte (`accountValue + spot.total` invece di `accountValue + (spot.total - spot.hold)`) — sovrastima esatta pari al margine impegnato, confermata su prova diretta contro l'API Hyperliquid | Bruno | 3 | **P0.** Trovato l'11-12 agosto durante la demo operativa isolata di Jordan (ordini testnet reali), diagnosticato da Bruno in indagine di sola lettura — non un fix al buio. Alimenta `sizePosition` (sovradimensionamento composto tra bot concorrenti), `risk_equity_history`/drawdown (picchi fittizi) e `marginPct` (sottostimato — la direzione pericolosa: l'alert di sovra-leva scatta più tardi del dovuto). Root cause: commit `9e3a236`, corretto nella premessa (fix di un equity-nullo reale) ma con l'addendo sbagliato — bug invisibile a conto piatto, mai esercitato prima con una posizione realmente aperta. Latente su mainnet oggi (accountValue 0, nessuna posizione) ma stesso codice condiviso. Prima di implementare: secondo campione con posizioni multiple/PnL non banale (vedi `.claude/agent-memory/bruno/project_equity-doppio-conteggio-spot.md`), poi funzione pura in `riskManager.js` + nuovo campo (non toccare `spotUsdc`, consumato altrove) + test sulla proprietà "aprire una posizione non cambia l'equity", non su un valore atteso fisso. |

**Totale Epic B: 19 SP.** Sei item (CHORE-01, OPS-02, OPS-03r, ADV-OPS-01, OBS-OPS-01, e la verifica
mainnet di CRIT-05) restano in carico diretto al PO o richiedono la sua decisione — non delegabili ad
agenti per la stessa ragione di sempre (accesso SSH/`.npmrc`/spesa reale/capitale condiviso).

---

## 4. EPIC C — Multi-provider anche per la strategia (Analyst)

**Chiude il residuo esplicitamente dichiarato di LLM-01** ("l'Analyst resta Anthropic-only") e
risponde alla richiesta diretta del PO. Riusa l'astrazione già costruita e testata in Sprint 4
(`src/agents/providers/`) — non la reinventa.

| ID | Storia | File | SP |
|:--|:---|:---|:--:|
| LLM-02 | Migrare `analyst.js` all'interfaccia `createChatCompletion` di `providers/`, stesso comportamento su Anthropic (zero regressioni sui test esistenti) | `src/agents/analyst/analyst.js` | 3 |
| LLM-03 | `AGENT_ANALYST_PROVIDER` (default `anthropic`), simmetrico a `AGENT_ADVISOR_PROVIDER` | `config.js` | incluso in LLM-02 |
| LLM-04 | Stima costo (`estimate()`) senza `countTokens` (specifico Anthropic, gratuito) — euristica per fornitore, stessa disciplina "preventivo prima di spendere" | `analyst.js`, `usage.js` | 2 |

**Totale Epic C: 5 SP.** Owner: Bruno. **Invariante da riportare in ogni storia:** nessun modello di
default cambia, nessuna chiave nuova obbligatoria — stesso principio già rispettato in LLM-01.
**Dipendenza:** LLM-VAL-01 (Epic B) dovrebbe girare anche per l'Analyst una volta migrato, non solo
per l'advisor — stesso rischio, stessa mitigazione (suite reale prima di fidarsi in produzione).

---

## 5. EPIC D — Il consulente nel monitoraggio, non solo nella chat

**Il problema che risolve:** oggi il consulente parla solo quando qualcuno apre il drawer e scrive.
Zero ruolo nel monitoraggio continuo. Il PO ha scelto **entrambi** i meccanismi proposti.

### 5.1 · ADV-04 — Digest periodico

Riepilogo in prosa (fill, chiusure, drawdown, anomalie) a cadenza fissa (default: giornaliero,
configurabile), inviato su Telegram e visibile nel tab Performance. **Riusa integralmente** gli
strumenti read-only e i guardrail di ADV-02 — non è un secondo consulente, è lo stesso con un
innesco diverso.

- Nuova sessione "di sistema" nel DB (`chat_sessions.source = 'digest'`, distinto da `'user'`) —
  serve a non confondere in audit un digest automatico con una conversazione umana.
- Stesso budget mensile hard di ADV-03: il vincolo del PO ("budget massimo mensile") copriva l'uso
  complessivo del consulente, non solo la chat interattiva. Se il digest esaurisce il budget, si
  ferma e lo dice — stesso comportamento di un turno di chat bloccato.
- Nessuna nuova capacità di scrittura: stessa allowlist di `toolset.js`.

**SP: 3.**

### 5.2 · ADV-05 — Commento su alert di rischio

Quando `riskSnapshot.deriveRiskAlerts()` produce un **nuovo** alert (non uno già notificato — stessa
lezione di SEC-10, una notifica per episodio non per tick), l'advisor genera un breve commento in
linguaggio naturale allegato alla notifica Telegram già esistente, invece di aspettare che qualcuno
apra la chat per chiedere "perché".

- Innesco: hook su `deriveRiskAlerts()`, non un nuovo timer — evita di introdurre un'altra fonte di
  polling.
- Stesso budget condiviso di ADV-04/ADV-03.
- **Da disegnare in refinement:** cosa succede se il budget è esaurito proprio mentre scatta un alert
  critico — la notifica esistente (deterministica, non-AI) deve **sempre** partire comunque; il
  commento del consulente è un'aggiunta, mai una condizione per l'invio dell'alert stesso.

**SP: 3.**

**Totale Epic D: 6 SP.** Owner: Bruno (innesco/logica) + Maya (superficie nel tab Performance).
**Prerequisito tecnico:** ADV-OPS-01 (Epic B) — la misura di costo reale di una sessione va fatta
prima di moltiplicare i canali che consumano lo stesso budget, altrimenti si dimensiona alla cieca.

---

## 6. EPIC E — Advisor fase 2: proposte dalla chat

Da `spike-ai-advisor.md` §9 fase 2 (stima originale: 3 SP). **Inclusa su decisione esplicita del PO**,
pur restando aperto il prerequisito che lo spike poneva (misura reale di fase 1) — la story ADV-OPS-01
in Epic B lo copre e va sequenziata prima di questa epica, non in parallelo.

| ID | Storia | SP |
|:--|:---|:--:|
| ADV-06 | `create_proposal` con `source:'advisor'`; validazione server-side del payload (stesse regole di onestà dell'Analyst: expectancy positiva nel rationale, non solo dichiarata); flag `ADVISOR_CAN_PROPOSE` default `false` | 3 |

**Vincolo non negoziabile, più stringente che altrove:** è la **prima** capacità di scrittura del
consulente in assoluto. Ogni altro strumento resta read-only; solo `create_proposal` si aggiunge
all'allowlist, e produce sempre e solo una riga `pending` — mai un'esecuzione. La suite avversaria di
ADV-02 va estesa con casi specifici su questo strumento (es. il modello prova a chiamarlo con un
rationale senza backtest, o con expectancy dichiarata ma non verificabile) prima di attivare il flag
di default in qualunque ambiente.

**Totale Epic E: 3 SP.**

---

## 7. Riepilogo e sequenziamento proposto

| Epica | SP | Stato | Blocca/dipende da |
|:--|:--:|:---|:---|
| A — Hardening mainnet | 21 | ✅ **Chiusa** (Sprint 1, review 11 agosto) | Nessuna — parte per prima |
| B — Completamento Release 1 | 19 | 🔄 **Sprint 2 in corso** (avviato 12 agosto) | Nessuna diretta, ma ADV-OPS-01 va fatta prima di D/E; CRIT-05 (P0) trovato in demo 11-12 agosto |
| C — Multi-provider Analyst | 5 | 🔄 **Sprint 2 in corso** (avviato 12 agosto) | Nessuna |
| D — Consulente proattivo | 6 | Da pianificare | ADV-OPS-01 (Epic B) |
| E — Advisor fase 2 | 3 | Da pianificare | ADV-OPS-01 (Epic B), idealmente dopo D |
| **Totale release** | **54** | **21/54 fatti** | |

**Distribuzione su sprint** (numerazione propria di Release 2 — non prosegue quella di Release 1,
per decisione esplicita del PO l'11 agosto: questa release riparte da Sprint 1):

- **Sprint 1 — Epic A per intero** (21 SP) ✅ **chiuso**: coerente con la decisione "prima epica,
  blocca le altre". Dettaglio e esito review in `sprint1.md`. Due extra nati in review (warning
  multi-bot stesso mercato, guard su `getLimits()`) consegnati nella stessa seduta.
- **Sprint 2 — Epic B + Epic C** (19 + 5 = 24 SP), pianificato il 12 agosto 2026: completamento
  operativo/debito residuo e multi-provider Analyst, nessuna dipendenza tra loro, parallelizzabili.
  Dettaglio storia per storia in `sprint2.md`, incluso il vincolo di sequenza esplicito su CRIT-05
  (va per ultima, dopo il secondo campione dalla demo operativa di Jordan in corso in parallelo).
- **Sprint 3 (proposto) — Epic D + Epic E** (6 + 3 = 9 SP, sprint più leggero, spazio per eventuale
  scivolamento da Sprint 1/2): il consulente proattivo e la sua prima capacità di scrittura, in
  questo ordine perché E dipende concettualmente da D (avere il consulente già integrato nel
  monitoraggio prima di dargli la possibilità di proporre).

*Epiche definite l'11 agosto 2026, riviste lo stesso giorno per la numerazione propria di Release 2
e i due item riportati da Sprint 2 di Release 1 (CI-01, CHORE-01). Il refinement dettagliato (storie
con criteri di accettazione) si fa sprint per sprint, all'avvio di ciascuno — stesso processo di
Release 1.*

---

## 8. Candidati futuri, non ancora pianificati

Registrati per non perderne traccia, non ancora assegnati a una release/epica specifica — richiedono
un refinement dedicato prima di poter stimare SP.

| Candidato | Tipo | Origine | Documento |
|:--|:--|:--|:--|
| Sistema Neofita-Maestro — memoria esperienziale interna, riduzione dipendenza da LLM esterni | Architecture Spike & R&D | Richiesta diretta del PO, 12 agosto 2026 | [`spike-neofita-maestro.md`](spike-neofita-maestro.md) |
| Integrazione MetaTrader (MT4/MT5) come layer di esecuzione alternativo/di supporto | Architecture Spike & R&D | Richiesta diretta del PO, 12 agosto 2026 | [`spike-metatrader-integration.md`](spike-metatrader-integration.md) |
