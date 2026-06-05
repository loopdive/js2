---
id: 6407
title: "Array.prototype.<m>.call(receiver, cb) never reads elements of a compiled $Vec / open-object receiver"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen+runtime
language_feature: array-methods
goal: correctness
sprint: 61
blocks: [1828, 1830, 1831, 1832]
---
# #6407 — `Array.prototype.<m>.call(receiver, …)` can't read elements of a compiled receiver

## Symptom (dev-w1, 2026-06-04)

- `Array.prototype.findIndex.call([10, 20, 30], x => x === 20)` → **-1** (want `1`).
- Same for `find` / `map` / `every` / `some` / `forEach` / `reduce` and the
  `indexOf`/`includes` search forms when the **`.call` receiver is a compiled
  array literal or open-object** rather than an `any`-typed array-like.
- Object-literal numeric keys `{0:1, 2:3}` are not retrievable through the same
  path (likely the same family — open-object receiver, not host JS object).

This is the shared root cause under **#1828 / #1830 / #1831 / #1832**, which
landed as "correct-but-unverifiable" point-fixes because their verification
exercises `Array.prototype.<m>.call(compiledReceiver, …)` and that call never
reads any elements. Fixing this unblocks verifying all four.

## Root cause

`Array.prototype.<m>.call(recv, cb)` is dispatched by
`compileArrayPrototypeCall` (`src/codegen/array-methods.ts:1713`). It resolves
the receiver:

1. If `resolveArrayInfo(receiverTsType)` succeeds (a typed array like
   `number[]`), it builds a synthetic `recv.<m>(cb)` and routes to
   `compileArrayMethodCall` — the **fast/typed path**.
2. Otherwise (an `any`-typed array-like), it routes to
   `compileArrayLikePrototypeCall` (`:458`) — the **generic loop** that iterates
   with the host imports `__extern_length` + `__extern_get_idx` and `call_ref`s
   the Wasm-closure callback.

The defect is in the **generic loop's element read** when the receiver is a
*compiled* value (a `$Vec` array literal or an open-object struct) that has been
coerced to `externref`:

- The host `__extern_get_idx(obj, idx)` (`src/runtime.ts:5190-5210`) reads the
  element with `obj[idx]`, then a sidecar, then a string key, then the struct
  getter export `__sget_${idx}`. For a **compiled `$Vec`** all four miss:
  - `$Vec` is an opaque WasmGC struct on the JS side — `obj[idx]` is `undefined`
    (no indexed JS access through `externref`).
  - `emitStructFieldGetters` (`src/codegen/index.ts:1626`) **explicitly skips**
    `__vec_*` and `__arr_*` structs (`:~1640`), so there is **no
    `__sget_0` / `__sget_1` getter** for vec elements.
  - There is no sidecar for a fresh literal.
  - ⇒ `__extern_get_idx` returns `undefined` for every index, so a dense
    `findIndex` finds nothing → -1.
- The `array-methods.ts` bailout at `:488-513` only catches a receiver whose
  *resolved Wasm type* is a named `__vec_*`/`__arr_*` ref — it routes those
  *away* from the generic loop back to `compileArrayMethodCall`. But it relies on
  `resolveWasmType(ctx, recvTsType)` yielding that named ref, which does not
  always happen for a literal/widened receiver, and when it does the
  `compileArrayMethodCall` typed path must itself accept a `.call`-form receiver
  (it currently keys off the synthetic `recv.<m>` `this`, which works for path 1
  only when `resolveArrayInfo` succeeded — the gap is the values that fall
  *between* "named-vec ref" and "`any` array-like").

So the failing values are compiled receivers that (a) reach the generic
`__extern_get_idx` loop, where the host helper can't read a `$Vec`/open-object,
or (b) reach `compileArrayMethodCall` but with a receiver shape it doesn't
element-index. Both are *element-retrieval* gaps for a compiled receiver.

Standalone mode has the symmetric gap: the **native** `__extern_get_idx` in
`object-runtime.ts` (the `$ObjVec` arm, `:~956/1255`) was taught to read the
enumeration `$ObjVec`, but **not** the array-literal `$Vec` (`__vec_*`) used by
compiled array literals — so the same `findIndex.call([…])` fails under
`--target wasi` too.

## Implementation Plan (architect, 2026-06-04)

### Decision

Make element retrieval **`$Vec`/open-object-aware in BOTH the host helper and
the native helper**, and tighten the dispatch so a compiled receiver always
reaches an element-aware path. The brand check is `ref.test`, consistent with
the project pattern (`ref.test` before `ref.cast` to avoid illegal_cast traps).
Prefer routing a compiled-vec receiver to the **typed `compileArrayMethodCall`
path** (it already has `vec.get` element access) over patching the host helper —
but patch the host/native helper too as the correctness backstop for receivers
that legitimately reach the generic loop (open-objects, mixed array-likes).

### Changes

**(A) Dispatch — route compiled-vec `.call` receivers to the element-aware typed path**

**File: src/codegen/array-methods.ts**
- `compileArrayPrototypeCall` (`:1713`), receiver resolution at `:1740-1774`:
  - Before falling to `compileArrayLikePrototypeCall` at `:1773`, also try
    `resolveArrayInfoForExpression(ctx, fctx, receiverArg, receiverTsType)`
    (`:404`) — it consults the **compiled Wasm type** of the expression
    (`inferExpressionWasmType`), not just the TS type. A literal `[10,20,30]`
    whose TS type widens but whose compiled value is a `__vec_externref`/
    `__vec_f64` is caught here and routed to the typed synthetic-prop path
    (`:1776-1791`). This is the primary fix for the literal-receiver symptom.
  - Keep `compileArrayLikePrototypeCall` as the fallback for genuinely
    `any`-typed / open-object receivers.
- `compileArrayLikePrototypeCall` (`:458`), the `__vec_`/`__arr_` bailout at
  `:488-513`: the bailout returns `undefined` (→ caller fallthrough to
  `__proto_method_call`, the host-native `Array.prototype.<m>` bridge). For a
  `$Vec` that bridge **cannot read elements either** (same opaque-externref
  problem). Change the bailout target: instead of `return undefined`, route
  these to `compileArrayMethodCall` via the synthetic-prop path (the element-
  aware typed loop), mirroring `:1776-1791`. Only `return undefined` (→ host
  bridge) for the assert_throws / throwing-getter cases at `:533-545` that
  genuinely need host exception propagation.

**(B) Host helper — make `__extern_get_idx` / `__extern_length` / `__extern_has_idx` read a `$Vec`**

**File: src/runtime.ts** (and the export surface)
- The host can't `struct.get` a `$Vec` directly, but the compiler can **emit a
  dedicated vec-element getter export** for any `__vec_*` type the module uses,
  the way `__sget_N` works for open-object fields. Add a single generic export
  `__vec_get_idx(externref vec, i32 idx) -> externref` and
  `__vec_len(externref vec) -> i32`, emitted as **Wasm functions** (not host
  imports) that:
  - `ref.test` the externref against each registered `__vec_*` struct type;
  - on match: `struct.get $Vec 0` for len / `struct.get $Vec 1` (backing array)
    + `array.get` at idx, then box the element to externref via the existing
    `coerceType(elemType → externref)` (f64→`__box_number`, i32→…, ref→
    `extern.convert_any`).
  - These mirror the existing `emitStructFieldGetters` export mechanism
    (`index.ts:1617`) but for the vec shape that getter pass deliberately skips.
- In `__extern_get_idx` (`runtime.ts:5190`) and `__extern_length`
  (`:5180`) and `__extern_has_idx` (`:5219`): **before** the `obj[idx]` / sidecar
  / `__sget_${idx}` chain, consult `exports.__vec_get_idx` / `exports.__vec_len`
  — `if (typeof exports?.__vec_get_idx === "function") { const v = exports.__vec_get_idx(obj, idx); if (v !== undefined) return v; }`. This is the
  correctness backstop for any receiver that still reaches the generic loop.
- Register `__vec_get_idx` / `__vec_len` in the export allowlist alongside
  `__sget_*` (search `__sget_` in the allowlist / export-emission sites).

**(C) Native helper — `$Vec` arm in the standalone `__extern_get_idx`**

**File: src/codegen/object-runtime.ts**
- The native `__extern_get_idx` / `__extern_length` (the `$ObjVec` arm,
  `:~956/1255`) gains a **`$Vec` (`__vec_*`) arm**: `any.convert_extern` →
  `ref.test` each registered `__vec_*` struct → on match `struct.get fieldIdx 1`
  (backing array) + `array.get idx` + box-to-externref; length via `struct.get
  fieldIdx 0`. This is the standalone twin of (B) and reuses the existing
  `getArrTypeIdxFromVec` to find the element array type.
- Because vec types are registered lazily and there can be several
  (`__vec_f64`, `__vec_externref`, …), emit the `ref.test` chain over
  `ctx.registeredVecTypes` (or whatever the registry exposes — see
  `getOrRegisterVecType` callers). A small ordered `if/else` chain by type
  index; fall through to the existing open-object / `$ObjVec` arms.

### Wasm IR pattern (native `$Vec` element read)

```wasm
;; __vec_get_idx(externref vec, i32 idx) -> externref  (one arm per registered $Vec type)
local.get $vec
any.convert_extern
local.tee $any
ref.test (ref $__vec_f64)
if (result externref)
  local.get $any
  ref.cast (ref $__vec_f64)
  struct.get $__vec_f64 1        ;; backing array (ref $__arr_f64)
  local.get $idx
  array.get $__arr_f64           ;; f64 element
  call $__box_number             ;; → externref (host) / struct.new box (standalone)
else
  ;; … next $Vec type arm, then $ObjVec, then open-object, then ref.null.extern
end
```

### Edge cases

- **Holes / out-of-range idx**: `array.get` traps on OOB. Guard with the
  `struct.get $Vec 0` length first: `if idx >= len → return undefined` (host) /
  the sentinel the generic loop treats as a hole. Spec §22.1.3.x array methods
  call `HasProperty` (→ `__extern_has_idx`) to skip holes; a dense `$Vec` has no
  holes, so `__extern_has_idx` returns 1 for `idx < len`, 0 otherwise. This is
  what makes `filter`/`find` skip past the end correctly.
- **Element boxing**: an `f64`/`i32`/`boolean` element must box to the SAME
  externref representation the callback expects (so `x === 20` compares a boxed
  number, not a struct). Reuse `coerceType(elemType → externref)` — do NOT
  hand-roll. For a `boolean` vec element this must box as a JS boolean
  (`__box_boolean`), tying into #1788's boolean-box fix.
- **Open-object numeric keys `{0:1, 2:3}`**: these are NOT a `$Vec` — they're an
  open-object struct with integer-named props. They already have `__sget_0` /
  `__sget_2` getters (open-object fields are NOT skipped by
  `emitStructFieldGetters`). Verify the dev-w1 `{0:1,2:3}` symptom is the same
  externref-vs-host-object gap and, if so, that the open-object arm of
  `__extern_get_idx` (the `__sget_${idx}` path) actually fires — it may be that
  the open-object struct doesn't surface `__sget_N` for purely-numeric keys.
  Carve a sub-check; if open-objects need a separate fix, file it as #6407b.
- **`map` result shape**: `map.call($Vec, cb)` must return a fresh array of the
  callback results — confirm the typed-path `compileArrayMethodCall` map builds
  a new `$Vec`, not a compacted/hole-losing one (the #1828 hole-handling fix
  must survive routing through this path).

### Slice breakdown

- **Slice 1 (load-bearing) — dispatch routing (A).** Route compiled-`$Vec`
  `.call` receivers to the typed `compileArrayMethodCall` element-aware path via
  `resolveArrayInfoForExpression`, and retarget the `__vec_`/`__arr_` bailout
  from the host bridge to the typed path. This alone fixes the headline
  `findIndex.call([10,20,30], …)` symptom for literal/typed receivers. ~60 LOC.
  Verify #1828/#1830/#1831/#1832 reproductions now pass.
- **Slice 2 — host backstop (B).** `__vec_get_idx`/`__vec_len` exports +
  consult them first in `__extern_get_idx`/`__extern_length`/`__extern_has_idx`.
  Covers receivers that still reach the generic loop (mixed array-likes that
  happen to be a `$Vec`). ~100 LOC.
- **Slice 3 — standalone native arm (C).** `$Vec` `ref.test` arm in the native
  `__extern_get_idx`/`__extern_length` so `--target wasi` reaches parity. ~80 LOC.
- **Slice 4 (conditional) — open-object numeric-key retrieval (#6407b).** Only
  if the `{0:1,2:3}` symptom is a distinct open-object gap, not covered by
  Slices 1–3.
- Slice 1 is independently shippable and unblocks the four dependent issues'
  verification; 2–3 close the dual-mode + array-like-receiver corners.

### Test files to verify

- Add `tests/issue-6407.test.ts` (equivalence): `findIndex`/`find`/`map`/
  `every`/`some`/`forEach`/`indexOf`/`includes` `.call` on a dense compiled
  array literal `[10,20,30]`, asserting the result matches native JS. Run BOTH
  default (JS-host) and `nativeStrings:true` (standalone) so Slices 2 and 3 are
  both covered.
- Re-run the #1828 / #1830 / #1831 / #1832 reproductions (their issue files cite
  the exact snippets) — they should now be *verifiable*, not just
  *correct-by-inspection*.
- test262: `built-ins/Array/prototype/{find,findIndex,map,filter,every,some,
  forEach,indexOf,includes}/*` `.call`-on-array-receiver tests, and the
  `15.4.4.*` legacy generic-array-method suite.

### Risk / conflicts

- File overlap: `array-methods.ts` (dispatch + bailout), `runtime.ts` (host
  helpers + allowlist), `object-runtime.ts` (native arm), `index.ts`
  (`emitStructFieldGetters` / export emission). Check the merge queue for
  in-flight array-method PRs (the #1815/#1816/#1828 family). Slice 1 is the
  smallest and should land first to unblock verification.
- Regression watch: the bailout retarget (A) moves `assert_throws`-wrapped
  throwing-getter cases — keep those on the host bridge (`:533-545` guard
  stays) so spec exception propagation is preserved (the #1382 reason the
  bailout existed). Run the `reduce`/`forEach` throwing-getter test262 cluster
  as the regression guard (PR #268 v1 regressed exactly those — do not repeat).
- No new host imports that lack a standalone fallback: `__vec_get_idx`/
  `__vec_len` are emitted **Wasm functions / exports**, not `env` imports, so
  the dual-mode rule holds. ✓
