---
name: project-close-reason-non-distingue-tp-da-sl
description: TP vs SL è ora un fatto letto dall'oid del fill di chiusura (fix Sprint 4), ma solo per le posizioni chiuse da lì in avanti — lo storico precedente resta ambiguo e non va riclassificato
metadata:
  type: project
---

`close_reason` resta **testo libero**, ma dallo Sprint 4 il bot lo scrive sapendo *quale ordine* ha
chiuso: `_registerClose` riceve `null` dal ramo di riconciliazione e deduce il motivo confrontando
l'**oid dei fill di chiusura** con gli oid dei trigger che ha piazzato (`slOid` e i nuovi `tpOids`,
entrambi persistiti in `trailing_json`). Bucket prodotti da `db.closeReasonBucket`: `tp`, `sl`,
`manual_or_external`, `strategy`, `safety`, `trigger_or_external` (= non deducibile), `other`.

**Why:** prima la stringa era sempre `'chiusa (TP/SL o esterna)'` e nello stesso secchio finivano TP,
SL, chiusura manuale e kill-switch — qualunque breakdown alla Freqtrade era impossibile. La deduzione
va fatta **nel momento della chiusura**, mentre gli oid sono ancora in memoria: a posteriori il dato
non esiste più. Il PO ha approvato il fix in review Sprint 4 dopo che l'avevo segnalato come
candidato di refinement.

**How to apply:**
- **Non riclassificare lo storico**: le righe chiuse prima del fix restano in `trigger_or_external`.
  Dedurre TP/SL dal segno del PnL sarebbe circolare (il PnL è proprio ciò che si aggrega per bucket)
  e metterebbe numeri inventati accanto a numeri veri.
- **Il dubbio non diventa mai un'etichetta**: senza fill, senza `oid` nei fill, o senza alcun trigger
  tracciato, `_classifyCloseFills` ritorna `null` e si ripiega sulla stringa generica di sempre.
  Se un giorno l'assunzione «il fill di un trigger porta l'oid del trigger» risultasse falsa su
  Hyperliquid, il degrado è verso "non lo so", mai verso un'etichetta sbagliata.
- **`safety` va provato per primo** in `closeReasonBucket`: `'SL non garantito (chiusura di
  sicurezza)'` contiene "SL", e invertire l'ordine farebbe contare un guasto come uno stop normale.
- `paperBroker` ora mette nel fill l'oid del trigger che è scattato (prima lo buttava via): è ciò che
  rende il caso TP/SL esercitabile in test senza rete ([[feedback-seam-di-test]]).
