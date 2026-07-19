---
id: 3457
title: "ci(test262): make the merge_group regression-ratio gate flap-tolerant (stop false-parking symmetric content-current churn)"
status: ready
sprint: current
created: 2026-07-19
updated: 2026-07-19
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: ci
area: ci
language_feature: n/a
goal: maintainability
depends_on: [1943]
---

# Make the merge_group regression-ratio gate flap-tolerant (L-adjacent)

Surfaced during the 2026-07-18/19 merge-queue firefight. Related to
`plan/ci-acceleration-review.md` (guard-fragility theme, §2.4).

## Problem (confirmed)

The auto-park regression gate uses a **raw 10 % regression-ratio threshold**
(the documented ratio gate enforced by #1943). It **false-parks** PRs whenever
content-current async / `$DONE` flap produces **SYMMETRIC** churn — improvements
≈ regressions, so the **NET is neutral** — because the raw ratio counts the
regression side without netting it against the equal improvement side.

Confirmed false-parks: **#3351 / #3318 / #3359** — all net-neutral, with flat
trap-category counts baseline→candidate, roughly half of the churn being
`compile_timeout` runner-load noise. **#3359** reproduced the same churn even
against the fresh QUIET baseline `03ca4729`, proving the churn is flap, not a
real regression. Only the raw ratio gate fails them; they are not real
regressions, and each false-park costs a `hold` + a full re-validation run.

## Fix (spec)

1. **Require ASYMMETRIC churn before parking** — park only when regressions
   *materially exceed* improvements, not on a raw ratio. Net-neutral symmetric
   flap must pass.
2. **Exclude `compile_timeout` / `ct_flake` ≤ 5000 ms noise from the regression
   numerator** — runner-load contention timeouts are not content regressions
   (same root cause as the #3447 contention-tolerant compile-timeout guard).
3. **(Optional)** require a regressed test to **reproduce across N runs** before
   it counts toward the gate — a one-run flip is flap, not signal.

## Acceptance criteria

1. A net-neutral PR with symmetric improvement/regression churn (repro:
   #3351/#3318/#3359 signature) passes the merge_group regression gate.
2. `compile_timeout` / `ct_flake` ≤ 5000 ms entries are excluded from the
   regression numerator.
3. A genuine one-directional regression (regressions ≫ improvements, real trap
   categories) still parks — the gate does not go blind.
4. Thresholds + the asymmetry rule documented in-workflow with the
   #3351/#3318/#3359 false-park evidence.

## Related

- #1943 (established the 10 % ratio / 50-per-bucket gate this refines).
- #3404 (sibling: promote tolerates single-shard *upload* flake — a different
  flake, not this content-churn gate).
- #3447 (same spirit: contention-tolerant compile-timeout count guard).
- #3376 (logged the flap evidence during the firefight).
- Review: `plan/ci-acceleration-review.md` §2.4 (guard fragility / contention
  pricing).
