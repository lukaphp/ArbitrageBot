---
name: environment-worktree-behind-shared-branch
description: A freshly spawned agent's worktree can start dozens of commits behind the shared branch and miss docs/KB/BACKLOG entirely — check git log before concluding files don't exist
metadata:
  type: project
---

Same issue Annie/Bruno/Joshua/Maya all independently hit in Sprint 2 of Release 2 (see their
`sprint2-status/*.json` "AMBIENTE" notes and Annie's own
`environment-worktree-behind-shared-branch.md`): a freshly spawned agent's isolated worktree
(`.claude/worktrees/agent-*`) is not guaranteed to be checked out anywhere near the tip of the
team's shared work branch (`feat/perps-hardening`). I hit it too, dispatched for the Sprint 2 risk
review — my worktree was at `aef36cd`, 69 commits behind, with no `docs/KB/` at all.

**How I detected it:** the task referenced `docs/KB/BACKLOG/release2/sprint2.md` and it wasn't there;
`git branch -a` showed `feat/perps-hardening` existed as a ref, and `git log --oneline -5` didn't
match what the dispatch described. That mismatch is the tell — don't conclude the files don't exist
or the task is wrong before checking this.

**How I fixed it (I have Bash but no Edit, same constraint as Annie):** confirmed my `HEAD` was a
strict ancestor of the shared branch with zero commits of my own
(`git merge-base --is-ancestor HEAD feat/perps-hardening`, `git status --porcelain` clean), then ran
`git merge --ff-only feat/perps-hardening` directly on my own worktree branch — no need for Annie's
extra `checkout -b` step, since my worktree's branch name is already distinct from
`feat/perps-hardening` (it's not the shared branch itself checked out here), so a plain fast-forward
merge worked with zero conflicts, including on a file I'd already written before discovering the
staleness (git merged it in cleanly since the incoming tree didn't touch that path).

**How to apply:** at the start of any sprint review/analysis task, if the expected backlog/status
paths are missing, run this check *before* reading further or writing anything — writing a status
file into a stale tree first (as I did) still works via `merge --ff-only` afterward, but it's cleaner
to check first. See [[environment-worktree-behind-shared-branch]] is Annie's version of this same
lesson if it ever needs cross-checking; this one is mine so it survives in my own memory directory
independently of hers.
