---
id: 1633
title: "spec gap: Array.from / Array.of constructor semantics (39 test262 fails, wasm_compile dominant)"
status: blocked
created: 2026-05-08
updated: 2026-05-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen+runtime
language_feature: array
goal: spec-completeness
sprint: 50
renumbered_from: 1339
parent: 1328
blocked_on: 1320, 1620
---
# #1339 — Array.from / Array.of: subclassing + iterable bridge

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

## Investigation 2026-05-27 (developer) — ESCALATE / blocked on iterator-bridge

Ran the full `built-ins/Array/{from,of}` suites through the real
`runTest262File` runner (the only reliable harness — a hand-rolled harness
mis-classifies due to TS `skipSemanticDiagnostics` and missing $262/realm
support). Current baseline against `origin/main` (6d5a806d0):

```
Array/from: pass 17, fail 28, compile_error 5
Array/of:   pass 6,  fail/throw ~11
```

**The issue title ("constructor semantics, fix in runtime.ts") rests on a false
premise.** The 28+ `from` failures are NOT one bug and are NOT fixable in
`runtime.ts` alone. They decompose into four independent root causes, three of
which depend on shared infrastructure owned by other (escalated) issues:

1. **Iterator/property bridge for compiled objects (DOMINANT — ~18 fails).**
   Every `from/iter-*` and `from/calling-from-valid-*` test defines its source
   as a TS object literal (`items[Symbol.iterator] = function(){…}` or an
   array-like `{0:..,length:3}`). js2wasm compiles these to **WasmGC structs**,
   so when the host runtime's `__array_from` calls `Array.from(items, mapFn)`,
   V8 sees `items[Symbol.iterator]` as an opaque wasm struct (not a callable JS
   function) and throws `%Array%.from requires that … items[Symbol.iterator] …
   be a function`. The array-like fallback path fails the same way:
   `o.length` / `o[k]` on a compiled struct → `Cannot access property on null
   or undefined`. `_materializeIterable` (runtime.ts:959) only bridges wasm
   **vec** structs via `__vec_len`/`__vec_get`; it does NOT drive the
   iterator protocol or array-like indexing through the wasm exports. Doing so
   requires the same `callbackState.getExports()` iterator-result/`__sget_*`
   bridge that **#1620 (IteratorResult struct, ESCALATED-needs-spec, task #102)**
   and **#1320 (Array.from externref iterator bridge)** own. This is the gating
   dependency — not a localized runtime fix.

2. **Subclass / `this`-as-constructor protocol (~15 `wasm_compile`, all of
   `Array.of/*` `.call(ctor)` + `from/proto-from-ctor-realm`).** Codegen in
   `src/codegen/expressions/calls.ts:2698,2811` hard-codes
   `propAccess.expression.text === "Array"` — only the literal identifier
   `Array.from` / `Array.of` is recognized. `Sub.from(...)` /
   `Array.of.call(Ctor)` never reach this path; they fall through to generic
   method dispatch with no `Construct(C, len)` semantics. Receiver-aware
   dispatch (resolve receiver at runtime, `Construct` via host, `__set_element`
   per spec step 12/13) is a sizeable codegen feature, not a runtime tweak.

3. **mapFn `thisArg` (3rd arg) dropped.** `calls.ts:2786-2791` only forwards
   `arguments[0]` and `arguments[1]`; the `thisArg` is never passed, and
   `__array_from` (runtime.ts:5080) calls `Array.from(iter, mapFn)` with no
   `T` binding. Clean to fix in isolation, BUT every test that exercises it
   (`from/iter-map-fn-this-*`) also hits root cause #1 first, so fixing it
   alone moves zero tests green.

4. **Arg boxing fidelity in `Array.of` (`of/creates-a-new-array-from-arguments`,
   `a2[1]` expected `false`, got `0`).** Boolean/null args are coerced i32→
   externref via `f64.convert_i32_s` + `__box_number` (per the documented
   coercion path), so `false`→boxed `0`, `null`/`undefined`→`0`/`NaN`. There is
   **no `__box_bool` / JS-boolean-externref helper** anywhere in the codebase —
   this is the cross-cutting "no boxed JS boolean" limitation, not specific to
   `Array.of`.

**Conclusion:** #1633 cannot be delivered as a self-contained
`runtime.ts` bugfix. Its dominant cluster is blocked on the iterator/property
bridge (#1320 / #1620, both not yet landed; #1620 is escalated-needs-spec).
The remaining clusters are independent features (receiver-aware
constructor dispatch; boxed-boolean externref) that each warrant their own
issue. Recommend: **keep #1633 blocked on #1320 + #1620**, and split out (a)
subclass-constructor dispatch and (b) boxed-boolean externref as separate
issues. No code change landed — a partial mapFn-thisArg/array-like patch
would move 0 tests until the bridge exists.
