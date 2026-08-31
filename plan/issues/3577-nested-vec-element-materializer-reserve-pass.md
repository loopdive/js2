---
id: 3577
title: "nested-vec element materializer reserve-pass (flatMap depth-always-one illegal-cast + related host-lane T[][] coercion traps)"
status: done
completed: 2026-08-29
resolution: done-by-other-means
created: 2026-07-24
updated: 2026-08-29
priority: medium
feasibility: medium
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: current
horizon: m
related: [3200, 1917, 2831, 5166]
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

## Blocked-on (cleared 2026-08-29 — see Resolution)

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

---

## Resolution (2026-08-29) — DONE BY OTHER MEANS

The repro passes on `main`, and has for a while. Measured on unmodified main
(`fc6fd3b5`) and again with #5166 applied, host lane, compiled + instantiated +
called in-process:

```ts
export function main(): string {
  const r = [1, 2, 3].flatMap(e => [[e * 2]]);
  return "" + r[0][0] + r[1][0] + r[2][0];
}
```

| lane | result |
| --- | --- |
| node | `"246"` |
| js2wasm legacy | `"246"` |
| js2wasm IR overlay | `"246"` |

No illegal cast, no trap.

### The mechanism that landed is NOT this issue's sketch

The fix sketch above had two parts: (1) recurse in `buildElemCoerce`, and (2) a
**reserve pass** extension in `member-set-dispatch.ts` so the per-target
`__vec_from_extern_<elemTypeIdx>` materializer resolves post-freeze. What
actually shipped is part (1) only, and it does not go through the reserved
per-target materializer at all: the `ref`/`ref_null` element arm of
`buildElemCoerce` (`src/codegen/type-coercion.ts`) recognises a nested vec via
`getVecInfo(ctx, elemTypeIdx)` and recurses into `buildVecFromExternref`
**in the same `FunctionContext`**, guarded against cycles by a
`materializingVecTypes` set. Because the conversion is emitted inline rather
than reserved, the index-space freeze that motivated the reserve pass never
comes into it — which is why part (2) was never needed.

Recording the difference explicitly: an issue closed against a mechanism it did
not describe is exactly the kind of thing that gets re-opened and
re-implemented later. Anyone reading this for the nested-`T[][]` coercion path
should read `buildElemCoerce`'s ref arm, not `reserveVecFieldMaterializers`.

### Acceptance, against the criteria as written

1. Nested `T[][]` flatMap results materialize correctly — **yes**, measured
   above. (The `flatMap/depth-always-one.js` test262 file itself is CI's to
   report; the illegal-cast trap this issue was filed for is gone.)
2. No test262 regressions — nothing was changed here to regress.
3. A repro test — pinned in `tests/issue-5166.test.ts` section F rather than in
   a `tests/issue-3577.test.ts`, since the carrier work is where a future
   regression would come from.

The **blocked-on** (#1917 Stage B, the `type-coercion.ts` refactor) is moot:
that refactor is where the recursion landed.
