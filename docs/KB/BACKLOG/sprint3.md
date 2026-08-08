# Sprint 3 — Backlog in raccolta

**Team:** Nautilus · **Stato:** non pianificato — nessuna sessione di planning con il PO è ancora
avvenuta (a differenza dello Sprint 2, che ha introdotto la ceremony di planning l'8 agosto). Questo
file raccoglie i candidati verificati man mano che emergono, come faceva `sprint2.md` §0 prima della
sua sessione di planning. Nessuno di questi è ancora un task assegnato: story point, owner e criteri
di accettazione si definiscono in planning, non qui.

---

## 0. Candidati raccolti

| # | Candidato | Origine | Verificato sul codice | SP stimati |
|:--|:---|:---|:---:|:--:|
| 1 | Comando Telegram per il kill-switch (on/off) | Maya, durante UI-01 (Sprint 2, fuori planning) | ✅ | 1-2 |

### 0.1 · Comando Telegram per il kill-switch

**Descrizione.** UI-01 (Sprint 2) ha corretto l'assenza di un modo per **disattivare** il kill-switch
dall'interfaccia web. Nello stesso lavoro, Maya ha verificato che **Telegram non offre alcun comando
per il kill-switch**, né per attivarlo né per spegnerlo: `_cmdCloseAll` (`src/perps/telegramControl.js:237`,
comando `/chiuditutto`) chiude le posizioni aperte ma non tocca il flag `settings.killswitch` né ferma
i bot. Un operatore che ha accesso solo alla chat Telegram — lo scenario per cui il bot invia notifiche
in primo luogo — non può né fermare né riprendere le aperture da lì.

**Cosa serve, indicativamente** (da raffinare in planning):

- Un comando `/killswitch` (o due comandi distinti `/killswitchon` / `/killswitchoff`) che chiami
  `riskAgent.setKillSwitch(...)`, simmetrico a quanto ora esiste in `public/perps.js` per il web.
- Stessa cautela già applicata in UI-01: il comando di disattivazione non deve implicare il riavvio
  dei bot fermati — resta una scelta separata.
- Verificare chi può eseguire comandi Telegram sul bot (autenticazione/allowlist chat id, se esiste)
  prima di esporre un comando che sblocca le aperture — un kill-switch disattivabile da chiunque scriva
  al bot sarebbe un problema nuovo, non solo una feature mancante.

**File coinvolti (da confermare in planning):** `src/perps/telegramControl.js`, `docs/MANUAL.md` §16
(tabella comandi), `public/manual.html`.

**Origine:** Maya, refinement candidate lasciato in `docs/KB/BACKLOG/sprint2-status/maya.json`,
promosso a story su richiesta del PO l'8 agosto 2026 (vedi `sprint2.md` §4.1).

---

## 1. Altri residui aperti, non ancora promossi a candidato

Segnalati durante lo Sprint 2 ma lasciati come nota, non ancora valutati per l'inclusione in questo
sprint — riportati qui per non perderne traccia, si decide in planning se promuoverli:

- `npm run lint` non copre `public/*.js` (`scripts/lint-syntax.js` ha `roots = ['src','test','scripts']`) — un errore di sintassi in `perps.js` (~1900 righe) passerebbe la CI in silenzio. (Maya, UI-01)
- `POST /api/agents/killswitch`: `req.body?.on !== false` attiva il kill-switch anche su body malformato o `{"on":"false"}` (stringa). Direzione fail-safe ma da rendere esplicita. (Maya, UI-01)
- Asimmetria di notifica: l'attivazione del kill-switch notifica su Telegram/log, la disattivazione no. (Maya, UI-01)
- `ws_reconnects_total` conta insieme drop reali e ri-sottoscrizioni volontarie da cambio rete — un contatore separato è stato suggerito da Bruno (WS-01, Sprint 2).
- `secretBox.js` ricade silenziosamente su una chiave di sviluppo hardcoded se la variabile di cifratura è assente — nessun test la copre. (Annie, TEST-01)
- `rotate-encryption-key.js` confronta solo l'id della chiave, non il materiale, per decidere se ri-cifrare — disallineamento silenzioso possibile. (Annie, TEST-01)
- Rating "Sforzo: Basso" per l'apertura del webhook a TrendSpider in `INDEX.md` §1.1, probabilmente sbagliato. (Maya, DOC-02)
- Duplicato AOLM e typo nel nome file in `INDEX.md` §4, residui pre-Sprint-1. (Maya, DOC-02)

---

*Prossimo passo: sessione di planning con il PO, sul modello di `sprint2.md` §0.1, quando si deciderà di avviare lo Sprint 3.*
