---
id: 1441
title: "spec gap: String.prototype.split — Array result shape + String wrapper receivers"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: string-split
goal: spec-completeness
sprint: 52
related: [1439]
---
# #1441 - String.prototype.split: Array shape + wrapper receivers

## Problem

Two related defects make `String.prototype.split` fail on ~70 test262
entries:

1. **Result Array missing `.constructor === Array`.** The array returned
   by `split` is a JS host externref whose `constructor` property either
   doesn't resolve or doesn't compare strictly equal to the `Array`
   identifier visible inside the wasm module.
2. **`new String("...")` wrapper objects as receivers.** Many tests do
   `var __string = new String("hello"); __string.split(re, void 0)`. The
   compiler does not unbox the String wrapper into a primitive string
   before invoking the split helper.

Sample failing tests (all fail at the *first* assertion `__split.constructor === Array`):
- `test/built-ins/String/prototype/split/arguments-are-new-reg-exp-and-void-0-and-instance-is-string-hello.js`
- `test/built-ins/String/prototype/split/call-split-l-3-instance-is-string-hello.js`
- `test/built-ins/String/prototype/split/argument-is-regexp-d-and-instance-is-string-dfe23iu-34-65.js`
- `test/built-ins/String/prototype/split/checking-by-using-eval.js`
  (fails earlier: "dereferencing a null pointer")
- `test/built-ins/String/prototype/split/instance-is-function.js`
  ("Cannot access property on null or undefined at 72:3")

## Failure count

97 failures in `built-ins/String/prototype/split` in
test262-current.jsonl; 68 of them match the `__split.constructor` pattern
(grep confirmed). The remaining ~30 split failures involve null/undefined
receivers, eval, and `instance-is-function`.

## Root cause

- `src/codegen/string-ops.ts:1746` routes `split` with a non-RegExp first
  arg to the native helper `__str_split`, and with a RegExp arg to the
  host import path. **Both paths** produce a result whose host-side
  `constructor` is *something* but the test compares it against the
  `Array` reference looked up inside the wasm module — equality fails
  unless we coerce the result through `Array.from(...)` or expose the
  host's `Array` identity to the module.
- `new String(...)` creates a String wrapper externref. When that
  wrapper is used as the `this` of `split`, the compiler should call
  `ToString(this)` first, but the receiver compile path treats the wrapper
  as opaque externref and feeds it directly to the split helper, which
  then returns null when it tries to index it as a flat string.

## Implementation sketch

1. **Array identity:** in the `split` host-import path, wrap the returned
   externref so its `constructor` is the same `Array` that the runtime
   exposes to the module (the same fix likely benefits `match`, `matchAll`).
   Either:
   - Pass the result through a tiny JS shim that re-creates it as
     `Array.from(result)`, or
   - Register the `Array` host identifier the module *sees* (via
     `__array_proto_constructor`) so the equality check passes.
2. **Wrapper receivers:** insert a `RequireObjectCoercible(this) →
   ToString(this)` step before the split call. The existing `ToString`
   helper used by template literals can be reused.
3. **Null/undefined receiver:** `split.call(null)` must throw
   `TypeError` — today it produces a null-deref. Same `RequireObjectCoercible`
   guard covers it.

## Acceptance criteria

1. `["a","b"].constructor === Array` for the array returned by `split`
   in compiled code.
2. `new String("hello").split(/.../)` returns the same array as
   `"hello".split(/.../)`.
3. `"x".split.call(null)` throws `TypeError`.
4. `built-ins/String/prototype/split` failures drop by ≥80%.

## Files to inspect

- `src/codegen/string-ops.ts:1746-1800` (split dispatch)
- `src/codegen/expressions/calls.ts` (this-value coercion)
- `src/codegen/type-coercion.ts` (RequireObjectCoercible/ToString)
- `src/runtime.ts` (Array host import, String wrapper unbox)
- `tests/issue-1441.test.ts`
