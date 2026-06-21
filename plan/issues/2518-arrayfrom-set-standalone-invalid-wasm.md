---
id: 2518
title: "standalone Array.from(Set) emits invalid Wasm (struct.new arity) — Set struct mis-read as a __vec by structural resolveArrayInfo"
status: done
assignee: ttraenkler/sd2
sprint: 64
created: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: collections, iterators, array-methods
goal: standalone-mode
related: [42, 2162, 2169]
origin: "2026-06-19 standalone leak/crash sweep (sd2): compiling collections/iterators with --target standalone surfaced Array.from(Set)/Array.from(Map) emitting invalid Wasm."
---

# #2518 — standalone `Array.from(Set)` emits invalid Wasm

## Problem

In `--target standalone`, `Array.from(set)` (and `Array.from(map)`) emit
**invalid Wasm**: `WebAssembly.Module(): ... not enough arguments on the stack
for struct.new (need 4, got 2)`. `Array.from(array)` / `Array.from(string)` are
fine; `[...set]` spread is fine.

```ts
const s = new Set<number>([1, 2, 3]);
const a = Array.from(s);   // standalone: INVALID WASM (struct.new arity)
a.length;                  // → never runs
```

## Root cause

`src/codegen/expressions/calls.ts`, the `Array.from` handler. A `Set` lowers to
a `ref $Map` struct whose field layout is **not** a `__vec` (field 0 is not a
length; field 1 is the internal entries bucket array). The array-copy fast path
guards on `resolveArrayInfo` (`array-methods.ts`), which is purely **structural**
— it matches *any* WasmGC struct whose field[1] is a `ref array`. The Set struct
matches, so the fast path treats it as a `__vec`: `struct.get 0/1` on the Set
struct, then `struct.new <vecTypeIdx>` with a mismatched field arity → the crash.
(The generic `__iterator` native-drain fallback, #2169c, instead hard-casts the
subject to a `__vec` → `illegal cast` trap at runtime for a non-vec Set.)

## Fix

Route `Array.from(set)` through the **same `emitCollectionIteratorVec` driver**
the `[...set]` spread (#42) and `.values()` paths already use — a Set yields its
values (§23.1.4.1 / §24.2.3) as a canonical externref `$Vec`, exactly
`Array.from`'s result. Additionally, reject the known non-array builtin
collections (a Set the driver declined, plus `Map`/`WeakSet`/`WeakMap`) from the
structural array-copy fast path so they cannot trigger the `struct.new` crash.

Two-line summary:
- New `import { emitCollectionIteratorVec } from "../map-runtime.js"`.
- In the `Array.from` handler: a `argSymName === "Set"` (native-strings) branch
  calling `emitCollectionIteratorVec(..., "values", true)` and returning its vec;
  plus an `isNonArrayBuiltinCollection` guard on the array-copy fast path.

## Acceptance criteria

- `const a = Array.from(set); a.length / a[i] / for-of` all correct standalone
  (no invalid Wasm, no trap, host-import-free). ✓
- `Array.from(array)` / `Array.from(string)` unchanged. ✓
- No regression to Set/Map for-of, `.values()`, or `[...set]` spread. ✓

## Validation

`tests/issue-arrayfrom-set-standalone.test.ts` (8 cases): Set→array length, sum
via for-of, index, de-dup, indexed for-loop, host-import-free assertion, plus
array/string regression guards. `tsc`/prettier/biome clean. Existing
`issue-1103a-standalone-map`, `issue-2151-spread-literal`,
`issue-2157-iterator-generator-residual` suites green.

## Out of scope (documented follow-ups)

- **Chained `Array.from(set).length`** (inline, no local) reads `0` — a separate
  property-access *result-type-threading* gap: the chained `.length` on a call
  result does not yet recognise the externref-vec representation
  `emitCollectionIteratorVec` returns. The dominant assign-then-use form
  (`const a = Array.from(s); a.length`) is correct. (`[...set].length` works
  because spread copies into a number-element vec matching the literal type.)
- **`Array.from(map)`** → `[k, v]` entry pairs needs the `$ObjVec` pair-indexing
  path, which is not yet sound. Map stays on the prior routing (now rejected from
  the crashing array-copy fast path, so it routes to the native drain instead of
  emitting invalid Wasm — strictly no worse than the base, where it was invalid
  Wasm).
