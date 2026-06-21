---
id: 2379
title: "Uint8ClampedArray methods mis-dispatch to host extern-class imports (invalid Wasm host / Uint8ClampedArray_* leak standalone)"
status: done
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: typed-arrays
goal: correctness
sprint: 64
assignee: ttraenkler/sd3
---
# #2379 — `Uint8ClampedArray` methods mis-dispatch to host extern-class imports

## Problem

`new Uint8ClampedArray([1,2,3,4]).reduce((a,x)=>a+x, 0)` (and every other
`Uint8ClampedArray.prototype` method) is routed through the **host extern-class
dispatch** instead of the **native typed-array array-method path** that all the
other typed arrays use. Consequences:

- **JS-host / GC mode:** emits **invalid Wasm** — the receiver compiles to a
  concrete GC vec ref `(ref null $Vec)` but the synthesized
  `env.Uint8ClampedArray_reduce` import's `self` param is `externref`, so the
  module fails to compile: `call[0] expected type externref, found local.tee of
  type (ref null 4)`.
- **standalone / WASI mode:** leaks an unsatisfiable `env.Uint8ClampedArray_*`
  host import (`Uint8ClampedArray_reduce`), so the module fails at instantiation.

Every other typed array works: `Int8Array`/`Int16Array`/`Int32Array`/
`Uint8Array`/`Float32Array`/`Float64Array.reduce` all route natively (no env
leak). Only `Uint8ClampedArray` is mis-routed.

## Root cause

`isExternalDeclaredClass(type)` (`src/checker/type-mapper.ts`) returns `true` for
a `declare var X: XConstructor` lib type **unless** the name is in the
`BUILTIN_TYPES` set (which excludes the natively-implemented builtins so they
take their dedicated codegen path). `BUILTIN_TYPES` listed every typed array —
`Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array,
Float32Array, Float64Array` — **but omitted `Uint8ClampedArray`**. So
`isExternalDeclaredClass(Uint8ClampedArray)` returned `true`, and the method
dispatch (`calls.ts`, the `if (isExternalDeclaredClass(receiverType)) {
compileExternMethodCall(...) }` branch) fired **before** the native
`compileArrayMethodCall` path, routing the call to the host
`Uint8ClampedArray_<method>` import.

## Fix

Add `"Uint8ClampedArray"` to `BUILTIN_TYPES` in `src/checker/type-mapper.ts`
(one line, next to its `Uint8Array` sibling). `Uint8ClampedArray` already lowers
to the same `(ref null $Vec[f64])` vec representation as the other typed arrays
(`TYPED_ARRAY_NAMES` / `typedArrayVecStorage` in `index.ts` include it), so the
native array-method path handles it correctly once `isExternalDeclaredClass`
stops claiming it.

## Acceptance criteria

- [x] `new Uint8ClampedArray([1,2,3,4]).reduce((a,x)=>a+x,0)` returns `10` (was
      invalid Wasm in GC mode).
- [x] Standalone: no `env.Uint8ClampedArray_*` host import leaks
      (`env=[none]` for reduce, matching the other typed arrays).
- [x] No regression in `Uint8Array`/`number[]`/other typed-array methods.
- [x] `Uint8ClampedArray` length/index/forEach/map/indexOf all dispatch natively.

## Out of scope

`Uint8ClampedArray` value-clamping on store (`a[0]=300 → 255`) is the f64-vec
representation gap shared with the other non-`Uint8Array` integer typed arrays
(only `Uint8Array` has packed byte storage today) — tracked under the #2159
typed-array packed-storage family, unaffected by this dispatch fix.

## Source

sd3 dispatch-bug mining, 2026-06-19. Repro: `call[0] expected externref` on
`Uint8ClampedArray.reduce`.
