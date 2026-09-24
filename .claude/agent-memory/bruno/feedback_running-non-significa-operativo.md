---
name: feedback-running-non-significa-operativo
description: Prima di spingere una config sulla flotta, verifica che ogni bot possa DAVVERO agirci — `status='running'` e tick regolari convivono con un bot strutturalmente incapace di aprire (entryRules assenti)
metadata:
  type: feedback
---

Prima di applicare una modifica operativa di configurazione a bot in produzione, verifica che
ciascuno di quei bot sia in grado di **usare** ciò che gli stai dando. `status='running'` non
significa operativo.

**Why:** il 2026-09-15, incaricato di spingere timeframe più rapidi + partial TP sulla flotta VPS,
ho letto lo stato fresco e trovato 6 bot tutti `running`, tutti che ticcano puntualmente, nessun
errore, watchdog silenzioso — e **nessuno con `entryRules` in config**. Ogni `lastEval` diceva
«Nessuna regola d'ingresso configurata» (`strategyEngine.js`), zero trade e zero righe `positions`
da quando esistono. Applicare `candleInterval: '5m'` e una scala di TP parziali lì dentro sarebbe
stato un **no-op travestito da intervento**: un timeframe più corto su un bot senza regole vuol dire
solo valutare «hold» più spesso, e una scala di uscita si applica a posizioni che non nasceranno
mai. Il PO avrebbe visto un cambio di config applicato con successo e concluso che la flotta era
stata resa più aggressiva.

**How to apply:**
- Leggi lo stato **runtime**, non la riga DB: `/api/perps/bots` espone `lastEval`, `lastTickAt`,
  `stats` e la `config` effettiva dell'istanza in memoria. La riga `bots` dice cosa è configurato,
  `lastEval` dice cosa sta **succedendo** — ed è l'unico dei due che si accorge di una config
  inerte ([[feedback-guardrail-copre-solo-chi-scrive-lo-stato]]: verificalo eseguendo, non
  leggendo).
- Controprova che costa nulla: passa la config di ciascun bot a
  `strategySchema.validateStrategyConfig()`. È già in grado di dire «nessuna regola d'ingresso: un
  bot così non aprirebbe mai una posizione» — la stessa diagnosi, da una funzione pura, senza
  toccare la produzione.
- Verifica anche che i **flag** nella config siano consumati da qualcuno: un `grep` su `src/` di
  ogni chiave non standard. Su quella flotta `useMultiFeedSentiment` e `usePredictionSentiment`
  non comparivano in nessuna riga del repo — residui di codice mai integrato
  ([[hotpatch-vps-20260914]]), inerti ma con l'aspetto di una feature attiva.
- Se il blocco emerge, **fermati e riportalo invece di applicare comunque**: la precondizione
  (definire una strategia d'ingresso, ricreare o fermare la flotta) è una decisione di prodotto.
  Prepara il payload esatto lo stesso, così la decisione arriva completa.

**Seconda occorrenza, stessa flotta, difetto più subdolo (2026-09-22, fix `BUG-RULESHAPE-01`):** i 6
bot avevano finalmente `entryRules`, ma in una forma che il motore non sapeva leggere (`type`
assente, `signal: 'open_long'`), quindi di nuovo ~46 ore a `hold` fisso. Qui la controprova col
`validateStrategyConfig` suggerita sopra **avrebbe funzionato** — sa già dire «tipo non
riconosciuto» — mentre `lastEval.reason` diceva «Nessun segnale d'ingresso», indistinguibile da un
mercato fermo. Lezione aggiuntiva: non basta controllare che `entryRules` **esista**, va controllato
che ogni regola sia **valutabile**. E non fidarti di `getMonitor()` per scoprirlo: era cieca nello
stesso punto — vedi [[feedback-ramo-default-neutro-e-diagnosi-cieca]].

**Terza forma, dall'altra parte (2026-09-24, `SYNC-RESTART-01`):** anche l'istanza **in memoria** può
mentire su sé stessa. `bot.status === 'running'` con `bot.timer` già a null è uno stato reale —
`shutdown()` lo produce di proposito, e un'istanza sostituita nella Map ci resta dentro. Il fatto è
`status === 'running' && timer != null` (ora `PerpsBot.isTicking()`); `status` da solo è l'etichetta.
Conseguenza pratica trovata scrivendo il test, non leggendo il codice: `PerpsBot.start()` era
idempotente **sull'etichetta** (`if (this.status === 'running') return`), quindi su un'istanza zombie
non ripartiva mai — il caso peggiore dei tre, perché è l'unico in cui anche la UI dice «running».
Regola generale: una guardia di idempotenza si scrive sulla **risorsa osservabile** (il timer, il
socket, il file descriptor), non sul flag che dovrebbe descriverla.

**Corollario per il codice:** la stessa asimmetria vale per qualunque diagnosi automatica di
"bot fermo". Un watcher che propone di accorciare il timeframe a un bot senza `entryRules`
propone una cura finta per una diagnosi sbagliata: la causa va dedotta dalla **config**
(`entryRules` presenti o no), non dal testo di `lastEval.reason`, che è una frase per un essere
umano e verrà riformulata prima o poi. Vedi `src/agents/inactivityWatcher.js`.
