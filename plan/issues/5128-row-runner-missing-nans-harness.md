---
id: 5128
title: "run-test262-row.mts does not link nans.js: needsNans keys on `distinctNaNs` but tests use `NaNs`, so the row runner reports a degenerate shape"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: test-tooling
goal: pipeline-health
---

# The single-row test262 runner silently drops the NaN harness

`scripts/run-test262-row.mts` wraps a test with `wrapTest`, whose harness
inclusion predicate `needsNans` (`tests/test262-runner.ts:2918`) keys on the
identifier `distinctNaNs` — but test262's NaN-consistency tests reference the
harness binding `NaNs` (`harness/nans.js`). Result: for any test using `NaNs`
but not `distinctNaNs`, the row runner compiles a module in which `NaNs` is
undefined and reports a **degenerate shape that differs from what CI actually
runs**, while the tool's own header claims harness faithfulness.

The authoritative path — `runTest262File` via `assembleOriginalHarness` — links
`nans.js` correctly. The two paths disagree exactly on this family.

## Measured cost (2026-08-28, PR #5125 park diagnosis)

Diagnosing the parked
`built-ins/TypedArray/prototype/map/return-new-typedarray-conversion-operation-consistent-nan.js`,
the row runner reported a bogus failing shape (NaNs undefined) that pointed at
the wrong bug; only re-running through `runTest262File` produced the true
byte-identity evidence that exonerated the PR. The tool's faithfulness claim
means the next person will trust the wrong output first.

## Fix

Make `needsNans` (and audit the sibling `needs*` predicates in the same block
for the same single-spelling trap) match what the harness file actually
exports/binds — e.g. key on `nans.js`'s known bindings (`NaNs`,
`distinctNaNs`, or simply the string `NaN` heuristics used elsewhere), or
switch the row runner to `assembleOriginalHarness` so both paths share one
inclusion decision. Sharing the assembly path is the stronger fix: it removes
the whole class, not one spelling.

## Acceptance criteria

- The row runner's compiled module for the test above is byte-identical to the
  one `runTest262File` produces (same harness set linked).
- A regression test pins one `NaNs`-using test through the row runner.
- The audit result for the other `needs*` predicates is recorded here (either
  "no other single-spelling traps" or fixes for the ones found).
