---
id: 2190a
title: "standalone: homogeneous string sub-array of any[] traps on e[0][0] ($AnyString[]-in-any[] read-back layer)"
status: done
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
goal: standalone-conformance
sprint: 63
depends_on: [2190]
---

## Problem

In standalone (`--target standalone`, pure-Wasm) an `any[]` whose elements are
homogeneous-string sub-arrays traps when the nested element is read back:

```ts
const e: any[] = [["a", "b"]];
e[0][0]; // "dereferencing a null pointer"
```

The OUTER `e[0]` read works (it returns the boxed inner vec externref). The
INNER `e[0][0]` routes through the native `__extern_get_idx(externref, f64)`
runtime helper, which had no indexing arm for a `$AnyString[]` / `$NativeString[]`
carrier — so it fell through to its null fallback, the consuming site's
`ref.test $AnyString` then failed, and `struct.get $AnyString` null-dereffed on
the `.length` / element read.

This is the READ-side mirror of #2511 (which fixed the heterogeneous-tuple WRITE
layer under native-strings). Broken on `main` too — confirmed by stashing the
fix and re-running the repro.

## Root cause

`boxVecElementToExternref` (`src/codegen/object-runtime.ts`) — the per-carrier
element-boxing helper used by `fillExternGetIdxVecArms` — handled `f64`, `i32`,
and `externref` element kinds but returned `null` (no arm emitted) for a
`ref`/`ref_null` GC-struct element. A homogeneous string literal `["a","b"]`
lowers to a `$AnyString[]` vec (element type `(ref null $AnyString)`), so it got
no `__extern_get_idx` arm.

The first cut of #2190 deferred GC-ref elements precisely because a naive arm
left a raw `(ref null N)` on the helper's `externref` return — invalid Wasm.

## Fix

Add a `ref`/`ref_null` arm to `boxVecElementToExternref`, scoped to the STRING GC
types (`ctx.anyStrTypeIdx` / `ctx.nativeStrTypeIdx`), boxing via
`extern.convert_any` — the universal GC-ref → externref conversion. The return is
then a genuine externref; the consuming site re-tests/casts it back to
`$AnyString`, so the round-trip is identity for a string element and null for an
array hole. Non-string GC-ref / boolean carriers stay skipped, so the per-carrier
validity hazard the first cut hit is unchanged for them. Standalone only.

## Measured

Standalone, before → after (0 env imports, valid Wasm both ways):
- `e[0][0].length` on `[["a","b"]]`: trap → 1
- `e[0][1].length` on `[["a","bb"]]`: trap → 2
- 2×2 string matrix `e[1][0].len + e[0][1].len`: trap → 5
- content round-trip `("Xy")[0].charCodeAt(0)`: trap → 88 ('X')
- flat `any` string array `a[2]` read-back: undefined → element (the #2190 test
  that documented the deferral is updated to assert the now-correct read)

Regression-clean: number-inner `e[0][1]`, flat number `any[]`, flat string
`any[].length`, fromEntries-homog all unchanged. `tests/issue-2190` (+4 new #88
cases) green; #2190b / #2162b / #2036 / #2014 / #2505 / #786 suites green; tsc +
coercion-sites gate clean. The pre-existing standalone heterogeneous
`[["a", 7]]` `e[0][1]` trap is a DISTINCT residual (externref-element inner vec,
not a string carrier) — also broken on `main`, out of scope here.
