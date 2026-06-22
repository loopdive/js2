---
id: 2604
title: "Standalone Set.prototype.METHOD.call(nonSet) — native dispatch + [[SetData]] brand-check TypeError"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-af6ff9d85ab8e6fc4
sprint: 65
created: 2026-06-22
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: collections
language_feature: Set
goal: standalone-mode
parent: 2162
---

# #2604 — Standalone `Set.prototype.METHOD.call(receiver, …)` native dispatch + brand-check

## Problem (verified on main `6d76f5b2d`, host-vs-standalone diff)

The largest residual Set bucket (**~84 rows**) is the `[[SetData]]` brand-check
cluster: `Set.prototype.add/has/delete/clear/forEach/entries/keys/values`
applied via `.call()`/`.apply()` to a **non-Set receiver** must throw
`TypeError` (spec 24.2.3.* step "If S does not have a [[SetData]] internal slot,
throw a TypeError"). Standalone currently does NOT throw.

Two forms appear in every method's test dir:

```js
// Set.prototype.{add,has,delete,clear,forEach,entries,keys,values}/this-not-object-*.js
assert.throws(TypeError, function () { Set.prototype.add.call("", 1); });
// .../does-not-have-setdata-internal-slot-{object,array,map,weakset,set-prototype}.js
assert.throws(TypeError, function () { Set.prototype.add.call({}, 1); });
assert.throws(TypeError, function () { var s = new Set(); s.add.call({}, 1); });
```

Receivers exercised: `""`, `0`, `true`, `null`, `undefined`, `Symbol()`, `{}`,
`[]`, `new Map()`, `new WeakSet()`, `Set.prototype` itself.

## Root cause (PROVED with two probes)

1. `Set.prototype.METHOD.call(recv, …)` does **not** route to the native Set
   runtime at all — even with a *valid* Set receiver. Probe:
   `Set.prototype.has.call(realSet, 5)` returned the no-op sentinel (neither
   `true` nor `false`), i.e. it falls through `tryCompileNativeSetMethodCall`
   (which only fires on `className === "Set"` for the *direct* `s.add(v)` shape
   in `src/codegen/expressions/extern.ts:73`) into the generic `.call` /
   member-closure path, which has no native-Set knowledge.
2. So there is no site that brand-tests the receiver — `Set.prototype.add.call(
   "", 1)` runs to completion (probe returned `0` = no throw).

This is therefore TWO things in one slice: (a) recognize the
`Set.prototype.METHOD.call(recv, …)` and `setInstance.METHOD.call(recv, …)`
shapes and dispatch to the native runtime; (b) emit a runtime brand-test on the
compiled receiver and throw `TypeError` when it is not the `$Map` backing
struct.

## Implementation Plan

### Root cause
`tryCompileNativeSetMethodCall` only intercepts the *direct* `s.METHOD(args)`
call shape (gated on the receiver's static `className === "Set"`). The
reflective `Set.prototype.METHOD.call(recv, …)` / `inst.METHOD.call(recv, …)`
shapes never reach it, so neither the native dispatch nor the brand-check fires.

### Changes

**File: src/codegen/expressions/calls.ts** (the `.call`/`.apply` member-closure
dispatch — see the `(#2193 PR-B) Reflective m.call(thisArg, …args)` handler near
line ~738, and the `compileDotCall`/member-closure recovery around 720–800)
- Add a pre-check, BEFORE the generic member-closure recovery, that detects when
  the closure being `.call()`'d is a `Set.prototype.METHOD` or
  `setExpr.METHOD` reference (METHOD ∈ {add, has, delete, clear, forEach,
  entries, keys, values}) under `ctx.nativeStrings`.
- When matched, synthesize the native dispatch: compile the first `.call`
  argument as the receiver (the `thisArg`), brand-check it (below), then route
  the remaining args to the same helper `tryCompileNativeSetMethodCall` already
  emits (`__set_add`/`__map_has`/`__map_delete`/`__map_clear`/forEach/iterator).
  Reuse `coerceSetArgToAnyref` for the value arg.

**File: src/codegen/set-runtime.ts**
- Factor the brand-test into a shared helper `emitSetBrandCheck(ctx, fctx)`:
  assumes the receiver value (as anyref/externref) is on the stack; emit
  `ref.test $Map` (the `ctx.mapTypeIdx` struct that backs Set). On **false**,
  throw a `TypeError`. Follow the existing standalone throw-helper pattern (grep
  `__throw_type_error` / how `regexp-standalone.ts` and `map-runtime.ts` raise a
  TypeError in standalone; if none exists, emit the canonical
  `throw (ref.i31 …)` exception used elsewhere for TypeError). Do NOT use
  `ref.cast` (it traps with `illegal cast`, not a catchable TypeError — see the
  `entries/this-not-object-throw-symbol.js` `illegal cast in __proxy_revoke()`
  symptom).
- The receiver must be brand-checked WITHOUT trapping for null / primitive /
  wrong-struct. Use `ref.test $Map` (returns 0/1, never traps) then branch.
  `null`/`undefined`/`i31`(boolean,smi)/string/other-struct all `ref.test`-miss
  → TypeError. A genuine `$Map` (Set or Map backing) passes — note a real `Map`
  also `ref.test`s as `$Map` so this WON'T distinguish Set-from-Map by struct
  alone (the `does-not-have-setdata-internal-slot-map.js` row); that sub-row
  needs a Set/Map discriminator (see Edge cases) and may stay red — still nets
  the ~75 primitive/object/array/null rows.

### Wasm IR pattern
```wasm
;; brand-check receiver (anyref on stack) for Set.prototype.add.call(recv, v)
local.tee $recv_any
ref.test $Map            ;; ctx.mapTypeIdx — 0 if recv is not the backing struct
i32.eqz
if
  ;; throw TypeError (catchable) — NOT ref.cast (which traps illegal_cast)
  ... emit standalone TypeError throw ...
end
local.get $recv_any
ref.cast $Map            ;; safe now (passed ref.test)
local.get $v_anyref
call $__set_add
```

### Edge cases
- `recv` is `null`/`undefined` → `ref.test $Map` = 0 → TypeError (NOT null deref).
- `recv` is a primitive (`""`, `0`, `true`, `Symbol()`) → `ref.test` = 0 → TypeError.
- `recv` is `{}` / `[]` → struct/vec but not `$Map` → `ref.test $Map` = 0 → TypeError.
- `recv` is a real `Map`/`WeakSet` (also `$Map`-backed) → `ref.test $Map` = 1, so
  the bare struct test PASSES where spec wants TypeError. To flip
  `does-not-have-setdata-internal-slot-{map,weakset}.js` (a handful of rows) the
  backing struct needs a 1-byte kind tag (Set vs Map vs Weak) checked here —
  scope this as a stretch; the primitive/object/array/null rows (the bulk) flip
  without it.
- Both `Set.prototype.add.call(...)` AND `s.add.call(...)` forms must be caught
  (same closure target, two syntactic shapes).

### Failing test262 paths (representative)
- `test/built-ins/Set/prototype/add/this-not-object-throw-{string,null,number,boolean,symbol,undefined}.js`
- `test/built-ins/Set/prototype/add/does-not-have-setdata-internal-slot-{object,array,map,weakset,set-prototype}.js`
- same matrix under `has/`, `delete/`, `clear/`, `forEach/`, `entries/`, `values/`
- `test/built-ins/Set/prototype/{isSubsetOf,isSupersetOf,isDisjointFrom}/receiver-not-set.js`

### Estimated rows
~75–84 (the bulk flip without the Set/Map kind-tag discriminator; the
`internal-slot-{map,weakset}` sub-rows need the stretch tag).

### Notes / dispatch
- **File overlap**: `src/codegen/expressions/calls.ts` (`.call` member-closure
  path) is shared with the reflective `m.call`/`m.apply` work (#2193) — coordinate
  to avoid a conflict; this slice ADDS a Set-specific pre-check, it does not
  rewrite the generic path. `src/codegen/set-runtime.ts` is owned by #2162 only.
- Verify host/gc mode unchanged (the pre-check is gated on `ctx.nativeStrings`).
- Independent of #2580 value-rep substrate (brand-test is a `ref.test`, not a
  dynamic property read).

## Resolution (2026-06-22)

Landed with #2607 in one branch (`issue-2604-2607-set-brand-check`).

**Changes**
- `src/codegen/set-runtime.ts` — new shared `emitSetBrandCheck(ctx, fctx, recvType)`:
  normalises the compiled receiver to anyref, `ref.test $Map` (NON-trapping); on a
  miss throws a *catchable* `TypeError` via `emitThrowTypeError` (NOT `ref.cast`,
  which traps `illegal cast`), on a hit `ref.cast`s to the validated `(ref $Map)`.
  Plus `tryCompileSetReflectiveCall` (dispatches `Set.prototype.METHOD.call(recv,…)`
  / `inst.METHOD.call(recv,…)` for add/has/delete/clear after the brand-check) and
  the cheap `isSetReflectiveCallShape` predicate.
- `src/codegen/expressions/calls.ts` — in the `.call`/`.apply` handler, BEFORE the
  generic #2193 member-closure recovery: when `isSetReflectiveCallShape` matches,
  `addUnionImports(ctx)` (so the arg-boxing `__box_number` is registered up-front,
  mirroring the direct path's extern.ts setup — avoids a mid-body index shift) then
  `tryCompileSetReflectiveCall`. ADDS a Set pre-check; does NOT rewrite the generic
  path (#2193 reflective tests unchanged).

Gated on `ctx.nativeStrings`; host/gc mode unchanged. Both syntactic shapes
(`Set.prototype.add.call` and `s.add.call`) are caught. `.apply` and
forEach/keys/values/entries reflective forms fall through (deferred). The
Set-vs-Map kind-tag discriminator (`internal-slot-{map,weakset}` sub-rows) is the
documented stretch — those few rows stay red; the primitive/object/array/null
bulk flips.

## Test Results

- `tests/issue-2604-set-brand-check.test.ts` — 31/31 pass: add/has/delete ×
  {"", 0, true, null, undefined, {}, [], Set.prototype} all throw TypeError;
  clear.call(non-Set) throws; instance form `s.add.call({},1)` throws; valid
  `Set.prototype.{has,add,delete,clear}.call(realSet,…)` dispatch correctly;
  direct `s.add`/`s.has` regression guard.
- Set regression suites green (issue-2162-set-algebra/standalone-set/set-foreach/
  iterators, issue-42-set-spread; Map foreach/from-array; #2193 reflective — 88
  tests total). gc-mode Set (direct + reflective + algebra) unchanged.
- tsc + prettier + coercion-sites gate clean.
