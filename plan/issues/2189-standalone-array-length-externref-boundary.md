---
id: 2189
title: "standalone: array .length reads 0 through the externref boundary (latent $Array introspection gap)"
status: done
assignee: ttraenkler/sdev-proxy3
created: 2026-06-18
completed: 2026-06-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
goal: standalone-conformance
sprint: 63
---
# #2189 — standalone array `.length` through the externref boundary

> Note: originally drafted as #2186; renumbered to #2189 because an unrelated
> issue (`2186-standalone-delete-touched-object-representation-steering`) landed
> on main first and owns ID #2186. The `(#2186)` markers in the committed
> codegen comments refer to *this* work and are left intact to match the PR.

## Problem

A real array literal (and any array result) lowers to a `__vec_<elemKind>` struct
`(length i32, data (ref array))`. When such a value crosses the **externref
boundary** — assigned to an `any` local, returned from an `any`-typed function,
passed where an `any`/externref is expected — member access like `arr.length`
routes through the native `__extern_length(externref)` runtime helper.

That helper only recognised a `$ObjVec` (enumeration result) or an array-like
`$Object` (`{0:x, length:n}`), **NOT** the concrete `__vec_<elemKind>` struct.
So a boxed array fell through to the `0` default:

```ts
const a: any = [1, 2, 3];
a.length;            // === 0  (should be 3)
function g(): any { return ["a", "b"]; }
g().length;          // === 0  (should be 2)
```

Surfaced while wiring the Proxy `ownKeys`/`apply` traps (#1355): the trap's
returned key/arg array could not be measured. But it is **foundational** — it
breaks ANY array read for `.length` after an externref roundtrip, so it likely
moves a real chunk of standalone test262 (iteration bounds, `arguments`-style
length reads, generic array-like consumers).

## Root cause

`getOrRegisterVecType(elemKind)` mints a distinct struct per element kind
(`__vec_f64`, `__vec_externref`, `__vec_i32`, …). There was no common supertype,
so `__extern_length` had no single `ref.test`-able type for "is this a vec?".

## Fix

Introduce a shared `$__vec_base` supertype struct with a single `length` (i32)
field (field 0). Every `__vec_<elemKind>` now declares `superTypeIdx:
$__vec_base` — `length` at field 0 is a valid struct-subtype prefix. The base is
`superTypeIdx: -1` (open / non-final). `__extern_length` gains a leading
`$__vec_base` arm: `ref.test $__vec_base` → `ref.cast` → `struct.get 0` →
`f64.convert_i32_s`, returning the real length regardless of element kind.
Standalone-only (`objArrayLikeArms = ctx.standalone`); host mode's
`__extern_length` JS import owns the path.

Files:
- `src/codegen/registry/types.ts` — `getOrRegisterVecBaseType` + every vec
  subtypes it.
- `src/codegen/context/{types,create-context}.ts` — `vecBaseTypeIdx` cache field.
- `src/codegen/object-runtime.ts` — `$__vec_base` arm in `__extern_length`.

## Scope / deferred

- **Length only.** Element **indexing** through the externref boundary
  (`(arr as any)[i]`) is element-type-polymorphic — `__extern_get_idx` would
  need per-kind dispatch or a uniform boxed-element read — and is tracked
  separately (it does not block the length wins, which are the high-impact ones:
  `Object.keys`-style iteration bounds, ownKeys/apply argsList measurement).
- The pre-existing typed `string[]` direct-index returning `undefined`
  (`["x","y"][0]`) is an unrelated string-array bug, not part of this fix.

## Acceptance criteria

1. `const a: any = [1,2,3]; a.length === 3` (number array). ✓
2. `const a: any = ["x","y"]; a.length === 2` (string array). ✓
3. `function g():any{return [1,2,3,4];} g().length === 4`. ✓
4. Empty array → length 0; grown-via-push array → correct length. ✓
5. No regression in typed-array `.length`, push/pop, map/filter, for-of, spread.
   `tests/issue-2186.test.ts` (7 tests) + canonical equivalence array suites
   green. ✓
