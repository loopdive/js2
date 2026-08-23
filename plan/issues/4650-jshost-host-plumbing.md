---
id: 4650
title: "js-host: host-plumbing harness self-tests — fnGlobalObject, detachArrayBuffer, testTypedArray"
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
  - scripts/test262-fyi-runtime.js
  - tests/test262-runner.ts
---

# js-host: host-plumbing harness self-tests — 3 failures

Goal context: 100% of `test262/test/harness/` in BOTH lanes; js-host is at
102/116 (2026-08-23, branch `claude/harness-standalone-green`,
`.tmp/run-harness-all-host.mts`). This issue owns three unrelated singles that
all touch host/global plumbing:

| test | js-host error |
| --- | --- |
| `fnGlobalObject.js` | `TypeError: null is not a function in __module_init` — the include's `Function("return this;")()` (string-body Function constructor) compiles to a null callee. Also requires `fnGlobalObject() === this` at top level (global `this` identity) |
| `detachArrayBuffer.js` | Expected ReferenceError NOT thrown — the test (no includes!) calls bare `$DETACHBUFFER(ab)` and REQUIRES a ReferenceError because the identifier is undeclared. Either the runner/shim leaks a `$DETACHBUFFER` definition into js-host tests, or the compiler fails to throw ReferenceError for an undeclared identifier call |
| `testTypedArray.js` | `callCounts[name]` is `undefined`, expected `8` — the harness counts constructor invocations in an object keyed by ctor name across `testWithTypedArrayConstructors`; computed-string-key accumulation (`callCounts[name] = (callCounts[name] ?? 0) + 1`-shape) or the ctor `.name` read is broken |

## Implementation Plan (initial — deepen before implementing)

1. **fnGlobalObject**: check how `Function(...)` (called AS function, string
   body) lowers in js-host. If a host-eval import exists (js-host has host
   `eval`), route `Function(bodyString)` through it; otherwise a minimal
   special-case for the harness idiom `Function("return this;")()` → the
   native globalThis object is acceptable ONLY if implemented as a general
   `Function` ctor arm, not a source-text match. Then verify `gO === this`
   (top-level `this` must be the same identity as `globalThis` in js-host
   sloppy/script mode).
2. **detachArrayBuffer**: ROOT CAUSE FOUND (lead, 2026-08-23): the runner
   leaks the shim. `tests/test262-runner.ts:2962` sets
   `needsDetachBuffer = /\$DETACHBUFFER\b/.test(body)` — regex on the body,
   NOT gated on `includes.includes("detachArrayBuffer.js")` — and injects a
   `$DETACHBUFFER` function (#1515 shim, ~L2093). This self-test deliberately
   has NO includes and requires the identifier to be UNDECLARED. Fix: gate the
   injection on the include being requested (every real consumer declares
   `includes: [detachArrayBuffer.js]`; mirror the `proxyTrapsHelper` gating
   two blocks below). THEN verify the second half: with no shim, the bare
   `$DETACHBUFFER(ab)` call must produce a CATCHABLE ReferenceError
   (`err.constructor === ReferenceError`) in js-host — check what the
   compiler does with an undeclared identifier call (CE would also fail the
   test; standalone currently PASSES this test, so establish how before
   changing shared assembly — the fix must not flip standalone red).
3. **testTypedArray**: minimal repro of the counting pattern in
   `test262/harness/testTypedArray.js` (read it first): an outer object,
   per-ctor `name` string keys, increments inside a callback invoked by
   `testWithTypedArrayConstructors`. Suspects: `.name` of TypedArray ctors,
   computed member increment on an any-typed object, or property-read of a
   never-written key returning something that breaks `undefined + 1` NaN
   handling in the harness's guard.
4. `wellKnownIntrinsicObjects.js` also fails js-host but is OWNED by #4633
   (standalone twin in flight) — do not touch it here; note findings in
   #4633 instead.

## Acceptance criteria

- The 3 tests pass js-host (`.tmp/run-harness-all-host.mts` green for them).
- Standalone category unchanged (113/116 on the stacked base); js-host sample
  59/60 (`.tmp/run-host-list.mts` + `.tmp/host-sample.txt`).
- No new host imports without a standalone fallback (CLAUDE.md dual-mode
  rule) — anything added to the js-host lane states its standalone story.

## Permanent repro

`test262/test/harness/fnGlobalObject.js`,
`test262/test/harness/detachArrayBuffer.js`,
`test262/test/harness/testTypedArray.js` (js-host lane,
`tests/test262-runner.ts` `runTest262File(..., undefined)`).
