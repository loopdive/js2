---
id: 2605
title: "Standalone `x instanceof Set/Map/WeakMap/WeakSet` returns false for native collections"
status: done
sprint: 65
created: 2026-06-22
completed: 2026-06-22
assignee: ttraenkler/dev-collections
priority: high
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: collections
language_feature: Set, instanceof
goal: standalone-mode
parent: 2162
---

# #2605 — Standalone `instanceof` for native Set/Map/Weak collections

## Problem (verified on main `6d76f5b2d`)

`combined instanceof Set` is `false` standalone where it must be `true`. The
ES2025 set-algebra methods (`union`/`intersection`/`difference`/
`symmetricDifference`) correctly return a new Set, but every test asserting the
result's type fails:

```js
const combined = s1.union(s2);
assert.sameValue(combined instanceof Set, true, "The returned object is a Set");
```

This affects the basic (non-subclass, non-species) `instanceof`-result rows of
all four set-algebra ops (**~21 rows**), and also any standalone program that
does `x instanceof Set/Map/WeakMap/WeakSet`.

## Root cause (read `compileInstanceOf`)

`src/codegen/typeof-delete.ts` `compileInstanceOf` (line ~464) resolves the
right operand to a `className`, then looks up `collectInstanceOfTags(className)`
(class-tag map) / `ctx.structMap.get(className)`. Native `Set`/`Map`/`WeakMap`/
`WeakSet` are NOT user classes and resolve to the `$Map` backing struct
(`ctx.mapTypeIdx`) with **no class tag** — so `compatibleTags.length === 0` →
the function emits `i32.const 0` (false) and drops the left operand
(line ~502–509).

## Implementation Plan

### Root cause
`compileInstanceOf` has no arm for the native-collection backing struct; it
treats `Set`/`Map`/`WeakMap`/`WeakSet` as unknown classes → constant `false`.

### Changes

**File: src/codegen/typeof-delete.ts**
- In `compileInstanceOf`, BEFORE the `compatibleTags.length === 0` →
  `i32.const 0` fallback (line ~501), add a native-collection arm gated on
  `ctx.nativeStrings`:
  - When `className` ∈ {`Set`, `Map`, `WeakMap`, `WeakSet`} and
    `ctx.mapTypeIdx >= 0`: compile the left operand, normalize to anyref
    (`extern.convert_any` if externref; `ref.null` guard for null), then emit
    `ref.test $Map` (`ctx.mapTypeIdx`). Return `{ kind: "i32" }`.
  - All four names share the `$Map` backing struct, so a bare `ref.test $Map`
    can't distinguish `Set` from `Map` from `WeakMap` from `WeakSet`. That is
    acceptable for the targeted rows (each test checks `result instanceof <its
    own type>`, which is always the matching backing struct), BUT a cross-type
    assertion like `set instanceof Map === false` would wrongly return true.
    Check the failing-test corpus: the targeted rows only assert
    `instanceof <same type>`. If a kind tag exists (see #2604 stretch), refine
    later; for THIS slice the bare `ref.test` flips the ~21 rows. Note this in
    the code comment so a future cross-type assertion doesn't regress silently.

### Wasm IR pattern
```wasm
;; combined instanceof Set   (combined : ref $Map on stack)
;; left already a ref $Map → ref.test directly
local.get $combined
ref.test $Map                ;; ctx.mapTypeIdx
;; → i32 (1)
;; for an externref left: any.convert_extern first, then ref.test (never traps)
```

### Edge cases
- Left operand is `null`/`undefined` → `ref.test $Map` = 0 → false (correct).
- Left operand is externref (e.g. boxed) → `any.convert_extern` then `ref.test`.
- Left operand is a primitive (i31/number) → `ref.test $Map` = 0 → false.
- Cross-type (`set instanceof Map`) is NOT distinguished by the bare struct test
  — document the limitation; not in the targeted corpus.

### Failing test262 paths (representative)
- `test/built-ins/Set/prototype/union/{appends-new-values,combines-empty-sets,combines-itself,combines-same-sets,combines-sets}.js`
- `test/built-ins/Set/prototype/{intersection,difference,symmetricDifference}/{combines-empty-sets,combines-itself,combines-same-sets,combines-sets,add-not-called}.js`

### Estimated rows
~21 (the basic `instanceof`-result assertions; the `subclass`/`combines-Map`/
`species` variants need #2606/#2607 and substrate, not this slice).

### Notes / dispatch
- **No file overlap** with #2604/#2606/#2607 (this is the only slice touching
  `typeof-delete.ts`). Independent, easy, high-value — good first dispatch.
- Gated on `ctx.nativeStrings`; host/gc `instanceof Set` already works via the
  host class table — verify host path unchanged.

## Resolution (2026-06-22 — dev-collections)

**Re-grounded against current main (`4bed9499c`, post-#2604/#2607).** The spec's
predicted root cause (`compileInstanceOf` in `typeof-delete.ts` constant-folding
`false`) was **stale** — `instanceof Set` does not flow through `compileInstanceOf`
for a builtin RHS. The real dispatch is `expressions.ts:1061` →
`compileHostInstanceOf` → `tryStaticInstanceOf`, and `Set` is already a registered
builtin (`BUILTIN_TYPE_TAGS.Set`), so `combined instanceof Set` already
statically resolves to `i32.const 1` standalone.

**Actual root cause of the ~21 failing rows:** the test262 harness lowers
`assert.sameValue(combined instanceof Set, true)` to
`assert_sameValue_bool(actual: any, expected: boolean)` → `actual !== expected`.
The `instanceof` result (a boolean) crosses into the `any` parameter as a boxed
value; the standalone dynamic-equality tag dispatch
(`binary-ops.ts` `noJsHost` arm) coerced the `boolean` operand to externref via
`coerceType` (which uses `f64.convert_i32_s` + `__box_number` → tag **number**),
while the other operand was a boxed boolean **true** (tag boolean). The
tags mismatched → fell to reference identity → wrong `false`.

**Fix:** in the `binary-ops.ts` strict/loose-equality externref tag-dispatch,
box a **boolean** operand (known from the TS-level `leftIsBool`/`rightIsBool`
flags) via `__box_boolean` instead of `__box_number`, so the "both typeof
boolean → unbox i32, compare" arm fires. This is a broad fix — any standalone
`x === <boolean>` / `assert.sameValue(bool, bool)` across test262 benefits, not
just Set rows.

**Files:** `src/codegen/binary-ops.ts` (`boxOperandToExternref` helper in the
no-JS-host equality arm). No change to `typeof-delete.ts`.

## Test Results

Set/prototype standalone sweep (host-pass-but-standalone-fail rows in
`built-ins/Set/prototype/{union,intersection,difference,symmetricDifference,
isSubsetOf,isSupersetOf,isDisjointFrom,has}`): **110 → 65** (−45 fails) combined
with #2606 Bug A. The instanceof/sameValue-bool rows (`combines-*`,
`appends-new-values`, `add-not-called`, `has/returns-*-{boolean,number,string,
symbol,nan}`) now pass. Dedicated vitest:
`tests/issue-2605-2606-collections-bool-null.test.ts`.
