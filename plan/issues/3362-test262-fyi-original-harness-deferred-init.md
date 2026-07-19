---
id: 3362
title: "test262.fyi original-harness lane: run top-level harness after host export wiring"
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: test262-runner
language_feature: harness, function-properties
goal: test262-conformance
assignee: codex/root
related: [3284, 3285]
files:
  - scripts/run-test262-fyi.mjs
  - scripts/test262-fyi-runtime.js
  - tests/test262-fyi-runner.test.ts
---
# #3362 — original-harness lane runs before host exports are wired

## Problem

The new `test:262:fyi` lane feeds js2wasm the literal test262.fyi assembly:
the host shim, upstream `assert.js`, `sta.js`, metadata includes, and the raw
test body. On an eight-test `language/directive-prologue` sample, the project
runner passes 7/8 while the original-harness lane passes only 1/8. Six tests
that pass under the project runner fail during module initialization with a
`WebAssembly.Exception`.

This is the runner-visible form of #3284's diagnosed export-wiring race:
top-level harness statements execute in Wasm `(start)` during instantiate,
before the host can call `setExports(instance.exports)`. The real upstream
`assert.js` assigns callable properties such as `assert.sameValue` and
`assert.throws`; host-mode wrapping of those closures needs the exports-backed
dispatch helpers.

## Scope

This issue fixes the project-owned `test:262:fyi` integration, whose host
contract is under our control:

1. Compile GC-lane raw-harness sources with `deferTopLevelInit: true`.
2. Instantiate, call `setExports`, then invoke the exported `__module_init`.
3. Preserve runtime-negative classification when initialization throws.
4. Add a regression test using the real upstream `assert.js` assignment shape
   without `wrapTest()` or a synthetic preamble.

This does **not** close #3284's universal external-host requirement. A third
party that instantiates a js2wasm module without calling `__module_init` still
needs the compiler-side native function-object dispatch solution described
there.

## Acceptance criteria

- The minimal raw `assert.sameValue = function ...; assert.sameValue(1, 1)`
  source passes in the original-harness runner.
- Re-running the same eight-test sample materially reduces the measured 6-test
  harness gap.
- Existing original-harness argument tests and TypeScript checks pass.

## Implementation Summary

### What was done

- The GC original-harness lane now compiles with `deferTopLevelInit: true`,
  wires `setExports(instance.exports)`, and only then invokes `__module_init`.
- The host shim's eager `var print = console.log` property read became a lazy
  forwarding function, avoiding host-property access during harness install.
- FYI-discovered tests are sorted by path before filtering/limiting, making
  sampled measurements reproducible.
- Wasm exception payloads are decoded after instantiation, replacing opaque
  `[object WebAssembly.Exception]` output with the actual test failure.

### What worked

The minimal raw top-level `assert.sameValue` reproduction now passes without
`wrapTest()`. On the deterministic eight-test `language/directive-prologue`
sample, the original-harness lane moved from 0/8 to 6/8. The project runner
also passes exactly 6/8 on those same paths, reducing the measured harness gap
from six tests to zero.

### What did not work

Deferred initialization alone still left every sample failing because the
js2wasm host shim eagerly read `console.log` at top level. Exception decoding
identified this as line 4 of the shim; deferring that property read until
`print()` is called removed the second initialization blocker.

### Files changed

- `scripts/run-test262-fyi.mjs`
- `scripts/test262-fyi-runtime.js`
- `tests/test262-fyi-runner.test.ts`
- `plan/issues/3362-test262-fyi-original-harness-deferred-init.md`

### Tests

- `node node_modules/vitest/dist/cli.js run tests/test262-fyi-runner.test.ts`
- Deterministic eight-file FYI sample: 6/8 original harness, 6/8 project
  runner, identical failing paths (`10.1.1-11-s.js`, `10.1.1-14-s.js`).
- `pnpm typecheck`

### Larger follow-up sample

A different deterministic sample—the first 50 sorted paths under
`language/expressions/array`—passes 17/50 with the original harness and 33/50
with the project runner. The original-harness pass-count gap is therefore
closed and reversed by 16 tests on this sample. Path-level results are 16
passing in both runners, 17 project-only passes, one original-only pass
(`spread-obj-symbol-property.js`), and 16 failures in both runners.

The first selected test defines a non-writable `Array.prototype[0]`. Running
the literal harness originally leaked that mutation into Node and crashed the
batch before a comparison was possible. The original-harness lane now resolves
intrinsics from a fresh VM realm for each source and restores host prototype
descriptors defensively between records.
