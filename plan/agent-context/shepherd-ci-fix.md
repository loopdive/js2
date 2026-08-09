# PR-queue shepherd — session context (2026-07-30/31)

Role: PR-queue shepherd. Brief: take every open PR not merging cleanly, diagnose
it, fix it, drive it to merged.

## Outcome

**11 PRs driven to merged**: #3859, #3864, #3865, #3866, #3867, #3868, #3869,
#3871, #3873, #3874, #3875 — plus later #3876, #3879, #3880, #3882.
**Nine needed a manual one-shot enqueue. All nine were one bug (#3878), now
fixed and merged.** No PR was ever re-enqueued; no push was ever made to a
queued PR.

Issues filed from evidence: **#3881**, **#3883**, **#3884**, **#3886**,
**#3889**. Fixes landed: **#3878**, **#3889**.

## The two CI defects fixed

### #3878 — `release-pending` failed on EVERY fork-head PR

`retarget-stacked-pr-children.mjs:495` compared the PR's head **repository**
against `expected.repo` = `GH_REPO`, the **base** repo. A head repo is fixed at
PR creation and is the fork for every PR this team opens, so the disjunct was
unconditionally true. A red **non-required** check drives `mergeStateStatus` to
`UNSTABLE`, and `auto-enqueue` accepts only `{CLEAN, HAS_HOOKS}` — so every team
PR stranded, invisibly, while looking green.

**Not a missing fork-head special case — a category error.** The comparison
never meant anything; the fix deletes the disjunct and keeps the SHA guard.
The "obvious" fix (mirror the sibling's benign no-op at `:305`) **would have
regressed**: `isImmediateOpenChildByRef` filters children on **base** repo only,
so a fork-head PR *can* legitimately carry `stack-retarget-pending`, which is in
`HOLD_LABELS` — an early return would strand it permanently.

### #3889 — auto-enqueue's trigger allowlist misses non-required workflows

`workflow_run: workflows: ["Test262 Sharded", "CI"]` covers all *required*
checks, but `mergeStateStatus` is driven by **all** checks. When
`Refresh Benchmarks` (`measure-and-gate`) finishes **last**, the PR flips
`UNSTABLE → CLEAN` with **no trigger**, and waits for the ~30-min cron.
Narrow fix (add the workflow); general fix (any-completion + existing guard)
deferred on Actions-quota grounds. **The allowlist is a maintenance trap that
breaks silently** — recorded in both the issue and the workflow comment.

## Reusable techniques

- **Runtime-confirm a disjunct** by making the *other* one false by construction.
  Called the live function against real PR #3876 with `expected.headSha` set
  equal to the real head SHA; it still threw, proving the repo disjunct fired.
  Converted a read-from-source claim into a measured one.
- **Kill-switch every test.** Restore the pre-fix condition and confirm the test
  fails with the *exact production error*. A test nobody has watched fail is not
  a test — a probe that scored 6/6 identically on harmful and fixed code was
  mistaken for validation earlier this session.
- **`PUT /pulls/N/update-branch` with `expected_head_sha`, not `git push`**, when
  a PR needs a catch-up merge. Branch authors keep worktrees checked out by
  default here; pushing into a live branch is the clobber hazard. The API
  touches no tree. Confirmed necessary on #3876.
- **Read state, never infer it from tool behaviour** — see allocator below.
- **Count `fail`-conclusion checks; don't eyeball.** A *pending* required check
  reads as `BLOCKED` exactly like a *failing* one.

## Traps hit, with counts

- **Stale `origin/main`: SIX times.** `git fetch origin main` does not reliably
  advance `refs/remotes/origin/main`. Always
  `git fetch origin '+refs/heads/main:refs/remotes/origin/main'` then verify
  `git rev-parse origin/main` against
  `gh api repos/loopdive/js2/commits/main --jq .sha`. Every miss produced a
  confident wrong answer.
- **`claim-issue.mjs --allocate` fails in BOTH directions.** Five times it
  crashed/ref-locked while reporting success (→ stranding). Once it produced
  **no output and a 600s timeout while the reservation had already succeeded** —
  which burned an id and nearly shipped a workflow citing **another agent's**
  reservation from four minutes earlier. Retrying on apparent failure is exactly
  what burns the second id. **Read per-id metadata off
  `refs/heads/issue-assignments`** — the highest-number-on-`main` heuristic would
  have shipped the collision.
- **`grep` silently returns 0 matches on a file containing a NUL byte**
  (treats it as binary). Use `grep -a`.

## State at stand-down

- `#3687` — `DIRTY` + bot park-hold, deliberately untouched. Needs real conflict
  resolution plus diagnosis of its cited `merge_group` failure, not a label strip.
- `#3877` — left alone; being folded into #2742 as a duplicate.
- `#3886` — Backlog landmine: the same category error survives at
  `retarget-stacked-pr-children.mjs:291,381,383,392,394`, unreachable only while
  every stack parent is fork-head. Needs a semantics decision, not a typo fix.
- Issue id **3890** is a reserved hole (allocator double-reserve).

## The methodological result worth keeping

**The noise is signed.** Machine load inflates the improvement and regression
columns of the test262 gate *simultaneously*, so de-noising one side biases the
verdict predictably — **one-sided rigour is worse than none, because it looks
like rigour.** Established while triaging #3871: `other`-category regressions
were deterministic (stable 27-path core across runs) while `compile_timeout` and
`absent` swung wildly on byte-identical source, and **every** reported
"improvement" was a timeout recovery — zero genuine ones across four runs.

Corollary, from the same episode: **state your lane, your harness, and which two
commits you diffed.** Host-vs-standalone and local-vs-CI each produced a
confident wrong conclusion within an hour, and from the inside they are
indistinguishable.
