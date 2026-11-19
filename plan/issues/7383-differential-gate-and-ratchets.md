---
id: 7383
title: "Differential gate against node on the Prepared entry, with crash and post-claim ratchets"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir, ci, testing
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# A differential gate so reviewers stop hand-running probes

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R6.

## Problem

Review census, 85 reviewed PRs created 2026-11-05 to 11-19: 29 first reviews found a behaviour defect the PR
introduced. About 17 of the 29 were found by the reviewer generating small programs and comparing against node and
the base, then discarding the probes; about 4 more need a crash or compile-error ratchet; all 10 claim-then-withdraw
findings (the IR selects a unit, then fails and falls back) need only a ratchet on `irPostClaimErrors`, which is
recorded but not gated. Slices already run such sweeps by hand (slice T: 1,584 programs) and do not commit them.

## To decide

- The generator: a committed grammar over the constructs the Prepared path accepts, values × positions, seeded.
- Oracle: node's result; verdicts: same answer, named refusal, or failure (wrong answer, crash, invalid Wasm).
- Where it runs (PR, on the diff's lane; full in merge group) and its time budget.
- Ratchets: compile crashes on the ES5 corpus (495 today on the Prepared path) and `irPostClaimErrors`.

## Acceptance criteria

1. One command runs the sweep on the Prepared entry and on the ordinary pipeline and reports wrong answers, crashes
   and invalid modules.
2. It reproduces at least 12 of the 17 listed review findings when run against the pre-fix commits (list in the
   review census).
3. CI fails on a new wrong answer, a new crash, or a rise in post-claim errors.
4. Each lane adds its probes to the shared generator instead of a private sweep.
