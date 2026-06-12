---
id: 1967
title: "sort is a silent no-op on string/object-element arrays (even with comparator); map/filter/reduce on struct-element arrays return empty garbage"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: array-methods
goal: builtin-methods
related: [1361, 1816, 1966]
origin: "2026-06-10 deep-audit sweep (objects agent): verified miscompile on main"
---

# #1967 — element-type gates exclude ref/externref arrays from sort and HOF methods

## Problem

The element-type dispatch gates silently exclude non-numeric arrays:

| repro | wasm | node |
|-------|------|------|
| `["b","a","c"].sort(); a[0]+a[1]+a[2]` | `"bac"` (no-op) | `"abc"` |
| `[{k:2},{k:1}].sort((x,y)=>x.k-y.k)` | `"2,1"` (no-op) | `"1,2"` |
| `[{v:"a"},{v:"b"}].map(o=>o.v)`: `m[0]+"|"+m.length` | `"null|0"` | `"a|2"` |

All silent — modules instantiate and run.

## Root cause

`src/codegen/array-methods.ts:2593-2598` — `case "sort"` only dispatches when
`elemType.kind === "f64" || "i32"`; strings are externref (JS-host mode) and
objects are `ref`, so dispatch returns `undefined` and the call falls into the
same garbage generic fallback as #1966 (returns receiver-ish value untouched).
The same gate pattern excludes `ref`-element receivers from
`map`/`filter`/`reduce`/`find*`/`some`/`every` (2600-2660: `f64 | i32 |
externref` only) — third repro. The #1816 comparator sort
(`tryCompileComparatorSort`, line 6292) is correct but unreachable for
non-numeric element types because the gate sits *before* it.

## Fix direction

Widen the `case "sort"` gate to externref/ref elements — comparator path:
coerce elements to the closure param types (machinery in
`tryCompileComparatorSort` already coerces via `coercionInstrs`); default
path: ToString-compare via host `__str_compare` or the
`__extern_method_call("sort")` bridge. For map-family on ref elements, box
elements to externref (pattern exists in `destructureParamArray`'s convert
loop). At minimum, make the fallthrough loud (shared fix with #1966).

## Acceptance criteria

- All three repros match Node
- Sort stability preserved where the underlying impl is stable
- Note: default *numeric* sort using numeric order (`[10,9,1].sort()`) is
  #1816's documented follow-up — out of scope here

## Dupe check

#1361/#1816 (done) — #1816 carves out only the numeric-default-ToString-order
follow-up. "Non-numeric element arrays never sort at all, comparator included"
and "map on struct-element arrays returns length 0" are unfiled.

## Partial resolution (2026-06-12) — `sort` landed

The outer dispatch gate in `compileArrayMethodCall`
(`src/codegen/array-methods.ts`, `case "sort"`) only passed `f64`/`i32`
element kinds, so externref (string, JS-host mode) and ref (struct) element
arrays fell into the generic no-op fallback. But `compileArraySort` *already*
routes non-numeric elements correctly — comparator via
`tryCompileComparatorSort` (#1816) and the default ToString order via
`compileArrayDefaultToStringSort` (#1993). The gate was the only blocker.

Widened the `sort` gate to also accept `externref`/`ref`/`ref_null`. No change
to `compileArraySort`'s body. Covered (match Node —
`tests/equivalence/sort-nonnumeric.test.ts`, 4 green):
- `["b","a","c"].sort()` (string default)
- `[{k:2},{k:1},{k:3}].sort((x,y)=>x.k-y.k)` (struct comparator)
- string comparator sort by length
- numeric comparator sort unregressed

Regression-clean across #1361/#1816/#1966/#1993/#1589 + array-prototype-methods
(72 tests green); tsc clean.

### Remaining (issue stays open)

- **map/filter/reduce/find\* on struct (`ref`) element arrays** still return
  empty/garbage (`[{v:"a"}].map(o=>o.v)` → `null|0`). The HOF gates already
  accept `externref` but not `ref`; widening them needs `compileArrayMap` (and
  siblings) to box each `ref` element to externref before invoking the callback
  (the convert-loop pattern in `destructureParamArray`). Larger, separate change
  — split out from the safe sort gate fix.

## map-family on struct elements landed (2026-06-12) — issue fully closed

The remaining HOF work is now fixed. The presumed complexity above
(boxing each `ref` element to externref) was unnecessary: the native
WasmGC loop machinery (`setupArrayLoop` + `buildClosureCallInstrs`) is
**already generic over `elemType`** — it reads the element via
`array.get` and coerces it to the closure's param type via
`coercionInstrs(elemType, paramTypes[0])` (a no-op when the closure param
is the same struct ref). As with the sort gate (#1390), the only blocker
was the dispatch gate.

Changes (`src/codegen/array-methods.ts`):
- Added an `isHofElemKind(kind)` helper and widened the `map` / `filter` /
  `reduce` / `reduceRight` / `forEach` / `find` / `findIndex` / `findLast` /
  `findLastIndex` / `some` / `every` gates from `f64|i32|externref` to also
  accept `ref`/`ref_null`.
- Fixed `compileArrayFind` and `compileArrayFindLast`: in non-fast mode the
  result local was hard-coded `f64` (initialised to NaN), which mismatches a
  struct ref on `local.set` → invalid binary. ref/externref elements now use
  a **nullable element-typed** result local with a `null` not-found sentinel
  (new `nullableValType` / `nullRefInstrs` helpers), matching JS `find`
  returning `undefined`.

Covered (match Node — `tests/equivalence/hof-struct-elements.test.ts`, 15
green): map (string field / numeric / struct-returning), filter (length +
chained field access), reduce/reduceRight (numeric accumulator over structs),
find/findLast (+ null not-found sentinel), findIndex/findLastIndex,
some/every, forEach. Regression-clean across array-prototype-methods /
sort-nonnumeric / array-of-structs / reverse-struct-map /
array-callback-three-params / array-filter-obj-length (31 green); tsc clean.

Out of scope (distinct issues, NOT regressed by this change):
- `some`/`every` return an i32 truthy flag not boxed to a JS boolean at the
  export boundary — pre-existing for **numeric** arrays too (verified on
  main); unrelated to struct elements.
- A **struct accumulator** in `reduce` with no initial value still hits the
  numeric `accTmp` typing generalised under #1994.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1390 (sort) plus the map-family PR above; frontmatter was
stale at `in-progress`. Flipped to `done` during the sprint-62 issue review.
