---
id: 5266
title: "Catalogue + triage: 8 `tests/issue-*.test.ts` files carry 18 pre-existing failures on main (measured), none of them run by any required check"
status: ready
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: medium
horizon: m
complexity: M
feasibility: medium
reasoning_effort: medium
task_type: test-fix
area: tests, ci
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r4
related: [3347, 5259, 5262, 5263, 5264, 5265, 3523]
---

# 8 issue-test files are red on main, measured, and uncatalogued

## Problem

The `tests/issue-*.test.ts` suite is known not to be clean — `ci.yml` says so
in the `issue-tests` job comment, and #3347 and #5259 each file ONE rotted file.
There is no register of the rest, so each discovery is re-derived from scratch
by whoever next touches a file.

This issue is the register for what has actually been measured, and the place to
either fix or fan out per-file issues.

## Evidence

Measured 2026-09-01 during #3523 gap 4, by running each file with the compiler
sources AND the test files taken from pristine `origin/main` (file-copy A/B,
`--pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism`).
These are **base** failures — the gap-4 branch was separately confirmed to add
none of them:

| file | failing tests on main |
| --- | --- |
| `tests/issue-1004.test.ts` | 3 |
| `tests/issue-2951.test.ts` | 1 |
| `tests/issue-3214-callable-abi.test.ts` | 1 |
| `tests/issue-3518-bench-string-prepared-cutover.test.ts` | 1 |
| `tests/issue-4390-global-function-descriptors.test.ts` | 7 |
| `tests/issue-4457.test.ts` | 4 |
| `tests/issue-4462.test.ts` | 1 |
| `tests/issue-4504-inherited-set.test.ts` | 1 (suite-level error) |

**Total 18 failing tests across 8 files.** This is a floor, not a census: the
sweep covered only the ~170 files referencing `irOutcomes` /
`IrObservedOutcome` / `irBodyRouteAudit`, so files outside that set were never
run.

Known rotted files already filed separately, NOT counted above:
`issue-3517-map-module-init` (#5259, 5 tests), `issue-3519-ir-outcomes`
(#5262, 5 tests), `issue-3525-multi-prepared-callable-bindings` (#5263, 6
tests), `issue-4267-overload-inventory-owner` (#5264, 1 test), and
`issue-2924` (#3347, 2 tests).

## Why this is not merely untidy

A red file is not just missing coverage — it actively hides regressions. A PR
that touches one of these files inherits its reds in the required `quality`
gate, which is what forced #3523 gap 4 to skip 12 tests rather than fix
subsystems it had no business changing. Every red file is therefore a tax on
the next unrelated PR that comes near it.

## Acceptance criteria

1. Each of the 8 files is triaged into exactly one of: (a) stale pin — rewrite
   to assert current truthful behaviour, (b) real compiler defect — file or
   link an issue, (c) obsolete — delete with rationale.
2. Whatever cannot be fixed now is recorded in a machine-readable known-red
   allowlist, so #5265's broader gate can be turned on without waiting for a
   clean suite.
3. This file is updated with the disposition of each, and closed only when the
   list is empty or fully re-homed.

## Explicitly NOT claimed here

None of the 18 have been diagnosed. They are measured as failing on main and
nothing more; do not treat the counts as a classification.
