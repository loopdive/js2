---
id: 6453
title: "`__extern_get_idx` has no `$__ta_view` arm — a buffer-backed view reads NaN through every array-like walk"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

The standalone indexed read `__extern_get_idx(v, i)`
(`src/codegen/object-runtime-enumeration.ts` ~L710, body built by
`buildExternGetIdxBody`, per-element-kind arms appended at finalize by
`fillExternGetIdxVecArms`) recognises `$ObjVec`, the `__vec_<k>` carriers and
the array-like `$Object` (#2036). It does **not** recognise the shared-backing
`$__ta_view` struct that `new Uint8Array(<ArrayBuffer>)` builds (#3054), so it
takes the miss branch and answers `undefined` for every index.

Its sibling `__extern_length` **does** answer correctly for a view. The pair
therefore disagrees, and every consumer that walks an array-like as
`__extern_length` + `__extern_get_idx` reports the right length with `NaN`
elements — a wrong answer that looks like a populated array.

## Evidence

Measured 2026-09-13 on `7adc0a6e89`, standalone lane, at the intermediate state
of [#6422](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6422-array-from-buffer-backed-view-illegal-cast)
— after that fix stopped `Array.from` from trapping on a view but before it
learned to de-view one, so the view reached `__array_from_native`'s array-like
branch, which is exactly this walk:

```ts
const buf = new ArrayBuffer(32);
const fill = new Uint8Array(buf);
for (let i = 0; i < 32; i++) fill[i] = 3;
const a = Array.from(new Uint8Array(buf));
a.length; // 32   — correct (__extern_length)
a[0];     // NaN  — wrong, should be 3 (__extern_get_idx)
```

Controls in the same module: reading the view directly (`v[i]` in a loop) sums
to 96, and `Array.from(new Uint8Array([1,2,3,4]))` sums to 10 — so the view is
built and indexable, and the plain-vec arms are fine.

#6422 **dodges** this rather than fixing it: its `Array.from` arm de-views the
`$__ta_view` into a real vec with `emitTaViewToVec` before copying, so that one
caller never reaches the walk. Every other caller still does.

## Scope to check

`__extern_get_idx` is called from at least `array-from-native.ts`,
`iterator-native.ts`, `spread-arg-list.ts`, `hof-native.ts`,
`object-runtime.ts` (`Object.assign`'s copy loop, `Object.values`,
`__apply_closure`'s argument read) and `object-runtime-proxy.ts`
(`ownKeys`). Each of those over a buffer-backed view is a candidate for the
same silent `NaN`.

## Acceptance criteria

1. `__extern_get_idx` over a `$__ta_view` returns the view's element at that
   index (decoded per the view's element kind and signedness, honouring
   `byteOffset` and the auto-length `-1` sentinel — the same reads
   `pushTaViewEffectiveLen` / `emitTaViewElementGet` already do), and
   `undefined` out of bounds.
2. Anti-vacuity: `$ObjVec`, the `__vec_<k>` carriers and the array-like
   `$Object` arms keep their current answers, including the OOB-miss
   `undefined`.
3. A spread / `Object.values` / iterator-drain case over a buffer-backed view
   returns the bytes, not `NaN` — pick at least one caller other than
   `Array.from` and pin it.
4. Regression test under `tests/`, failing on the parent and passing with the
   fix.
5. A/B over the 17 dogfood suites at one HEAD.

## Provenance

Found while fixing
[#6422](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6422-array-from-buffer-backed-view-illegal-cast).

## Implementation Plan

**Confirmed on 54c36a9fe3 (standalone, untyped two-file fixture):** `Array.prototype.map.call(view, x=>x*2)[1]`, `Object.values(view)[1]` and `f(...view)` all read `NaN`; plain-array controls and the `{0:7,length:3}` OOB miss are correct. Why (from the code, not a guess): `$__ta_view_<name>` (registry/types.ts `getOrRegisterTaViewType`, fields `[length, buf, byteOffset, kind]`, supertype `$__vec_base`) is absent from `ctx.vecTypeMap`, so `fillExternGetIdxVecArms` (object-runtime.ts ~L8793) never mints an arm; `fillExternArrayLikeStructArms` (~L11808) skips it via `isVecBaseSubtype` (#4443); `fillTaDynViewMopArms` (ta-dyn-mop.ts ~L340) only `ref.test`s `$__ta_dyn_view`. `__extern_length` is right by accident — its `$__vec_base` arm reads field 0 raw (and answers `-1` for an auto-length view over a resizable buffer). Host lane is unaffected (JS import owns `__extern_get_idx` there).

**Fix — mirror the dyn-view pattern, one arm per registered static view (standalone only):**
1. `src/codegen/dataview-native.ts`: add `ensureTaViewGetElemHelper(ctx, viewName, taViewTypeIdx): number | undefined` minting `__ta_view_get_elem_<name>(externref recv, f64 idx) -> externref`, `noJsHost`-gated, idempotent via `funcMap`, built with a `makeFctx`-style `FunctionContext` (copy the small local helper from ta-dyn-mop.ts or export it). Body: `any.convert_extern; ref.cast $__ta_view_<name>` → `tv` local; `len` = `pushTaViewEffectiveLen(ctx, fctx, tv, taViewTypeIdx)` (honours the `-1` auto-length sentinel, byte-inert without a resizable AB); valid-index check = `pushIsValidIntegerIndex(fctx, 1, i, len)` (export it from ta-dyn-mop.ts; integral, not `-0`, `(u32)i < len`) else `undefinedExternInstrs(ctx) ?? ref.null.extern; return`; `arr = tv.buf.data`, `off = tv.byteOffset + i*desc.bytes`, `le = 1`; decode via `emitReadBytes(ctx, fctx, {kind:"get", bytes, signed, float}, arr, off, le, byteArrTypeIdx)` with the STATIC `taViewDecode(ctx, taViewTypeIdx)` descriptor (this recovers Int8/Int16 signedness, unlike the `i8_byte` unsigned vec arm); box with `__box_number`. Register via `mintDefinedFunc` + `pushDefinedFunc` (append-only, no import shift).
2. New `fillTaViewGetIdxArms(ctx)` (put it in ta-dyn-mop.ts next to `fillTaDynViewMopArms`): return unless `ctx.standalone && ctx.externGetIdxReserved`; for each `[name, typeIdx]` of `ctx.taViewTypeMap` sorted by typeIdx, `fn.body.unshift(local.get 0; any.convert_extern; ref.test typeIdx; if { local.get 0; local.get 1; call helper; return })` into `__extern_get_idx` **and** `__extern_has_idx` (has = same valid-index predicate boxed as i32 — add a `__ta_view_has_idx_<name>` twin or reuse the get helper + `__extern_is_undefined`). Prepending at index 0 is safe: the type test is exact (`$__ta_view_<name>` is neither a `__vec_<k>` nor `$ObjVec` nor `$Object`), so every existing arm's answer is untouched — that is AC2.
3. `src/codegen/index.ts`: call `fillTaViewGetIdxArms(ctx)` immediately after `fillTaDynViewMopArms(ctx)` at **both** finalize sites (~L6607 single-source and ~L11356 multi-source), i.e. after `fillExternGetIdxVecArms`/`fillExternArrayLikeStructArms` so `taViewTypeMap` is complete. Check `check:dead-exports` for the newly exported helpers.
4. Optional, same PR, one arm: prepend a `ref.test $__ta_view_<name>` arm to `__extern_length` returning `f64(pushTaViewEffectiveLen)` so an auto-length view over a resizable buffer stops reporting `-1` — gate on `ctx.resizableAbTypeIdx >= 0` to keep fixed-buffer modules byte-identical.

**Probe first:** `.tmp/p6453/probe3.mts` shape — `compileProject(entry.ts, {target:"standalone", allowJs:true, skipSemanticDiagnostics:true})`, instantiate with `{}`; expect `pMap 204 · pValues 802 · pCallArgs 12` after the fix (parent: NaN/NaN/NaN).

**Regression test** `tests/issue-6453-extern-get-idx-ta-view.test.ts`: untyped `mod.js` (`new Uint8Array(new ArrayBuffer(8))` filled 1..8) + `entry.ts` re-exports, standalone target. Pin: `Array.prototype.map.call(view,…)` → `[2,4,…]`, `Object.values(view)[1] === 2`, `f(...view)` → 12, an `Int8Array` view with `-5` reads `-5` (signedness), a `(buf, 4, 2)` offset view reads bytes 5,6 and `view[100] === undefined`. Anti-vacuity controls in the same module: plain `[4,5,6]` through `map.call`/`Object.values`, `{0:7,length:3}` array-like with `[1] === undefined`, and `new Uint8Array([1,2,3,4])` (the `i8_byte` vec arm) — all must keep today's answers. Fails on parent (NaN), passes with fix.

**Out of scope (file follow-ups, do not fix here):** `[...view]` / `for (const x of view)` throw "not iterable" and `Array.prototype.reduce/indexOf.call(view)` throw TypeError (iterator + borrow-dispatch gaps, never reach `__extern_get_idx`); `Object.assign({}, view)[1]` is NaN through the string-key `__extern_get` path.

**Expected movement:** dogfood anchors (webpack 16/16 … hono ~261/324) are host-lane and should be unchanged — A/B at one HEAD is AC5 evidence, not a target. Standalone lane: small positive on test262 `built-ins/TypedArray*` rows that borrow Array.prototype generics or `Array.from(anyView)`; the equivalence-gate and standalone floor must not move down; gc/host output byte-identical (all new code is `standalone`/`noJsHost`-gated).

## Dispatch

**opus** — the fix is a mechanical mirror of the existing `$__ta_dyn_view` fill with known helpers, but it touches finalize ordering at two sites and needs the anti-vacuity discipline around arm precedence, which is medium rather than CI-only.
