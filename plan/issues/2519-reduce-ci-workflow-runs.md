---
id: 2519
title: "reduce redundant CI workflow runs (debounce idempotent sweeps + heavy test262 merge_group-only)"
status: done
priority: high
feasibility: medium
reasoning_effort: medium
task_type: ci
area: ci
goal: dev-velocity
sprint: 64
related: [2517]
status_note: "Part 2 landed via admin-merge during the 2026-06-20 merge-queue wedge (the queue was wedged so it could not be canary-validated through the queue first; canary deferred to post-merge verification — confirm a PR still enqueues with cheap-gate green + 'merge shard reports' green-skipped)."
completed: 2026-06-20
---

# #2519 — Reduce redundant CI workflow runs

## Problem

During the 2026-06-19 merge-queue incident, workflow-run volume was very high
(~70 runs/hr): `Auto-enqueue green PRs` 26×, `Approve trusted-fork runs` 30×,
`Baseline floor staleness alert` 15×, vs only 1× `Test262 Sharded` / 1× `CI`.
High event volume can contribute to GitHub soft-throttling webhook/event
delivery (which manifested as merge_group events not firing). Separately, the
heavy 57-shard test262 matrix runs **twice per PR** — once on `pull_request`
(pre-queue validation) and again on `merge_group` (final gate) — doubling the
most expensive CI cost.

Two independent reductions:

## Part 1 — debounce idempotent sweeps (DONE in this PR)

`auto-enqueue.yml` and `baseline-floor-staleness-alert.yml` are **idempotent
sweeps** (the latest run covers everything), but used `concurrency:
cancel-in-progress: false`, which serial-runs every queued trigger instead of
collapsing a burst to the most-recent run. Flipped both to
`cancel-in-progress: true` (latest-wins). The baseline-alert's own comment
already described latest-wins behaviour — the setting was simply mis-set.

**Deliberately NOT changed: `approve-fork-runs.yml`.** Cancelling that workflow
mid-run can drop a fork PR's run-approval and strand its CI, so it stays
`cancel-in-progress: false`.

## Part 2 — heavy test262 merge_group-only (SPEC — careful follow-up)

Goal (stakeholder): *"only run CI on PRs when they are in front of the merge
queue, to avoid duplicated runs."* Make the heavy `test262-shard` job
(57-shard matrix) run **only** in `merge_group` (when the PR reaches the front
of the queue and is about to merge) + `push` (baseline) + `workflow_dispatch`,
**not** on `pull_request`. This halves the most expensive CI per PR.

### Approach
- In `.github/workflows/test262-sharded.yml`, remove the `pull_request` arm
  from the `test262-shard` job's `if:` (lines ~337-341), keeping
  `merge_group` / `push` / `workflow_dispatch`.
- Keep the **cheap gate** (typecheck + lint, `cheap gate (main-ancestor +
  lint)`) on `pull_request` — it's fast and gives authors early feedback at
  negligible cost.
- The required check **`merge shard reports`** must **green-skip on
  `pull_request`** (since the shards no longer run there) so a PR is mergeable/
  enqueueable, mirroring the existing merge_group no-shards skip path (see the
  aggregate-job comment ~L312-315). In `merge_group` it runs the real shards.
- Confirm ruleset `16700772` ("main: merge queue + required checks") sources
  the required contexts from the **merge_group** run (it should — it is the
  merge-queue ruleset). The PR enqueues without the heavy check having run at
  PR-time; the merge_group produces it.

### Trade-offs (must be acknowledged)
- **No early heavy validation**: a PR with a real test262 regression is caught
  only when it reaches the merge_group → it fails there and is ejected,
  feedback is later than PR-time. Acceptable: the merge_group is the
  authoritative gate; the PR-time run was duplicative pre-validation.
- **More dependent on merge_group delivery**: if merge_group webhooks are
  down (the #2517 / 2026-06-19 incident), NO heavy validation runs at all.
  The cheap gate still runs at PR-time, limiting blast radius.

### Validation
This changes the required-checks gate — a misconfiguration can block ALL
merges (required check never satisfied) or let unvalidated PRs through. The
two coordinated edits (both in `test262-sharded.yml`):
1. `test262-shard` `if:` drops the `pull_request` arm (keeps push /
   merge_group / workflow_dispatch).
2. `merge-report`'s `SHARD_SKIP_OK` widened from `(pull_request &&
   actor==bot)` to **all** `pull_request`, so the required `merge shard
   reports` check green-skips at PR-time (the shards no longer run there).
   `regression-gate` already no-ops on skip under `always()` and is not a
   required check, so it needed no change.

Pre-merge local checks done: YAML parses (`js-yaml`); semantic assertions
confirmed — `test262-shard.if` no longer mentions `pull_request`, the cheap
gate (`cheap gate (main-ancestor + lint)`) still runs on `pull_request`, and
`SHARD_SKIP_OK` green-skips every `pull_request`.

**Landed via admin-merge** during the 2026-06-20 merge-queue wedge — the
queue was wedged, so the spec's "canary through a healthy queue first" was
not possible. Post-merge canary (REQUIRED follow-up): once a PR opens against
the new main, confirm it shows cheap-gate green + `merge shard reports`
green-skipped + enqueues, and that a merge_group runs the real 114-job
matrix and merges only when green.

## Acceptance criteria
- [x] Part 1: `auto-enqueue` + `baseline-floor-staleness-alert` use
      `cancel-in-progress: true`; `approve-fork-runs` unchanged.
- [x] Part 2: heavy `test262-shard` skips `pull_request`; `merge shard
      reports` green-skips at PR-time (admin-merged 2026-06-20). Post-merge
      canary verification pending (see Validation).
