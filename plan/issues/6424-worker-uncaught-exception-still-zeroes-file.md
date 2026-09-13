---
id: 6424
title: "An uncaught exception in the dogfood Wasm worker still zeroes the whole test file — the other half of #5369"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-12
completed: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: infra
area: testing
goal: correctness
---

## Problem

[#5369](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5369-unhandled-host-rejection-zeroes-test-module)
removed the whole-file cliff for one failure mode — an unobserved host-promise
**rejection** — by installing a sink in
`tests/dogfood/upstream-suite-compile-worker.mjs` and attributing each reason
to the test that was running.

The sibling mode is untouched. A host **throw** from outside any awaited test
body — a `setTimeout` callback, a stream `error` event, a scheduler handle the
guest left behind — is an `uncaughtException`, and the worker still has no
listener for it. Node kills the worker, the parent finds no JSON on stdout,
`wasm: null`, and `summarizeUpstreamRuns` records every test of that file as
failed with `wasmError: null`. Exactly the shape #5369 describes, reached by a
different door.

That door is known to be walked through: `installNativeLateErrorBoundary` in
`tests/dogfood/upstream-suite-runner.mjs` exists *because* hono's
`concurrent.js` threw "interval violated" from a `setTimeout` ~2 minutes into
an npm-compat refresh (run 32623956233) and killed the driver. That boundary
covers the **native** lane only; the Wasm worker has no equivalent.

## Why #5369 deliberately did not do it

Recorded so this is a decision and not an oversight. Swallowing an
`uncaughtException` in the worker is not symmetric with swallowing a rejection:

- An uncaught exception in the worker is more often a **harness** bug (a
  compiler crash, a bad import object) than guest behaviour, and today it fails
  fast with a readable message in `compile.errors[0]`.
- Recording and continuing risks turning that fast failure into a **180 s
  worker timeout**, because the worker may never reach its `emit`.

So the fix needs a rule that distinguishes "the guest's stray timer threw,
keep going" from "the harness is broken, report and die" — probably: attribute
and continue only while the sequential test loop is running, and stay fatal
before the first test and after the last.

## Acceptance criteria

1. An `uncaughtException` raised while test N runs is attributed to test N (its
   `wasmError` carries the message) and the remaining tests of the file still
   run.
2. An `uncaughtException` outside the test loop (compile, instantiation,
   module init, emit) stays fatal and keeps today's `compile.errors` message —
   no silent 180 s timeout.
3. Regression fixture in the shape of `tests/dogfood/unhandled-host-rejection.test.ts`:
   a 3-test module whose test 1 schedules a throwing host timer must read 2/3
   with the message on test 1 (today 0/3, `wasmError: null`).
4. A/B over all 17 upstream suites at one HEAD: no count changes.

## Notes

`tests/dogfood/upstream-unhandled-rejections.mjs` already has the sink and
`attributeRejections` shape to reuse; this is mostly a second listener plus the
in-loop/out-of-loop rule.

## Implementation Plan

**Confirmed on 23a0ddaa26** (`.tmp/probe-6424.mjs`, 3-test module, test 1 runs `setTimeout(function(){ throw new Error(...) }, 0)`): `compile.success:false`, `wasm: null`, headline **0/3**, all three `wasmError: null`; control module 3/3. The throw is guest behaviour: Node's timer invokes the compiled closure through `wasmClosureDynamicBridge` (`src/runtime.ts:2189`), which rethrows via `normalizeModuleCallbackException`, and the worker has no `uncaughtException` listener. No `src/` change is needed — this is dogfood-harness only.

**Files/functions (in this order):**
1. `tests/dogfood/upstream-unhandled-rejections.mjs` — extend `createUnhandledRejectionSink` with a second, *unarmed-by-default* channel: `armUncaughtExceptions()` installs a `process.on("uncaughtException")` listener that pushes `rejectionText(error)` onto a separate `pendingUncaught` list (stderr line `[label] uncaught host exception: …`) and returns a `disarm()` that removes it; add `drainUncaught()` (same one-`setImmediate`-turn rule as `drain()`). Generalise `attributeRejections` with an optional `kind = "unhandled rejection"` label so the folded text reads `uncaught host exception: …` (do not prefix it with "unhandled rejection:"). Keep existing signatures/return shapes — `runNative` in the runner calls `drain()` and expects an array.
2. `tests/dogfood/upstream-suite-worker-protocol.mjs` `runSequentialUpstreamTests` — when `rejections` is given, `const disarm = rejections.armUncaughtExceptions?.()` **before the first `invoke`**, and `disarm()` in a `finally` **after the trailing drain** (the trailing-uncaught folds into the last test as `late`, exactly like trailing rejections; with zero tests it goes to `moduleRejections`). Per test: after the existing `attributeRejections` for rejections, run the same fold over `await rejections.drainUncaught()` with `kind: "uncaught host exception"`. Order constraint: rejections drain first, then uncaught, so an already-failed test keeps its own reason (the #5823 rule) and the worker's `unhandledRejections` field keeps its current contents.
3. `tests/dogfood/upstream-suite-compile-worker.mjs` — no change to control flow. Compile, instantiation, `__module_init`, `cleanupUpstreamTestEnvironment` and `emit` all run with the listener **absent**, so an uncaught there still kills the worker and the parent still reports the stderr text in `compile.errors[0]` (acceptance 2, no 180 s timeout). Add a two-line comment at the `rejections` creation pointing at this issue.

**Regression test** — `tests/dogfood/uncaught-host-exception.test.ts`, cloned from `unhandled-host-rejection.test.ts` (`runHarness`, `UPSTREAM_TEST_SHIM`, `summarizeUpstreamRuns`). Fixture: 3 tests; **test 1 must be `async`, schedule the throwing timer, then `await new Promise(r => setTimeout(r, 5))`** — a 0 ms timer scheduled by a synchronous test is not guaranteed to fire before `drain()`'s `setImmediate` (timers phase precedes check only once the 1 ms threshold has elapsed), so a sync test 1 would attribute to test 2 nondeterministically. Cases: (a) control 3/3 both lanes (anti-vacuity); (b) Wasm-lane throw, `nativeSource` = control: expect `compile.success true`, `wasm.statuses [false,true,true]`, `errors[0]` contains `uncaught host exception` and the reason, `errors[1..2] == ""`, `fatal` undefined, headline `2/3`, `tests[0].wasmError` carries the reason (fails on parent: 0/3, `wasmError` null); (c) same source both lanes: native stays 3/3 with the entry in `native.lateHostErrors` (file-level native policy is unchanged). Plus a unit test in `upstream-suite-worker-protocol.test.ts`: `process.listenerCount("uncaughtException")` is equal before and after `runSequentialUpstreamTests` and is +1 inside `invoke` — the cheap guard for acceptance 2. Register the new test file in `check:dead-exports` terms by actually importing the new helpers.

**Expected movement:** no anchor should change (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono 259/324). The only legitimate move is **upward** on a file that today zeroes from a stray timer throw — hono (`concurrent.js`-style timers) is the candidate; if hono rises, record the per-file delta in the issue. A/B (acceptance 4): run the 17 `tests/dogfood/*-upstream-suite.test.ts` / `npm-small-upstream-suites.test.ts` on parent and branch at one HEAD, diff per-file counts.

**Standalone lane:** unaffected — the worker is JS-host-only harness code; no compiler or runtime source changes, so standalone floor/net guards see nothing.

## Dispatch

**opus** — small diff, but the in-loop/out-of-loop arm window and the event-loop ordering of the fixture (async test 1) are the whole correctness of the change; a mechanical lane is likely to ship a flaky fixture or an always-on listener that reintroduces the 180 s-timeout hazard the issue explicitly rejects.

## Resolution

Implemented as planned; the plan's diagnosis held on `e06f76745b` without
amendment. Harness-only — no `src/` change.

**Reduction (before).** `.tmp/probe-6424.mjs`, a 3-test module whose test 1 is
`async`, schedules `setTimeout(function () { throw … }, 0)` and then awaits a
5 ms timer: `compile.success false`, `wasm: null`, headline **0/3**, all three
`wasmError: null`; the control module 3/3. The compiled closure is invoked from
Node's timers phase and rethrown by `normalizeModuleCallbackException`
(`src/runtime.ts:2189`), so it reaches the worker as an `uncaughtException` for
which no listener existed. Node killed the worker and the parent found no JSON
on stdout. Same probe after the change: **2/3**, test 1 carrying
`uncaught host exception: Error: …`.

**Mechanism.**

- `tests/dogfood/upstream-unhandled-rejections.mjs` — the sink gained a second,
  **unarmed-by-default** channel: `armUncaughtExceptions()` installs the
  `uncaughtException` listener and returns an idempotent `disarm()`;
  `drainUncaught()` takes what it captured after the same one-`setImmediate`
  turn `drain()` uses. `attributeRejections` takes a `kind` label so the folded
  text reads `uncaught host exception: …` rather than borrowing the rejection
  wording. Existing signatures and return shapes are unchanged.
- `tests/dogfood/upstream-suite-worker-protocol.mjs` —
  `runSequentialUpstreamTests` arms before the first `invoke` and disarms in a
  `finally` after the trailing drain. Per test the uncaught fold runs **after**
  the rejection fold, so a test that already has a reason keeps it (#5823) and
  the worker's `unhandledRejections` field keeps meaning only what its name
  says. A trailing uncaught folds onto the last test as `(late)`, the same rule
  trailing rejections follow.
- `tests/dogfood/upstream-suite-compile-worker.mjs` — comment only. Compile,
  instantiation, `__module_init`, `cleanupUpstreamTestEnvironment` and `emit`
  all run with the listener absent, so a throw there still kills the worker
  immediately and still surfaces as `compile.errors[0]` (acceptance 2: no
  silent 180 s timeout).

**Acceptance.**

1. ✅ attributed to the running test, remaining tests still run — 2/3 with the
   message on test 1.
2. ✅ out-of-loop stays fatal — guarded by the listener-count assertion in
   `tests/dogfood/upstream-suite-worker-protocol.test.ts` (equal before and
   after the call, +1 inside `invoke`) and by the arm window itself.
3. ✅ `tests/dogfood/uncaught-host-exception.test.ts`, 5 cases. On the parent
   the new work fails **5 of 8** (with
   `tests/dogfood/upstream-suite-worker-protocol.test.ts`): `wasm.statuses`
   `undefined` instead of `[false, true, true]`, headline 0/3, the two sink
   unit tests, and the listener-count guard. With the change **8 of 8** pass.
   The control case (3/3 both lanes, no stray throw) passes on both sides —
   the anti-vacuity control.
4. ✅ A/B over all 17 upstream suites at `e06f76745b`: **no count changes.**

**A/B (base vs fix, one HEAD `e06f76745b`).** webpack 16/16 · three 17/18 ·
clsx 32/32 · cookie 63740/63740 · lodash 59/62 · redux 67/82 · axios 208/231 ·
stylelint 108/108 · tailwindcss 13/13 · jsdom 6/6 · styled-components 9/9 ·
uuid 75/75 · marked 16/30 · moment 10/10 · prettier 108/151 · jest 335/356 ·
hono 261/324. Fifteen matched the recorded 2026-09-12 anchors exactly. Two read
**above** them — hono 261 (anchor 259) and prettier 108 (anchor 107) — so both
were re-measured on the unmodified harness at this same HEAD and came back
**identical** (hono 261/324, prettier 108/151), with a per-file diff of the
report JSON showing **0 files differing** on each. That movement is main-side
drift in the anchors, not this change.

**Residual.** A module that registers **zero** tests still arms the channel for
the two drain turns that follow, so a host throw landing in exactly that window
is recorded on the module instead of being fatal — and, because
`moduleRejectionText` owns that field's wording, it reads
`unhandled rejection: …`. Reaching it needs a file with no registered tests and
a stray timer left by module init firing inside two event-loop turns; no
upstream suite exercises it today.
