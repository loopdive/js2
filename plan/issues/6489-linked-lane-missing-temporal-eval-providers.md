---
id: 6489
title: "test262 linked shadow job does not download the Temporal and runtime-eval providers — ~1,300 rows differ for that reason alone"
status: ready
sprint: current
created: 2026-09-16
updated: 2026-09-16
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infra
area: ci
goal: test262-conformance
depends_on: [6486]
related: [3451, 5353, 6486]
---

# #6489 — linked job lacks the provider downloads

## Problem (first full-corpus run, 2026-09-16, run 35116762391)

`test262-linked` (`.github/workflows/test262-sharded.yml`, added by #6486 on the
`test262-native-first` template) has neither the `JS2WASM_TEMPORAL_CACHE`
env nor the two steps every host shard job has:

- `Download compiled Temporal provider (#5353)`
- `Download selected runtime-eval provider (#2928/#4242)` (+ the verify step)

So in the linked lane `msg.temporal` rows found no provider
(`getWorkerTemporalProvider` → null) and ran without `Temporal`. The parity
report's largest buckets are exactly that: `Temporal is not defined` 713,
`Cannot read properties of null (reading 'since'|'until'|'toString'|'equals'|'subtract'|'catch')`
~340, `since|until|round|total is not a function` ~175, plus most of the
`Expected a RangeError but got a TypeError` 154+37+25+25. Eval-dependent rows
are affected the same way by the missing runtime-eval provider.

Note the worker order in `doCompile` (`scripts/test262-worker.mjs` ~L1445 vs
~L1468): a Temporal row takes the honest `compileWithTemporalGlobal` branch
BEFORE the linked branch, so with the provider present those rows are honest
rows inside the linked run (stamped `linked-harness`, though — the stamp should
say so; see plan step 3).

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

1. In `test262-linked`: add the `JS2WASM_TEMPORAL_CACHE: .test262-cache/temporal`
   env and the `needs:` entries / download+verify steps copied verbatim from
   `test262-shard` (~L189–240: Temporal provider download, runtime-eval
   provider download, verify shared runtime-eval provider cache). Keep the
   `if:` gate of the job unchanged.
2. Same for any other env the host job sets and the linked job lacks — diff
   the two `env:` blocks and list every difference in the issue; copy only
   what the honest lane has, never add lane-specific knobs.
3. Stamp honesty: a row that took the Temporal (honest) branch inside a
   linked run is not a linked measurement. In `doCompile`, when the Temporal
   branch wins while `linkedHarness` is set, mark
   `linkedHarness.fellBack = true` with reason `temporal row: honest compile
   (compileWithTemporalGlobal)` so the parity report counts it as a fallback,
   not as agreement. (A real linked+Temporal co-link is a later slice.)
4. Validate structurally (yaml parse, job graph unchanged for required checks)
   and with `tests/issue-6486-linked-parity-report.test.ts`.

## Acceptance

- [ ] Next `linked_lane` dispatch: `Temporal is not defined` bucket = 0; the
      Temporal rows appear as fallbacks with the new reason.
- [ ] Required checks and `docs/ci-policy.md` untouched.
