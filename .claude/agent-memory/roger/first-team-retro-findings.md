---
name: first-team-retro-findings
description: Cross-cutting findings from Nautilus team's first full retrospective (2026-08-12/13), covering whole project to date
metadata:
  type: project
---

Team held its first full retrospective 2026-08-12/2026-08-13, explicitly requested by the PO, covering the entire project so far (not a single sprint). Format: Glad/Sad/Bad per person (Bruno, Joshua, Maya, Annie, Jordan) plus the PO as Scrum Master (Glad/Mad/Sad). I (Roger) received all six reflections as text in the dispatch, never written to files — they are not independently re-checkable by me, and I was told not to touch repo files for this task.

Cross-cutting findings, each reported independently by multiple people without coordinating with each other:

- **Worktree/branch desync**: 5 of 6 reflections (Bruno, Joshua, Maya, Annie, Jordan) independently hit a stale/behind worktree (missing recent commits, missing their own prior memory file) at session start, each documenting their own workaround without anyone fixing the root cause. Jordan explicitly names this pattern ("ciascuno documentando la propria soluzione senza che nessuno lo risolvesse alla radice per tutti"). Ties directly to the PO's separate complaint about losing control of branches and wanting merge-back to master at release close — see [[po-process-concerns-branch-review-tooling]].
- **Acknowledged-but-unowned risk**: several known issues sit in a "recognized in review" limbo without an explicit PO decision to fix/defer/reject: harden-runner fail-open (flagged by Joshua, confirmed independently by Annie, prioritized by Jordan, but sitting in a refinement list with no owner — Joshua explicitly wants an explicit "not now" from the PO instead of silent consensus standing in for a decision), the green Max Drawdown badge Maya flagged (still live post-deploy — "riconosciuto non è pianificato"), ADV-02 criterion 5 recurring as ADV-OPS-01 still blocked (Bruno), and the >24h gap between Jordan's CRIT-05 code fix landing and it reaching the live demo instance he was actively presenting from.
- **"Documented" vs "actually run/executed"**: recurring failure mode — DEPLOY.md described a key-rotation procedure that was never actually runnable (wrong DB column), CI-01 had 31 green audit runs that never touched cold-cache network paths, Maya found MANUAL.md/manual.html version numbers diverging for a year unnoticed. Bruno explicitly proposes (his stated hope) making "has this literally been run for real, where else does this same defect live" a permanent Definition of Done line.
- **My own role**: Joshua reports that the aggregation mechanism described in my role (reading sprint2-status/*.json to produce aggregate.json) has been superseded — aggregate.json in Release 2 apparently has `producedBy: claude` (the orchestrator), produced directly in PO review sessions, not by me. Unverified directly by me (Joshua's reflection is the only source). See [[role-erosion-aggregate-json]].

Also flagged (lower-priority for me specifically): Bruno/Maya module-boundary tension — the analyst/frontend contract between them is protected only by Bruno's manual diligence, never by an interface test (ANA-01 closeReasons shape mismatch, LLM-04 stale static claim in index.html). Maya experiences the same events positively (Bruno catches what she's chasing) rather than flagging it as a risk herself — same fact, two different framings, no actual disagreement between them.

**How to apply**: when asked about sprint/release process health, or when producing future aggregate/status reports, keep these patterns in mind as known, PO-acknowledged-but-not-yet-resolved systemic issues, not surprises to rediscover.
