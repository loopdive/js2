---
id: 4648
title: "js-host: asyncHelpers harness self-tests — 6 failures (asyncTest/throwsAsync family)"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/fn-global-shadow.ts
  - tests/test262-runner.ts
---

# js-host: asyncHelpers harness self-tests — 6 failures

Goal context: 100% of `test262/test/harness/` self-tests in BOTH lanes. The
js-host lane sits at 102/116 (measured 2026-08-23 on branch
`claude/harness-standalone-green`, `.tmp/run-harness-all-host.mts`). This issue
owns the 6-test asyncHelpers bucket:

| test | js-host error |
| --- | --- |
| `asyncHelpers-asyncTest-rejects-non-callable.js` | `compareArray(doneValues, [true×6])` got `[false×6]` — $DONE never called back with rejection verdicts |
| `asyncHelpers-asyncTest-returns-undefined.js` | `Test262:AsyncTestFailure:TypeError: Cannot convert object to primitive value` |
| `asyncHelpers-asyncTest-then-rejects.js` | `Test262:AsyncTestFailure:Test262Error: [object Object]` |
| `asyncHelpers-throwsAsync-custom-typeerror.js` | `Throws an instance of the matching custom TypeError` |
| `asyncHelpers-throwsAsync-func-never-settles.js` | `async completion marker not observed` |
| `asyncHelpers-throwsAsync-native.js` | `Expected a Error to be thrown asynchronously but …` |

## Implementation Plan (initial — deepen before implementing)

1. **Measure first.** Re-run the 6 with a js-host single-file runner
   (`.tmp/one-host.mts`, `F=test/harness/<f> npx tsx .tmp/one-host.mts`) and
   capture full errors + minimal repros in `.tmp/`.
2. **Check the standalone twin work (#4630) for shared roots.** The standalone
   fixes for `asyncTest-returns-undefined`/`then-rejects`/`then-resolves` were:
   (a) `globalThis.$DONE = …` must shadow the top-level `$DONE` function for
   bare reads/calls — implemented in `src/codegen/fn-global-shadow.ts` but
   **gated `ctx.standalone || ctx.wasi`**, so the js-host lane never gets the
   override-slot machinery. If the js-host failure has the same shape (harness
   reassigns `$DONE` via `globalThis`, compiled code keeps calling the static
   binding), widening the gate is the first candidate — BUT js-host bare-call
   lowering differs (host closures, `__call_fn_method_*`), so verify the write
   path actually lands on the same object the read path consults before
   widening. (b) The catch-clause param-inference withdrawal in
   `param-return-inference.ts` is NOT standalone-gated — already active.
3. `asyncTest-rejects-non-callable`: the test calls `asyncTest(<non-callable>)`
   ×6 and expects each returned promise to REJECT and `$DONE` to observe it.
   `[false×6]` means the rejection path never fires — likely the harness's
   `Promise.resolve(...).then(...)` chain around a non-callable, or
   `typeof !== "function"` guard, misbehaves under js-host lowering.
4. `throwsAsync-*`: `assert.throwsAsync` builds an async arrow that awaits
   `innerFn()` inside try/catch and inspects the error's constructor identity.
   Custom-typeerror failing while the standalone twin passes suggests js-host
   error-object identity (`err.constructor === TypeError`) or the
   `instanceof`/`.name` read through the any channel diverges.
5. **Never regress the throwsAsync-* baseline-pass set** — the standalone twin
   (#4630) proved param-inference changes cascade there; keep
   `.tmp/run-harness-all-host.mts` (full category, js-host) as the gate, plus
   `.tmp/host-sample.txt` via `.tmp/run-host-list.mts` (59/60 expected — the
   AsyncDisposableStack failure is pre-existing).

## Acceptance criteria

- All 6 tests above pass in js-host mode (`.tmp/run-harness-all-host.mts`
  reports them green; category ≥ 108/116).
- No regression in the js-host 60-test sample (59/60) or the standalone
  category (113/116 on the stacked base).
- Any codegen change states its lane gating explicitly (standalone-only vs
  both) with one sentence of justification in the code comment.

## Permanent repro

`test262/test/harness/asyncHelpers-asyncTest-rejects-non-callable.js` (js-host
lane, `tests/test262-runner.ts` `runTest262File(..., undefined)`).
