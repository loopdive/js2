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

## Implementation Plan

**Measured on 54c36a9fe3 (2026-09-13):** `npx vitest run tests/dogfood/uncaught-host-exception.test.ts` → 5/5 pass in 20 s, third case asserting native `[true,true,true]` + `lateHostErrors` containing the reason, Wasm `[false,true,true]`. Defect present; no other consumer of `lateHostErrors` exists (`grep -rn lateHostErrors tests scripts src` → only the runner and that test).

**Root cause (code, not hypothesis).** `runNative` (`tests/dogfood/upstream-suite-runner.mjs` ~L1068–1140) hand-rolls the per-test loop: it drains `nativeRejections.drain()` per test but never calls `armUncaughtExceptions()` / `drainUncaught()`, so every `uncaughtException` is only seen by the permanent file-level listener from `installNativeLateErrorBoundary` (~L1051). The Wasm lane's rule lives in `runSequentialUpstreamTests` (`tests/dogfood/upstream-suite-worker-protocol.mjs` ~L97–147): arm for the loop, rejections-then-uncaught per test, `foldTrailing` late onto the last test, disarm in `finally`.

**Fix — reuse the worker loop, don't copy it.**
1. `upstream-suite-runner.mjs`: import `runSequentialUpstreamTests` (already imports two symbols from the worker protocol). In `runNative`, replace the `if (typeof module.runUpstreamTest === "function")` loop body + the trailing-rejection fold (~L1092–1125) with `runSequentialUpstreamTests({ ids: [...Array(count).keys()], invoke: (i) => module.runUpstreamTest(i), timeoutMs: 0, failureText: (i) => String(module.upstreamTestErrors()[i] ?? ""), thrownText: errorText, rejections: nativeRejections })`. `withUpstreamTestTimeout` is a no-op at 0, so native keeps "no per-test timeout". Push its `moduleRejections` into the existing `moduleRejections` (the post-import drain stays where it is). Leave the `else` (`runUpstreamTests` batch export) branch untouched — no per-test window there, file-level policy is correct.
2. **Double-listener hazard (the one real trap):** Node fires *every* `uncaughtException` listener, so once the sink is armed the file-level `record("uncaughtException")` would also fire and the same throw would land both on test N and in `lateHostErrors`. Add a module flag `nativeUncaughtArmedForTests`; `record` returns early when it is set. Set it immediately before the `runSequentialUpstreamTests` call and clear it in a `finally` around it. Do not remove/re-add the file-level listener (keeps the #4604 S7 guarantee for import/teardown/between-file throws with zero window gaps). Optionally add an optional `label` param to `runSequentialUpstreamTests` so a future non-zero native timeout would not read "compiled upstream test".
3. `attributeRejections` order is preserved by reuse: rejections first, then `kind: "uncaught host exception"`, a test that already failed keeps its own reason (#5823).

**Regression test** (`tests/dogfood/uncaught-host-exception.test.ts`, inline sources through `compileAndRunUpstreamModule`, no .js fixture needed):
- Third case → rename "attributes a native-lane host throw to test 1 like the Wasm lane": expect `native.statuses` `[false,true,true]`, `native.errors[0]` contains `"uncaught host exception"` and `REASON`, `native.errors.slice(1)` `["",""]`, `native.lateHostErrors` `[]` (proves no double-record), `native.unhandledRejections` `[]`; Wasm assertions unchanged. Fails on parent (native reads 3/3), passes with fix.
- Anti-vacuity: existing control case stays 3/3 both lanes with `lateHostErrors: []`; add a case where the throw is scheduled from module top level *outside* every test (a `setTimeout` at module scope whose delay lands after the loop — e.g. inside `cleanupUpstreamTestEnvironment` or a module-scope timer with the loop made to finish first) asserting it still goes to `native.lateHostErrors` and statuses stay 3/3 — this is AC 2.

**A/B (AC 4):** run the 17 upstream suites once on parent and once on branch at the same HEAD (`node scripts/... generate:npm-compat` lanes or the per-suite dogfood tests); diff `native` per-file. Expected: the Wasm anchors (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono ~261/324) move only via admittance: a test that natively leaks a host throw drops out of the admitted set, so both numerator and denominator can fall (hono `concurrent.js` "interval violated" is the known candidate). Enumerate each moved test with its native error text in the PR; a move whose error is not `uncaught host exception: …` is misattribution and blocks. Standalone lane: no effect (native oracle only).

## Dispatch

**opus** — mechanically small (one loop replaced by a reuse, one flag, one test rewrite) but the double-listener interaction and the A/B enumeration over 17 suites need judgment about which count movements are legitimate.
