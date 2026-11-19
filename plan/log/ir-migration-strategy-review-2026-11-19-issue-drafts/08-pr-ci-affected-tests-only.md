---
id: TO-ALLOCATE
title: "PR CI: run affected issue tests only; full set in the merge group"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ci
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# PR CI takes 102 minutes for one job family

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R8.

## Problem

Measured from workflow runs on 2026-11-05, 11-07, 11-17 and 11-19:

- A code PR's `CI` workflow takes 102 to 103 min on a quiet day. The cause is `issue-tests-shard`: 4,958 root
  test files in 8 shards with a 100-minute step timeout. In every sampled run the slowest shard ends at 101 min,
  at the timeout. `scripts/issue-tests-baseline.json` does not exist, so the step runs in seed mode and reports
  success whatever happened. About 600 job-minutes per push.
- `auto-enqueue` fires when `CI` completes, so a green PR waits the full 102 min although the required checks
  finish in about 15.
- On 2026-11-19 at 14:53 UTC 120 runs were queued; the oldest CI run had waited 54 min. On 11-07 (283 CI runs) the
  PR median was 127 min, p90 239.

## To decide

- Selection on PRs: tests whose imports reach a changed file, plus the tests the PR touches.
- Where the full set runs (merge group, or nightly with a baseline that can actually fail).
- Whether `auto-enqueue` triggers on the required checks instead of the whole workflow.
- Concurrency: cancel superseded PR runs; skip the 12 small workflows on `hold`-labelled PRs.

## Acceptance criteria

1. Median PR CI wall time for a code PR under 25 min on a quiet day.
2. The full root test set runs somewhere with a baseline, and a new failure there fails a gate.
3. A green PR is enqueued within 5 min of its required checks.
4. Job-minutes per push are reported before and after.
