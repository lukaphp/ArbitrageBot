---
name: po-process-concerns-branch-review-tooling
description: PO's three process concerns raised at 2026-08-12/13 team retro — branch/master hygiene, story/review clarity, Jira/Taiga evaluation
metadata:
  type: project
---

At the team's first full retrospective (2026-08-12/13), the PO raised three distinct process concerns, none of them decided yet:

1. **Branch/master control** (PO's "Mad"): PO feels the team is losing control of branches, and wants everything merged back to master once a release is fully approved, at release close. This lines up with the cross-team worktree desync problem — see [[first-team-retro-findings]]. Not yet formalized as a process step.
2. **Story/review clarity** (PO's "Sad"): stories and reviews are written too tersely for the PO to understand what was actually done and its technical or functional utility. This is explicitly about how the orchestrator writes/presents stories and reviews for PO consumption — NOT about the rigor of the underlying work (which the retro reflections themselves show to be careful — e.g. Annie's real curl/API reproductions, Jordan's independent risk findings) nor about my aggregation (I don't author stories or reviews). Possibly connected to Joshua's point that aggregate.json now gets produced ad hoc inside PO review sessions by the orchestrator (see [[role-erosion-aggregate-json]]) — same session bottleneck could be compressing both artifacts. This is a hypothesis, not confirmed.
3. **Jira/Taiga evaluation**: PO is considering adopting a dedicated agile tool instead of the current docs/KB/BACKLOG JSON-file approach, but wants to weigh cost/benefit first. Explicitly framed as an evaluation to set up, not a decision made or an action to execute. Concrete pain points that could inform the evaluation criteria if PO wants to proceed: cross-sprint traceability of recurring blocked items (ADV-02→ADV-OPS-01, CI-01 deferred three sprints), visibility into acknowledged-but-unowned risks, and the story/review clarity complaint above.

**How to apply**: don't propose to implement any of these three unilaterally — all three require a PO decision (on process, on format, on tooling) or orchestrator-level workflow changes I can't execute myself (no Bash/Edit access). If asked to help, offer to prepare comparison/evaluation material rather than deciding.
