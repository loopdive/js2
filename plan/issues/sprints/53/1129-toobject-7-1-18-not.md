---
id: 1129
title: "ToObject (§7.1.18) not implemented — no primitive auto-boxing"
status: done
created: 2026-04-17
updated: 2026-05-21
priority: low
feasibility: hard
task_type: feature
language_feature: type-coercion
goal: core-semantics
es_edition: es5
found_by: "#1093 Phase 1 audit"
---
# #1129 — ToObject (§7.1.18) not implemented — no primitive auto-boxing

## Problem

The ECMAScript spec defines ToObject (§7.1.18) as an Abstract Operation that wraps
primitives in their corresponding Object wrappers:
- Number → Number wrapper object
- String → String wrapper object
- Boolean → Boolean wrapper object
- Symbol → Symbol wrapper object
- BigInt → BigInt wrapper object
- null/undefined → TypeError
- Object → return argument unchanged

Our compiler has **no dedicated ToObject operation**. Instead:
- Method calls on primitives (e.g., `(42).toString()`) are handled via direct dispatch
  to known methods — this gives correct results without wrapper creation. ✅
- `new Number(x)` / `new String(x)` / `new Boolean(x)` are detected by
  `scanForBoxedPrimitiveConstructors` and create externref wrappers via host. ✅
- `Object(42)` (without `new`) is not handled — should create a Number wrapper.
- Destructuring null/undefined → TypeError checks exist. ✅

## Gaps

1. **`Object(primitive)` call**: Should create a wrapper object. Currently not implemented.
2. **`for-in` on primitives**: Per spec, `for (let k in "abc")` should call ToObject("abc")
   and iterate string indices. May work via externref fallback but not spec-correct.
3. **Prototype methods receiving primitives as `this`**: Strict mode functions see the
   primitive `this`; sloppy mode auto-boxes. We don't distinguish.

## Impact

Low-medium. Most practical code doesn't rely on primitive auto-boxing semantics.
Test262 has tests specifically for ToObject behavior, particularly:
- `Object()` wrapper creation
- `this` boxing in sloppy mode functions
- Property access on primitives (auto-boxing for method lookup)

## Fix sketch

For `Object(x)` calls: detect at compile time and emit `__box_number` (for numbers),
string wrapping, or boolean wrapping. These create externref wrapper objects via the host.

For sloppy-mode `this` boxing: would require a per-function flag in the closure struct
indicating strict/sloppy, and auto-boxing the `this` argument on call. This is a significant
architectural change — defer to a later sprint.

## Acceptance criteria

- [x] `Object(42)` creates a Number wrapper (typeof === "object")
- [x] `Object("abc")` creates a String wrapper
- [x] `Object(true)` creates a Boolean wrapper
- [x] `Object(null)` and `Object(undefined)` return empty objects (per spec, NOT TypeError — that's only for ToObject, not the Object() constructor)

## Implementation

Added an `Object(x)` call handler in `src/codegen/expressions/calls.ts`
(after the `new RegExp` peephole), gated on `ts.isIdentifier(expr.expression)
&& expr.expression.text === "Object"`:

- `Object()` / `Object(null)` / `Object(undefined)` → `__object_create(null)`
  host import (mirrors `new Object()` in `new-super.ts`). Static null/undefined
  is detected via `ts.TypeFlags.Null | Undefined | Void` exact-match (unions
  that include other types fall through to the primitive/object branch).
- `Object(number)` → `__new_Number(f64)` — same host import used by `new Number(x)`.
- `Object(string)` → `__new_String(externref)`.
- `Object(boolean)` → coerce bool→i32→f64, then `__new_Boolean(f64)`.
- Object / externref / union — return the argument unchanged (per spec
  identity rule). A future runtime ToObject for `any`-typed values would
  require a `__to_object` host helper; deferred.

Sloppy-mode `this` boxing for prototype methods (Gap #3) is still deferred —
requires a per-function strict/sloppy flag in the closure struct.

`for-in` on primitives (Gap #2) works in practice because the externref
fallback iterates string indices via the host; no codegen change required
for the acceptance criteria.

## Test Results

`npm test -- tests/issue-1129.test.ts --run` — 9/9 pass:
- typeof checks for `Object(42)`, `Object("abc")`, `Object(true)`,
  `Object(false)`, `Object(null)`, `Object(undefined)`, `Object()` —
  all return `"object"`.
- `Object(42).valueOf() === 42` — Number wrapper round-trips through host valueOf.
- `Object("abc").toString() === "abc"` — String wrapper round-trips.
