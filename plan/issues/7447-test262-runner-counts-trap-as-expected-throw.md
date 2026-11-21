---
id: 7447
title: "test262 runner: a Wasm trap counts as the expected throw of a runtime-negative row (standalone and JS-environment lanes)"
status: ready
sprint: current
created: 2026-11-21
updated: 2026-11-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: test262, ci
goal: error-model
related: [7354, 3003, 3469, 2912]
---

# test262 runner: a Wasm trap counts as the expected throw of a runtime-negative row

## Problem

`scripts/test262-worker.mjs` scores a `negative: { phase: runtime, type: T }` row as a pass when the module
throws out of instantiate (`_start`) or `__module_init` and `originalHarnessExceptionMatches` accepts the
throw. That matcher (now in `scripts/test262-runtime-verdict.mjs`) ends with
`render(err).includes(T)`, and returns true for any throw when the row names no type.

A Wasm trap (`WebAssembly.RuntimeError`: `unreachable`, out of bounds, illegal cast, null dereference) is
rendered with its frame names: `unreachable [in Test262Error() ← assertThrows]`. So:

- a row expecting `Test262Error` passes when the module traps inside a function named `Test262Error`, or any
  frame whose name contains the expected type;
- a row with no expected type passes on any trap.

A trap is never a JavaScript throw (a JS throw leaves Wasm as a `WebAssembly.Exception` on the exception tag,
or as the host's error object). Both cases are false passes.

The async arm has the matching hole: a row passes when `Test262:AsyncTestComplete` was printed, even if the
microtask drain afterwards threw or trapped (a later continuation that would have printed the failure
marker).

#7354 step U0 closed both holes on the **Prepared** lane only (`TEST262_COMPILER_PATH=ir`; the worker knows
the lane from the job's `wholeProgram` request). The standalone lane and the JavaScript-environment lane (where
it still runs) keep them. This issue closes them there.

## Reproducer

`scripts/test262-prepared-trap-verdict.test.mjs` builds a module with functions `$Test262Error` (`unreachable`)
and `$assertThrows` (calls it). Its `non-Prepared` cases pin today's behaviour of the other lanes:

- `runtimeNegativeThrowAccepted(trap, …, { expectedErrorType: "Test262Error", prepared: false })` → `true`;
- the same with no expected type → `true`;
- `asyncRowVerdict({ completed: true, drainError: trap, prepared: false })` → `"pass"`.

The fix is to drop the `prepared &&` guard in both functions; those three cases then flip, which is the
intended change.

## Why this is its own issue

The fix changes published verdicts: every row that passes only through the hole flips pass → fail.

- The per-edition ratchet (`scripts/test262-edition-ratchet.ts`) fails on any lost row in a ratcheted edition
  and allows no regression at all in a completed one (ES5).
- The #3467 regression diff, the #1668 catastrophic guard and the standalone floor see the flips in the
  `merge_group` run.
- It is a scoring-rule change, so `scripts/check-verdict-oracle-bump.mjs` requires an `ORACLE_VERSION` bump
  (#2096/#3003), or every later merge group diffs new policy against old baseline and the queue wedges.

So the size of the flip must be known before the PR, and the PR lands as an oracle bump with a coordinated
re-baseline (and, if ES5 rows flip, a reviewed lowering of the ES5 floor).

## Measurement that comes first

How many currently passing rows pass only through the hole, per lane (standalone, JS environment) and per
edition:

1. Select the rows: every row of the current baseline with `status: pass` that is a runtime negative
   (`negative.phase: runtime`) or carries the `async` flag.
2. Run exactly those rows twice through the real worker (an exact manifest, `TEST262_EXACT_MANIFEST_FILE`):
   once on main, once with the `prepared &&` guards removed.
3. Diff the two result files. Every pass → fail row is a pass through the hole; list each with its
   rendered trap text.

Report the counts by lane and edition, and name any ES5 rows. Not attempted in U0.

## Acceptance criteria

- The measurement above, recorded here.
- `isWasmTrap` applies on every lane; the `prepared` field leaves `runtimeNegativeThrowAccepted` and
  `asyncRowVerdict`, and the test's lane loop collapses to one set of cases.
- `ORACLE_VERSION` bumped in the same PR; the ratchet and regression gates green after the re-baseline.
