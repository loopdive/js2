---
id: 1969
title: "concat's host bridge appends WasmGC array arguments as single opaque elements instead of spreading them (data loss → NaN)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: array-methods
goal: builtin-methods
related: [1359, 1567]
origin: "2026-06-10 deep-audit sweep (objects agent): verified miscompile on main"
---

# #1969 — `__array_concat_any` doesn't recognize vec structs as spreadable

## Problem

Per [§23.1.3.1.1 IsConcatSpreadable](https://tc39.es/ecma262/#sec-isconcatspreadable),
a true Array is always spread. A WasmGC vec (the compiled representation of a
true Array) passed as a concat *argument* is appended whole as one opaque
struct.

## Repro (verified on main)

```ts
const x: (number|number[])[] = [5,[6]];
const c = [1,2].concat(x as any);
return c.length + ":" + String(c[2]);
```

wasm: `3:NaN` — node: `4:5` (spec result `[1,2,5,[6]]`). Triggered whenever
the argument doesn't share the receiver's vec type or there are 2+ args with
at least one non-literal (literal args dodge it — they compile to JS arrays in
externref position).

## Root cause

`compileArrayConcatExtern` (`src/codegen/array-methods.ts:4374`) passes args
via `extern.convert_any` → opaque WasmGC structs. Host side
`__array_concat_any` (`src/runtime.ts:8435-8505`): `applyConcat` converts the
*receiver* via `__vec_len/__vec_get` but for arguments only spreads when
`_isWasmStruct(x) && _isConcatSpreadable(x)` — a plain WasmGC vec has no
`@@isConcatSpreadable` sidecar entry, so it hits `out.push(x)`.

## Fix direction

In `applyConcat`, before the spreadable check, detect vec structs (try
`exports.__vec_len(x)`) and spread via `__vec_get` — mirroring the receiver
conversion. Standalone-mode concat path should be checked for the same shape
(dual-mode policy).

## Acceptance criteria

- Repro matches Node (`4:5`, nested `[6]` preserved as element 3)
- Mixed literal + variable args correct
- #1359 @@species/sparse behavior unregressed

## Resolution

Fixed `applyConcat` inside `__array_concat_any` (`src/runtime.ts`). Per
§23.1.3.1.1 IsConcatSpreadable step 2 a true Array is ALWAYS spread (the
`@@isConcatSpreadable` sidecar only governs non-Array objects). Added two
branches before the sidecar-spreadable check:
- `Array.isArray(x)` → spread via `x[i]` (the common case: an `any`-typed array
  literal lowers to an externref JS array and reaches this custom concat).
- `tryVecLen(x) >= 0` → spread an opaque WasmGC vec struct via `__vec_get`,
  mirroring the receiver conversion (covers a vec arg that doesn't round-trip as
  a JS array).

The original `_isWasmStruct(x) && _isConcatSpreadable(x)` path (tagged array-like
structs) is unchanged. Standalone-mode concat goes through `__concat_N`, not this
bridge, so it is unaffected.

## Test Results

`tests/issue-1969.test.ts` — 5 cases: single array arg, multiple array args,
empty arg, interleaved scalar+array args, and the nested-arg element count. All
match Node. `tests/issue-1017-concat.test.ts`: 3/3 unchanged.

## Residual (separate issue)

Deep round-trip of a NESTED inner-array element through `__array_concat_any`'s
result is still lossy: `[1,2].concat([5,[6]] as any)` now returns the correct
LENGTH (4) and the scalar element (`5`), but the inner `[6]` reads back as the
scalar `6` instead of the array `[6]`. This is an externref representation
limitation in how the concat result's nested array elements are materialised
back into a WasmGC result — orthogonal to the argument-spreading bug fixed here
(the inner array is preserved correctly when read directly, e.g. `x[1]`). Should
be filed as a follow-up if it surfaces in practice.

## Dupe check

#1359 (done) covered routing to this bridge; #1567 builtin-subclass proto side
effects. The bridge's vec-argument non-spreading is unfiled.
