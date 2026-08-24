---
id: 4629
title: "Standalone: Set/Map members miss through the any channel (.size, Symbol.iterator, iterator protocol)"
status: done
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: l
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/map-runtime.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
loc-budget-allow:
  - src/codegen/map-runtime.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/map-runtime.ts::fillMapSetDynDispatchArms
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
status-note: implemented (deepEqual-mapset passes standalone)
---

# #4629 — Standalone: Set/Map members miss through the `any` channel

## Problem

`test/harness/deepEqual-mapset.js` fails standalone on its FIRST assertion,
`assert.deepEqual(new Set(), new Set())`. Measured probe (2026-08-23, this
exact shape):

```js
function probe(v) { ... }
probe(new Set([1]));
// hasIt=false  size=undefined  isSet=true  next.done=null
```

On an `any`-typed receiver holding a Set:

- `v[Symbol.iterator]` reads `undefined` (so `typeof v[Symbol.iterator] ===
  "function"` — deepEqual's `isIterableEquatable` — answers false),
- `v.size` reads `undefined`,
- `v instanceof Set` DOES work (the brand test is wired).

deepEqual's `compareIteratorEquality` additionally needs the returned
iterator to answer `.next()` → `{done, value}` and optional `.return`.

## Why

The standalone Set/Map runtime carrier (see `map-runtime.ts`) has typed
fast paths for statically-typed receivers, but the reflective
`__extern_get` ladder (object-runtime.ts) has no arm for the Set/Map
carrier structs: a symbol-keyed read (`[Symbol.iterator]`) and the `size`
member both fall through to the open-object walk and miss to null.

## Implementation Plan

1. **Identify the carrier structs**: find the `$Set`/`$Map` (or
   equivalently named) struct type indices in `map-runtime.ts`; confirm how
   a statically-typed `set.size` / `for (x of set)` lowers today (there is
   a working typed path — reuse its helpers).
2. **`__extern_get` arms (finalize-spliced, same discipline as
   `fillTaDynViewMopArms`)**:
   - receiver `ref.test $Set/$Map` + string key `"size"` → i32 count →
     `__box_number`.
   - same receivers + SYMBOL key equal to the well-known
     `Symbol.iterator` id → return a closure that mints the native
     iterator (see step 3). Well-known symbol ids are already modeled
     (see `builtin-value-read.ts` "well-known-symbol ids").
3. **Iterator object**: mint a small `$__setmap_iter` struct
   `{recv, idx}` plus a `next` native returning a two-field result object
   (`done` bool, `value` externref) through the existing `$Object`
   builder, mirroring how the existing typed `for-of` over Set/Map yields
   elements. `.return` may be absent (deepEqual guards with `if
   (b.return)`).
4. **Method-call twin**: `__extern_method_call` must dispatch
   `it.next()` on the iterator struct — add the arm next to the existing
   `$__ta_dyn_view` method arms (`call-receiver-method.ts` /
   `fillFnctorPrototypeDispatchArms` pattern).
5. **Acceptance**: `harness/deepEqual-mapset.js` passes standalone via
   `runTest262File(..., "standalone")`; probe above answers
   `hasIt=true size=1 next.done=false`; no regression in a 30-test
   standalone sample over `built-ins/Set/**` + `built-ins/Map/**`
   baseline-pass tests; js-host lane byte-identical (all arms
   noJsHost-gated).

## Order-preservation constraints

- All new natives are DEFINED functions minted at reserve time and filled
  at finalize (#1719 reserve-then-fill); no late host imports mid-emission
  (#608/#794).
- Splice arms in FRONT of the generic `$Object` walk, after the vec fills
  (last-fill-wins ordering documented in `ta-dyn-mop.ts`).

## Permanent repro

`test262/test/harness/deepEqual-mapset.js` (standalone lane via `pnpm run test:262` / `runTest262File`).
