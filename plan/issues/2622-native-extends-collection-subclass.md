---
id: 2622
title: "Standalone native `class X extends Set/Map/WeakMap/WeakSet` subclass — construction + [[SetData]] algebra + iteration + instanceof"
status: backlog
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
