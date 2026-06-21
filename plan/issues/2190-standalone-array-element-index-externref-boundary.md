---
id: 2190
title: "standalone: array element indexing (arr as any)[i] returns null/0 through the externref boundary"
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
depends_on: [2189]
---
# #2190 — standalone array element indexing through the externref boundary

## Problem

Sibling of #2189 (array `.length` through the externref boundary). A real array
literal lowers to a `__vec_<elemKind>` struct `(length i32, data (ref array))`.
When such a value crosses the **externref boundary** (assigned to an `any`
local, returned from an `any`-typed function, a Proxy trap's returned
key/args array), a **numeric** indexed read `arr[i]` routes through the native
`__extern_get_idx(externref, f64) -> externref` runtime helper
(`compileElementAccessBody`, `src/codegen/property-access.ts`, the
`objType.kind === "externref"` + `isNumericIndexExpression` arm — standalone
only).

That helper only recognises a `$ObjVec` (enumeration result) or an array-like
`$Object` (`{0:x, length:n}`). It does **NOT** recognise the concrete
`__vec_<elemKind>` struct, so a boxed array falls through to the `null` default.

Confirmed standalone repro (2026-06-18, vs upstream/main):

```ts
const a: any = [10, 20, 30]; a[1];   // => 0    (should be 20; null→f64 coerces to 0)
const a: any = ["x","y","z"]; a[2];  // => null (should be "z")
```

This is the **indexing** half of the same latent `$Array` introspection gap
#2189 fixed for `.length`. It blocks ANY element read after an externref
roundtrip — Proxy `ownKeys`/`apply` argsList element reads, generic array-like
consumers, `arguments`-style positional reads — so it should move a real chunk
of standalone test262.

## Root cause

`__extern_get_idx` has no arm that `ref.test`s the concrete `__vec_<elemKind>`
carrier types. Unlike `.length` (a single i32 at field 0, readable uniformly
through the `$__vec_base` supertype #2189 added), **element reads are
element-type-polymorphic**: each `__vec_<elemKind>` has a different `data`
array element type and the loaded element must be **boxed to externref**
differently per kind. A single supertype read cannot cover it.

Additionally, `__extern_get_idx` is registered eagerly inside
`ensureObjectRuntime` (lazy, first-use), but `ctx.vecTypeMap` is populated as
array literals of each element kind are compiled — which can be *after*
`ensureObjectRuntime` runs. So the set of vec kinds is not known at registration
time.

## Fix (design — confirmed against the existing `fillExternIsArray` pattern)

Use the **deferred body-fill** pattern already established by
`fillExternIsArray` (`src/codegen/object-runtime.ts`), which runs at
finalization in `src/codegen/index.ts` (~line 1672) AFTER all user functions and
late runtime helpers have registered their carrier types — so `ctx.vecTypeMap`
is complete.

1. **Reserve** `__extern_get_idx`'s typed-vec dispatch as a fill point (or, if
   simpler, keep the existing `$ObjVec`/`$Object` body and *append* a
   deferred-filled per-kind chain ahead of the `$ObjVec` test). Mirror
   `externIsArrayReserved` / `fillExternIsArray`.
2. In the fill, enumerate `ctx.vecTypeMap` carriers (reuse / factor out
   `collectStandaloneArrayCarrierTypeIdxs`, but here we need the **elemKind →
   typeIdx** mapping, not just the type set, to pick the right box op). For each
   `__vec_<elemKind>` (skip the non-array byte carriers `i32_byte`/`i8_byte`):
   - `ref.test $__vec_<k>` → if match: `ref.cast`, bounds-check `i` against
     `struct.get 0` (length) — return `null` when `i<0 || i>=len`, mirroring the
     existing `$ObjVec` arm — then `struct.get 1` (data) + `array.get` +
     **box the element to externref** per kind:
     - data `externref` / `ref_<anyStrTypeIdx>` (string-vec) → already a ref →
       `extern.convert_any` (or identity if already externref).
     - data `f64` → `__box_number`.
     - data `i32` → `f64.convert_i32_s` + `__box_number`.
3. Bounds/`$__vec_base` reuse: read the length via the `$__vec_base` supertype
   from #2189 for the bounds check (uniform), then the per-kind `ref.cast` only
   for the typed `array.get`.

Standalone-only (`objArrayLikeArms = ctx.standalone`); host mode's
`__extern_get_idx` JS import owns the path — do not register the arm in gc mode
(it would shift funcMap indices).

Files (expected):
- `src/codegen/object-runtime.ts` — reserve + `fillExternGetIdxVecArms` (new),
  factor an elemKind→typeIdx carrier enumerator.
- `src/codegen/index.ts` — call the new fill alongside `fillExternIsArray`
  (~line 1672).
- `src/codegen/context/types.ts` — a `externGetIdxVecReserved` flag if the
  reserve/fill split is used.

## Shipped scope (PR #1673) — number-array path only

First-cut implementation also synthesized indexing arms for `ref`/`ref_null`
(string `$AnyString` etc.) and `boolean`-tagged `i32` element vecs. That
produced **invalid Wasm** for some carriers the proposal harness registers
(`__extern_get_idx return[0] expected externref, got (ref null N)` / `got i32`),
regressing ~90 standalone test262 (the #2097 high-water floor breach). Root
cause: a synthesized arm could leave a non-`externref` value (an internal GC ref
or raw i32) at the helper's `return`. Verified by diffing the failing CI
standalone shards against the main baseline (120 `pass → compile_error`, all in
generator/async + destructuring-rest + TypedArray-iteration modules).

`boxVecElementToExternref` now only emits an arm for **provably
externref-returning** element kinds — plain `f64` (→`__box_number`), plain `i32`
(→`f64.convert_i32_s`+`__box_number`), and *literal* `externref` (identity, type
-safe by Wasm). `ref`/`ref_null`/`boolean`-i32/`f32`/`i64`/`v128` carriers get
**no arm** and fall back to the prior null behaviour (no worse than pre-#2190).

## Acceptance criteria

1. `const a: any = [10,20,30]; a[1] === 20` (number array). ✓
2. `function g():any{return [1,2,3,4];} g()[3] === 4`. ✓
3. Out-of-bounds (`a[99]`) and negative (`a[-1]`) → `undefined`. ✓
4. `$ObjVec`/array-like `$Object` indexing (existing arms) unchanged; **no
   standalone regression** (high-water floor restored). ✓
5. `tests/issue-2190.test.ts` green (number path + null-fallback assertions). ✓

## Deferred (follow-up)

- **String / GC-ref element indexing** (`const a: any = ["x","y"]; a[1]`): needs
  a per-carrier proof that the element ref widens to `externref` validly
  (`extern.convert_any` was insufficient/unsafe for some proposal-harness
  carriers). A boxed string array still reads back `undefined` through the
  boundary for now. This was criterion #2 of the original scope.

## Notes

- This is the second half of the foundational fix that unblocks Proxy
  `ownKeys`/`apply` standalone (#1355, #34/#36) — the trap's returned array can
  then be both *measured* (#2189) and *read* (#2190).
- The pre-existing typed `string[]` direct-index `["x","y"][0]` returning
  `undefined` (no externref roundtrip) is a separate string-array bug, NOT part
  of this fix.

## RESOLVED 2026-06-18 — round-3 SPLICE fix restored the floor (CI-confirmed)

Briefly parked after rounds 1-2 regressed ~120 modules, then **round-3 (the
SPLICE-not-rebuild fix) RESOLVED it**: CI `merge shard reports` is GREEN with
`current pass=21508 vs mark 21507 (delta +1)` — the -116 standalone regression is
gone and the lane is +1 ABOVE the high-water mark. Number-array boundary indexing
ships. The only post-fix CI failure was the #2108 coercion-site drift gate (+1
from the f64/i32 `__box_number` boundary box), resolved by a reviewed baseline
refresh. Full multi-round root-cause analysis retained below for the record.

### Root-cause findings (three rounds, all CI-verified by shard diff)

1. **NOT `boxVecElementToExternref`.** Rounds 1 (drop ref/boolean-i32 arms) and
   2 (number-only arms, ZERO ref-returning paths) did **not** change the failure
   set at all — the identical 120 modules regressed. So the bad arm was never the
   element boxing.
2. **The `(ref null N)` source = the body REBUILD, not the arms.** The fill
   originally did `fn.body = buildExternGetIdxBody({...})` at FINALIZE, which
   **re-baked** the `$Object` arm's `number_toString` / `__extern_get` `call`
   funcIdxs with then-current values. A later late-import reconcile shift
   (`addUnionImports` invariant) then **double-applied** to those re-baked
   targets → corrupted call → invalid Wasm in every module hitting the
   `$Object`/`number_toString` arm. The shift invariant only holds for a body
   baked **once** at registration.
3. **Round 3 fix (current branch HEAD)** changed the fill to **SPLICE** the vec
   arms into the EXISTING body (after the 3-instr setup, before `$Object`/
   `$ObjVec`) instead of rebuilding — preserving the original arms' shift-
   maintained funcIdxs. Validated locally on the previously-failing module shapes
   (generator-rest + `$Object` + number-vec all WebAssembly.validate). CI on this
   round was not confirmed green before the park decision.
   - Secondary gotcha found along the way: `ctx.vecTypeMap`'s `"externref"` key
     is NOT uniformly `(array externref)` — `arguments`/closure-arg vecs register
     it with a `ref`/`ref_null` element override, so an "identity" externref arm
     read `array.get` → `(ref null N)`. The number-only arm set sidesteps this.

### Safe future approach (option A — additive, zero-regression-risk)

Do **not** touch the existing `__extern_get_idx` body at all. Instead emit a
**separate** `__extern_get_idx_vec(externref, f64) -> externref` helper that the
element-access call site (`compileElementAccessBody`, the `externref` +
numeric-index arm in `src/codegen/property-access.ts`) calls **FIRST**; if it
returns a sentinel "not a typed vec" it falls back to the **untouched** original
`__extern_get_idx`. `__extern_get_idx_vec` is filled at finalize with the
number-only typed-vec arms via the `fillExternIsArray` deferred-fill pattern.
Because the original helper is never rebuilt, the late-import shift invariant is
preserved and there is no possible regression to existing `$Object`/`$ObjVec`
indexing. More code, but provably additive. The round-3 SPLICE on the current
branch is the lower-code alternative if a green CI run confirms it.
