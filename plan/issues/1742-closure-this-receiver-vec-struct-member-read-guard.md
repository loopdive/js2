---
id: 1742
title: "Closure `this`-receiver member reads trap 'illegal cast' when `this` is a compiled vec/struct (CPR prerequisite, shared with #1629)"
status: done
created: 2026-05-30
updated: 2026-05-30
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: this-receiver-binding
goal: test262-conformance
sprint: 57
related: [1719, 1629, 1636]
---

# #1742 — Closure `this`-receiver member reads trap "illegal cast" for compiled vec/struct receivers

## Problem

When a compiled closure body reads `this[i]` / `this.length` / `this.member` and
`this` is a **compiled value** (a WasmGC `$vec` array or a named struct) supplied
as the receiver through the `__call_fn_method_N` host-dispatch path, the read
**traps `RangeError`-class "illegal cast"** at runtime.

This is the prerequisite blocking **#1719 CPR** (driving an overridden
`Array.prototype[@@iterator]` whose body reads `this[i]`) and is the **same gap
class** sdev-1629 hits for accessor getters (`get x(){ return this.x }`, a
**struct** receiver). It is shared infrastructure, not a #1719-local fix.

## Root cause (pinned)

The closure **receiver ABI already exists** (#1636-S1, PR #873): `__call_fn_method_N`
takes `thisVal: externref`, stores it in the `__current_this` module global
before `call_ref`, and `ThisKeyword` resolution reads that global
(`src/codegen/expressions.ts:862`, gated on `fctx.readsCurrentThis`). **`this` is
passed via a global, NOT a calling-convention param — so there is no closure-ABI
ripple.**

`ThisKeyword` resolution returns the global as a literal **externref**
(`src/codegen/expressions.ts:~906`). When the body then does `this[i]` /
`this.length`, codegen takes the **statically-typed vec/struct fast path**
(because the override is typed `Array`/`number[]`/`this: T[]`) and emits a bare
`ref.cast externref → $vec` — which traps, because the read site does NOT
guard-convert the externref to the concrete type the way the dedicated
externref-receiver lanes (`emitStructGetFromExternref`, #1454) do.

Working contrast (proves it is receiver-binding, not array reads): the same
generator driven with the array as a **regular parameter** works
(`function* g(a){ …a[0]… } ; g(arr)` → correct). Only the `this`-receiver path is
broken. And the array-method receiver lane
(`compileArrayPrototypeForEach`, array-methods.ts) already reads an externref
receiver as a vec correctly — that is the pattern to generalize.

## Design — read-site guard-convert (generic over vec AND struct)

**Read-site guard, not resolve-at-source.** `this` must stay externref at the
`ThisKeyword` resolution site, because it can legitimately be a genuine host
externref (a real host-object receiver) in other contexts; forcing it to
vec/struct there would break those. Instead, the index/length/property **read
sites** guard-convert: when the receiver value is an externref but the access
implies a compiled receiver (`this[i]` ⇒ vec, `this.member` ⇒ struct), emit
`extern.convert_any` + `ref.test`-guarded `ref.cast` to the concrete type (reuse
the existing `emitStructGetFromExternref` / guarded-cast helpers), passing
through unchanged for a genuine host externref.

- **Generic over receiver type:** vec (`this[i]`/`this.length` — #1719) AND
  struct (`this.member` — #1629). This is THE shared primitive; #1629's getter
  path consumes it rather than building its own.
- **Sites (~2-3):** element-access (`this[i]`), `.length` read, property-access
  (`this.member`) in `src/codegen/property-access.ts`, where a runtime-externref
  receiver currently bare-casts.

## Acceptance criteria

- A generator/function whose body reads `this[i]`/`this.length`, dispatched via
  `__call_fn_method_N` with a compiled vec receiver, runs without "illegal cast"
  and returns correct values (the #1719 CPR drive: canonical override yields the
  `42` element).
- A getter `get x(){ return this.x }` with a compiled **struct** receiver reads
  the field correctly (the #1629 consumer).
- No regression: genuine host-externref `this` receivers (e.g. real host objects)
  still pass through to the host read path unchanged; byte-identical output for
  modules that never dispatch a compiled receiver through `__call_fn_method_N`.

## Implementation resume notes (pinned sites — senior-dev, 2026-05-30)

Branch `issue-1719-s2-arrayobj` (off origin/main, current). `ctx.protoOverrides`
scaffolding already landed (commit c002ac881). All sites pinned — no further
investigation needed:

1. **`ThisKeyword` resolves to externref** at `src/codegen/expressions.ts:862`
   (the `fctx.readsCurrentThis && ctx.currentThisGlobalIdx >= 0` branch) — returns
   `{kind:"externref"}` (null-guarded `__current_this` `global.get`).
2. **Element-access entry**: `compileElementAccess` (`property-access.ts:3029`)
   compiles the object at line **3155** (→ externref for a `this` receiver) and
   dispatches to `compileElementAccessBody` (line 3177). The body's vec/struct
   fast path is at **3245+** (`typeIdx` from `objType`). **Fix**: when
   `expr.expression` is `ThisKeyword` + `readsCurrentThis` + the static TS type
   resolves to a vec/struct typeIdx (via `resolveStructName` /
   `getArrTypeIdxFromVec` on `getTypeAtLocation(expr.expression)`), after compiling
   `this` to externref emit `any.convert_extern` + a `ref.test`-guarded `ref.cast`
   to that concrete typeIdx, then call `compileElementAccessBody` with the concrete
   ref ValType.
3. **Property/`.length` entry**: same guard in `compilePropertyAccess` (same file)
   for the `this`-receiver externref → struct/vec case.
4. **Reuse** `emitExternrefToStructGet` (line 628) `any.convert_extern` +
   guarded-cast pattern; factor a small shared
   `emitThisReceiverGuardConvert(ctx, fctx, targetTypeIdx)` (externref on stack →
   concrete ref) consumed by both #1719 (vec) and #1629 (struct getters).
5. **Genuine host externref `this` passes through unchanged** — guard with
   `ref.test`, convert only when the runtime value IS the compiled vec/struct, else
   keep the host read path (read-site-guard steer, NOT resolve-at-source).

**Verify**: `var g=function*(){ if(this.length>2) yield this[2]; }; var a=[5,6,7];`
driven `g.apply(a,[]).next()...` → no "illegal cast", reads `7` (both `this.length`
and `this[i]` currently trap; array-as-param already works). Then a struct getter
`get x(){ return this.x }` with a compiled-struct receiver (the #1629 consumer).

**Then CPR (#1719)**: write-arm in `compileElementAssignment` (`assignment.ts:~2450`,
builtin-prototype arm storing the override funcref in `ctx.protoOverrides`,
force-emit the closure) → read-drive at the branded dstr gate
(`destructuring.ts:892`): call the stored override with the array as `this` via
`__call_fn_method_N`, drain via `__iterator_next` → prove `[a,b,z]=arr` with
overridden `@@iterator` yields `z=42` → CPR-2 (values alias + for-of + spread) →
PR, #1719 status:done.

## Implemented (senior-dev, 2026-05-30)

The read-site guard landed in `src/codegen/property-access.ts`:

- **`emitThisReceiverGuardConvert`** (new, exported) — the shared primitive.
  Externref on stack → `any.convert_extern` + `ref.test $target` → in the
  then-arm casts to `(ref $target)` and runs the vec/struct path; in the
  else-arm keeps the externref and runs the host path. Both arms leave the
  access `resultType`, so a genuine host externref passes through unchanged
  (read-site-guard steer, NOT resolve-at-source). Generic over vec AND struct.
- **`resolveThisReceiverGuardTarget`** (new) — gates the guard to `ThisKeyword`
  receivers in a `readsCurrentThis` closure. Resolves the target typeIdx from
  (1) the static `this` type when it names a compiled struct (`this: T[]` /
  `this: Point`), else (2) for an element access, the **canonical externref
  `$vec`** (the representation the CPR drive installs — untyped override `this`).
- **Element access** (`compileElementAccess`): when the receiver is `this`,
  externref, and the index is side-effect-free, route through the guard.
- **`.length`** (`compilePropertyAccess`, top of the `length` block): same guard,
  reads vec field 0 in the then-arm, `__extern_length` in the else-arm.

Verified: WAT for `this[i]`/`this.length` in a lifted closure now emits
`ref.test`-governed reads off `__current_this` (no bare `ref.cast` trap).
Regression pinned in `tests/issue-1742-this-receiver-guard.test.ts`. Equivalence
suite green (no byte-identical regression for non-`this`-receiver sites).

**Runtime end-to-end note (for the #1719 CPR drive):** #1742 supplies the read
primitive but has no independent runtime trigger — the only thing that dispatches
a compiled vec/struct as `this` through `__call_fn_method_N` is the CPR drive
(steps 3-4) or a #1629 accessor getter. The guard tests against the **canonical
externref `$vec`**, so the CPR drive MUST normalise the array RHS to an
externref-vec receiver before installing it as `this` (a raw `$vec_f64`/`$vec_i32`
fails the `ref.test` and falls to the host path). This is the representation
contract the CPR drive consumes.

## Source

Carved from #1719 CPR build (senior-dev, 2026-05-30) after the size-gate probe
showed the `this`=compiled-receiver member-read guard is the genuine prerequisite
— ABI exists (no ripple), fix is in shared member-read codegen (~2-3 sites),
shared with #1629. Approved build-now by tech-lead.
