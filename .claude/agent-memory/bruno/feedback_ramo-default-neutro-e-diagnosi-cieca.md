---
name: feedback-ramo-default-neutro-e-diagnosi-cieca
description: Un `default:`/fallback che ritorna un valore neutro (match:false, 0, null) è un fallimento silenzioso — e gli strumenti diagnostici che leggono lo stesso campo sono ciechi allo stesso modo, quindi non fidarti di loro per trovarlo
metadata:
  type: feedback
---

Quando un `switch` o una catena di `if` su un campo di **dati esterni** (config, payload, riga DB)
ha un ramo terminale che ritorna un valore *neutro* — `match: false`, `0`, `null`, `[]` — quello non
è un default, è un fallimento silenzioso: produce esattamente l'output del caso legittimo «nessuna
condizione soddisfatta». Sul percorso dei soldi va distinto: «non si è verificato» e «non ho saputo
guardare» sono due cose diverse e vanno dette diversamente.

**Why:** OPS-FLEET-02, 2026-09-22 (fix `BUG-RULESHAPE-01`). Sei bot su produzione, ~46 ore, zero
segnali diversi da `hold`, mentre l'RSI reale attraversava le soglie 33-133 volte per coin. Le
`entryRules` in `bots.config_json` erano state scritte da un agente in una forma non canonica: senza
`type: 'indicator'` e con `signal: 'open_long'` invece di `'long'`. `strategyEngine._evalRule` cadeva
sul suo `default: return { match: false }` — cioè un bot strutturalmente incapace di aprire, con
l'aspetto identico a un bot che aspetta il segnale. Nessun errore, nessuna eccezione, nessuna
metrica: il sintomo era **l'assenza di eventi**, e non c'è niente in cui inciampare.

La parte che è costata di più, e che è il vero insegnamento: **tutta la diagnostica era cieca nello
stesso identico punto**, perché legge lo stesso campo.
- `ind.requiredCandles` inizia con `if (rule.type !== 'indicator') return 0` → `getMonitor()`
  dichiarava `warmingUp: { candlesNeed: 0, ready: true }` su un bot che non poteva aprire.
- `bot._diagRule` cadeva sul suo ramo finale → la card Monitor, che esiste letteralmente «per capire
  perché è fermo», mostrava `label: undefined, hint: ''`.
- `lastEval.reason` diceva «Nessun segnale d'ingresso»: vera e inutile, descrive il **mercato**
  quando il problema è la **configurazione**. Il secondo ramo diceva perfino una cosa falsa
  («Segnale non consentito, direzione: both» — `both` non blocca nulla), mandando a cercare il
  problema nel posto sbagliato.

**How to apply:**
- Su un ramo terminale che interpreta dati esterni, chiediti sempre: *questo valore è
  distinguibile dal caso legittimo?* Se no, o si lancia, o si segnala (log **e** notifica, una per
  episodio — vedi [[feedback-fallimenti-money-path-non-silenziosi]]).
- **Prima** di debuggare con gli strumenti diagnostici interni, verifica che non dipendano dal campo
  che sospetti rotto. Qui monitor, warmup e `reason` si appoggiavano tutti a `rule.type`: erano tre
  conferme apparenti dello stesso errore. Vale la regola di
  [[feedback-guardrail-copre-solo-chi-scrive-lo-stato]]: verifica eseguendo, e da una sorgente
  indipendente (qui: ricalcolare l'indicatore fuori dal bot, come ha fatto jordan).
- Se normalizzi una forma non canonica invece di rifiutarla, normalizza **solo le deduzioni
  univoche** (qui: `type` deducibile da `indicator` presente; `open_long` → `long`) e restituisci
  l'elenco di ciò che hai corretto e di ciò che resta inservibile. Indovinare un caso ambiguo
  (`op`+`value` senza `indicator`: `price`? `funding`?) significa far operare il bot con una regola
  che nessuno ha scritto — è la stessa ragione per cui `strategySchema` rifiuta invece di
  aggiustare.
- Il punto dove normalizzare è **il choke point della decisione** (`strategyEngine.evaluate`), così
  nessun consumatore vede una forma diversa dagli altri; ma se l'oggetto viene letto anche fuori da
  lì (qui: `needFunding`, `warmupCandles`, `_diagRule` leggono `bot.config` direttamente), va
  canonicalizzato anche al suo ingresso nell'istanza, altrimenti ripari la decisione e lasci la
  diagnosi bugiarda.
- Memoizza l'avviso per **identità dell'oggetto** config (WeakMap), non per contenuto: un warn a
  ogni tick è rumore, cioè di nuovo silenzio.
