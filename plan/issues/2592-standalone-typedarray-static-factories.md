---
id: 2592
title: "Standalone TypedArray.of / TypedArray.from static factories — CE __get_builtin"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-typedarray-2595-2597
sprint: 65
created: 2026-06-22
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 2159
depends_on: []
---

# Standalone TypedArray.of / TypedArray.from static factories

## Problem

In `--target standalone`, the typed-array static factory methods are a hard
compile error:

```ts
Uint8Array.of(1, 2, 3)        // CE: '__get_builtin' (dynamic-shape …) not supported in --target standalone
Int32Array.of(10, 20)         // CE
Uint8Array.from([4, 5, 6])    // CE
Int32Array.from([1,2,3], x=>x*2)  // CE
Float64Array.from([1.5, 2.5])     // CE
```

Verified on current upstream/main (`--target standalone`). The receiver
identifier is `Int32Array` / `Uint8Array` / … so it never reaches the
`Array.of` / `Array.from` native lowerings (those are keyed on the literal
identifier `Array`). The call falls through to the generic member-call path,
which lowers `TypedArray.of`/`from` as a dynamic-shape `__get_builtin` —
explicitly rejected standalone (#1472 Phase B).

This is the **`built-ins/TypedArrayConstructors` (321)** bucket's dominant
standalone compile-error class from the #2159 evidence.

## Root cause

`src/codegen/expressions/calls.ts`:
- `Array.of` already has a complete standalone-native lowering at **line ~4848**
  (`#1633`): it builds an f64 (or typed) vec directly with `array.new_fixed` +
  `struct.new`, no host import. `Array.from(arr)` (no mapFn) has a native
  copy/iterate path at **line ~4558**.
- Both are gated on `propAccess.expression.text === "Array"`. A
  `TypedArray.of` / `TypedArray.from` call has
  `propAccess.expression.text ∈ TYPED_ARRAY_NAMES`, so it misses both arms and
  falls through to the `__get_builtin` rejection.

## Implementation Plan

### Approach
Add a TypedArray static-factory arm in `compileCallExpression`
(`src/codegen/expressions/calls.ts`) **before** the generic member-call /
`__get_builtin` fallthrough, gated on `noJsHost(ctx)` and
`ts.isIdentifier(propAccess.expression) && TYPED_ARRAY_NAMES.has(propAccess.expression.text)`.

Reuse the storage-classification helper so the element vec matches the
constructor's existing `new Int32Array([...])` representation:

- **Element vec type**: call `typedArrayVecStorage(ctx, taName)` (index.ts:178)
  to get `{ key, type }` — `i8_byte` for standalone `Uint8Array`, `f64` for the
  rest (matches today's `new TA([...])`). Register via
  `getOrRegisterVecType(ctx, key, type)` →
  `getArrTypeIdxFromVec`. **Do not invent a new representation** — the result
  must be assignment-compatible with a `Uint8Array` / `Int32Array` typed local.

**`TypedArray.of(a, b, c)`** (mirror the `Array.of` native arm at ~4848):
- No spread → fixed arity. For each arg, `compileExpression(arg, elemWasm)`,
  coerce to the element type (`f64`, or `i32`→packed `i8` via array.set for
  `Uint8Array`). Emit `array.new_fixed` of arity N, then `struct.new` the vec
  `(len=N, data)`. Return the vec ref.
- Empty-arg case: `array.new_default` length 0 + `struct.new`.

**`TypedArray.from(iterable [, mapFn])`**:
- **Phase 1 (this slice)**: handle the common test262 shapes —
  `TypedArray.from(<array-literal | typed/number[] vec>)` and the same with a
  static arrow `mapFn`. Compile the source to its native vec, read `__vec_len`,
  loop `i = 0..len`, `__vec_get` each element, apply the mapFn closure inline
  when present (reuse the inline-closure call pattern already used by
  `Array.from(arr, mapFn)` / `TypedArray.prototype.map` in array-methods.ts),
  coerce to the element type, `array.set` into a fresh `array.new_default`-sized
  destination, then `struct.new`.
- Length comes from the source vec's field-0 (element count). For an
  array-literal source, that's statically known.
- **Out of scope (note, don't implement)**: `from(string)`, `from(Set/Map)`,
  `from` over an arbitrary `Symbol.iterator` object — those fall through to the
  existing host/iterator path (already non-standalone-native; tracked
  separately). Only array-like / vec sources are in this slice.

### Wasm IR sketch (`TypedArray.of`)
```wasm
;; Int32Array.of(10, 20)  — elemWasm = f64
f64.const 10        ;; arg 0 (coerced to f64)
f64.const 20        ;; arg 1
array.new_fixed $arr_f64 2
local.set $data
i32.const 2         ;; length
local.get $data
struct.new $vec_f64
```
For `Uint8Array.of`, coerce each arg `f64→i32` (ToUint8 wrap belongs to #2593;
this slice may leave the bare `i32`→`array.set` packing the low byte, matching
today's `new Uint8Array([...])` element-write behaviour) and use the `i8_byte`
vec.

### Edge cases
- Element type from contextual `Int32Array`/`Float64Array` static name — do NOT
  re-derive from arg types; the constructor name fixes the element width.
- `Uint8Array.of()` / `.from([])` → length-0 vec (must not trap).
- Spread arg in `.of(...xs)` → fall through to the existing path (don't claim it
  here); a standalone spread is a known gap, orthogonal.
- A `mapFn` that is not a simple arrow (e.g. a captured closure) — if the
  inline-closure pattern can't apply, roll back the speculative body
  (snapshot/rollback pattern already in calls.ts) and fall through.

### Files
- `src/codegen/expressions/calls.ts` — new TA-static arm (~line 4841 region for
  `.of`, ~4558 region for `.from`); reuse `typedArrayVecStorage`,
  `getOrRegisterVecType`, `getArrTypeIdxFromVec`, the array-literal/vec
  element-loop helpers.
- No change to `index.ts` storage selection (reuse as-is).

### Representative failing test262 paths
- `test/built-ins/TypedArrayConstructors/from/*` (mapfn, iterable, length)
- `test/built-ins/TypedArrayConstructors/of/*` (basic, length, this-is-not-ctor)
- `test/built-ins/TypedArray/prototype/...` tests that pre-seed via `.of`/`.from`

### Estimated rows
~40-90 standalone passes (of/from direct tests + the many TypedArray prototype
tests whose setup uses `TA.of`/`TA.from`).

## Notes
Substrate-independent (does NOT touch the value-rep substrate #2580). The
`Array.of`/`Array.from` native arms are the proven template. The integer
element-width wrapping for `Uint8Array.of(300)` → `44` etc. is **deferred to
#2593** — this slice only needs the factories to compile + produce the right
length/order, matching today's `new TA([...])` fidelity.

## Resolution (2026-06-22)

Implemented the TypedArray static-factory arm in
`src/codegen/expressions/calls.ts`, placed BEFORE the `Array.from`/`Array.of`
arms, gated on `noJsHost(ctx) && TYPED_ARRAY_NAMES.has(receiver)`. Exported
`typedArrayVecStorage` from `index.ts` so the element vec representation
(`i8_byte` for standalone `Uint8Array`, `f64` otherwise) matches `new TA([...])`.

- **`TA.of(...)`** — mirrors the `Array.of` native arm: per-arg coerce to the
  element store type (`i32` for `i8` packed, else `f64`), `array.new_fixed` +
  `struct.new`. Empty → `array.new_default` len 0. Spread args fall through.
- **`TA.from(arrayLike)`** (no mapFn) — element-by-element copy with re-coercion
  (the source vec's element type may differ from the dest), via a
  `block{loop{ if i>=len br 1; dst[i]=coerce(src[i]); i++; br 0 }}` built with
  `pushBody`/`popBody` so the `coerceType` conversion lands inside the loop.
  Handles f64→i8, i8→i8 (`array.get_u`), empty source.

**Deferred to follow-up (still fall through to existing path):**
- `TA.from(src, mapFn)` — needs in-loop closure dispatch; standalone still CEs
  (unchanged from before), gc/host works via the host import.
- `TA.from(string | Set | arbitrary iterable)` and spread in `.of(...xs)`.
- Integer element-width wrapping (`Uint8Array.of(300)` → 44) → **#2593**.

Validated: `tests/issue-2592.test.ts` (22 tests, standalone + gc/host);
`Array.of`/`Array.from` non-regression confirmed. tsc + prettier +
coercion-sites gates clean.
