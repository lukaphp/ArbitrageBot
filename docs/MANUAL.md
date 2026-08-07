# 📖 Manuale Utente — ArbitrageBot Perps

Guida completa all'uso della piattaforma di trading su **Hyperliquid DEX**: interfaccia,
bot automatici, motore di rischio, agenti AI e integrazioni.

**Versione 2.6** · Aggiornato: 7 agosto 2026

> 📄 Esiste anche una **versione HTML navigabile** con ricerca integrata, servita
> dall'app su `/manual.html`. Questo file ne è la versione testuale: stesso contenuto,
> leggibile da editor, diff e ricerca a riga di comando.
>
> Per l'installazione, i segreti e il deploy in produzione vedi invece [DEPLOY.md](DEPLOY.md).

---

## Indice

1. [Introduzione e architettura](#1-introduzione-e-architettura)
2. [MetaMask e Agent Wallet](#2-metamask-e-agent-wallet)
3. [Tab Dashboard](#3-tab-dashboard)
4. [Tab Execution — ordini manuali](#4-tab-execution--ordini-manuali)
5. [Tab Positions](#5-tab-positions)
6. [Tab Risk & Alerts](#6-tab-risk--alerts)
7. [Tab System — bot automatici](#7-tab-system--bot-automatici)
8. [Configurazione avanzata dei bot](#8-configurazione-avanzata-dei-bot)
9. [Paper trading (forward-test)](#9-paper-trading-forward-test)
10. [Backtest e ottimizzazione walk-forward](#10-backtest-e-ottimizzazione-walk-forward)
11. [Modello ML (predictor) e gate probabilistico](#11-modello-ml-predictor-e-gate-probabilistico)
12. [Analyst AI e coda delle proposte](#12-analyst-ai-e-coda-delle-proposte)
13. [Storico strategie](#13-storico-strategie)
14. [Indicatori tecnici](#14-indicatori-tecnici)
15. [Segnali esterni via webhook](#15-segnali-esterni-via-webhook)
16. [Controllo via Telegram](#16-controllo-via-telegram)
17. [Sicurezza e gestione dei segreti](#17-sicurezza-e-gestione-dei-segreti)
18. [Monitoraggio e metriche](#18-monitoraggio-e-metriche)
19. [FAQ e troubleshooting](#19-faq-e-troubleshooting)

---

## 1. Introduzione e architettura

**ArbitrageBot Perps** è una piattaforma per il trading — manuale e automatico — di
contratti perpetui sul protocollo decentralizzato **Hyperliquid**. Permette di
monitorare prezzi in tempo reale, aprire posizioni Long/Short con leva, impostare
stop dinamici e delegare l'operatività a bot a regole, con supervisione di agenti AI.

**Dati di mercato reali.** Prezzi mid, order book, candele storiche e funding rate
arrivano dalle API Hyperliquid (testnet o mainnet). I prezzi live viaggiano su
WebSocket, con polling REST come fallback automatico se la connessione cade.

**Sicurezza non-custodial.** La chiave privata del wallet principale non lascia mai
MetaMask. Il trading 24/7 usa un **Agent Wallet** dedicato, con permessi di solo
trading: **non può prelevare né trasferire fondi all'esterno**.

**Nota sul modulo Arbitraggio EVM.** La seconda vista dell'app (`Arbitrage`) è una
*demo educativa a prezzi simulati*, non arbitraggio reale. È disattivata di default
(`DEMO_EVM_ENABLED=false`) e va tenuta spenta in produzione. Il prodotto operativo è
**solo Perps**.

---

## 2. MetaMask e Agent Wallet

| Elemento UI | Funzione | Descrizione |
|:---|:---|:---|
| **🦊 Connetti MetaMask** | Connessione wallet master | Identifica il wallet titolare dei fondi. Su mainnet è **obbligatoria**: senza wallet connesso le operazioni sono bloccate. |
| **⚡ Abilita Trading Autonomo** | Firma EIP-712 `approveAgent` | Genera una coppia di chiavi agent e richiede **una sola** firma. Da quel momento il server invia ordini in background senza popup MetaMask. |
| **Account unificato (USDC)** | Collaterale | Hyperliquid usa un account unificato: gli USDC nel saldo Spot fanno da margine per i Perps. |
| **🔄 Trasferisci USDC a Perp** | Trasferimento interno | Sposta USDC tra saldo Spot e Perp tramite firma typed data. |

> 💡 **Garanzia strutturale.** La firma `approveAgent` autorizza **esclusivamente** ad
> aprire, modificare e chiudere posizioni. L'agent non ha il permesso di ritirare
> fondi. È la protezione più forte del sistema: anche in caso di compromissione totale
> del server, il capitale non può uscire dal tuo conto.

**Se devi revocare un agent** (sospetta compromissione), la revoca si fa
**dall'interfaccia Hyperliquid**: il pannello dell'app sa solo approvarne uno nuovo.

---

## 3. Tab Dashboard

Quadro sintetico di capitale, posizioni e stato del sistema.

| Metrica | Significato |
|:---|:---|
| **EQUITY** | Valore totale del conto: capitale depositato + PnL non realizzato. |
| **UNREALIZED PnL** | Profitto/perdita potenziale sulle posizioni aperte. |
| **MARGIN USED** | Capitale bloccato a garanzia delle posizioni attive. |
| **ALERTS BADGE** | Contatore delle avvertenze di rischio. Cliccandolo si passa al tab Risk. |

**Grafico Equity.** L'andamento del conto nel tempo. I campioni sono **persistiti su
database** (`risk_equity_history`), quindi la curva e il calcolo del drawdown
**sopravvivono ai riavvii** dell'applicazione — non ripartono da zero a ogni restart.

---

## 4. Tab Execution — ordini manuali

| Campo | Tipo | Descrizione |
|:---|:---|:---|
| **Order Market** | Select | Asset su cui operare (es. SOL, BTC, ETH). Mostra il prezzo *mid* corrente. |
| **Leverage** | Slider / numero | Leva finanziaria. Il tetto è `PERPS_MAX_LEVERAGE` (default 20x); il valore iniziale è `PERPS_DEFAULT_LEVERAGE` (default 3x). |
| **Margin (USD)** | Numero | Capitale allocato all'operazione. Notionale = `Margine × Leva`. |
| **Take Profit (TP)** | Numero | Prezzo obiettivo di chiusura in guadagno. |
| **Stop Loss (SL)** | Numero | Prezzo di chiusura in perdita, a protezione del saldo. |
| **🟢 LONG (BUY)** | Azione | Apre una posizione rialzista. |
| **🔴 SHORT (SELL)** | Azione | Apre una posizione ribassista. |

> ⚠️ **Gli ordini manuali sono eseguiti a mercato.** Non esiste (ancora) un tipo
> d'ordine *limit* per l'inserimento manuale: l'ordine entra al prezzo corrente con
> una tolleranza di slippage (default 2%). Tienine conto sui mercati poco liquidi.

**TP e SL vivono sull'exchange.** Quando imposti TP/SL, l'app li registra come
**trigger order lato Hyperliquid**, non come controlli nel loop locale. Se il server
si spegne o va in crash, gli stop restano attivi e proteggono la posizione. È una
differenza sostanziale rispetto ai bot che monitorano gli stop solo in memoria.

**Prima dell'invio** ogni ordine passa dal motore di rischio: leva, notionale e
limiti di portafoglio vengono verificati lato server. Un ordine che viola un limite
viene rifiutato con la motivazione, non ridimensionato in silenzio.

---

## 5. Tab Positions

Elenco delle posizioni aperte sull'account Hyperliquid.

| Colonna | Descrizione |
|:---|:---|
| **Coin & Direction** | Asset e direzione (LONG / SHORT). |
| **Size & Notional** | Dimensione in token e controvalore in USD. |
| **Entry Price** | Prezzo medio di carico. |
| **Mark Price** | Prezzo corrente usato per il PnL non realizzato. |
| **PnL (USD e %)** | Rendimento in dollari e in percentuale sul margine. |
| **Chiudi Posizione** | Invia un ordine market contrario di pari dimensione, azzerando l'esposizione. |

---

## 6. Tab Risk & Alerts

Il rischio è controllato su **tre livelli indipendenti**, tutti applicati lato server
prima di ogni esecuzione.

### 6.1 Limiti per singolo bot

Configurabili nel form del bot: **Max Daily Loss** e **Max Position** propri di quel bot.

### 6.2 Limiti globali di portafoglio

Validi per **tutti** i bot e per gli ordini manuali:

| Limite | Default | Effetto |
|:---|:---|:---|
| Max posizioni concorrenti | 3 | Blocca nuove aperture oltre la soglia. |
| Max esposizione totale (USD) | 2× `maxPositionUsd` | Somma dei notionali aperti. |
| Max perdite consecutive | 3 | Oltre la soglia scatta un cooldown. |
| Cooldown | 60 min | Durata dello stop forzato dopo le perdite consecutive. |

### 6.3 Gate deterministico unico

**Ogni** esecuzione — che venga da un bot a regole o da una proposta approvata
dell'Analyst AI — attraversa lo stesso gate di rischio. È deterministico: stesse
condizioni, stesso esito. **L'AI non lo può aggirare.** Le azioni che *riducono* il
rischio (chiusure, pausa, stop più stretti) non vengono bloccate dai cap.

### 6.4 Kill-switch

| Controllo | Funzione |
|:---|:---|
| **Risk Score Gauge** | Valutazione sintetica da 0 (basso) a 100 (critico). |
| **Limiti di Portafoglio** | Pannello di configurazione dei limiti del §6.2. |
| **🛑 KILL-SWITCH** | Ferma istantaneamente tutti i bot e blocca ogni nuova operazione. Opzionalmente chiude a mercato tutte le posizioni. |

Il kill-switch è raggiungibile anche da **Telegram** (`/chiuditutto`) e via API
`POST /api/perps/killswitch` — utile per averlo a portata di mano da fuori
dall'interfaccia.

---

## 7. Tab System — bot automatici

Un bot = **un mercato + una strategia**. Esegue un ciclo periodico:

```
snapshot mercato → valutazione regole → ingresso / gestione / uscita → persistenza
```

La macchina a stati è `idle` → `in_position` → `idle`. Ogni ciclo è isolato in
try/catch: un errore non ferma il bot né il processo.

| Azione | Descrizione |
|:---|:---|
| **▶️ Avvia Bot** | Il bot inizia a valutare le candele a ogni intervallo ed esegue secondo le regole. |
| **⏸️ Pausa / Stop** | Sospende il monitoraggio senza cancellare la configurazione. |
| **⚙️ Ottimizza Parametri** | Lancia una Walk-Forward Optimization (vedi §10). |
| **📊 Monitor** | Apre il dettaglio live del bot: ultima valutazione, motivo della decisione, gate attivi. |

I bot che erano in stato `running` **ripartono da soli** dopo un riavvio del server.

### Regole di ingresso e uscita

| Tipo di regola | Cosa valuta |
|:---|:---|
| `indicator` | RSI, EMA, SMA, MACD, Bollinger, ADX — con periodo, operatore e soglia. |
| `price` | Confronto diretto sul prezzo (`<`, `>`, `<=`, `>=`). |
| `funding` | Confronto sul funding rate previsto. Utile per strategie carry o contrarian. |
| `external` | Soddisfatta da un segnale ricevuto via webhook (§15). |

Le regole d'ingresso si combinano con `logic: any` (default — basta una) oppure
`logic: all` (devono valere tutte).

---

## 8. Configurazione avanzata dei bot

Oltre alle regole base, ogni bot espone i seguenti moduli.

### Sizing e cadenza

- **Sizing mode**: `percent` (percentuale dell'equity) o `fixed` (importo in USD).
- **Interval**: timeframe delle candele valutate (1m, 5m, 15m, 1h, 4h, 1d).
- **Direction**: long, short o entrambe.

### Uscite

| Modulo | Descrizione |
|:---|:---|
| **Take Profit / Stop Loss** | Modalità `percent` (percentuale dall'ingresso) o **`atr`** (multiplo dell'Average True Range: lo stop si adatta alla volatilità del mercato). |
| **Trailing Stop** | Stop che segue il prezzo a favore del trend, anch'esso in modalità `percent` o `atr`. Aggiornato sull'exchange: il vecchio trigger viene rimosso solo dopo che il nuovo è stato accettato. |
| **Partial Take Profit** | Scala di prese di profitto parziali: chiude frazioni della posizione a livelli successivi invece di uscire tutto in una volta. |

### Ingressi condizionati

| Modulo | Descrizione |
|:---|:---|
| **Conferma multi-timeframe (MTF)** | Prima di aprire, verifica che un timeframe superiore concordi (confronto con una EMA, periodo default 50). Se non concorda, il bot resta fermo e lo scrive nella motivazione. |
| **Gate ML** | Apre solo se il modello statistico stima una probabilità superiore a `minProb` (default 0.55). Vedi §11. |

### DCA (mediazione del prezzo d'ingresso)

Se il prezzo va **contro** la posizione, il bot può aggiungere size a soglie
progressive:

| Parametro | Significato |
|:---|:---|
| `steps` | Numero massimo di aggiunte. |
| `stepPercent` | Soglia della prima aggiunta. Le successive scattano a multipli: step 2 a `2 × stepPercent`, step 3 a `3 × stepPercent`… |
| `sizeMultiplier` | Dimensione dell'aggiunta come multiplo della size corrente. |

> ⚠️ **Il DCA aumenta l'esposizione mentre sei in perdita.** È l'esatto opposto di uno
> stop loss e va usato con cognizione: su un mercato con leva, mediare un trend
> avverso è il modo più diretto per trasformare una perdita gestibile in una
> liquidazione. Usalo con `steps` bassi, e mai senza uno stop loss finale.

---

## 9. Paper trading (forward-test)

Ogni bot ha un flag **PAPER**. Attivandolo:

- **prezzi, candele e segnali restano reali e live**;
- **solo l'esecuzione è simulata** da un broker interno.

È il modo corretto di validare una strategia dopo il backtest e prima del denaro
reale: il backtest ti dice come *sarebbe* andata sui dati passati, il paper trading
ti dice come *sta* andando sul mercato di adesso, senza rischio. I bot in paper mode
mostrano un badge **PAPER** nella lista.

---

## 10. Backtest e ottimizzazione walk-forward

### Backtest

Rigioca la strategia sulle candele storiche di Hyperliquid e misura win rate, profit
factor, expectancy, max drawdown e return.

Il backtester **riusa gli stessi moduli dei bot live** — strategy engine e risk
manager — quindi riflette il comportamento reale invece di approssimarlo. Non c'è
look-ahead: il segnale a ogni candela usa solo le candele chiuse fino a quel punto,
l'entrata avviene alla chiusura della candela di segnale, e TP/SL sono verificati sui
massimi/minimi delle candele successive.

### Ottimizzazione (Hyperopt walk-forward)

Cerca la combinazione di parametri migliore eseguendo molti backtest e classificandoli
per obiettivo (expectancy, profit factor, SQN…).

La difesa contro l'overfitting è la **validazione walk-forward**: l'ottimizzazione
gira sulla prima parte del periodo (*in-sample*), poi il vincitore viene verificato
sull'ultima parte, **mai vista durante la ricerca** (*out-of-sample*). Se l'edge
regge anche fuori campione è più credibile; se crolla, i parametri erano
sovra-ottimizzati.

> ⚠️ I risultati sono storici e statistici. Non garantiscono rendimenti futuri.

---

## 11. Modello ML (predictor) e gate probabilistico

Un modello statistico leggero — regressione logistica, senza dipendenze pesanti —
stima la probabilità che il prezzo salga nelle prossime candele a partire da feature
tecniche: RSI, distanza dalle EMA, istogramma MACD, %b di Bollinger, ritorni recenti
e volatilità.

**Come si usa.** Non decide le operazioni: fa da **gate**. Il bot apre solo se la
probabilità stimata supera `minProb`. Le decisioni restano delle regole.

**Onestà sui numeri.** Con dati di mercato reali l'accuratezza realistica è del
**50-56%**. Il modello riporta **sempre** l'accuratezza in validazione **e la
baseline** (la classe maggioritaria). Se l'accuratezza è vicina alla baseline, il
modello **non ha edge** e non va usato da solo — il pannello lo dice esplicitamente
invece di mostrare solo una percentuale lusinghiera.

**Decadimento nel tempo.** Un agente dedicato riaddestra periodicamente i modelli
(default ogni 6 ore) e traccia l'andamento dell'accuratezza contro la baseline, così
il modello non invecchia in silenzio nella cache. Se l'edge scende sotto soglia il
gate smette di filtrare e ricevi un avviso Telegram.

---

## 12. Analyst AI e coda delle proposte

L'agente Analyst (basato su Claude) gira periodicamente, raccoglie evidenze con
strumenti **read-only** e produce **proposte**.

**Non esegue mai nulla.** Ogni proposta finisce in una coda di approvazione e diventa
operativa solo dopo il tuo consenso esplicito — e comunque dopo essere passata dal
gate di rischio deterministico (§6.3).

Tipi di proposta ammessi: `pause_bot`, `close`, `tighten_sl`, `open`,
`new_strategy_candidate`.

| Azione | Effetto |
|:---|:---|
| **Approva** | Esegue la proposta, previa validazione del gate di rischio. |
| **Rifiuta** | Scarta la proposta. |
| **Collega a bot** | Associa la proposta a un bot esistente. |

Le proposte non approvate **scadono** (default 30 minuti): un suggerimento basato su
un mercato di mezz'ora fa non deve poter essere eseguito ore dopo.

### Controllo dei costi

L'Analyst consuma token a pagamento. Due protezioni:

- **Cap di chiamate/ora** (`AGENT_MAX_CALLS_PER_HOUR`, default 8).
- **Modale di stima costo**: prima di lanciare un'analisi on-demand ricevi un
  preventivo in dollari. Solo il primo input è misurato esattamente; il resto è un
  intervallo, perché il numero di iterazioni del loop agentico non è noto in anticipo.
  La stima tiene conto del *prompt caching* (scrivere in cache costa 1,25×, rileggere 0,1×).

I prezzi per milione di token sono configurabili (`PRICE_SONNET_IN`, `PRICE_SONNET_OUT`…)
e vanno aggiornati se i listini cambiano.

---

## 13. Storico strategie

Ogni strategia proposta o testata viene archiviata, con:

- **Categorizzazione** per esito e tipo;
- **Riciclo**: recupera una strategia archiviata e la ripropone come candidata,
  senza doverla riscrivere;
- **Eliminazione in blocco** per fare pulizia.

È la memoria di lungo periodo del sistema: serve a non ri-testare per la terza volta
una strategia che era già stata scartata.

---

## 14. Indicatori tecnici

| Indicatore | Cosa misura | Uso tipico |
|:---|:---|:---|
| **RSI** (Relative Strength Index) | Momentum, scala 0-100. | Sotto 30 = ipervenduto (spunto long); sopra 70 = ipercomprato (spunto short). |
| **EMA / SMA** (medie mobili) | Media ponderata o semplice su N periodi. | Il crossover di una media veloce (EMA 9) sopra una lenta (EMA 21) segnala trend rialzista. |
| **MACD** | Differenza tra due EMA + istogramma. | Istogramma > 0 = fase rialzista, < 0 = ribassista. |
| **Bollinger Bands** | Banda di volatilità attorno a una media. | Prezzo oltre la banda superiore/inferiore = estensione o breakout. |
| **ADX** (Average Directional Index) | **Forza** del trend, a prescindere dalla direzione. | Sopra 25 = trend solido. Sotto = fase laterale: filtra i falsi segnali. |
| **ATR** (Average True Range) | Volatilità assoluta. | Adatta l'ampiezza di stop e trailing ai movimenti reali dell'asset. |

---

## 15. Segnali esterni via webhook

Il tipo di regola `external` è pensato per innescare l'operatività da un segnale
ricevuto via HTTP:

```
POST /api/perps/webhook
{ "coin": "ETH", "signal": "open_long" }
```

> 🔒 **Stato attuale: endpoint interno, non raggiungibile da servizi esterni.**
> Come tutte le rotte `/api/*` (eccetto login/logout/status), il webhook è dietro il
> gate di autenticazione dell'app: richiede il cookie di sessione emesso al login.
> Un servizio come **TradingView o TrendSpider non può chiamarlo così com'è**, perché
> non ha modo di ottenere quel cookie — e questo vale a prescindere dal secret
> opzionale (`PERPS_WEBHOOK_SECRET`), che è un controllo aggiuntivo, non un sostituto
> dell'autenticazione. Oggi puoi usarlo solo da un client che ha già una sessione
> autenticata (es. uno script tuo che fa login e poi POST). È una scelta deliberata di
> questo sprint, non una svista: aprirlo davvero a fonti esterne è un progetto a sé
> (firma HMAC del corpo, timestamp anti-replay, whitelist del path, rate limit
> dedicato), non ancora pianificato.

Il segnale resta valido **5 minuti**, poi scade: un webhook arrivato durante un
disservizio non deve poter aprire una posizione mezz'ora dopo, su un mercato che nel
frattempo è cambiato. Questo TTL protegge solo dai segnali "vecchi" rimasti in coda:
non è una difesa anti-replay (un payload catturato e re-inviato entro i 5 minuti
verrebbe comunque accettato come nuovo).

---

## 16. Controllo via Telegram

Configura token e chat id **dal pannello** (vengono salvati **cifrati** sul database)
oppure via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

Ricevi notifiche su entrate, uscite, errori, limiti raggiunti e kill-switch, e puoi
comandare il bot dalla chat.

| Comando | Effetto |
|:---|:---|
| `/start`, `/help` | Menu di aiuto con i comandi supportati. |
| `/status` | Stato del server, equity e bot attivi. |
| `/saldo` | Saldo e margine del conto. |
| `/posizioni` | Posizioni aperte con PnL non realizzato. |
| `/bot`, `/bots` | Elenco dei bot configurati e loro stato. |
| `/avvia <bot>` | Avvia un bot. |
| `/ferma <bot>` | Ferma un bot. |
| `/chiuditutto` | **Kill-switch**: ferma tutto e chiude le posizioni. |
| `/proposte` | Elenca le proposte dell'Analyst AI in attesa. |
| `/approva <id>` | Approva una proposta. |
| `/rifiuta <id>` | Rifiuta una proposta. |

---

## 17. Sicurezza e gestione dei segreti

Quattro punti che vale la pena conoscere anche come semplice utente:

**1. L'agent non può prelevare.** È la garanzia strutturale: nessun software bug e
nessuna compromissione del server può far uscire i fondi dal tuo conto Hyperliquid.

**2. I segreti sono cifrati a riposo.** Chiavi agent e token Telegram sono salvati sul
database con AES-256-GCM. La chiave di cifratura è **versionata**, quindi **ruotabile**:
se sospetti un'esposizione puoi cambiarla senza perdere l'accesso ai dati esistenti.
Procedura completa nel [runbook di rotazione](DEPLOY.md#10-rotazione-della-chiave-di-cifratura--runbook).

**3. Il pannello è protetto da password** (hash scrypt) e sessione firmata. In
produzione l'app **si rifiuta di partire** se mancano i segreti critici: meglio un
server fermo di uno che opera senza le protezioni attese.

**4. Mainnet richiede due conferme esplicite.** Servono
`HYPERLIQUID_NETWORK=mainnet` **e** `ALLOW_MAINNET=true`. All'avvio compare un avviso
rosso, e nell'interfaccia le operazioni mainnet richiedono un wallet connesso.

Backup, esposizione di rete, rotazione delle chiavi e risposta a un incidente sono
trattati in [DEPLOY.md](DEPLOY.md).

---

## 18. Monitoraggio e metriche

- **`/health`** — endpoint di stato, da collegare a un servizio di uptime monitoring.
- **`/metrics`** — metriche in formato Prometheus: errori API, errori nei tick dei
  bot, ordini inviati, riconnessioni WebSocket, più gauge letti al momento dello scrape.
  Se `METRICS_TOKEN` è impostato, l'endpoint richiede il token; **altrimenti è
  pubblico**.
- **Log** — `docker compose logs` in produzione, `logs/app.log` con lo script di riavvio.

---

## 19. FAQ e troubleshooting

**Perché vedo ancora "Connetti MetaMask"?**
Il wallet non è collegato. Clicca **🦊 Connetti MetaMask** in alto a destra. Su
mainnet la connessione è obbligatoria per operare.

**Cosa significa "Agent Wallet pending approvazione"?**
La coppia di chiavi agent è stata generata sul server, ma manca la tua firma EIP-712
in MetaMask. Finché non firmi, l'agent non può inviare ordini.

**I miei fondi sono al sicuro in Testnet / Mainnet?**
In testnet si opera su rete di prova, senza denaro reale. In mainnet si usa
l'exchange reale con i tuoi USDC; l'agent ha permessi limitati ad aprire e chiudere
posizioni e **non può prelevare**.

**Il bot non apre mai una posizione. Perché?**
Apri il **Monitor** del bot: mostra l'ultima valutazione e la motivazione. Le cause
più frequenti sono, in ordine:
1. candele insufficienti a scaldare gli indicatori (su timeframe lunghi serve tempo);
2. conferma multi-timeframe non concorde;
3. gate ML sotto la soglia `minProb`;
4. un limite di portafoglio raggiunto o un cooldown attivo;
5. kill-switch inserito.

**Ho impostato TP/SL: restano attivi se il server si spegne?**
Sì. Sono registrati come trigger order **su Hyperliquid**, non gestiti in memoria dal
bot. È il motivo per cui vale la pena impostarli sempre.

**Il backtest è ottimo ma in reale va male.**
È il caso classico dell'overfitting. Verifica che l'ottimizzazione sia stata
walk-forward e guarda il risultato **out-of-sample**, non quello in-sample. Poi passa
dal **paper trading** (§9) prima del denaro reale: è lo stadio che separa una
strategia che ha funzionato sul passato da una che funziona adesso.

**L'Analyst AI ha proposto un'operazione ma non è stata eseguita.**
Le proposte richiedono approvazione esplicita e scadono dopo `AGENT_PROPOSAL_TTL_MIN`
minuti. Se l'hai approvata e comunque non è passata, è stato il gate di rischio a
bloccarla: la motivazione compare nel log di audit.

**Quanto mi costa l'Analyst AI?**
Dipende da modello e frequenza. Usa la modale di stima prima di lanciare un'analisi
on-demand e tieni `AGENT_MAX_CALLS_PER_HOUR` basso. Con `AGENTS_ENABLED=false` il
costo è zero e la piattaforma resta pienamente funzionante: gli agenti sono un
supporto, non un requisito.
