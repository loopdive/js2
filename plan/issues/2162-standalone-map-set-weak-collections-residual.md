---
id: 2162
title: "Standalone Map/Set/WeakMap/WeakSet conformance residual (~532 tests)"
status: in-progress
sprint: 65
created: 2026-06-15
updated: 2026-06-18
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
_weak_ (collectable) reference is not modelled — WasmGC has no weak refs, so
entries are strongly retained; a memory property, not observable (only WeakRef/
FinalizationRegistry liveness, skip-filtered, could tell). Host/gc unchanged.
**Verified** (`tests/issue-2162-standalone-weak.test.ts`, 6/6, `--target wasi`,
zero `WeakMap_*`/`WeakSet_*`/`Map_*` imports): WeakMap set+get / has / distinct
keys / overwrite / delete; WeakSet add+has / delete / chained add.

## Slice — Map/Set `keys()`/`values()` + for-of iteration (this PR)

`keys()` / `values()` and bare `for-of` over a native Map/Set now lower without
a `Map_*`/`Set_*` host import. The projection is materialized eagerly into a
**canonical externref `$Vec`** (mirroring the array `.values()`/`.keys()` path,
`array-methods.ts`): a new `emitCollectionIteratorVec` (map-runtime.ts) walks the
entries vector once, sizing the result to `liveCount` and skipping tombstones,
and projects each live entry to its key (`keys`) or value (`values` — for a Set,
key === value). The for-of array fast path then drives it, so `for (const v of
m.values())`, `for (const k of m.keys())`, `for (const v of set)` and `[…]`
indexing all work.

**Latent bug fixed:** the `$Map` struct's `entries` field is a ref-to-array, so
`getArrTypeIdxFromVec($Map)` returns a valid array index — which made
`arrayIteratorReceiverForForOf` misidentify a native Map/Set as a plain vec and
iterate its raw struct as garbage. `compileForOfStatement` now intercepts native
collections (`compileForOfNativeCollection`) **before** the array-receiver
detection.

`Set.forEach` (the shared `tryCompileNativeCollectionForEach` helper, previously
only wired for Map) is enabled here too.

**Verified** (`tests/issue-2162-iterators.test.ts`, 7/7, `--target wasi`, zero
`Map_*`/`Set_*` imports): Map/Set `keys()`/`values()` for-of, bare Set for-of,
tombstone-skip, Set.forEach.

## Slice 3 — native Set.forEach (PR, dev-1, 2026-06-17)

`Set.prototype.forEach` produced **invalid Wasm** standalone (the call fell
through `tryCompileNativeSetMethodCall`'s `add/has/delete/clear` gate to the
generic host path). Fixed by routing `forEach` to the shared
`tryCompileNativeCollectionForEach(..., isSet=true)` — the SAME entries-vector
drive Map.forEach (#1527) already uses, which already had the `isSet` branch
(passes the value as both `value` and `key` per spec 24.2.3.6). One import + a
3-line dispatch route in `set-runtime.ts`; no new runtime helper. Verified
standalone (empty-`{}` instantiate, zero `Set_*`/`Map_*` imports): count, sum,
value===key, tombstone-skip after delete, insertion order, empty-set no-op.
Test: `tests/issue-2162-set-foreach.test.ts` (6/6).

## Slice 4 — `new Set([...])` / `new Map([[k,v],...])` from array literal (PR, dev-1, 2026-06-17)

The constructor-from-iterable forms fell through to the host path:
`new Set([1,2,3])` leaked `env.*` imports, `new Map([[1,10]])` was a hard
"Unsupported new expression". Fixed in `new-super.ts` for the **array-literal**
argument (the dominant iterable form): build the empty `$Map` (`__map_new`),
then seed element-by-element — each Set element via `__set_add` (dedups through
the shared insert), each Map `[k,v]` pair via `__map_set`. Keys/values boxed via
`coerceMapKeyToAnyref`; the no-arg forms are unchanged. A non-array-literal
iterable (spread, a variable, a non-pair Map element) still falls back to the
empty collection (the general iterator drive is the remaining slice below).
Verified standalone (empty-`{}` instantiate, zero `Set_*`/`Map_*` imports): seed
+ size, dedup, has(), empty literal, seeded-forEach, Map pair overwrite, no-arg
control. Test: `tests/issue-2162-collection-from-array.test.ts` (10/10).

### Remaining slices (issue stays in-progress)

- ~~**`entries()` `[k, v]`-pair iteration**~~ — **done** in the entries-for-of
  slice below.
- **value/key/entries SPREAD** (`[...set]`, `[...map.values()]`,
  `[...map.entries()]`) — the array-spread consumer reads the canonical externref
  vec but stores into a scalar-typed array (externref↔f64 mismatch ⇒ invalid
  Wasm). A separate spread-consumer slice; the for-of path is unaffected.
- `new Map(iterable)` / `new Set(iterable)` over a NON-literal iterable — needs
  the general iterator drive (Slice 4 from-array covers only array literals).
- ES2025 set-algebra: `union`/`intersection`/`difference`/
  `symmetricDifference`/`isSubsetOf`/`isSupersetOf`/`isDisjointFrom` — **done**
  (see the set-algebra slice).
- The `Set === literal` / collection-of-`any` comparison confounds depend on the
  value-rep work (#2104/#2106), out of scope here.

## Slice — native Map/Set `entries()` `[k, v]` for-of (PR, dev cs-2163, 2026-06-18)

`for (const [k, v] of map.entries())` and the bare `for (const [k, v] of map)`
(Map default → entries) — plus the Set `[v, v]` form — now iterate host-import-
free standalone. Previously the bare-Map for-of CE'd ("element is not an array
type"); routing it through the `$ObjVec` pair projection + generic `[k, v]`
destructuring leaked `__array_from_iter_n` / `__get_undefined` / `__extern_get`
(the pair element was read via the host extern-index arm).

**Fix** — new `compileForOfNativeMapEntries` (`src/codegen/statements/loops.ts`):
a dedicated native walk over the `$Map` entries vector that binds the STORED
key/value DIRECTLY into the `[k, v]` targets per live entry (skipping tombstones)
— no intermediate pair object, no host import. It mirrors
`tryCompileNativeCollectionForEach`'s tombstone-skipping entry walk (cursor
advanced before the body so a `continue`/tombstone-skip never re-reads a slot)
and `compileForOfArray`'s block/loop/body-block break/continue depth
bookkeeping. Entry fields are externalized (`extern.convert_any`) then coerced to
the bound local's type via the shared `coercionInstrs` (numeric key → f64, string
→ native string ref, etc.). The `$Map`/`$MapEntry` field layout is exported from
`map-runtime.ts` as `MAP_LAYOUT` so the driver doesn't re-derive the constants.
`compileForOfNativeCollection` now dispatches the `entries` kind here (the
non-`[k,v]` shapes — single-identifier binding, holes, rest, assignment targets —
fall back to the generic path). Gated on `ctx.nativeStrings`; host/gc unchanged
(verified host Map entries for-of still returns the same value).

**Verified** (`tests/issue-2162-entries-foreach.test.ts`, 9/9, `target:
standalone`, ZERO host imports): explicit `.entries()` and bare-Map `[k, v]`
for-of, Set `[v, v]` entries, numeric + string keys, tombstone-skip after delete,
insertion order, `break`, `continue`, empty collection. tsc + lint +
format:check clean; all prior #2162 standalone suites (iterators, set-foreach,
collection-from-array, set-algebra, standalone-set, standalone-weak,
weak-mapHelpers-shift = 50 tests) unaffected.

## Slice — ES2025 Set set-algebra (PR, dev-1, 2026-06-17)

All 7 ES2025 Set set-algebra methods are now Wasm-native standalone/WASI (they
leaked `Set_*` host imports before). New `src/codegen/set-algebra.ts`:
`union`/`intersection`/`difference`/`symmetricDifference` return a new Set;
`isSubsetOf`/`isSupersetOf`/`isDisjointFrom` return a boolean. Each builds on the
shared `$Map` backing store — walk one operand's entries vector (the same
insertion-ordered, tombstone-skipping walk `forEach`/`__map_iter_next` use) and
consult the other via `__map_has`, accumulating into a fresh Set (`__map_new` +
`__set_add`) or an i32 flag. Dispatched from `extern.ts` when BOTH the receiver
and the single argument type as `Set` (a genuine Set `b`; a Set-LIKE arg / the
GetSetRecord path is a follow-up). No host import, no iterator object.

Verified standalone (empty-`{}`/wasi, zero `Set_*`/`Map_*` imports): all 7 ops,
true+false predicate cases, content checks, dedup. Test:
`tests/issue-2162-set-algebra.test.ts` (10/10, operands built via `.add()` so the
slice is independent of the `new Set([...])` constructor slice). tsc + prettier
clean; Set Slice-1 unaffected.

## Slice — WeakMap/WeakSet stale-`mapHelpers`-index fix (PR, dev-mech1, 2026-06-17)

Standalone WeakMap/WeakSet **construction + methods already existed** upstream
(`new WeakMap()`/`new WeakSet()` → `__map_new`; get/set/has/delete/add via
`tryCompileNativeWeakMethodCall`, reusing the `$Map` backing store). But on the
`standalone:true, nativeStrings:true` path they emitted **invalid Wasm**: e.g.
`wm.has(k)` validated-failed with `if[0] expected i32, found call of anyref`.

**Root cause** (not weak-specific — a latent bug in the function-index shift
machinery): `shiftLateImportIndices` (`expressions/late-imports.ts`) and the two
`addUnionImports` shift sites (`index.ts`) keep `funcMap` / `nativeStrHelpers`
(#1677) / `nativeRegexHelpers` (#1913) in lockstep with the defined-function
shift, but **never shifted `ctx.mapHelpers`**. So when a late import
(`__box_number`, pulled in to coerce a numeric key/value) lands BETWEEN a
map-helper's registration and its `call` site, every defined function moves up by
`added` but the `mapHelpers` entries stay stale-low — `wm.has` then emits a
`call` to `__map_get` (the function one slot lower, returning `anyref` where an
`i32` boolean was expected) → invalid Wasm. WeakMap exposed it because its first
method call is often the first `__box_number` trigger; plain Map/Set hit the same
window whenever a numeric key/value forces a late box. `--target wasi` dodged it
(box helpers import eagerly), which is why the wasi-compiled
`issue-2162-standalone-weak` suite passed before.

**Fix** (mirrors #1677/#1913 exactly): add a `mapHelpers` lockstep shift at all
three shift sites. After the fix, all weak methods produce valid Wasm and correct
runtime values (get=42, has/miss/delete correct, add/has/delete correct).

Tests: `tests/issue-2162-weak-mapHelpers-shift.test.ts` (5/5) — compiles each
WeakMap/WeakSet/Map case `standalone+nativeStrings` and asserts valid Wasm; the
assertion is `false` without the three-site fix (verified by reverting). tsc
clean; existing Map/Set/Weak standalone suites (34) + shift-sensitive #2131 +
foreach/algebra (29) unaffected.

## Slice — `new Set(nonLiteralArray)` constructor (PR, dev-carla, 2026-06-21)

The prior from-array slice seeded `new Set([1,2,3])` only from an array
**literal**; a non-literal array-typed argument (`new Set(arr)` where `arr` is a
variable / call result) fell through to the host path and **leaked env imports**
(`env: module is not an object or function` on instantiate). Now seeded
host-import-free.

**Fix** — `seedNativeSetFromArrayArg` (`src/codegen/expressions/new-super.ts`):
when the single `new Set(...)` argument is a checker-confirmed array/tuple type
(`isArrayTypedArg`) that is NOT an array literal, compile it to its `$Vec`
(`{length: i32, data: (ref $arr)}`), then emit a counted Wasm `block`/`loop` that
walks `data[i]`, boxes each element to anyref via the existing
`coerceMapKeyToAnyref` (spliced into the loop body), and calls `__set_add`. The
element `array.get` uses the per-kind sign-extension (`array.get_u`/`_s` for
packed i8/i16). On a non-vec / unsupported-element arg the helper gracefully
leaves the empty Set on the stack — never a host-import leak or CE. Gated on
`ctx.nativeStrings`; gc/host mode untouched.

**Verified** (`tests/issue-2162-nonliteral-set-ctor.test.ts`, 7/7, `target:
wasi`, ZERO `Set_*`/`Map_*` imports): numeric-array-variable seed + dedup,
membership hit/miss, string-array seed + dedup, function-returned-array seed, and
the no-arg + array-literal forms unaffected. tsc + prettier clean; all prior
#2162 standalone suites (23 across set/iterators/collection-from-array) green.

**Still open (this slice's siblings):** `new Map(pairsVariable)` — the inner
`[K,V]` pair lowers to a typed tuple *struct* (`$__tuple_<n>`), not an inner vec,
so its extraction is a distinct shape (per-field `struct.get`, varying field
types) and falls through to an empty Map for now. `[...collection]`
spread-of-Set/Map and `new Set(iterableNonArray)` (general iterator drive) also
remain.
