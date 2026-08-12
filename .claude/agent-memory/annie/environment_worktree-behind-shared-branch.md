---
name: environment-worktree-behind-shared-branch
description: A freshly spawned agent's worktree can start dozens of commits behind the shared branch and miss docs/KB/BACKLOG entirely — how to detect and fix it
metadata:
  type: project
---

A newly spawned agent's isolated worktree (`.claude/worktrees/agent-*`) is not guaranteed to be
checked out at the tip of the team's shared work branch (`feat/perps-hardening`). In Sprint 2 of
Release 2 my worktree started at commit `aef36cd`, 56+ commits behind — `docs/KB/BACKLOG` didn't
exist at all (no `sprint2.md`, no `sprint2-status/`), because the whole backlog-reorg + Sprint 1 +
Sprint 2 work had landed on `feat/perps-hardening` after that point. Bruno, Joshua and Maya all hit
the identical issue on their own worktrees that same sprint (see their `sprint2-status/*.json`
"AMBIENTE" notes) and fixed it the same way.

**Why it happens:** each spawned agent gets its own git worktree, and the shared branch name
(`feat/perps-hardening`) is usually already checked out in the main repo worktree — git refuses to
check out the same branch in two worktrees at once, so a plain `git checkout feat/perps-hardening`
inside the isolated worktree fails.

**How to detect it:** `ls docs/KB/BACKLOG/release2/` (or whatever path the task references) coming up
empty/missing is the tell. Don't assume the task instructions are wrong — check `git log --oneline -5`
first; if the branch/history doesn't match what the task describes, the worktree is stale.

**How to fix it, read-only-safe (what I did as Annie, who has no Edit and must not disturb others'
work):** confirm the shared branch is a strict ancestor with no commits of your own
(`git merge-base --is-ancestor <shared-branch> HEAD` fails, i.e. shared branch is NOT already merged,
means I'm behind), then create a **new local branch** pointed at the shared branch's tip commit
instead of trying to check out the shared branch name itself:
`git checkout -b <my-review-branch> <shared-branch>`. This works because it's a different ref
pointing at the same commit — no conflict with the other worktree that has the branch name checked
out. Verified afterward with `git log --oneline -3` and `ls docs/KB/BACKLOG/...` that the expected
files are now present. This never touches anyone else's files or history.

**How to apply:** at the start of any Sprint review task, if the expected backlog/status paths are
missing, check this first before concluding the task instructions are stale or the files don't exist.
See also [[sprint2-r2-review-outcome]] for what this unblocked in Sprint 2.
