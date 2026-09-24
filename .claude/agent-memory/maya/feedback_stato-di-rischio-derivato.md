---
name: feedback-stato-di-rischio-derivato
description: Rendere uno stato di rischio che il backend non espone come campo — cerca il campo diretto, match di prefisso con startsWith (mai includes, la coda è testo utente), e un'etichetta che accosta due numeri deve dichiarare la finestra di ciascuno
metadata:
  type: feedback
---

Quando un freno di rischio è già nel backend ma la UI deve mostrarlo, la domanda che mi arriva è
«fai un badge». Prima del badge ci sono tre decisioni che nessuno esplicita, e sbagliarne una
produce un pannello che *afferma* invece di *riportare*.

**Why:** OVERTRADE-01, 24 settembre 2026 — badge «Trade Velocity» sulla card bot, superficie utente
del freno di overtrading di Bruno. Il brief arrivava con la stringa del match già suggerita e il
testo del badge già scritto: entrambi andavano verificati, e uno dei due era falso.

**How to apply:**

1. **Cerca il campo diretto prima di scrivere il match, e dichiara che non c'è.** Il gate attivo non
   ha un booleano nello stato del bot: si riconosce solo da `lastEval`, che `_overtradingBlock()`
   scrive con `action: 'hold'` e un motivo nato in `checkOvertrading` col prefisso `Overtrading:`.
   Gli altri rami usano prefissi diversi (`Bloccato:`, `Sizing:`, `Portafoglio:`, `Cooldown
   post-perdite:`) ⇒ il match è esclusivo. Scrivi nel commento che il campo diretto è stato cercato
   e dove andrà messo il giorno che esiste: è l'unico punto da cambiare.
2. **`startsWith`, mai `includes`, e mettici una seconda condizione in AND.** La coda del motivo cita
   testo scritto dall'utente (nome del bot, parametri): con `includes` bastava chiamare un bot
   «Overtrading: tutto a posto» per accendere un badge rosso falso. Un caso di test su quel nome
   ostile vale quanto quelli sull'escaping. L'AND con `action === 'hold'` rende il riconoscimento
   non dipendente dal solo confronto testuale.
3. **Ordine di severità: un fatto già deciso dal backend batte una misura incerta.** Se il gate è
   attivo, il rosso vince anche su `openRate: null` — anzi il caso fail-closed (conteggio illeggibile
   ⇒ il bot si ferma per prudenza) è esattamente quello in cui il dato manca *e* il bot è bloccato.
   Il complemento di [[feedback-stato-ignoto-non-e-zero]]: «ignoto» non è zero, ma non è nemmeno più
   importante di un blocco già avvenuto.
4. **Un'etichetta che accosta due numeri deve portare la finestra/unità di CIASCUNO.** Il brief
   chiedeva `⚡ N/soglia aperture/30min`, ma `lastHour` conta su 60 minuti e la soglia vale su
   `windowMinutes` (30): «3/4 aperture/30min» dice al lettore che le 3 stanno dentro la mezz'ora, e
   il dato non lo dice. Ho scritto `⚡ 3 aperture/1h · max 4/30min` — stessa lunghezza, zero
   affermazioni gratuite — e l'ho dichiarato come scostamento voluto nello stato, non zitta.
   **Corollario che è il vero guadagno:** il numero che servirebbe («quante aperture nella finestra
   del freno *adesso*») era già calcolato a ogni tick lato backend e buttato via. Quando un'etichetta
   ti costringe ad approssimare, quasi sempre il dato esatto esiste già: chiedilo come candidato
   invece di girarci intorno (vedi [[feedback-segnalare-fuori-perimetro]]).
5. **Un badge «tutto bene» non si mostra.** Quattro esiti, ma due sono «niente»: freno disattivato e
   ritmo normale. Un badge su ogni card rende invisibili i due che contano. Stessa ragione per cui
   lo slot alert non viene emesso affatto quando è vuoto: un contenitore vuoto lascia un buco
   nell'angolo di ogni card tranquilla.
6. **Se due allarmi possono convivere nello stesso slot, uno solo può lampeggiare.** CRASH e «IN
   PAUSA» sono pari grado e compaiono insieme: condividono la classe base (stessa forma, stessa
   dimensione — a distinguerli è il colore), ma due elementi che pulsano a ritmi diversi si annullano
   a vicenda. Il lampeggio era già speso dal CRASH.

Collegati: [[feedback-tipo-nuovo-in-render-generico]] (stessa griglia applicata a un tipo nuovo in un
renderer generico), [[feedback-verifica-dod-frontend]] (come si dimostra rosso il caso di escaping).
