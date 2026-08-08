---
name: feedback-doc-riflette-codice
description: La documentazione utente deve descrivere il comportamento reale del codice, non quello desiderato — verificare sempre nel sorgente prima di scrivere
metadata:
  type: feedback
---

Prima di scrivere o correggere una sezione di `MANUAL.md` / `manual.html`, verifica il comportamento
nel sorgente. Se una feature non è utilizzabile per lo scopo che il testo le attribuisce, il manuale
deve dirlo esplicitamente, con la ragione e cosa servirebbe per abilitarla davvero.

**Why:** in SEC-04 (Sprint 1) la sezione webhook presentava `POST /api/perps/webhook` come pronto per
TradingView/TrendSpider. In realtà la rotta sta sotto il gate `requireAuth` applicato a tutte le
`/api/*` tranne login/logout/auth-status, quindi un servizio esterno senza cookie di sessione non
può chiamarla. Dettaglio scomodo ma istruttivo: quella affermazione sbagliata era in una sezione
scritta da me poco prima nello stesso sprint — non l'aveva introdotta qualcun altro. Il PO ha
confermato l'opzione B (endpoint interno, documentazione corretta) invece di aprire l'endpoint.

**How to apply:** vale per ogni claim di integrazione ("puoi collegare X", "compatibile con Y") e per
ogni affermazione di sicurezza. Il pattern di scrittura validato dal PO è: dichiarare lo stato reale
in grassetto, spiegare *perché* è una scelta e non una svista, ed elencare cosa servirebbe per
cambiarla — così nessuno la "riscopre" tra sei mesi come un bug. Stesso trattamento per le mezze
verità: il TTL di 5 minuti sui segnali esterni non è una difesa anti-replay, e il manuale lo dice.
Collegati: [[feedback-segnalare-fuori-perimetro]], [[feedback-task-fe-assente]].
