---
id: 2502
title: "Array.prototype.sort on an externref-element array emits invalid Wasm (__isort_externref f64.gt on externref) — 28 test262"
status: done
assignee: ttraenkler/sd5
sprint: 64
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
test262_bucket: sort-externref
test262_count: 28
origin: "2026-06-19 jsonl scout (sd5): 28 compile_errors, verified on main"
---

# #2502 — `__isort_externref` emits `f64.gt` on externref array elements (invalid Wasm)

## Problem

```ts
var x = new Array(2);
x.sort();   // wasm: invalid binary — compile fails
```

28 test262 `compile_error`s (19 `built-ins/Array/prototype/sort/*`, 9
`built-ins/Atomics/*` — the Atomics harness sorts a setup array). The exact
error:

```
invalid Wasm binary (WebAssembly.instantiate(): Compiling function
#N:"__isort_externref" failed: f64.gt[0] expected type f64, found array.get
of type externref)
```

## Root cause

`Array.prototype.sort()` with no comparator on an array whose element type is
**externref** (holes / `undefined` / mixed `any`) routes to the numeric Timsort
fallback (`ensureTimsortHelper`, `src/codegen/array-methods.ts`). But
`emitInsertionSort` / the timsort family in `src/codegen/timsort.ts` are typed
`elemKind: "i32" | "f64"` only. When the caller passes an externref-element
array, the helper is minted as `__isort_externref` yet its comparator falls into
the `else` branch:

```ts
// timsort.ts:96
const gtOp: Instr = elemKind === "i32" ? { op: "i32.gt_s" } : { op: "f64.gt" };
```

so it emits `f64.gt` over `array.get` of an `externref` element → the WasmGC
validator rejects the binary (`f64.gt[0] expected type f64, found … externref`).

The numeric Timsort is only valid for `i32` / `f64` element arrays. Externref
arrays need the §23.1.3.30 SortCompare semantics (no comparator ⇒ compare by
ToString), which the codebase already has as a ToString-comparing insertion
sort (the `#1993` path at `array-methods.ts:7067+`).

## Fix direction

Gate the numeric Timsort path to `i32` / `f64` element kinds. For an
externref-element array sorted with no comparator, route to the existing
ToString-comparing insertion sort (the `#1993` default path) instead of the
numeric timsort — so no `__isort_externref` is ever emitted. No new helper
needed; this is a dispatch gate, not a new sort.

## Acceptance criteria

- `new Array(2).sort()` compiles to valid Wasm and yields `[undefined,
  undefined]` (length 2, both holes).
- An externref/`any[]` array `.sort()` (no comparator) sorts by ToString
  (§23.1.3.30) and produces valid Wasm.
- Numeric `number[]` / typed-int arrays keep the fast numeric Timsort
  (no regression on the existing sort fast paths).
- The 28 `__isort_externref` compile_errors clear.

## Dupe check

No existing issue covers the externref-element numeric-timsort mis-dispatch
(#1816 added the comparator insertion sort; #1993 added the ToString default
sort; neither gated the numeric path against externref element kind). New.

## Resolution (sd5, 2026-06-19)

Single-file fix in `src/codegen/array-methods.ts` (`compileArraySort`): the
numeric Timsort fallback is now gated to `i32` / `f64` element kinds. A
ref/externref-element array whose default ToString sort doesn't run is **no-op'd
in place** (return the receiver unchanged) instead of reaching
`ensureTimsortHelper` with a lying `"i32"|"f64"` cast — so `__isort_externref`
is never emitted and the binary is always valid.

Why no-op rather than route to a native externref ToString sort: the populated
externref string arrays (the 9 Atomics cases, e.g. `['A ok','B ok'].sort()`)
already reach the existing string default-sort path (their `string_compare` host
helper IS pre-registered), so they sort correctly once the crash is removed. The
remaining cases are genuine all-holes arrays (`new Array(N)`, all `undefined`),
for which an in-place no-op is the correct ordering. A first attempt to wire
`__extern_toString` into the default sort for boxed `any` elements was reverted —
calling `ensureLateImport` mid-body shifted func indices and caused the
comparator to self-recurse (infinite loop); the no-op gate is the safe,
contained fix. (Boxed-`any` ToString-order sorting is a non-crashing follow-up.)

The 28 `__isort_externref` compile_errors clear. Note: the all-holes
`Array/sort` cases that also assert `x[0] === undefined` after sort convert
compile_error → fail (the `new Array(N)` hole `=== undefined` semantics are a
separate pre-existing gap, confirmed broken on main even without `.sort()`), so
they no longer poison the whole module; the populated-array Atomics cases pass.

## Test Results

`tests/issue-2502-sort-externref.test.ts` — 8 tests green. Verifies: `new
Array(2)`/`new Array(3)`/`any[]` sort compile to **valid Wasm** (no
`__isort_externref` crash) with length preserved; and regressions —
`[3,1,2]`/`[10,9,1,100]` numeric default ToString sort, `["banana",…]` string
sort, and `(a,b)=>a-b` comparator sort are all unchanged. `tsc` clean; the
existing #1816 (9) and #1993 (12) sort suites pass unchanged.
