---
id: 2863
title: "Standalone: dynamic-shape object/property ops refused — __get_builtin (reflective builtin/namespace read), __extern_toLocaleString, __object_groupBy/fromEntries"
status: done
completed: 2026-07-01
created: 2026-06-30
updated: 2026-07-01
priority: high
feasibility: medium
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2860, 1472, 2861]
umbrella: 2860
---

# Standalone: dynamic-shape object/property operations refused

## Problem

`--target standalone` refuses several dynamic-shape object/property operations
with:

```
Codegen error: '<op>' (dynamic-shape object/property operation) is not yet
supported in --target standalone (#1472 Phase B).
```

### Impact (measured 2026-06-30) — 365 standalone-only failures (all CE)

| op                        | tests | meaning                                                                    |
| ------------------------- | ----- | -------------------------------------------------------------------------- |
| `__get_builtin`           | 314   | reflective read of a built-in/namespace member that missed every fast path |
| `__extern_toLocaleString` | 34    | `.toLocaleString()` on a dynamic receiver                                  |
| `__object_groupBy`        | 10    | `Object.groupBy`                                                           |
| `__object_fromEntries`    | 7     | `Object.fromEntries`                                                       |

## Root cause

`refuseStandaloneObjectImport` (`src/codegen/expressions/late-imports.ts:85`,
list at lines 56-75) hard-refuses these `__*` imports under standalone. They are
the host-mode dynamic fallbacks that have no Wasm-native carrier yet.

`__get_builtin` dominates: it is the generic fallback emitted by
`compileMemberRead` when a property access resolves to a built-in **by name at
runtime** and no fast path / native-proto glue matched (see
`property-access.ts:170-186, 382-386`). A large share of the 314 are
**namespace static reads** — `Math.PI`/`Math.LN2`, `JSON.stringify`,
`Reflect.get`, `Atomics.add` — and reflective `obj[computedName]` against a
built-in. This overlaps with the namespace-static-read follow-on noted in
umbrella #2860 and with #2861.

## Implementation Plan

### Phase 1 — namespace static reads (the bulk of `__get_builtin`)

**File: `src/codegen/property-access.ts`** (`compileMemberRead` / the
`__get_builtin` shortcut site, ~line 382)

- For `Math`/`JSON`/`Reflect`/`Atomics`/`Number`/`Symbol` **namespace** members
  with a statically-known property name:
  - **Data constants** (`Math.PI`, `Math.E`, `Math.LN2`, `Number.MAX_SAFE_INTEGER`,
    `Symbol.iterator`/well-knowns): emit the constant value directly (f64 const,
    or the interned well-known symbol). `Math.PI` etc. already have an exclusion
    note at property-access.ts:382 — extend it to emit the value rather than
    refuse.
  - **Static methods** (`JSON.stringify`, `Reflect.get`, `Math.max`): emit a
    native static-method closure (reuse the `ensureStandaloneBuiltinStaticMethodClosure`
    factory, property-access.ts:686 / the #2175 `"static"` path).

### Phase 2 — `__extern_toLocaleString`

- Route `.toLocaleString()` on a dynamic receiver to the receiver's
  `.toString()` native path (per spec the default `Object.prototype.toLocaleString`
  calls `toString`); for Number/Array/Date use the existing native toString.

### Phase 3 — `Object.groupBy` / `Object.fromEntries`

- Implement as native helpers over the `$Object` runtime + iterator protocol.
  `fromEntries` depends on the iterator carrier — sequence AFTER #2864 if it
  needs generic iteration; the common `Object.fromEntries(array)` case can use
  the `$__vec_base` fast path now.

### Edge cases

- A genuinely dynamic `obj[expr]` where `obj` is user-typed must keep routing to
  the typed struct.get fast path, not `__get_builtin` (unchanged).
- Shadowed namespace identifiers (`const Math = …`) → keep refusing / route to
  the local (guard like property-access.ts:819).

## Test plan

Standalone CE → pass:

- `test/built-ins/Math/**` (PI/LN2/E value reads, max/min static methods)
- `test/built-ins/Atomics/**`, `test/built-ins/JSON/**`, `test/built-ins/Reflect/**`
- `test/built-ins/TypedArray/prototype/toLocaleString/**`
- `test/built-ins/Object/{groupBy,fromEntries}/**`

Full `merge_group` + standalone high-water; zero host-mode regression
(`ctx.standalone`-gated).

## Progress (2026-06-30)

- **Phase 2 (`__extern_toLocaleString`) — DONE** (this slice). Array/TypedArray
  receivers route to the native comma-join (shared with `toString`, gated to
  standalone/wasi in `array-methods.ts`); generic dynamic receivers route to the
  native `__extern_toString` (`expressions/calls.ts`). Host (gc) mode keeps
  `__extern_toLocaleString` for real Intl. Tests:
  `tests/issue-2863-standalone-tolocalestring.test.ts`.
- **Phase 1 staleness note** — the issue's premise that namespace data constants
  (`Math.PI`/`E`/`LN2`, `Number.MAX_SAFE_INTEGER`/`EPSILON`) refuse is now
  **partly stale**: those statically-named reads already compile + fold on
  current main. The remaining Phase 1 work is the static-METHOD **value reads**
  (`JSON.stringify`/`Reflect.get` as a value), reflective `any`-typed
  `namespace[computedKey]` (currently TRAPs, not CE), and any residual
  `__get_builtin` after #2861 landed — re-measure the 314 bucket against current
  main before picking it up.
- **Phase 3 (`Object.groupBy`/`fromEntries`)** — lib-types slice DONE; native
  standalone slice delegated. Details:
  - **`Object.groupBy` lib-types — DONE (2026-07-01).** `Object.groupBy` (ES2024)
    is declared in `lib.es2024.object.d.ts`, which was missing from the checker's
    `ES_BASE_LIB_NAMES` (only `lib.es2024.collection.d.ts` — carrying
    `Map.groupBy` — was present). Every `Object.groupBy(...)` therefore failed the
    TS type-check with "Property 'groupBy' does not exist on type
    'ObjectConstructor'" → a hard CE, masking the working #965 host runtime and
    blocking all `test/built-ins/Object/groupBy/**` before codegen ran. Fix: add
    `lib.es2024.object.d.ts` (src/checker/index.ts). Measured host (gc) lane over
    `Object/groupBy` + `Map/groupBy`: was ~all-CE → now **22 pass / 6 fail** (the
    6 are pre-existing edge cases: callback receiver details, `toPropertyKey`
    ordering, invalid-callback error type — separate issues, not regressions; a
    lib addition can only move CE→pass/fail, never pass→fail). Tests:
    `tests/issue-2863-object-groupby-libtypes.test.ts`.
  - **`Object.fromEntries(array)` — already native standalone** on current main
    (the `$__vec_base` fast path); verified compiles + runs host-free.
  - **`Object.groupBy` native standalone — DELEGATED.** Standalone still (and
    correctly) refuses `__object_groupBy` pending a Wasm-native carrier; the
    generic-iterable + `__make_callback`-in-standalone machinery it needs is owned
    by #2919 (generic iterable combinators) and #2921 (standalone `__make_callback`
    leak). Boundary asserted in the test so a future native impl doesn't silently
    regress the refusal contract.
- **`__get_builtin` bucket re-measured (2026-07-01).** Static data-constant reads
  (`Math.PI` etc.) compile+fold; static-METHOD **value reads**
  (`JSON.stringify`/`Reflect.get`/`Math.max` as a value) now surface as the
  `#1907`/#2861 "built-in static property value read" refusal — **#2861's
  territory** (owned by dev-standalone), not this issue. Reflective `any`-typed
  `namespace[computedKey]` (e.g. `Math["PI"]`) compiles but reads back `0`
  (minor residual correctness gap; no longer a CE).
