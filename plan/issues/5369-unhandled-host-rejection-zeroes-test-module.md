---
id: 5369
title: "One unobserved host-promise rejection inside a compiled module kills the dogfood worker and zeroes the whole test file — a single failing call reads as a 24-test cliff"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-12
completed: 2026-09-12
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infra
area: testing
goal: correctness
---

## Problem

#5362's bisect found that hono's `src/utils/cookie.test.ts` went 24/35 →
0/35 on `main` because **one** `crypto.subtle.importKey` call (the
binary-secret case) rejected and nobody observed the rejection: Node's
default `unhandledRejection` behaviour terminated the suite worker, and every
test in the file — including the 24 that had already passed — was recorded
as failed with `wasmError: null`. Decisive control: with
`process.on("unhandledRejection", …)` installed and nothing else changed,
`main` scored exactly 24/35, the parent's number.

So the harness turns any single host-API rejection into a whole-file zero,
with a null per-test error and no reason in `compile.details` either. That is
how a one-test defect looked like a 244 → 220 regression, cost a bisect, and
would have been mis-attributed to whichever PR measured next.

## Acceptance criteria

1. An unhandled rejection raised while test N runs is attributed to test N
   (its `wasmError` carries the rejection reason) and the remaining tests in
   the file still run.
2. A rejection outside any test (module init, `beforeAll`) is recorded on the
   module: `compile.details[N].runtimeError = "unhandled rejection: <reason>"`
   — never a silent null.
3. The native lane is left symmetric (its own unhandled rejections are
   attributed the same way), so a lane difference is still visible.
4. A/B at one HEAD over all 17 suites: no count changes on current `main`
   (#5362 already removed the trigger), demonstrated; plus a probe that
   re-creates the parent's condition (a compiled call whose host promise
   rejects, unobserved) showing the file no longer zeroes.
5. The compiler-side sibling found in the same probe — `await getCryptoKey(…)`
   handing back the Promise itself — is **not** fixed here; it is #5371.

## Implementation Plan

1. Read the worker in `tests/dogfood/upstream-suite-runner.mjs`
   (`compileAndRunUpstreamModule`, `UPSTREAM_TEST_SHIM`): how tests are run
   sequentially, where per-test results are written, and what happens on a
   worker crash (today: every test of the file marked failed, `wasmError:
   null`).
2. Track the "current test" in the shim's `it` runner; install
   `process.on("unhandledRejection")` in the worker that (a) records the
   reason on the current test and resolves that test as failed, or (b) with no
   current test, records it on the module. Do not swallow the reason; print it
   once to the worker log too.
3. Keep the worker alive: continue with the next test. If the rejection
   arrives *after* the test settled (late), attribute it to the last test and
   mark the attribution as late in the message.
4. Regression: a fixture module whose one test calls a compiled function that
   returns an unobserved rejecting host promise, followed by two passing
   tests — must read 2/3 with the reason on test 1 (today 0/3, null).
5. A/B; one PR. Touches `tests/dogfood/` only.

## Dispatch

Model: **opus**. Harness change with a clear contract; the only judgement is
the attribution rule for late rejections.

## Resolution

Landed 2026-09-12. `tests/dogfood/` only; no `src/` change.

### Mechanism

Node's default `unhandled-rejections=throw` mode terminates a process that
never observes a rejected promise. The Wasm lane runs each upstream module in
a disposable compile worker (`tests/dogfood/upstream-suite-compile-worker.mjs`)
that had **no** `unhandledRejection` listener, so one unobserved host rejection
killed it mid-run. The parent then found no JSON on the worker's stdout and
recorded `compile.success: false`, `wasm: null` — and `summarizeUpstreamRuns`
turns a null `wasm` into "every test of this file failed, `wasmError: null`".
That is the 24 → 0 cliff #5362 bisected.

The fix is three pieces, in a new shared module
`tests/dogfood/upstream-unhandled-rejections.mjs`:

1. **A sink, installed before any guest code runs** (worker `main()`, and the
   native boundary in `upstream-suite-runner.mjs`). A listener exists, so Node
   reports instead of terminating; every reason is echoed to stderr once.
2. **`drain()` yields one full event-loop turn before taking what it captured.**
   That turn is the load-bearing part: Node reports a rejection as unhandled
   only after the microtask queue drains, and a sequential test loop made of
   `await`s never leaves that queue on its own. Without it, a rejection leaked
   by test 1 is first seen after test N.
3. **`attributeRejections()` folds the reasons into the test that was running** —
   `runSequentialUpstreamTests` (Wasm) and `runNative`'s loop (native oracle)
   drain after each test. Rejections that arrive after the last test settled go
   to that last test, marked `(late)`. Rejections belonging to no test (module
   init, teardown, a file that registered nothing) become
   `compile.details[N].runtimeError = "unhandled rejection: <reason>"`.

Two deliberate calls:

- **Module-level rejections are NOT written to `wasm.fatal`.** Acceptance 2 asks
  for them on `compile.details[N].runtimeError`; routing them through `fatal`
  would have satisfied that literally and re-created the bug, because
  `summarizeUpstreamRuns` marks every test of a file with a `fatal` as
  `runtime-failed`. They travel on a separate `wasm.unhandledRejections` /
  `native.unhandledRejections` field that `compile.details` reads.
- **A test that already failed keeps its own reason.** #5823's async-resume
  guard converts an uncatchable wasm trap into a rejection of the frame's own
  result promise, which the test observes through its normal error channel;
  overwriting it with an identical-looking "unhandled rejection: …" would report
  one defect twice.

### Counts, both ways

Probe (`compileAndRunUpstreamModule`, 3-test module, test 2 awaits a real host
timer so the loop actually hands the event loop back):

| scenario | parent harness | with the fix |
| --- | --- | --- |
| control, no rejection | 3/3, `wasm.errors` `["","",""]` | 3/3, identical |
| Wasm-lane-only leak in test 1 | **0/3**, `compile.success:false`, `wasm: null`, `details.runtimeError: null` | **2/3**, `wasm.statuses [false,true,true]`, reason on test 1 |
| both lanes leak in test 1 | **0/3**, `wasm: null`; native silently 3/3 | 2/2 scored, `native` and `wasm` both `[false,true,true]` with the reason |
| leak outside any test (module init) | **0/3**, `wasm: null`, no reason in the report | 3/3, `details.runtimeError = "unhandled rejection: …"` |

A module whose tests are *all synchronous* never reproduces the cliff — the
worker reaches `process.exit` before Node reports the rejection — which is why
the fixture's second test awaits a real timer. Recorded here because it is the
difference between a regression test that bites and one that is vacuous.

Regression test `tests/dogfood/unhandled-host-rejection.test.ts` (8 cases).
On the parent harness: **3 failed / 5 passed** — the three harness-level
scenarios above fail, and the no-rejection control still passes (anti-vacuity).
With the fix: **8 passed**.

### A/B over all 17 upstream suites

Base and fix measured at the same HEAD (`cf82f78d6d`), one suite at a time,
compared per test file.

| suite | base | fix | | suite | base | fix |
| --- | --- | --- | --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | | tailwindcss | 13/13 | 13/13 |
| three | 17/18 | 17/18 | | jsdom | 6/6 | 6/6 |
| clsx | 32/32 | 32/32 | | styled-components | 9/9 | 9/9 |
| cookie | 63740/63740 | 63740/63740 | | uuid | 75/75 | 75/75 |
| lodash | 59/62 | 59/62 | | marked | 16/30 | 16/30 |
| redux | 67/82 | 67/82 | | moment | 10/10 | 10/10 |
| axios | 202/231 | 202/231 | | prettier | 105/151 | 105/151 |
| stylelint | 108/108 | 108/108 | | jest | 335/356 | 335/356 |
| | | | | **hono** | **258/324** | **257/324** |

**16 of 17 identical per file, 0 unmeasured files either way.** The one mover is
hono `src/utils/crypto.test.ts` 1/4 → 0/4:

```
base: passed  "Should not be the same values - compare difference objects"  wasmError: null
fix:  failed  "…"  wasmError: "unhandled rejection: TypeError: TextEncoder is not a constructor;
                                TypeError: TextEncoder is not a constructor"
```

That test was passing *because* its failure was invisible: it compares two
values that are unawaited Promises (the #5371 family), so the comparison is
trivially satisfied while two host rejections are dropped on the floor. The
other three tests in the same file already fail on `TextEncoder is not a
constructor`, so the underlying gap is not new. The −1 is an accuracy
correction, not a regression — the harness now scores the test the way the two
rejections say it should.

Runtime: the per-test `setImmediate` is not measurable. cookie, with 63,740
tests in each lane (~127k extra event-loop turns), compiled and ran in 28.6 s
against 28.8 s on base. The larger wall-clock swings in this A/B (moment 172 s →
405 s, axios 519 s → 964 s) are `compile.durationMs`, a phase this change does
not touch, on a box whose 1-min load average went from ~5 to ~200 between the
two sweeps.

### Residuals

- **Attribution is per-test, not per-promise.** A rejection leaked by test N
  that only surfaces during test N+1's window is charged to N+1. There is no
  Node hook that ties a rejection back to the code that created the promise, so
  closing this would need `async_hooks` tracking that costs more than it buys.
- **The native oracle's boundary is process-wide and shared across files.** A
  rejection left over from file A can be charged to the first test of file B.
  Pre-existing (`nativeLateCurrentFile` had the same imprecision); made finer,
  not exact.
- **`uncaughtException` is unchanged** — still a file-level `lateHostErrors`
  note on the native lane, and still fatal to the Wasm worker. Attribution there
  would need the same treatment; deliberately out of scope, since an uncaught
  exception in the worker is far more often a harness bug than guest behaviour,
  and swallowing it risks turning a fast failure into a 180 s worker timeout.
- **A module-level rejection is visible in `compile.details[N].runtimeError`
  but not in the printed headline.** A reader has to open the report JSON.
