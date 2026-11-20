---
id: 7442
title: "`'a'.repeat(Number.MAX_SAFE_INTEGER)` gives a 2^31-1 string instead of throwing RangeError"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: medium
horizon: s
task_type: bug
area: runtime, strings
goal: core-semantics
related: [7380]
---

# #7442 — `String.prototype.repeat` past the string length limit does not throw

## Problem

```ts
export function run(): number {
  try { return "a".repeat(9007199254740991).length; }
  catch (e) { return e instanceof RangeError ? -1 : -2; }
}
```

node: -1 (RangeError, "Invalid string length"). js2wasm, default JS target and `--target standalone`: 2147483647. No
exception at all: the native repeat clamps the result length to 2^31-1 code units.

Called from JavaScript through the compiled exports adapter,
`repeat("a", Number.MAX_SAFE_INTEGER)` instead throws `WebAssembly.RuntimeError` ("requested new array is too
large") when the adapter materializes that string.

Measured on `claude/7380-pins-b`, found by the #7380 PR 2b review.

## Evidence

`tests/issue-3518-string-repeat-ir.test.ts` "documents #7442: a result longer than the string limit traps instead of
throwing RangeError". The test pins the current wrong behaviour; the fix changes its expectation to `RangeError`.

## Acceptance criteria

1. When `count * length` exceeds the engine's string limit (and the string is not empty), `repeat` throws RangeError on
   both targets, in-module and through the adapter.
2. `"".repeat(Number.MAX_SAFE_INTEGER)` stays `""`; the other rows of the test are unchanged.
3. The pinning test flips to `RangeError`.
