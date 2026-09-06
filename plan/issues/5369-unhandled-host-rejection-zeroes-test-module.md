---
id: 5369
title: "One unobserved host-promise rejection inside a compiled module kills the dogfood worker and zeroes the whole test file — a single failing call reads as a 24-test cliff"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
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
