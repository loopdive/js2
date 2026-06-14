---
id: 1338
title: "spec gap: Array.from / Array.of constructor semantics (39 test262 fails, wasm_compile dominant)"
status: done
completed: 2026-06-12
created: 2026-05-08
updated: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array
goal: spec-completeness
sprint: 50
parent: 1328
---
# #1338 — Array.from / Array.of: subclassing + iterable bridge

## Problem

`built-ins/Array/from`: **18 / 47 pass (38.3%)** — 15 wasm_compile, 9 assertion_fail, 3 other.
`built-ins/Array/of`: **6 / 16 pass (37.5%)** — 8 assertion_fail, 1 type_error, 1 other.

Spec §23.1.2.1 (Array.from) and §23.1.2.3 (Array.of) require:
1. **`Array.from(items, mapFn?, thisArg?)`** — construct via `this` (so `class Sub extends Array`
   produces `Sub.from(...)` returning a `Sub`).
2. From an iterable: GetIterator, loop, push.
3. From an array-like: read .length, iterate by index.
4. **`Array.of(...args)`** — same `this`-as-constructor pattern.

The 15 `wasm_compile` errors strongly suggest the constructor type-check assumes the receiver
is the Array constructor exactly — no support for `Sub.from(...)` where Sub is a subclass.

This relates to issue #1320 (Array.from externref iterator bridge).

## Acceptance criteria

1. `built-ins/Array/from/calling-from-valid-1-noStrict.js` passes.
2. `built-ins/Array/from/iter-set-length.js` passes (set length before assigning elements).
3. `built-ins/Array/of/proto-from-ctor-realm.js` passes.
4. Pass-rate for `built-ins/Array/from` rises from 38% to ≥75%; for `Array/of` from 38% to ≥85%.

## Files to modify

- `src/codegen/array-methods.ts` — `compileArrayFrom`, `compileArrayOf`
- `src/codegen/property-access.ts` — `this`-as-constructor lookup

## Implementation Plan

### Root cause

The Array.from path emits a fixed `array.new` of `(ref Array)` instead of dispatching on the
receiver. When called as `Sub.from(items)`, the receiver is `Sub` — `array.new $Array` is wrong
type, hence `wasm_compile` errors at link time when subclasses use Array.from.

### Approach

When the receiver is statically `Array`, keep the fast path. Otherwise:
1. Resolve receiver at runtime via `__construct_with_this(thisCtor, length)` host import (or
   pure-Wasm helper for typed subclasses).
2. Push elements via `__set_element(target, index, value)` rather than direct
   `array.set $Array.elements`.

For Array.of — same dispatch.

### Edge cases

- Receiver is non-callable → TypeError per spec.
- mapFn returns thenable → spec says no special handling (just store the result).
- iterable returns done=true on first next() → Array of length 0.

### Test262 sample

- `test262/test/built-ins/Array/from/iter-set-length.js`
- `test262/test/built-ins/Array/from/calling-from-valid-1-noStrict.js`
- `test262/test/built-ins/Array/of/proto-from-ctor-realm.js`

## Investigation 2026-05-28 (dev-1338, branch issue-1338-array-from-of)

Re-baselined `built-ins/Array/from` (47 files) against current main
(`9a819e46c`). **Reality differs from the 2026-05-08 framing:**

- `from/iter-set-length.js` (acceptance #2) — **already passes** on main.
- `from/calling-from-valid-1-noStrict.js` (acceptance #1) — fails with
  "Cannot access property on null or undefined" at runtime, not
  `wasm_compile`. Not a subclassing bug — the receiver is `Array`. The
  source uses `assert.sameValue(calls[0].thisArg, this, …)` and our
  `args.push(arguments)` path drops/dereferences something to null.
- `of/proto-from-ctor-realm.js` (acceptance #3) — fails with
  `$262 is not defined`. Blocked on **#1523** (wire up $262 host-object
  in test262 runner). Not a #1338-localized fix.

Categorised failures in `built-ins/Array/from`:

| Bucket | Count | Belongs to |
|--------|-------|------------|
| `wasm_compile` (real codegen) | 4 | #1338 candidate |
| `returned N` (test262 multi-assert wrapping) | ~12 | **#1318** |
| null/undefined deref (mapfn / iterator host-bridge) | ~3 | **#820** family |
| `$262` not defined | 1 | **#1523** |
| pre-existing assertion fails (spec gap) | rest | mixed |

The 4 real wasm_compile errors are **NOT subclassing**:
- `from/iter-map-fn-args.js` — `call[0] expected externref, found (ref null 20)`
- `from/iter-set-elem-prop.js` — same shape
- `from/source-object-iterator-1.js` — `__cb_1 struct.get expected (ref null 26), found (ref null 25)`
- `from/source-object-iterator-2.js` — same shape

Pattern: **closure struct-type mismatch when an iterator/mapFn closure
captures into a vec / iterator-result struct.** This overlaps with
#1684 (iterator-result object literal nested-closure types) and #1620
(`__iterator_next` multi-value), both already in flight.

`built-ins/Array/of` scan crashed the host with `WebAssembly.Exception`
on `of/does-not-use-set-for-indices.js` and `of/length.js` — wasm trap
bubbling past the runner's catch. Not investigated further.

### Subclassing path (the original #1338 framing)

The `Sub extends Array; Sub.from(...)` case requires:
1. **`__construct_with_this(thisCtor, length)` host import + runtime
   support** — not present in `src/runtime.ts`.
2. Runtime per-element write via `__set_element(target, i, v)` instead
   of `array.set $Array.elements` — requires struct/vec untyping.
3. Receiver-dispatch at `propAccess.expression !== "Array"` in
   `compileArrayFrom`/`compileArrayOf`.

This is the same iterator-bridge gap **#1320** has already been
**ESCALATED-NEEDS-ARCHITECT** for (task #158). Without that bridge
landing, the #1338 subclass path has no scaffolding to attach to.

### Recommendation

#1338 as written is **NOT a single localized bugfix**. The failures
decompose into:

- 4 closure-struct wasm_compile errors → overlap with **#1684/#1620**
  (already escalated/in-flight).
- ~12 `returned N` wraps → **#1318**.
- ~3 null deref → **#820** family.
- $262 → **#1523**.
- Subclass-via-`this`-construct → **blocked on #1320 architect spec**.

Suggest: close as `[NOT-A-LOCALIZED-FIX]` and route the residuals into
existing issues, OR keep open and gate on #1320 + #1684 + #1318 landing.
No standalone PR should land for #1338 in its current scope.
