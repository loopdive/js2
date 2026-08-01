---
id: 2622
title: "Standalone native `class X extends Set/Map/WeakMap/WeakSet` subclass — construction + [[SetData]] algebra + iteration + instanceof"
status: backlog
updated: 2026-07-17
model: fable
fable_role: spec
sprint: Backlog
created: 2026-06-22
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: collections
language_feature: Set, Map, class
goal: standalone-mode
model: fable
fable_role: spec
parent: 2162
depends_on: 2620
---

# #2622 — Native subclass of a native-collection builtin (standalone)

Substrate follow-up split from **#2620**. #2620 landed the safe index-shift-lane
fix: a standalone subclass of a native-collection builtin
(`Set`/`Map`/`WeakMap`/`WeakSet`) is now a **clean compile error** (no
host-import leak, no invalid Wasm). This issue is the real feature — make such a
subclass *work* natively so the conformance rows pass.

## Problem

`class MySet extends Set {}` (and Map/WeakMap/WeakSet) under `--target
standalone`/`wasi` is currently refused (#2620). The base collections are served
by the WasmGC-native `$Map` runtime (#1103a/#2162), but a *subclass* has no
native path: the generic host-constructible subclass machinery
(`BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`) lowers `new`/`super` to the host
`__new_<Name>` import, which standalone cannot satisfy.

## Acceptance criteria (the rows)

`test/built-ins/Set/prototype/{union,intersection,difference,symmetricDifference,
isSubsetOf,isSupersetOf,isDisjointFrom}/subclass-receiver-methods.js` (~7 rows).
Each constructs `class MySet extends Set { size(){…} has(){…} keys(){…} }`,
`const s1 = new MySet([1,2])`, then e.g. `s1.union(s2)` and asserts:

- `[...combined]` spreads the right elements (native iteration over the result);
- `combined instanceof Set === true` and `combined instanceof MySet === false`
  (the result is a base Set, not the subclass);
- `sizeCount === hasCount === keysCount === 0` — the set-algebra methods read the
  internal `[[SetData]]` slot directly and MUST NOT call the subclass's
  overridden `size`/`has`/`keys`.

## Direction

- Route `class X extends Set/Map/WeakMap/WeakSet` under `nativeStrings` to a
  native `$Map`-backed instance (the way base `new Set([...])` is intercepted in
  `new-super.ts`), instead of the host-constructible path. The subclass instance
  needs the `$Map` backing PLUS room for the subclass's own fields (a hybrid
  struct, or a `$Map`-carrying field on the user struct).
- `super.size`/`super.has`/`super.add`/`super.keys` in subclass methods → native
  `__map_*`/`__set_*` helpers (not the host externClass dispatch).
- Set-algebra methods on the subclass receiver read `[[SetData]]` directly
  (never the overridden methods — the conformance assertion).
- `instanceof` discrimination: `combined instanceof Set` true,
  `instanceof MySet` false (the algebra methods return a base Set).
- Remove the #2620 refusal (`isNativeCollectionBuiltin` guard in
  `class-bodies.ts`) once this lands.

## Lane

Value-rep / collection-runtime substrate (#2162 / #2580 M2). Index-shift-sensitive
and broad-impact — validate via merge_group / full local-ci, not a scoped sweep.

## Implementation Plan (Fable, 2026-07-18) — composes with the #2917 real-backing authority (PR #3324)

### Design authority this must follow

#2917's merged design decision is **REAL native backing, NOT a wrapper
struct** — a subclass instance IS the parent's backing value, because (a)
`instanceof` is a native `ref.test` on the real backing (Slice A, #2916), (b)
parent prototype methods brand-check the real backing, (c) the standalone
floor watches `ref.eq` identity. #2622 follows the same rule with one
refinement `$Map` uniquely affords (below). Also inherited from PR #3324:
the shared `resolveStandaloneBuiltinSuperCtorIdx` dispatch ladder (both
`class-bodies.ts` sites) and the **per-arity `__new_X@N` registration** rule
(the latent forwarder mis-call fix — any new allocator here MUST register
per-arity).

### Instance representation — `$MapSub`, a branded SUBTYPE of `$Map` (not a wrapper, not a bare backing)

`$Map` is our OWN struct (`map-runtime.ts:130`:
`{ buckets; entries; entryCount; liveCount; … kind(M_KIND) }`, with the #3171
`kind` stamp discriminating Map/Set/WeakMap/WeakSet), and its layout comment
already guarantees append-stability. So unlike Array (where the `$Vec` family
is shared with literals and a subtype would fork the whole element-typed
family), the collection subclass CAN have the best of both worlds:

```
$MapSub <: $Map { …$Map fields…, (field $classId i32), (field $props (ref null $PropsHash)) }
```

- **It IS a real `$Map`**: every native (`__map_get/set/has`, the set-algebra
  bodies in `set-algebra.ts`/`collections-es2025.ts`, the for-of iteration
  arms, the #3172 brand checks, Slice-A `ref.test ctx.mapTypeIdx`
  `instanceof`) accepts it unchanged — subtype passes every
  `ref.test`/`ref.cast $Map`. No unwrap shims anywhere (#2917 rationale 2
  satisfied).
- **`$classId`** = the user-class id (the `$Error_struct.$userClassId`
  precedent, which #2917 noted "does not generalize without a slot" — `$Map`
  can afford the slot, so here it DOES generalize). Gives
  `s1 instanceof MySet` a truthful dynamic answer via #2916 Slice-B arm 2's
  fast pre-check, and sibling discrimination.
- **`$props`** = the Error-family sidecar pattern for subclass OWN FIELDS
  (`this.count = 0` in the subclass ctor). The #2917 "own fields silently
  dropped" accepted-cost does NOT apply here — collections get real own
  fields. `externrefBackedOwnFieldBacking()` (the PR #3324 router) gains a
  collection-ancestry arm: `ref.test $MapSub` → `$props` sidecar (the exact
  Error-family mechanics).

### Construction

1. New allocator `__map_new_sub(kind: i32, classId: i32) -> (ref $MapSub)`
   beside `__map_new` (`map-runtime.ts`), registered per-arity via the shared
   ladder (`resolveStandaloneBuiltinSuperCtorIdx` gains the
   Set/Map/WeakMap/WeakSet row).
2. `class MySet extends Set` ctor lowering (`class-bodies.ts` — remove the
   #2620 refusal at `:617` LAST, after everything below works):
   `super(iterable?)` → `__map_new_sub(SET_KIND, classId)` + the SAME
   iterable-seeding loop the base `new Set([...])` interception uses
   (`new-super.ts` — extract the seeding into a shared helper rather than
   duplicating; it must handle the vec-literal fast shape AND the dynamic
   iterable shape identically to base construction).
3. Implicit-forwarder subclasses (`class A extends Set {}` with no ctor) ride
   the same allocator through the per-arity forwarder machinery.

### The conformance semantics the rows assert (and why they fall out)

`subclass-receiver-methods.js` (union/intersection/difference/
symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom, ~7 rows):

- **Overridden `size`/`has`/`keys` are NOT called** (`sizeCount === 0` …):
  automatic — the native set-algebra bodies read `[[SetData]]` directly off
  the `$Map` fields (`entries`/`liveCount`), never dispatching through
  user-visible properties. No work needed; add the counter assertion to the
  test to LOCK it.
- **Result is a base Set** (`combined instanceof Set === true`,
  `instanceof MySet === false`): the algebra bodies allocate their result via
  `__map_new` (base), not the receiver's type — verify each body allocates
  base (grep the result-allocation site per method) and add the discrimination
  assertion. With `$MapSub` + #2916 arm 2, `instanceof MySet` answers false
  truthfully (result has no `$classId`).
- **`[...combined]` spreads natively**: the iteration arms ref.test `$Map` —
  passes for both base and sub.
- **`this`-arg brand checks** (#3172 `require-internal-slot`): a `$MapSub`
  receiver passes `ref.test $Map` + `kind` check — correct per spec (the
  subclass HAS the internal slot).

### Method dispatch on the subclass receiver

- Statically-typed receivers (`s1.union(s2)` with `s1: MySet`): the call site
  resolves members through the class shape; **inherited** collection methods
  route to the native `$Map` ops (the `super.add`-style routing in the
  Direction section — via the native helpers, NOT host externClass dispatch);
  **own** subclass methods dispatch as ordinary class methods (the class
  registry knows `MySet`; the receiver ValType is the `$MapSub` ref).
- Dynamic (`any`) receivers: the member-get/set dispatchers'
  collection arms already ref.test `$Map`; add a front `ref.test $MapSub` arm
  ONLY for own-field/own-method names (children-first ordering, the #2963
  method-arm discipline).

### Edge cases

- `WeakMap`/`WeakSet` subclasses: same struct/kind machinery; keep the weak
  semantics caveats of the base runtime (no new guarantees).
- `Symbol.species` is NOT consulted by the ES2025 set-algebra methods (they
  always construct base Sets per spec §24.2.4) — no species machinery needed;
  record this so nobody adds it.
- Multi-level (`class B extends MySet`): `classId` = the most-derived class;
  the per-arity forwarder chain (PR #3324 fix 2) already threads args.
- Cross-collection misuse (`Map.prototype.get.call(mySetSub)`): the #3171
  `kind` stamp still throws TypeError — subtype carries the right kind.
- gc/host lanes: byte-identical (all arms `ctx.standalone || ctx.wasi`
  gated); the host path keeps `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`.

### Ordering / slices

1. **S1 (M)**: `$MapSub` type + `__map_new_sub` + ctor/forwarder lowering +
   own-field sidecar routing + remove the #2620 refusal. Rows: construction +
   `[...new MySet([1,2])]`.
2. **S2 (S–M)**: algebra-result base-allocation verification + the 7
   acceptance rows + dynamic-receiver arms + instanceof discrimination
   (needs #2916 B0/arm-2 for the truthful `instanceof MySet`; before that,
   assert only the `instanceof Set === true` half).
3. Validate on full `merge_group` (index-shift-sensitive + representation
   change; the Lane note's discipline stands).

## Implementation plan (2026-07-31, traced against `main`)

Verified substrate facts this plan rests on:

- `$Map` is `struct { buckets, entries, entryCount(mut), liveCount(mut),
  kind(imm i32) }` (`map-runtime.ts` `ensureMapRuntimeTypes`). It declares **no
  `superTypeIdx`**, i.e. it is currently FINAL.
- Set reuses the Map backing store — `__map_new` yields the `$Map` a Set wraps,
  branded by the trailing immutable `kind` field (`COLLECTION_KIND`, #3171).
- The native interception is gated on a literal constructor-NAME match:
  `ctx.nativeStrings && ts.isIdentifier(expr.expression) && expr.expression.text === "Map"`
  (`new-super.ts:3033`, and the `"Set"` twin at :3088). `new MySet()` cannot
  match it, which is the ENTIRE reason a subclass falls to the host path.
- #2605 (`x instanceof Set/Map/...` for native collections) is **done** and
  keys off the `kind` brand — so the instanceof half of this issue's acceptance
  criteria already has a working mechanism to extend.

### Design: WasmGC subtyping, not composition

Declare the subclass struct as a **subtype of `$Map`** with its own fields
appended:

    $MySet <: $Map   fields: [ ...$Map's 5 ..., ownField0, ownField1, … ]

This is the load-bearing choice. `ref $MySet` is then a subtype of `ref $Map`,
so **every existing `__map_*` / `__set_*` helper accepts a subclass instance
unchanged** — no unwrapping at call sites, no per-method shim, no second
representation to keep in sync. Composition (`$MySet { map: ref $Map, … }`)
would require touching every helper call site and is rejected for that reason.

Steps:

1. **Make `$Map` extensible.** Set `superTypeIdx = -1` ("sub with no super")
   when a subclass is present — the same marking `class-bodies.ts` already
   applies to user parent structs. Check `MAP_LAYOUT` consumers first: the
   `kind` field is documented as *trailing + immutable*, and subtype fields
   append AFTER it, so any code assuming "kind is the last field" must move to
   "kind is at index `M_KIND`" (it already is, via `MAP_LAYOUT`).
2. **Widen the interception predicate.** Replace the `text === "Map"` /
   `=== "Set"` name equality with "this constructor resolves to the Map/Set
   builtin, directly or through a subclass chain" — `ctx.classParentMap` +
   `isNativeCollectionBuiltin` already give the chain walk (#2620 uses it).
   Emit `struct.new $MySet` with the `$Map` prefix initialised exactly as
   `__map_new` does (same buckets/entries allocation, same `kind` brand), then
   the subclass's own field initialisers.
3. **Drop the #2620 standalone refusal** for the now-supported shapes, keeping
   it as the fallback for anything the native path still cannot build.
4. **`instanceof` discrimination.** `x instanceof Set` follows from the `kind`
   brand (#2605, done). `x instanceof MySet` needs the subclass struct identity
   — `ref.test $MySet` — which subtyping gives directly.
5. **Own methods.** These stop being a problem for free: with the instance a
   real `$MySet` struct, the struct `this` parameter that `class-bodies.ts`
   already emits is CORRECT, so the pinned gc/host defect (see #2620's
   correction section — `this.<inherited>()` dropped because self was a struct
   the host instance could never satisfy) does not arise on this path.

### Acceptance beyond the 7 rows

The `subclass-receiver-methods.js` rows assert `union` reads `[[SetData]]`
directly (`sizeCount/hasCount/keysCount === 0`), which the subtyping design
satisfies by construction: the set-algebra helpers walk the `$Map` prefix and
never dispatch through the subclass's overridden methods.

### Explicitly NOT in scope

Narrow typing of the entries. `$MapEntry` is `{key: anyref, value: anyref,
next: i32, hash: i32}`, so a `Map<string, number>` boxes every value. That is a
separate slice — it benefits BASE collections too, and #3921's acorn allocation
census measured `$AnyValue` boxing at **48% of all allocations** (310,485 boxes,
~7.4 per token), which is the same representation question at much larger
scale. Fold it in and neither lands. Note also that #1103's original design
specified per-key-type compiled hash functions; what shipped hashes by RUNTIME
type dispatch (`__obj_hash` `ref.test`-ing `$HashedString`, plus #3673's cached
FNV-1a). Compile-time hash specialisation is a further, smaller slice on top.

## Implementation attempt 1 (2026-08-01) — design CONFIRMED, blocked on an unidentified body-rewrite

Attempted end-to-end on `--target standalone`. **Reverted; the tree is back to
#2620's clean refusal.** The WIP diff is not committed — it is reproducible from
the four steps below, which are worth having because two of the plan's
assumptions are now *measured* rather than assumed.

### CONFIRMED — the subtyping design works

`$Sub <: $Map` is declared correctly and the field types line up, verified by
reading the emitted WAT:

```wat
(type $Map   (sub          (struct (field $buckets (mut (ref null 46))) … (field $kind i32))))
(type $MySet (sub final $type47 (struct (field $buckets (mut (ref null 46))) … (field $kind i32))))
```

`$type47` IS `$Map`. So `ref $MySet` is a subtype of `ref $Map` and the
`__map_*` helpers accept a subclass instance unchanged — the load-bearing claim
of the plan above, now demonstrated rather than argued.

### The real reason `parentStructTypeIdx` was undefined

Not "Map has no struct" — `ensureMapRuntimeTypes` DOES `structMap.set("Map", …)`.
The collection types are created **lazily**, so at class-collection time nothing
has touched a Map yet and the lookup simply misses. Calling
`ensureMapRuntimeTypes(ctx)` at the #2620 gate fixes it and is safe: it is
idempotent (`if (ctx.mapTypeIdx >= 0) return`) and registers **types only** — the
helper FUNCTIONS come from the separate `ensureMapHelpers`, so it cannot pull
runtime code into a module that never uses a collection.

`structFields` is NOT populated for `"Map"`, so the parent field list must be
read off `(ctx.mod.types[ctx.mapTypeIdx] as StructTypeDef).fields`.

### Steps that worked

1. At the #2620 gate: `ensureMapRuntimeTypes(ctx)`, then
   `parentStructTypeIdx = ctx.mapTypeIdx` and `parentFields` from the type def.
   Fall through to the ordinary struct-subclass path. (~15 lines.)
2. Export `INIT_CAP` from `map-runtime.ts`.
3. In the `splitInit` constructor emission (`class-bodies.ts`, the
   `newBody` loop), emit a `__map_new`-equivalent prefix for the five inherited
   fields instead of the generic zero/null defaults — `array.new` buckets filled
   with -1 at INIT_CAP, `array.new_default` entries, two zero counts, and the
   parent's COLLECTION_KIND brand — then let the loop default the subclass's OWN
   fields via `fields.slice(5)`.
4. Identify the class via `ctx.classParentMap` + `isNativeCollectionBuiltin`
   (walking the chain, so `class B extends A extends Set` works). **No new ctx
   state is needed** — the plan's implied `classNativeCollectionParent` map is
   unnecessary.

### THE BLOCKER — something rewrites the constructor body after it is assigned

`MySet_new`'s body is **correct at the moment it is assigned**, logged directly:

```
i32.const:-1 i32.const:8 array.new i32.const:8 array.new_default
i32.const:0 i32.const:0 i32.const:1 struct.new local.set local.get return_call
```

Five operands for a five-field struct. But the EMITTED body carries two extra
`i32.const 0` immediately before `struct.new`, so field 0 receives an i32 and the
module fails to validate:

```
MySet_new failed: struct.new[0] expected type (ref null 46), found i32.const of type i32
```

Ruled out by instrumenting each and observing that **neither fires** for this
compile:

- `patchStructNewForAddedField` (`expressions/late-imports.ts`) — the
  add-a-field-late patcher.
- `patchStructNewWithShapeId` (`struct-field-exports.ts`, #2009) — the `$shape`
  retro-stamp. `collidingTypeIdxs` is empty, so it returns before patching.

The emitted `$MySet` type still has exactly five fields, so whatever inserts the
two operands did **not** correspondingly extend the type — the two are out of
sync, which is the actual defect to find. Next step for whoever picks this up:
dump `ctx.mod.functions` for `MySet_new` immediately before emit and bisect the
passes between constructor assignment and encoding, rather than guessing at
splice sites (three guesses were wrong here).

### Note

Removing the #2620 refusal without completing this makes
`class X extends Set {}` emit **invalid Wasm** instead of a clean compile error —
strictly worse, and a direct violation of the #1888 dual-mode invariant the
refusal exists to uphold. Keep the refusal in place until construction validates.
