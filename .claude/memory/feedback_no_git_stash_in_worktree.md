---
name: no-git-stash-in-worktree
description: "Never use `git stash` in an agent worktree — the stash stack is shared across all worktrees of the same .git, so concurrent agents clobber each other's stashes"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

Never run `git stash` / `git stash pop` inside an agent worktree under `/workspace/.claude/worktrees/`.

**Why:** All worktrees of a repo share one `.git` and therefore ONE stash stack. When multiple dev agents work concurrently, `git stash` from agent A and `git stash` from agent B interleave on the same stack. A later `git stash pop` then pops *whoever's* stash landed at `stash@{0}` — not necessarily your own. Observed 2026-05-27 on issue-1602: stashing to test a clean baseline, another agent's #1529 WIP got popped into my worktree and my own 1602 edits were buried deeper in the stack. Recovering required `git stash list` + `git stash apply stash@{N}` by explicit ref and re-stashing the misplaced work with a recovery label.

**How to apply:** To compare against a clean baseline without your changes, do ONE of:
- `git diff > /tmp/mywork.patch`, `git checkout -- <files>`, run baseline, then `git apply /tmp/mywork.patch`; or
- spin up a separate throwaway `git worktree add` on origin/main and run the baseline there; or
- just `git commit` your WIP first (commits are per-branch, not shared) and compare commits.
If you ever DO find a stash collision, never `git stash drop` — use `git stash list` and `git stash apply stash@{N}` by explicit ref, and re-stash any misplaced work with a `MISPLACED-...recover` label so the rightful owner can find it. Related: [[feedback_no_stash_before_merge]].

**Recurred 2026-05-27 on issue-1332** despite this rule: stashed a 1-line runtime.ts fix to measure a baseline; a concurrent agent (issue-1682) pushed its own stash and my entry vanished from the stack entirely (working tree came back clean, fix lost). Recovery was trivial only because the change was tiny and I had the verbatim diff in context — re-applied via Edit. Lesson reinforced: for a SMALL change, never stash at all; if you must measure a baseline, `git commit` the WIP first (per-branch, never shared) or use a throwaway `git worktree add origin/main`.

## Project-lead refinement (2026-08-13): the rule is about CONTENTION, not the command

`git stash` is permitted when the stash stack cannot be contended: **in an
isolated worktree/clone no other agent touches** (e.g. a harness-managed
per-agent worktree of a repo whose other worktrees have no active agents), or
**when you are provably the only agent working on that copy**. The hazard was
never the command — it is two writers interleaving on one shared stack. When
ANY concurrent agent shares the same `.git` (the normal state in this repo's
multi-agent worktree setup), the full prohibition stands, and commits / file
copies / throwaway worktrees remain the default tools. When in doubt about
whether another agent is active on the same repo, assume contention and do not
stash.

## ⚠ The `cp` workaround has its OWN hazard: never restore ACROSS a moved base

Measured 2026-08-02, a near-miss caught only by a diffstat.

CLAUDE.md recommends **file copies** as the safe alternative to `git stash` for a
revert-and-measure A/B cycle. That is correct **within one tree state**. It is
**wrong for restoring work onto a base that has moved**, and the failure is
silent.

An agent finished on a branch that then merged. Its next change needed a fresh
branch off current `main`, so it saved its three files, branched, and copied
them back. The diffstat came back **161 insertions / 102 deletions** where it
expected **+50 / −10** — `regexp-standalone.ts` had advanced on main, and the
restore would have **silently reverted other people's landed changes inside an
otherwise-green 13-flip PR**. Nothing would have flagged it: the tests pass, the
gates pass, and the reverted work belongs to someone who is not reviewing.

**The rule:**

> After rebasing / branching onto a moved base, restore work as a **PATCH**,
> never as a whole-file copy — and **check the diffstat matches what you
> actually changed.**

```bash
git diff > /tmp/mine.patch          # BEFORE moving
git switch -c new-branch <fresh-base>
patch --dry-run -p1 < /tmp/mine.patch   # confirm hunks apply
git apply /tmp/mine.patch
git diff --stat                     # MUST match your own change size
```

**The diffstat is the only cheap signal**, and it is a good one — hunks applying
"with offsets" is normal and fine; a line count several times larger than your
own change is not. Same family as the stash hazard (clobbering a concurrent
agent's work), but it arrives through an innocuous `cp` rather than a command
this file already warns about.

**Corollary:** after any restore-onto-moved-base, re-measure on the **new** base
rather than quoting the pre-move numbers, and if a control ran pre-move, say so
explicitly instead of letting it imply coverage it does not have.
