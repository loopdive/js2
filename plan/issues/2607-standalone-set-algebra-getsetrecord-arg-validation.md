---
id: 2607
title: "Standalone Set set-algebra: GetSetRecord argument validation (TypeError on non-object / non-Set arg)"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-af6ff9d85ab8e6fc4
sprint: 65
created: 2026-06-22
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: collections
language_feature: Set
goal: standalone-mode
parent: 2162
---

# #2607 — Standalone set-algebra GetSetRecord argument validation

## Problem (verified on main `6d76f5b2d`)

The ES2025 set-algebra methods (`union`/`intersection`/`difference`/
`symmetricDifference`/`isSubsetOf`/`isSupersetOf`/`isDisjointFrom`) must run
`GetSetRecord(obj)` on their single argument (spec 24.2.1.2):

```
1. If obj is not an Object, throw a TypeError exception.
7. Let has be ? Get(obj, "has");  8. If IsCallable(has) is false, throw a TypeError.
9. Let keys be ? Get(obj, "keys"); 10. If IsCallable(keys) is false, throw a TypeError.
```

Standalone does NOT throw — `s1.isSubsetOf(1)` / `s1.isSubsetOf("")` /
`s1.isSubsetOf([])` complete without error (the bad arg falls through the native
algebra path or to a host import that leaks `env`).

## Scope split (IMPORTANT — substrate boundary)

GetSetRecord has TWO halves; this slice is the **validation** half only:

- **THIS SLICE (tractable, ~8–10 rows):** throw TypeError when the argument is
  NOT a Set (a primitive `1`/`""`/`1n`/`true`/`Symbol()`, or a plain object /
  array that is not the `$Map` backing struct). I.e. the negative/throw cases.
- **DEFER to #2580 M2 (value-rep substrate, ~10 rows):** accept an arbitrary
  *set-like* object — read `obj.size` / `obj.has` / `obj.keys` from a dynamically
  shaped `any` receiver and drive the algorithm against them
  (`allows-set-like-object.js`, `set-like-class-mutation.js`,
  `converts-negative-zero.js`, `compares-Map.js`). This needs `__dyn_get` /
  dynamic property read on an `any` object — exactly the #2580 dynamic-read
  substrate. **Do NOT attempt the set-like *data* path in this slice.**

## Root cause (read `set-algebra.ts`)

`tryCompileNativeSetAlgebraCall` (`src/codegen/set-algebra.ts` ~348) compiles the
argument and calls `castToMap(ctx, fctx, argType)` (~372). When the arg is a
non-Set:
- a non-struct primitive → `castToMap` returns false → the whole call returns
  `undefined` → falls through to the host path → `env` leak (no throw); OR
- a wrong struct ($ObjVec/array) → emits `ref.cast` → `illegal cast` trap (NOT a
  catchable TypeError) or the `call expected (ref null 57), found f64.const`
  invalid-Wasm seen in `called-with-object.js`.

Neither produces the spec TypeError.

## Implementation Plan

### Root cause
The set-algebra arg path has no GetSetRecord validation: a non-object/non-Set
argument is silently dropped (host fall-through) or trap-cast instead of throwing
a catchable TypeError.

### Changes

**File: src/codegen/set-algebra.ts**, `tryCompileNativeSetAlgebraCall`
- After compiling the argument, replace the bare `castToMap(arg)` with a
  brand-check-or-throw: emit `ref.test $Map` on the compiled arg value; on
  **false**, throw `TypeError` (reuse the `emitSetBrandCheck` helper from #2604 —
  this slice should land AFTER #2604 so the helper exists, OR inline the same
  `ref.test` + standalone-throw pattern). Only then `ref.cast $Map`.
- The receiver brand-check (`receiver-not-set.js` — `isSubsetOf.call(nonSet,
  realSet)`) is the predicate version of #2604's `.call` brand-check; if #2604
  generalizes its brand-check to the predicate methods, the receiver half is
  covered there. This slice owns the ARGUMENT validation.

### Wasm IR pattern
```wasm
;; s1.isSubsetOf(arg) — arg must be a Set
local.tee $arg_any
ref.test $Map
i32.eqz
if
  ;; throw TypeError (catchable) — GetSetRecord step 1 / IsCallable steps
end
local.get $arg_any
ref.cast $Map
call $__set_isSubsetOf
```

### Edge cases
- arg is `1` / `""` / `1n` / `true` / `Symbol()` → `ref.test $Map` = 0 → TypeError.
- arg is `[]` / `{}` → struct/vec but not `$Map` → TypeError (spec: a plain object
  WITHOUT a proper `size`/`has`/`keys` set-like shape → eventually throws; an
  array specifically throws because `[].size` is undefined → NaN. For THIS slice
  the bare `ref.test $Map` = 0 → TypeError covers `array-throws.js` and
  `called-with-object.js`).
- arg is a real `Set` → passes → run the algebra.
- arg is a genuine set-like *object* (size/has/keys) → DEFER (#2580 M2); this
  slice will (correctly, conservatively) throw TypeError for it, which is wrong
  for `allows-set-like-object.js` — that row stays red until M2. Accept that.

### Failing test262 paths (this slice)
- `test/built-ins/Set/prototype/{isSubsetOf,isSupersetOf,isDisjointFrom}/array-throws.js`
- `test/built-ins/Set/prototype/{isSubsetOf,isSupersetOf,isDisjointFrom}/called-with-object.js`
- `test/built-ins/Set/prototype/isSupersetOf/keys-is-callable.js`
- `test/built-ins/Set/prototype/{isSubsetOf,isSupersetOf,isDisjointFrom}/receiver-not-set.js` (if not covered by #2604)

### Deferred to #2580 M2 (NOT this slice)
- `allows-set-like-object.js`, `set-like-class-mutation.js`,
  `converts-negative-zero.js`, `compares-Map.js`, `builtins.js` (the last is
  function-reflection, separate substrate).

## Estimated rows
~8–10 (validation/throw cases). The set-like-data rows (~10) are #2580 M2.

## Notes / dispatch
- **File overlap**: `src/codegen/set-algebra.ts` (this slice's primary file) is
  #2162-owned, no overlap with #2604 (`calls.ts`/`set-runtime.ts`) or #2605
  (`typeof-delete.ts`). The shared dependency is the `emitSetBrandCheck` helper
  from #2604 — **sequence #2607 after #2604** (or inline the pattern). The
  receiver-brand-check overlap with #2604 is the only coordination point.
- Gated on `ctx.nativeStrings`; host/gc unchanged.
- Conservatively throwing for genuine set-like objects is acceptable (those rows
  are M2-deferred, currently failing anyway — no regression).

## Resolution (2026-06-22)

Landed with #2604 in one branch (`issue-2604-2607-set-brand-check`).

**Change** — `src/codegen/set-algebra.ts`, `tryCompileNativeSetAlgebraCall`:
replace the bare `castToMap(arg)` (which silently fell through to the host path
or trap-cast) with the shared `emitSetBrandCheck` from #2604 — `ref.test $Map` →
catchable `TypeError` on a non-Set argument (GetSetRecord 24.2.1.2 step 1 +
has/keys-callable steps), else `ref.cast $Map`. Covers both predicate
(`isSubsetOf`/`isSupersetOf`/`isDisjointFrom`) and set-op (`union`/`intersection`/
`difference`/`symmetricDifference`) methods.

The genuine set-LIKE-object data path (read `obj.size`/`has`/`keys` off an `any`)
is **#2580 M2** (dynamic property read) and is conservatively (correctly) rejected
with a TypeError here — those rows currently fail anyway, so no regression.

## Test Results

- `tests/issue-2607-set-algebra-arg-validation.test.ts` — 27/27 pass: predicates
  × {1, "", true, [], {}} throw TypeError; set-ops × {1, []} throw; valid
  `isSubsetOf`/`isDisjointFrom`/`union`/`intersection` with a real Set arg still
  run the algebra (no over-throw).
- Reuses the #2604 `emitSetBrandCheck` helper; no new coercion site. tsc +
  prettier + coercion gate clean; Set/Map regression suites green.
