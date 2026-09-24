---
name: feedback-nan-attraversa-ogni-guardia
description: Un NaN sul percorso dei soldi non viene fermato da nessun controllo, perché ogni confronto con NaN è falso — dove nasce in questo repo e come si chiude
metadata:
  type: feedback
---

Su un percorso che calcola quanto si compra, **un NaN è peggio di un'eccezione**: ogni confronto con
NaN è falso, quindi attraversa *tutte* le guardie difensive scritte come `if (x <= 0)` o
`if (x > tetto)` e arriva intatto all'ordine.

**Why:** verificato eseguendo, BUG-SIZECAP-01 (2026-09-23). Con `sizing` privo di `value` il ramo
statico calcolava `equity × (undefined/100)` = NaN, e la catena rispondeva: `plan.size <= 0` → falso,
`riskManager.checkLimits` → `{ok: true, reason: 'OK'}`, Budget Ceiling `NaN > 500` → falso. La size
NaN arrivava a `placeMarketOrder`. È esattamente lo scenario che il commento di SEC-05 descriveva per
`equity`/`price` — lì c'è una guardia che **lancia**, ma un campo diverso lo ha riaperto.

**How to apply:**
- Nei calcoli di size/notional valida **ogni** ingresso numerico che viene dalla config, non solo
  quelli di cui ti fidi meno: `Number(x)` + `Number.isFinite` + `> 0`, e fail-**closed** (size 0 con
  motivo, o eccezione) — mai propagare.
- Quando aggiungi una guardia difensiva, chiediti che cosa risponde **con NaN in ingresso**: se
  risponde "passa", non è una guardia.
- Il piano restituito porta il motivo (`plan.blocked`) e il chiamante I/O lo dice: un'apertura
  mancata su un segnale valido è un evento, va loggato e notificato — una volta per episodio, non per
  tick ([[feedback-fallimenti-money-path-non-silenziosi]]).
- Un test onesto qui assert su `!Number.isNaN(...)` **e** sul fatto che la size non raggiunga il
  broker (posizione `null` dopo `_openPosition`): il solo controllo sul valore non dimostra che la
  catena si sia fermata.

Collegati: [[feedback-stesso-parametro-due-percorsi]], [[feedback-seam-di-test]].
