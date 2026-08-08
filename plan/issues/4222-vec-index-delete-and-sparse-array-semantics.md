---
id: 4222
title: "Standalone array semantics: `delete arr[k]` never makes the index absent, `new Array(n)` fills `undefined` instead of holes"
status: in-progress
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-holes, delete-operator, property-model, array-length
goal: es5
related: [4159, 4160, 3251, 2001, 4010, 4221]
# The bulk of the new code went into a NEW module (`vec-overlay-presence.ts`),
# which is why `fillVecOverlayHelpers` only grows by its call site. What is left
# is in-place and cohesive: one `if` arm in the `in` operator's existing vec
# branch, one presence gate inside the for-in loop body, one ctx flag + its
# doc-comment. Extracting any of those would put a two-line helper behind an
# import and hide the branch from the code that has to reason about it.
loc-budget-allow:
  - src/codegen/statements/loops.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
---

# #4222 — the array-semantics leftovers WP4-filter exposed

Wave-1 of the ES5-standalone-90 program (`plan/goals/es5-standalone-90.md`,
WP4) fixed `Array.prototype.filter`'s per-index `HasProperty` + fresh `Get`
discipline (`src/codegen/array-filter-spec-access.ts`). Doing so exposed that
the *presence* answer the new gate consults is itself wrong for two whole
classes of absent index. This issue covers those, plus the two smaller
`built-ins/Array` clusters the same measurement turned up.

## 1. `delete arr[k]` on a vec-backed array is a no-op (PRIMARY)

Measured on `main` + Wave 1, `--target standalone` **and** the gc lane:

```js
const arr = [0, 1, 2, 3];
delete arr[1];
1 in arr;                  // → true   (spec: false)
Object.keys(arr).length;   // → 4      (spec: 3)
for (k in arr) …           // → 4 iterations (spec: 3)
arr.filter(() => true).length; // → 4  (spec: 3)
```

### What actually works already

The runtime is *not* the gap. `__delete_property` has had a complete vec arm
since #4010 (`buildVecDeletePrologue`, `src/codegen/vec-bag-seed.ts`): it
defines `undefined` into the #3251 overlay companion and marks the entry
`FLAG_DELETED_INDEX | FLAG_COMPANION_VALUE`. Two consumers honour it today:

| surface | after `delete arr[1]` | correct? |
| --- | --- | --- |
| `__extern_get_idx` (dynamic read, `(arr as any)[1]`) | `undefined` | ✅ |
| `__vec_gopd` / `Object.getOwnPropertyDescriptor` | `undefined` | ✅ |
| `__extern_has_idx` (`1 in arr`, `"1" in arr`) | `true` | ❌ |
| for-in / `Object.keys` | index enumerated | ❌ |
| typed `filter`/`forEach`/… presence gate | present | ❌ |

So the tombstone is written and never read by the **presence** side. Two
independent reasons:

- **(a)** `__extern_has_idx`'s `$__vec_base` arm answers `0 <= i < length`
  and has no overlay consult at all (unlike `__extern_get_idx`, which got a
  finalize-spliced prologue in #3251).
- **(b)** The typed HOF kernels only route presence through `__extern_has_idx`
  when `overlayRouteActive(ctx)` — i.e. under the #4159 pre-scan flag
  `vecAccessorDescriptorDirty`, which a plain `delete` does not set. A module
  whose only overlay writer is a `delete` keeps the dense `i < len` gate.

### Fix

1. A new pre-scan flag `vecIndexDeleteDirty` (`scanForArrayHoles`), set by any
   `delete <ElementAccessExpression>`, joins `vecAccessorDescriptorDirty` in
   `overlayRouteActive`. Same discipline as #4159: compile-time
   over-approximation, **not** a runtime guard, so a module without a
   `delete arr[i]` is byte-identical.
2. A finalize-spliced **presence prologue** on `__extern_has_idx`, mirroring
   the `__extern_get_idx` read prologue: gated on the same
   `__vec_overlay_numeric` flag global, it answers `0` when the companion
   entry for that index carries `FLAG_DELETED_INDEX`, and otherwise falls
   through to the existing dense answer byte-for-byte.

`__extern_has` (string-key lane) delegates numeric keys to `__extern_has_idx`,
so `"1" in arr` is fixed by the same prologue.

Unblocks the `filter` 9-3 / 9-6 / 9-b-9 family and the same
delete-inside-callback shape in every/some/forEach/map/indexOf.

## 2. `new Array(n)` fills `undefined`, not holes

`usesArrayHoles` is set only by array-literal *elisions* today, so
`new Array(3)` produces a dense vec of `undefined` and `0 in new Array(3)`
answers `true`. Blocks `filter` 9-5 / 9-b-1 and the `built-ins/Array` sparse
cluster.

CAUTION carried from the Wave-1 report: turning `usesArrayHoles` on has
module-wide blast radius (it arms the global `$Hole` read-guard on every
externref-elem vec read). Scope any activation to modules that actually
construct `Array(n)`.

## 3. `built-ins/Array` misc (23 failing)

- OOB reads must yield `undefined`, not trap
  (`oob:array element access out of bounds`, 6 tests:
  `15.4.5.1-5-1/-5-2`, `S15.4.5.1_A2.1_T1`, `S15.4.5.2_A1_T1/_T2`,
  `property-cast-number`).
- sparse-array `undefined` hole reads (`S15.4_A1.1_T4…T9`).
- `arr.toString()` via `Object.prototype` — measured: returns `undefined` in
  standalone, `"1,2,3"` in gc.

## 4. `built-ins/Array/length` (17 failing)

Setting `length` truncates (works today); the gaps are RangeError on invalid
values (`[].length = 4294967296` → measured *no throw*), `15.4.5.1-3.d-*`,
and the interplay with `src/codegen/array-length-define.ts`.

## Acceptance

- `delete arr[k]` makes `k` absent to `in`, `hasOwnProperty`, for-in,
  `Object.keys`, `getOwnPropertyDescriptor` and every array HOF, in the
  standalone lane, without regressing the gc lane.
- Regression tests in `tests/es5-standalone-array-semantics*.test.ts` pin each
  root cause on both lanes.
- No new host imports (dual-mode rule).

## Scope actually landed

See the commit trailer list. Items shipped in priority order; anything not
shipped is recorded under "Leftovers" below rather than silently dropped.
