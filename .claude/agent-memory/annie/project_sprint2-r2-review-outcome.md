---
name: sprint2-r2-review-outcome
description: Review verdict for Sprint 2 of Release 2 (10 stories, Bruno/Joshua/Maya) — all pass, two with a minor honestly-self-disclosed gap, one pending PO deploy decision on CRIT-05
metadata:
  type: project
---

Reviewed and verified (independently, not transcribed) all 10 `ready_for_review` stories of Sprint 2
Release 2 on 2026-08-12: CI-01, LLM-PRICE-01 (Joshua); DEBT-02, LLM-02 (incl. LLM-03), LLM-04, CRIT-05
(Bruno); DEBT-03, DEBT-04, DEBT-05, DEBT-06 (Maya). Full results and verification method are in
`docs/KB/BACKLOG/release2/sprint2-status/annie.json`.

**Outcome:** all 10 pass. Two carry an honestly self-disclosed partial criterion (not something I
found — the implementers flagged it themselves and I confirmed the flag was accurate, not an
omission): LLM-PRICE-01 criterion 1 (one OpenRouter DeepSeek price is a declared range-estimate, not a
pinned verified value) and LLM-04 criterion 2 second half (heuristic-vs-real calibration needs a real
Anthropic API call, blocked on the same PO real-spend decision as ADV-OPS-01/LLM-VAL-01).

**Why:** npm test 648/648 and npm run lint clean at the sprint's final commit (`4c55c38` on
`feat/perps-hardening`). I independently re-ran every relevant test file, flipped each fix back to its
pre-fix state and confirmed the exact red-test counts implementers claimed (e.g. CRIT-05:
equityComposition 11/13 red, equityAccountContract exactly 1/6 red when the old `accountValue +
spot.total` formula is restored), then restored and reconfirmed green. For CI-01 I independently hit
the GitHub API for the harden-runner SHA and used `gh run view --log` on the three real CI runs
Joshua's branch produced (`feat/ci-01-egress-block-verify`, never merged/PR'd) to confirm the exact
domains blocked, not just his notes.

**Open item needing a PO decision, not blocking the code review:** CRIT-05 is correct, but
`risk_equity_history` on the demo instance (`:8091`) still holds equity values inflated by the
pre-fix double-count. Deploying the fix there will show an instantaneous ~$102 drop that isn't a real
loss — drawdown/alerts would misread it. Bruno left three options undecided (do nothing / truncate the
demo series / recompute historical rows — discouraged). Needs a PO call before deploying CRIT-05 to
the demo instance specifically (mainnet is unaffected, the bug was latent there).

**How to apply:** if asked about Sprint 2 R2 status, this is current as of 2026-08-12. If the
CRIT-05/demo-history decision surfaces again, check whether the PO has since chosen an option before
assuming it's still open — this memory is a snapshot, not a live status feed (see
`docs/KB/BACKLOG/release2/sprint2-status/*.json` for the current state). See
[[environment-worktree-behind-shared-branch]] for how I got access to the code to review it.
