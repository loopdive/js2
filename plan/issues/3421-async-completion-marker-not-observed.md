---
id: 3421
title: "Async tests: literal-harness completion marker ($DONE) not observed — 2,653 default-lane reclassifications"
status: ready
created: 2026-07-18
priority: high
feasibility: hard
task_type: bugfix
area: codegen-async
goal: test262-conformance
model: fable
sprint: current
horizon: l
related: [3370, 3227, 3178, 3417]
---

# #3421 — async completion marker not observed under the literal harness

## Problem
The largest single default-lane v8 reclassification bucket:
- **`async completion marker not observed` = 2,653**
- `asyncTest called without async flag` = 68 (same family)

Under the literal harness, `async`-flagged tests are assembled with
`doneprintHandle.js` (which installs `$DONE`/print-based async completion signalling —
see `tests/test262-original-harness.ts`, the `async` prefix branch). The positive
verdict requires observing the completion marker (a `print("Test262:AsyncTestComplete")`
/ `$DONE()` with no error). The compiler's async execution does not drive the harness
to emit that marker, so these read as fails even when the async logic is correct.

This is distinct from #3227 (async post-drain verdict RE-READ) — that re-reads a
verdict that exists; here the literal-harness completion **marker** is never produced.
The v7 synthetic wrapper fabricated its own async verdict path, masking this.

## Root cause (to confirm during impl)
Candidate causes — the dev should bisect on a minimal `async`-flagged test:
1. `doneprintHandle.js`'s `$DONE`/`print` completion call routes through `print` →
   `console.log` host import; if the async continuation that calls `$DONE` never runs
   host-free, or the marker string isn't flushed to the runner's captured output, the
   runner never sees it.
2. The async continuation (microtask/promise job) that calls `$DONE` isn't drained
   before the runner reads the marker (overlaps #3227's drain fix, but for the marker
   channel, and in BOTH runner + worker lanes).
3. `$DONE` is installed as a global the compiler doesn't wire to the emitted output
   channel.

## Implementation Plan
- Reproduce with one `built-ins/Promise/**` async test through
  `scripts/test262-worker.mjs` (originalHarness=true, asyncTest=true) and trace whether
  `doneprintHandle.js`'s completion `print` is (a) executed, (b) captured by the
  runner's console/print sink.
- Fix the marker channel so the harness's `$DONE`/`print` completion signal reaches
  the runner's captured output after microtask drain, in BOTH `tests/test262-runner.ts`
  and `scripts/test262-worker.mjs` (mirror #3227 S1↔S4 parity — do not fix one lane
  only).
- If the marker is host-`print`-dependent, ensure the js-host lane captures it via the
  `consoleProxy`/`globalSandbox` already wired at worker line ~1418; for standalone,
  fold into the async-machinery umbrella #3178 (out of scope here — this issue targets
  the default/js-host lane's 2,653).

## Verification
- Scoped: a set of `built-ins/Promise/**` + `language/expressions/await/**` async
  tests report the completion marker and pass on the default lane.
- Zero-regression: sync tests unaffected; #3227's post-drain verdict still honored.

## Notes
Default-lane focus (js-host). The standalone async story is #3178.
