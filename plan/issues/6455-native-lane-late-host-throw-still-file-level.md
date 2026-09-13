---
id: 6455
title: "The native oracle still records a stray host throw per FILE, so the two lanes now disagree about which test leaked it"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: infra
area: testing
goal: correctness
---

## Problem

[#6424](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6424-worker-uncaught-exception-still-zeroes-file)
gave the Wasm worker a per-test rule for a host throw raised outside every
awaited test body: while the sequential loop is running, the reason is folded
into the test that was running, and the rest of the file still runs.

The native oracle lane kept the older, coarser rule. `installNativeLateErrorBoundary`
in `tests/dogfood/upstream-suite-runner.mjs` records every `uncaughtException`
into `nativeLateHostErrors` tagged with the **file**, and `runNative` drains that
list into `native.lateHostErrors` at the end of the run. No test's status
changes. That was the right call for #4604 S7 — the boundary exists so one
stray timer cannot cost six packages a measurement — but it is now asymmetric
with the compiled lane, in a way that costs signal in two places:

1. **Admittance.** The native lane decides which upstream tests are admitted.
   A test that leaks a host throw natively still reads `passed`, so it is
   admitted and counted as a native pass, and the throw shows up only as a
   file-level note nothing scores.
2. **Lane comparison.** After #6424 the compiled lane says "test 3 leaked
   this"; the native lane says "somewhere in this file". A genuine lane
   difference and a shared defect look the same in the report.

Confirmed by `tests/dogfood/uncaught-host-exception.test.ts`'s third case: with
the same throwing source on both lanes, native scores `[true, true, true]` with
the reason in `native.lateHostErrors`, while Wasm scores `[false, true, true]`
with the reason on test 1.

## Acceptance criteria

1. A host throw raised while native test N runs is attributed to test N, the
   same fold the Wasm worker applies (`attributeRejections` with
   `kind: "uncaught host exception"`).
2. A throw raised outside the native test loop — module import, teardown,
   between files — still goes to `native.lateHostErrors` and still costs
   nothing but a report entry. The #4604 S7 guarantee (one stray timer must
   never cost a whole matrix row) is preserved.
3. `tests/dogfood/uncaught-host-exception.test.ts`'s third case is updated to
   assert the new native shape, and a control with no throw still scores 3/3
   on both lanes.
4. A/B over all 17 upstream suites at one HEAD. Unlike #6424 this one **can**
   legitimately move counts downward: a test that leaks a host throw natively
   stops being an unqualified native pass. Any movement must be enumerated
   per file and each moved test shown to be a real leak rather than
   misattribution.

## Notes

The sink already has everything needed — `armUncaughtExceptions()` /
`drainUncaught()` from #6424. The work is deciding the arm window for a lane
that runs in the driver process rather than a disposable worker, where the
boundary is currently installed once and never removed.
