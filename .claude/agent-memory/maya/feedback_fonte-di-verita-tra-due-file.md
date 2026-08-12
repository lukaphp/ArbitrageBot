---
name: feedback-fonte-di-verita-tra-due-file
description: Quando due file devono restare d'accordo, scegli come fonte di verità quello in cui la struttura porta significato per l'utente — e scrivi la regola dentro il file, non solo nel commit
metadata:
  type: feedback
---

Quando un task dice "allinea A a B **o viceversa**, dichiarando quale è la fonte di verità", la
scelta non va fatta sul costo del lavoro ma su **dove la struttura significa qualcosa per chi legge**.
E poi la regola va scritta nel file, non solo nel messaggio di commit: altrimenti la deriva torna alla
prima aggiunta fatta in un file e non nell'altro.

**Why:** DEBT-05 (Sprint 2 R2, 12 agosto 2026). `docs/MANUAL.md` e `public/manual.html` avevano una
sola sezione fuori ordine su 21. Allineare l'HTML al Markdown sarebbe stato banale (spostare un blocco
e una voce di nav) e rinumerare il Markdown era il lavoro più grosso — ma la nav dell'HTML raggruppa
le sezioni sotto **intestazioni che l'utente vede** ("Bot & Strategie", "Intelligenza Artificiale"), e
spostare "Indicatori tecnici" lì l'avrebbe messa sotto *Intelligenza Artificiale*: una classificazione
falsa (sono RSI/EMA/MACD, li usano le strategie dei bot). Nel Markdown l'ordine è solo un numero e non
porta significato. Quindi **fonte di verità = `manual.html`**, e il Markdown si rinumera. Conferma
indipendente che ha chiuso la decisione: `MANUAL.md` già dichiarava di sé, nella sua intestazione, di
essere "la versione testuale" di quella HTML — la scelta era già scritta, nessuno l'aveva applicata.

**How to apply:**
- Chiediti quale dei due file, se lo riordini, **cambia quello che l'utente capisce**. Quello è la
  fonte. Il costo di allineare l'altro non è un argomento: è solo lavoro.
- Cerca se uno dei due **dichiara già** il proprio ruolo (intestazione, README, commento): spesso la
  decisione esiste e non è mai stata fatta valere.
- **Scrivi la regola nel file** che si allinea ("sull'ordine la fonte è X; una sezione nuova va
  collocata prima in X"), e mettila sotto test. Un disallineamento del genere è invisibile: nessuno dei
  due file è sbagliato da solo, lo sono solo confrontati, quindi senza un test torna. La tabella di
  corrispondenza fra le due tassonomie (id HTML ↔ titolo Markdown) vive **nel test**: è l'unico punto
  del repo dove si toccano, e chi aggiunge una sezione deve passarci.
- Mentre ci sei, cerca le altre affermazioni che i due file fanno **sulla stessa cosa**: dicevano
  versioni diverse (2.8 e 2.7) pur dichiarando contenuto identico. È la stessa mezza verità dell'ordine,
  e nessuno la ricontrolla a mano. Vedi [[feedback-doc-riflette-codice]] e
  [[feedback-verifica-dod-frontend]] per gli script di verifica.
