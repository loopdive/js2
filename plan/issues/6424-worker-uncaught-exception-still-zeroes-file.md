---
id: 6424
title: "An uncaught exception in the dogfood Wasm worker still zeroes the whole test file — the other half of #5369"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
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
