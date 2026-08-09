# Sprint 77 retrospective

**Numbers, completed-issue list and action items live in
[`plan/issues/sprints/77.md`](../../issues/sprints/77.md)** — under the rolling
budget-window model (#2751) the freeze record written by `freeze-sprint.mjs`
*is* the retrospective of record. This file carries the two post-mortems that
are too long to sit inline there.

---

## Post-mortem 1 — `git worktree prune` deleted another session's live worktrees

### What happened

A cleanup pass ran `git worktree prune` from inside the container. It removed
~25 worktree registrations, several belonging to a **live** session.

### Why it was wrong

This repo is worked from **two environments sharing one `.git`**:

| | repo path | worktrees |
|---|---|---|
| container | `/workspace` | `/workspace/.claude/worktrees/…` |
| host (macOS) | `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm` | `/private/tmp/js2-*` |

One `.git` means **one worktree registry**. From the container,
`/private/tmp/js2-*` does not exist, so `git worktree list` marks every host
worktree `prunable` and `prune` deletes it. The label describes *visibility from
the current mount*, not staleness.

### How we know it hit live work

- `js2-3836-control` was registered at `88e12f2` — the main tip from minutes
  earlier.
- `js2-3836-repair`'s branch advanced `b96b016 → 0fc0989` **between two
  consecutive commands** in the same investigation.
- Registry entries reappeared during the session (3 → 4), i.e. the other session
  was actively re-creating them.

### Blast radius

Bounded. Commits and refs live in the shared object store and were never at
risk; what died was registration plus any uncommitted working-tree edits.

### Recovery (host-side only)

`git worktree repair` from the container cannot fix host worktrees — their
`.git` files reference a host gitdir that does not resolve here.

```bash
cd "/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm"
git worktree repair /private/tmp/js2-*
```

### Prevention

- Never run `git worktree prune` from the container. Worktree cleanup is a
  **host-side** operation for this repo.
- Never treat `prunable` as a delete signal here.
- Before deleting a worktree directory, prove the content is recoverable. The
  cheap discriminator: `git hash-object <file>` then `git cat-file -e <sha>` —
  if the blob is already in the object DB, that exact content was committed and
  deletion loses nothing.

### The 283 orphans are the same bug, already fired

`/workspace/.claude/worktrees/` holds 283 directories against 4 surviving
metadata entries; `git status` inside them fails with *"not a git repository"*.
That is accumulated residue of this same cross-environment prune, ~47 GB on a
volume at 94% capacity. Cleaning it up is worthwhile but is **not** the trivial
`prune` it appears to be.

---

## Post-mortem 2 — "green" kept meaning "did nothing", twice

Two unrelated gates in this window reported success while doing no work:

1. **Summary sync (#3658)** — ran and reported SUCCESS at 18:29, 19:45, 21:27,
   22:28 and 23:32Z, committing nothing, while fresh baseline data existed. The
   landing page sat frozen at `15:43Z / 30390-43098` for ~9h.
2. **`quality`** — an early step aborting under `bash -e` skips the later gates
   entirely, while the step that did run reports fine.

The shared lesson: **a green conclusion is not evidence the job did its work.**
Diagnosis must confirm the *effect* (the commit, the artifact, the gate that
actually executed), never the *conclusion*. This cost real time here, because a
genuine promote outage looked unfixed when its visible symptom was a second,
independent bug.

Follow-up #3658 asks for the sync to **fail loudly** when it finds new baseline
data and produces no commit. That is still open — only the symptom is resolved.

---

# Structured retrospective — sprint 77

**Date**: 2026-07-31
**Window**: `sprint-77/begin` (bb5b414, 2026-07-24) → 88e12f2 (2026-07-30)
**Volume**: 1,541 commits · 671 merged PRs · 79 issues frozen (a floor, see I6)
**Baseline → final**: host 30,364 / 43,102 → 29,856 / 43,099 across an
`ORACLE_VERSION` 10 → 12 re-baseline — **not comparable, and not a regression**
(see `plan/issues/sprints/77.md`). Standalone highwater 22,626.

> Per the retro skill's step 6, the action items below are **proposed, not
> applied**. Only this document changed.

## What went well (with evidence)

- **The de-inflation shipped with a declared re-baseline** rather than by
  quietly absorbing the delta — `69493a7` bumps `ORACLE_VERSION` 11 → 12 as an
  explicit, reviewable act. The honest-floor discipline held under pressure to
  make the number look good.
- **A real merge-queue deadlock was root-caused, not worked around.** The
  symptom (promote failing identically on every push) had an obvious wrong
  explanation available (#3634's push race). Reading the actual log found a
  different cause.
- **The A/B that proved blast radius.** PR #3636 failed at 22:18Z on the stale
  baseline and passed at 23:01Z on the fresh one **with no code change** — a
  clean control, not an inference.
- **`reconcile-tasklist.mjs` is report-only for frontmatter.** That design
  decision is now vindicated by measurement: a naive flip would have been wrong
  half the time (I6).

## What didn't

### I1 — Change-scoped allowance evaporates in the post-merge promote
**What happened**: a declared `trap-growth-allow` resolves from the change-set,
so it applied at PR level and vanished in the promote job (`tolerance 0`). The
baseline pinned at `illegal_cast` 74 while main sat at 75; every push failed
identically.
**Impact**: four PRs (#3635, #3636, #3627, #3639) parked with identical
misleading verdicts; ~9h of queue confusion.
**Root cause**: allowance scope (change-set) ≠ gate scope (merged state).
**Residual**: the allowance is consumed by exactly ONE promote run — an
unrelated failure of that run re-creates the wedge (#3660).

### I2 — "Green" meant "did nothing", twice
**What happened**: the summary sync reported SUCCESS at 18:29/19:45/21:27/
22:28/23:32Z and committed nothing, with fresh data available (#3658). Separately,
`quality`'s early `bash -e` abort skips later gates while the step that ran looks fine.
**Impact**: the report page sat ~9h stale; a fixed outage looked unfixed because
the visible symptom was a *second, independent* bug.
**Root cause**: jobs report step conclusions, not effects.

### I3 — `git worktree prune` from the container killed the host's live worktrees
**What happened**: one shared `.git`, two mounts. Host worktrees at
`/private/tmp/js2-*` are invisible from `/workspace`, so they report `prunable`.
**Impact**: ~25 registrations deleted, several live (`js2-3836-repair` advanced
`b96b016 → 0fc0989` between two commands). Committed work survived; registrations
did not. Recovery is host-side `git worktree repair`.
**Root cause**: a cheap signal (`prunable`) treated as authoritative when it only
described visibility from one mount.

### I4 — Nobody froze at the budget rollover
**What happened**: `freeze-sprint.mjs`'s budget trigger is still unwired (#2751),
so freezing depends on a human running `--force` at the exact moment a budget
window closes — precisely when attention is scarcest.
**Impact**: sprint 77 was frozen days late and its record spans the intended tail
plus the following days, because the script re-tags by frontmatter, not by date.

### I5 — `--dry-run` is advertised but gated behind the trigger check
**What happened**: `freeze-sprint.mjs`'s usage block documents `--dry-run`, but
the no-op trigger check runs first, so a bare `--dry-run` previews nothing.
**Impact**: minor, but it cost a cycle and it makes the safe path look broken.

### I6 — The issue tracker is not a record of what landed
**What happened**: of 314 PRs merged since `sprint/76`, **132 (42%) carry no
issue reference**; 111 of those are substantive, 49 of them `ir`. Of the 182 that
do reference an issue, 112 pointed at one still open — but **only 12 could be
safely flipped**; half the rest were `docs(#N): file …` PRs that *created* the
issue they name.
**Impact**: "issues completed" is a floor, not a census. A 49-PR IR migration has
no auditable trail, which the #2855 coverage ratchet needs.

### I7 — `/workspace` rotted 1,279 commits behind
**What happened**: agents work in worktrees, so the shared checkout never
advances on its own.
**Impact**: stale reads; and catching it up disturbed a concurrently-live session.

## Action items

| # | Change | File | Priority |
|---|---|---|---|
| A1 | Wire the weekly-budget source so the freeze fires without a human | `scripts/freeze-sprint.mjs` (+ statusline cache) | HIGH |
| A2 | Evaluate `--dry-run` **before** the trigger gate | `scripts/freeze-sprint.mjs` | LOW |
| A3 | Required check: PR title must carry a `#NNNN` resolving to `plan/issues/`, with a recorded `no-issue:` escape | `.github/workflows/ci.yml`, `docs/ci-policy.md` | HIGH |
| A4 | Summary sync must FAIL when it finds new baseline data and produces no commit | summary-sync workflow (#3658) | HIGH |
| A5 | Forbid `git worktree prune` from the container; cleanup is host-side | `CLAUDE.md` (+ memory, already recorded) | HIGH |
| A6 | Reconciler reports `auto-flippable` vs `needs-judgment` as separate counts; never writes frontmatter for the second | `scripts/reconcile-tasklist.mjs` | MEDIUM |
| A7 | Persist a granted trap allowance alongside the baseline so it survives a failed promote run | `scripts/check-baseline-trap-growth.ts` (#3660) | MEDIUM |
| A8 | Auto-fast-forward `/workspace` after each merge | `scripts/sync-workspace-main.sh` via post-merge hook | MEDIUM |
| A9 | Adopt `fixes #N` / `files #N` in PR bodies so reconciliation stops inferring intent from commit type | `docs/ci-policy.md`, PR template | MEDIUM |

**Testable next window**: A1 → a freeze exists without anyone running `--force`.
A3 → the unreferenced-PR share drops below 42%. A4 → a sync that commits nothing
turns the job red. A5 → no host registrations disappear.

## Cross-cutting root cause

I1, I2, I3 and I6 are the same error in four costumes: **a cheap signal was
trusted as if it were the thing it stands for.** A green conclusion stood in for
work done; `prunable` stood for stale; a `#N` in a title stood for "this PR fixed
that issue"; a PR-level gate stood for the merged-state gate. The generalisable
rule — already load-bearing in this repo's memory as *measure, never
extrapolate* — is to **confirm the effect, not the proxy**, and to say plainly
which one you actually checked.
