---
id: 3577
title: "nested-vec element materializer reserve-pass (flatMap depth-always-one illegal-cast + related host-lane T[][] coercion traps)"
status: blocked
created: 2026-07-24
updated: 2026-07-24
priority: medium
feasibility: medium
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: current
horizon: m
blocked-on: "#1917 Stage B (sdev is actively refactoring src/codegen/type-coercion.ts — the emitToPrimitive façade); land after that settles to avoid a guaranteed conflict"
related: [3200, 1917, 2831]
origin: "2026-07-24 #3200 Slice-2 (flatMap) — routed out; the depth-always-one illegal-cast trap"
loc-budget-allow:
  - src/codegen/type-coercion.ts
  - src/codegen/member-set-dispatch.ts
---

# #3577 — nested-vec element materializer reserve-pass

Routed out of **#3200 Slice-2** (flatMap correctness). The priority-(a)
trap `built-ins/Array/prototype/flatMap/depth-always-one.js` (illegal cast)
is a **host-lane nested-`T[][]` coercion** gap, not a flatMap-specific bug.

## Root cause (measured, #3200 Slice-2)

Host-lane `flatMap` (`compileArrayFlatMap`) delegates to the JS host import
`__array_flatMap`, which returns an **externref JS array**. When the callback
returns arrays (`[1,2,3].flatMap(e => [[e*2]])` → `number[][]`), the result
externref is coerced to the declared vec type via `buildVecFromExternref`
(`src/codegen/type-coercion.ts:~450`). Its inner `buildElemCoerce` (`~:398`)
handles a **vec-typed ref element** with a naked:

```
any.convert_extern
ref.cast_null <elemVecTypeIdx>     // e.g. (ref null __vec_f64)
```

But each element of the host result is itself a **plain JS sub-array**
(externref), NOT a WasmGC `__vec_*` struct → `ref.cast` fails → **illegal cast
[in __module_init()]** (uncatchable trap).

## Fix sketch

1. **`buildElemCoerce`** (type-coercion.ts): when the element type `et` is a
   ref to a **vec struct** (not a tuple), recurse — call the reserved
   per-target materializer `__vec_from_extern_<elemTypeIdx>`
   (`vecFromExternFuncIdx`, `buildVecFromExternMaterializer`, #2831) instead of
   the naked `ref.cast_null`. That helper already handles null / same-rep /
   host-array-materialize and (once it recurses) deeper nesting is
   self-consistent.
2. **Reserve pass** (`reserveVecFieldMaterializers`, member-set-dispatch.ts):
   today it reserves `__vec_from_extern_*` only for **struct-FIELD** vec types.
   The flatMap result is a **local / expression coercion target** the reserve
   pass never sees, and the index space is **frozen at emit** so the element
   materializer can't be reserved lazily inside `buildElemCoerce`. Extend the
   reserve pass to also reserve materializers for the **element type of every
   registered vec-of-vec type** (iterate `ctx` vec types; for any whose element
   is itself a vec, `buildVecFromExternMaterializer(elemTypeIdx)`), so the
   recursion in (1) resolves post-freeze.

## Risk / low blast radius

The `ref`-element non-tuple arm currently **always** illegal-cast-traps for a
host-array nested element, so (1) can only convert a 100%-trapping path into a
correct value — it cannot regress a passing test. (2) reserves extra defined
funcs; verify no interaction with index-space freeze / dead-func elimination.

## Blocked-on

**#1917 Stage B** — sdev is actively refactoring `type-coercion.ts` (the
`emitToPrimitive` façade). Two agents editing that file in parallel is a
guaranteed conflict. Land this after #1917 Stage B settles; the coercion-infra
owner picks it up then.

## Acceptance

1. `flatMap/depth-always-one.js` passes (host lane); nested `T[][]` flatMap
   results materialize correctly.
2. No test262 regressions (gc + standalone floors).
3. Repro in a `tests/issue-3577.test.ts` (`[1,2,3].flatMap(e => [[e*2]])` →
   `[[2],[4],[6]]`).
