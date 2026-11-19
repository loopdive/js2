---
id: 7358
title: "#3518 receipt/pin tests red on main: re-express as living structural invariants or retire with a reason"
status: ready
sprint: current
created: 2026-11-17
updated: 2026-11-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: test
area: tests, ir
goal: ir-full-coverage
depends_on: []
related: [3518, 7354, 7356, 7357]
---

# #3518 receipt/pin tests red on main

## Problem

A family of #3518 tests pins whole-file content (SHA-256 / length / reconstructed historical bytes) of source files
that keep evolving. CI runs a root test file only when a PR touches it, so a pin that breaks on main stays red without
anyone noticing. Later PRs that touch the pinned source break the same tests again, but the breakage is hidden behind
failures that are already there. The #7354 stack (slices D1, P, Str, Perf) ran into this repeatedly: every slice had
to compare "failing set equal to base" instead of "green".

## Red on main or in the #7354 stack (measured 2026-11-16/17)

| Pin family | Consuming test files | Failures |
| --- | --- | --- |
| Receipts that pin `src/ir/program/data.ts`, broken by #7354 Perf (brand checks, copy-brand fact): `tests/helpers/ir-runtime-program-relocation.json`, `ir-c1-authority.json`, `ir-ownership-evolution.ts`, `ir-runtime-program-policy-program-validator.json`, `ir-source-map-position-inventory-successor.json`, `ir-deno-post-position-main-successor.json` | `tests/issue-3518-program-ownership-runtime-seam.test.ts`, `tests/issue-3518-semantic-provider-boundary.test.ts`, `tests/issue-3518-wasmgc-helper-policy-evolution.test.ts` (and any other reader of those helpers) | masked: the consumers already fail |
| Core-vocabulary evolution | `tests/issue-3518-core-vocabulary-evolution.test.ts` | 115 |
| Policy-evolution / provider-boundary receipts | `tests/issue-3518-wasmgc-helper-policy-evolution.test.ts`, `tests/issue-3518-semantic-provider-boundary.test.ts` | ~626 (134 + 349 on the Perf base, the rest in sibling slices) |
| Ownership-seam SHA pins, incl. `src/ir/prepared-component-dependencies.ts` ("runtime program relocation: length/SHA256") | `tests/issue-3518-program-ownership-runtime-seam.test.ts` | 10 |
| Number-format requirements | `tests/issue-3518-native-number-format-requirements.test.ts` | 2 |
| Realm requirements | `tests/issue-3518-native-realm-requirements.test.ts` | 1 |

Also seen red in the same sweeps, likely the same pattern (verify): historical donor/receipt checks in
`issue-3518-native-value-resources`, `-native-string-number-resources`, `-native-string-no-demand-emitter-forward`,
`-native-object-storage-resources`, `-native-object-layouts`, `-native-object-key-foundation`,
`-native-symbol-carrier-resources`, `-native-argument-vector-resources`, `-native-closure-resources`,
`-symbolic-support-ref`, `-native-vector-resources`.

## Diagnosis (pattern established by #7356 / #7357)

A whole-file hash of an evolving file is not an invariant; it is a snapshot. It records what a file looked like when a
review happened, and it rots silently as soon as an unrelated change lands. The test then asserts nothing useful,
and its red state hides real regressions.

## Plan

For each pin family, either:

1. **re-express it as a living structural invariant**: the property the pin was protecting (e.g. "this module exports
   exactly these names", "these declarations keep this order", "no import edge from X to Y"), checked against the
   current source; or
2. **retire it**, with the reason recorded in the test file or this issue (the historical review it protected is done).

Never refresh a hash to make the test green without stating the invariant it protects.

## Acceptance criteria

- Every test file in the table is green on main, or has its remaining assertions retired with a recorded reason.
- No remaining test in these families compares a whole-file hash of a file that is still edited.
- Must land before the #7354 stack is complete: the stack's slices currently prove "failing set equal to base" for
  these files, and that proof means nothing once the pins are fixed independently.

## Finding (S8, 2026-11-19)

- **Confirmed red on main `89e47482`.**
  `tests/issue-3518-runtime-program-relocation.test.ts` fails 298 of 298
  (re-run 2026-11-19). The pin is the receipt
  `tests/helpers/ir-runtime-program-relocation.json` (20,038 lines). It has
  not changed since `4346f628af` (2026-10-01): there is no diff between that
  commit and main.
- **Eight byte-pinned files have drifted.** The first one the test loop hits
  is `src/ir/prepared-component-dependencies.ts`. The full list:
  - `src/ir/prepared-component-dependencies.ts`
  - `src/ir/core/types.ts`
  - `src/ir/identity.ts`
  - `src/ir/nodes.ts`
  - `src/ir/prepared-component-ownership.ts`
  - `src/ir/prepared-instruction-support.ts`
  - `src/ir/program/abi-lookup.ts`
  - `src/ir/program/data.ts`

  A refresh means regenerating the ~20k-line receipt.
- **The first breaker is PR #6582** (merge `e1e07bd468`, 2026-10-07,
  `linear-memory-layout.ts` +4 lines). Its first parent passes 298; the
  merge fails 298. Later breaks are hidden behind it:
  - PR #6597 (merge `d2beec5ce7`, `program/data.ts`);
  - PR #6807 (merge `87cb29544a`, the first change to
    `prepared-component-dependencies.ts`);
  - several #7106 commits.
- **Why no CI check caught it:** no required check runs the file unless a PR
  edits it.
  - `quality`'s "changed root tests must pass" step runs only the test files
    a PR edits.
  - `issue-tests-pinned` is fatal but not required, and it runs a fixed
    15-file list that does not include this file.
  - `issue-tests-select` and `issue-tests-changed` are `continue-on-error`.
  - `issue-tests-shard` and `issue-tests-gate` run in seed mode, because
    `scripts/issue-tests-baseline.json` does not exist.
  - `issue-tests.yml` is a post-merge detector, not a gate.
- **`claude/7354-realm` does not fix it.** Its "#3518 pins" commit
  `f3384fc598` touches other #3518 tests and has no diff on the 46 receipt
  paths.
- **Recommendation:** do not make this a required check as it stands. After
  this issue's rework, either add the file to the fatal pinned list in
  `scripts/select-changed-issue-tests.mjs`, or seed
  `scripts/issue-tests-baseline.json` so that `issue-tests-gate` enforces it.
