---
name: sprint2-r2-risk-review
description: Risk-lens review outcome for Sprint 2 of Release 2 (2026-08-12) — CRIT-05 correct but demo deploy needs risk_drawdown_state reset too (my own finding, beyond what Bruno/Annie flagged); DEBT-02 cap not wired for future ADV-05; CI-01 fail-open unaddressed
metadata:
  type: project
---

Reviewed Sprint 2 of Release 2 (`docs/KB/BACKLOG/release2/sprint2.md`) on 2026-08-12 with a risk
lens ("do these changes actually reduce the risk they claim to"), separate from Annie's correctness/
coverage review (10/10 pass, see her `project_sprint2-r2-review-outcome.md`). Full writeup in
`docs/KB/BACKLOG/release2/sprint2-status/jordan.json`.

**CRIT-05 (equity double-count fix) — correct, verified algebraically not just on the sample.** The
"opening a position doesn't change equity" property holds by construction in `composeEquity()`
(`spotAvailable = total - hold`), so the small sample (2 concurrent positions from the demo) isn't a
statistical-power problem the way a 7-trade profitability claim would be — it's confirming the
formula's real-world inputs behave as modeled, not proving the formula itself.

**My own addition beyond Bruno/Annie's notes:** deploying the fix to the demo instance (`:8091`)
needs `risk_drawdown_state` reset alongside `risk_equity_history`, not `risk_equity_history` alone.
`mergeDrawdownState()` in `riskSnapshot.js` computes `maxUsd`/`maxPct` as `Math.max(current,
persisted, ...)` — explicitly monotone by design. The ~$102 artificial equity drop on the first
post-fix tick would get written into `risk_drawdown_state` as a new max and stay there as a
permanent floor (every future drawdown reading maxed against it) even after `risk_equity_history` is
truncated/fixed. Neither Bruno's implementation notes nor Annie's review mention this second table.
See [[project_equity-doppio-conteggio-spot]] (Bruno's memory, not mine, for the underlying bug) for
the root-cause writeup this builds on.

**DEBT-02 (advisor tool-call cap) — correct today, but not wired for tomorrow.** The cap lives
inline inside `advisor.chat()`'s loop, not in a shared/reusable function. ADV-05 (risk-alert
comment, Epic D, not yet built — see `release2/README.md` §5.2) is exactly the "risk incident"
moment this cap was meant to matter for, but nothing forces whoever implements it to reuse `chat()`
or re-apply the cap in a new code path. Also found (not asked, but same class of gap): `analyst.js`
has the identical unguarded tool-use loop pattern DEBT-02 fixed in `advisor.js` — never capped,
and the Analyst runs unattended on a schedule (no human present to notice a runaway turn), which is
arguably higher exposure than the interactive chat DEBT-02 actually fixed.

**CI-01 (harden-runner block) — process worked this time, not yet repeatable by design.** Joshua's
allowlist-building process caught a real gap (cold-cache network paths invisible to 31 warm-cache
audit runs) and documented the lesson *inside* `ci.yml`'s comments, which is good. But there's no
checklist step forcing the next dependency change to repeat the cold-cache verification — the lesson
is narrated, not proceduralized. Also confirmed independently: harden-runner fail-open (degrades
block→audit silently on cache-host resolution failure, job stays green) is real and still open as of
this review.

**How to apply:** if asked about Sprint 2 R2 status or whether CRIT-05 has been deployed to the demo,
check current state of `risk_drawdown_state`/`risk_equity_history` on the demo DB rather than
assuming this snapshot still holds — this is frozen at 2026-08-12. If Sprint 3 (Epic D, ADV-04/ADV-05)
planning comes up, the DEBT-02 wiring gap and the analyst.js tool-cap gap are both worth re-raising
if they haven't been turned into explicit backlog items yet.
