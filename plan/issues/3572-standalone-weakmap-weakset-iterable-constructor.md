---
id: 3572
title: "standalone: native WeakMap/WeakSet iterable constructor (host-leak wiring gap)"
status: done
completed: 2026-07-24
created: 2026-07-24
updated: 2026-07-24
priority: high
feasibility: medium
task_type: conformance
area: codegen
language_feature: collections
goal: standalone
sprint: 76
horizon: s
assignee: ttraenkler/dev-mapset-opus
parent: 2162
related: [1103, 2162]
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
---

# standalone: native WeakMap/WeakSet iterable constructor (host-leak wiring gap)

## Problem

`new WeakMap()` / `new WeakSet()` route to the native weak-collection runtime
under `--target standalone` (#2162), but **only the no-arg form**. The iterable
constructor forms — `new WeakSet([o1, o2])`, `new WeakMap([[k, v], …])`,
`new WeakSet(null)`, `new WeakSet(undefined)`, `new WeakSet([])` — fell through
to the generic externClass constructor, which emits a `WeakSet_new` /
`WeakMap_new` host import a pure-Wasm engine can't satisfy → `compile_error`
under standalone.

The code even flagged it: `new-super.ts` said *"No-arg form only; the iterable
form falls through."*

## Measured evidence (2026-07-24, `--target standalone`, real test262 runner)

Baseline (current main, before fix), WeakMap/WeakSet families:

| family  | pass | fail | CE |
| ------- | ---- | ---- | -- |
| WeakMap | 95   | 23   | 23 |
| WeakSet | 58   | 14   | 13 |

Of the 36 host-leak CE: 23 array-literal ctor + 2 null/undefined ctor + 11 that
need the general iterator protocol (deliberate `iterator-*-failure` side-effect
tests — out of scope for a seeding fast path).

## Fix

Generalise the WeakMap/WeakSet native-ctor branch in
`src/codegen/expressions/new-super.ts` to mirror the existing
`new Set([…])` / `new Map([[k,v],…])` native seeding:

- no-arg / `null` / `undefined` → empty branded collection (all spec-empty);
- array LITERAL → seed (WeakSet elements via `__weakset_add`; WeakMap
  `[key,value]` pairs via `__map_set`);
- (WeakSet only) a non-literal array-typed arg → runtime vec walk
  (`seedNativeSetFromArrayArg`).

Other forms (general iterator with observable protocol steps) still fall
through — but no longer leak, and are the documented follow-up slice.

Gated on `ctx.nativeStrings` — host (gc) mode is untouched.

## Measured flip (same runner, after fix — 0 regressions)

| family  | Δpass | Δfail | ΔCE  |
| ------- | ----- | ----- | ---- |
| WeakMap | +11   | +4    | −15  |
| WeakSet | +7    | +2    | −9   |
| **sum** | **+18** | +6  | −24  |

**+18 host-free passes, 0 pass→non-pass regressions** (verified per-file). All
18 flips are `reached_test=true`, `vacuous=false` (de-inflated, real). The +6
`fail` and the residual CE are CE→fail moves on the iterator-protocol
side-effect tests (neutral for `host_free_pass`). Honest caveat: ~4 of the 18
(`add-not-callable-throws`, `get-add-method-failure`, `set-not-callable-throws`,
`get-set-method-failure`) pass partly because a *separate* standalone quirk
(assigning to a native builtin prototype throws) coincidentally satisfies the
expected `TypeError`; the other ~14 are clean seeding flips. Net is strictly
positive either way.

## Acceptance criteria

- [x] `new WeakSet([…])` / `new WeakMap([[k,v],…])` / `new WeakSet(null|undefined)`
  compile host-import-free under standalone (no `WeakSet_new`/`WeakMap_new`).
- [x] Seeded entries are readable via `has`/`get`/`delete`.
- [x] No-arg form unaffected; host (gc) mode unaffected.
- [x] Net non-negative standalone flip, measured on the real runner.

## Notes

Parent (done): #2162. Discovered while measuring the standalone
Map/Set/WeakMap/WeakSet/Symbol lane (2026-07-24). The dominant remaining lane
blocker — `Function.prototype.call/apply/bind` on builtin methods (uncurryThis /
propertyHelper) — is filed separately as substrate #3571.
