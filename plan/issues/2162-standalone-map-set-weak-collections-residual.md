---
id: 2162
title: "Standalone Map/Set/WeakMap/WeakSet conformance residual (~532 tests)"
status: in-progress
sprint: 63
created: 2026-06-15
updated: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: collections
goal: standalone-mode
parent: 1103
---

# Standalone Map/Set/Weak collections conformance residual

## Problem

Wasm-native Map/Set/WeakMap collections landed in #1103 (`done`, sprint 58).
The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows
**532 tests pass in host mode but fail standalone**, attributed to the
collection types — currently **untracked/unscheduled**.

## Evidence

- Gap categories: `built-ins/Set` 286, `built-ins/Map` 148,
  `built-ins/WeakMap` 101, plus WeakSet/WeakRef/FinalizationRegistry tails.
- `Set_new` and related host-import leaks plus `(none)`-leak compile errors.

## Acceptance criteria

- Standalone pass count for Map/Set/WeakMap/WeakSet rises toward host parity.
- No collection host-import leak (e.g. `Set_new`) for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1103. Part of sprint-62 standalone catch-up (rank 7 by gap
impact).

## Triage (2026-06-16)

Probed each collection in standalone (`target: standalone`). Findings:

- **Map is already fully functional** in standalone — `new/set/get/has/
  delete/size/clear` all return correct values when the result is read into a
  typed binding. The apparent Map failures in casual probing were
  `m.get(k) === <literal>` confounds (the `any === literal` boxed-compare gap,
  owned by value-rep #2104/#2106, not Map). No Map work needed for the core
  methods.
- **Set had NO native standalone runtime** — leaked `Set_new`/`Set_add`/… host
  imports, so every Set program failed (`built-ins/Set` ≈ 286, the dominant
  slice). Same for WeakMap/WeakSet (101+).

## Slice 1 — native Set runtime (PR #1510, merged)

A Set is a Map with `value === key`, so the entire #1103a Map backing store
(ordered hash table, SameValueZero key equality, tombstone deletion) is reused.
New `src/codegen/set-runtime.ts` adds only `__set_add(m, v) = __map_set(m, v, v)`
and the dispatch interceptors; `has`/`delete`/`clear`/`size` route to `__map_*`.
Wiring mirrors Map: `new Set()` → `__map_new` (new-super.ts); methods →
`tryCompileNativeSetMethodCall` (extern.ts); `.size` →
`tryCompileNativeSetSizeGet` (property-access.ts); `Set` resolves to `ref $Map`
(index.ts); externClass skipped under `nativeStrings`. Host/gc unchanged.
**Verified** `tests/issue-2162-standalone-set.test.ts` 6/6.

## Slice 2 — native WeakMap/WeakSet runtime (this PR)

`new WeakMap()` / get/set/has/delete and `new WeakSet()` / add/has/delete now
host-import-free in standalone (~101+ tests). New
`src/codegen/weak-collections-runtime.ts` reuses the Map backing store with
**object-identity keys** (the Map runtime already compares object keys by
`ref.eq`) and adds only `__weakset_add(m,v)=__map_set(m,v,v)`; the rest route to
`__map_*`. Wiring mirrors Map/Set: `new` → `__map_new` (new-super.ts); methods →
`tryCompileNativeWeakMethodCall` (extern.ts); `WeakMap`/`WeakSet` resolve to
`ref $Map` (index.ts); externClass skipped under `nativeStrings`. Weak
collections have **no iteration and no `.size`** (spec), so none is wired. The
*weak* (collectable) reference is not modelled — WasmGC has no weak refs, so
entries are strongly retained; a memory property, not observable (only WeakRef/
FinalizationRegistry liveness, skip-filtered, could tell). Host/gc unchanged.
**Verified** (`tests/issue-2162-standalone-weak.test.ts`, 6/6, `--target wasi`,
zero `WeakMap_*`/`WeakSet_*`/`Map_*` imports): WeakMap set+get / has / distinct
keys / overwrite / delete; WeakSet add+has / delete / chained add.

### Remaining slices (issue stays in-progress)

- **Map.forEach** (PR #1527) and **Set.forEach** (follow-up) — entries-vector
  drive over the callback closure.
- `keys()`/`values()`/`entries()` + `for-of` over Map/Set — needs a JS-iterable
  iterator object; `new Map(iterable)` / `new Set(iterable)` — needs
  `__map_new_from_arr`.
- ES2025 set-algebra: `union`/`intersection`/`difference`/
  `symmetricDifference`/`isSubsetOf`/`isSupersetOf`/`isDisjointFrom`.
- The `Set === literal` / collection-of-`any` comparison confounds depend on the
  value-rep work (#2104/#2106), out of scope here.
