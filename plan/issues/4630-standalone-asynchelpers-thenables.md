---
id: 4630
title: "Standalone: asyncHelpers harness self-tests — thenable coercion through asyncTest closures"
status: ready
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/async-frame.ts
  - src/codegen/expressions/calls-closures.ts
---

# #4630 — Standalone asyncHelpers self-tests (4 tests + 1 trap)

## Problem

Five `test/harness/asyncHelpers-*` self-tests fail standalone (measured
2026-08-23 via `runTest262File(..., "standalone")`):

| Test | Symptom |
| --- | --- |
| asyncTest-return-not-thenable | `[false×6]` vs `[true×6]` — none of the six non-thenable return values produced the expected synchronous Test262Error rejection path |
| asyncTest-returns-undefined | `Test262:AsyncTestFailure:Test262Error: [object Object]` |
| asyncTest-then-rejects | same |
| asyncTest-then-resolves | same |
| throwsAsync-same-realm | `RuntimeError: dereferencing a null pointer in __closure_111 (via asyncTest ← __fn_tramp…)` — a hard trap, distinct from the four soft failures (also depends on #4634's realm shim) |

## What the harness needs

`asyncTest(testFunc)` (harness/asyncHelpers.js):

1. calls `testFunc()` and inspects the RESULT for thenable-ness
   (`res && typeof res.then === "function"`) — a duck-typed `.then` read on
   an `any` value that may be a compiled closure result, a native Promise
   carrier, a plain `$Object` with a `then` member, or a primitive;
2. chains `.then(onFulfilled, onRejected)` with harness closures and
   routes the outcome to `$DONE`;
3. `assert.throwsAsync` builds its OWN promise around the thenable and
   compares constructor identities on rejection values.

The `[object Object]` rendering in three of the failures means the
rejection VALUE reached `$DONE`, but it stringifies as a plain object —
the Test262Error's message is not recovered — so either the wrong value is
propagated or `String(err)`/`err.message` on it misses.

## Implementation Plan

1. **Reproduce small**: reduce each failure in `.tmp/` probes:
   (a) `typeof x.then === "function"` for x = compiled async fn result,
   plain object with `then`, number; (b) `.then(f, r)` on a native promise
   held in `any`; (c) `String(thrownTest262Error)` through the async
   rejection path. Identify which of the three legs breaks per test.
2. **Fix the `.then` duck-typing leg** first (likely shared with #4629's
   any-member-read mechanics): the native Promise carrier must answer a
   callable `then` through `__extern_get`.
3. **Fix rejection-value fidelity**: the async frame's rejection plumbing
   (async-frame.ts) must hand the ORIGINAL thrown value to the `onRejected`
   closure, not a re-boxed generic object; verify `err.message` and
   `err.constructor` survive (constructor identity additionally needs the
   fnctor proto machinery, cf. #4626 third-slice notes).
4. **Trap in throwsAsync-same-realm**: chase the null deref in
   `__closure_111` separately — reproduce with the full-harness assembly,
   bisect includes; do NOT fold into the soft fixes.
5. **Acceptance**: the four soft tests pass standalone;
   the trap test at minimum stops trapping (its pass additionally requires
   #4634); 20-test standalone sample over `built-ins/Promise/**`
   baseline-pass tests shows 0 regressions.
