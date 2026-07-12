---
id: 3172
title: "standalone: Set-algebra methods (union/intersection/difference/…) set-like protocol + Map/WeakMap getOrInsert(Computed) spec semantics (120 gap tests)"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-collections-brand
created: 2026-07-12
updated: 2026-07-12
# (#3102) God-file growth allowance for THIS change-set: the implementation
# lives in the NEW subsystem module collections-es2025.ts; the residual
# growth is unavoidable wiring — getOrInsert(Computed) in the Map/WeakMap
# proto CSVs + length table (+15), and the finalize fill call for the
# reserved __setrec_field_* readers (+7).
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/index.ts
# (#2108) Coercion-vocabulary allowance: the GetSetRecord kernels are emitted
# WASM FUNCTION BODIES (runtime helpers), not compile-time call-site lowering —
# they must invoke the runtime coercion helpers (__to_primitive for the spec's
# ToNumber(size) with valueOf-once, __unbox_number for the numeric read,
# __is_truthy for ToBoolean(has(v))) by funcidx inside the kernel. The
# compile-time coercion ENGINE cannot run inside an emitted body; these are
# the same helper invocations the engine itself lowers to.
coercion-sites-allow:
  - src/codegen/collections-es2025.ts
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: collections
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 3171, 3149]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
---

# #3172 — standalone: Set-algebra set-like protocol + getOrInsert(Computed)

## Problem

**120 gap tests** (measured 2026-07-12 lane-baseline diff, method in #3169)
in the two newest collection method families:

- **Set-algebra, 69 tests**: `union` 11, `symmetricDifference` 11,
  `intersection` 11, `difference` 10, `isSupersetOf` 9, `isDisjointFrom` 9,
  `isSubsetOf` 8 under `built-ins/Set/prototype/`.
- **getOrInsert/getOrInsertComputed, 51 tests** across `Map.prototype`
  (15+9) and `WeakMap.prototype` (rest).

The native kernels EXIST (`src/codegen/set-algebra.ts` landed the algorithms;
#3149 landed `Map.groupBy`). What fails is the **spec protocol around them**,
measured as `assert.throws(TypeError, …)` rows that don't throw plus
wrong-value rows:

- GetSetRecord coercion on the argument: `size` must be read and
  `ToNumber`-coerced (`size-is-a-number.js`), `has`/`keys` must be callable,
  non-object arguments must throw `TypeError` — i.e. accepting **set-LIKE**
  arguments (a plain `{ size, has, keys }` object), not only real Sets.
- Receiver brand check (`receiver-not-set.js`) — shares the #3171 gate.
- getOrInsertComputed: callback-throw propagation, key normalization
  (`append-new-values-normalizes-zero-key.js`), insertion-order and
  re-entrancy rules; WeakMap key-validity `TypeError`s.

## ANTI-BLOAT directive

- Extend `src/codegen/set-algebra.ts` / `map-runtime.ts` /
  `weak-collections-runtime.ts` in place. The missing piece is ONE shared
  **GetSetRecord** helper (arg → {size, has, keys} with spec coercion order +
  TypeErrors) used by all 7 algebra methods — do not duplicate the coercion
  per method.
- Receiver brand checks come from #3171's shared gate — sequence with it or
  land the gate here if #3171 hasn't started (agree the boundary in the
  TaskList before both go in-progress).
- Callback invocation for `getOrInsertComputed` uses the #3098 native
  callback-dispatch substrate — no `__make_callback` reintroduction.

## Acceptance criteria

- ≥90 of the 120 measured gap tests flip to host-free standalone passes.
- Sample tests:
  - `test/built-ins/Set/prototype/intersection/receiver-not-set.js`
  - `test/built-ins/Set/prototype/isSupersetOf/size-is-a-number.js`
  - `test/built-ins/Map/prototype/getOrInsert/append-new-values-normalizes-zero-key.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, this family only.

## Test Results (2026-07-12, implementation)

Standalone lane (`TEST262_TARGET=standalone`, filter
`built-ins/{Map,Set,WeakMap,WeakSet}/prototype`) vs the post-#3171 run:

- **81 flips fail→pass, 0 regressions** (suite 478→559 of 700). All three
  acceptance samples pass (`intersection/receiver-not-set`,
  `isSupersetOf/size-is-a-number`,
  `getOrInsert/append-new-values-normalizes-zero-key`).
- **Below the ≥120-gap/≥90 bar (81)** — the residual buckets each have a
  DIFFERENT root cause than this issue's protocol layer and are separable
  slices:
  - class-getter set-likes (`allows-set-like-class`, `set-like-class-order`,
    ~14): accessor `get size()` + METHOD has/keys on closed class structs —
    needs method-as-closure minting in the `__setrec_field_*` fill;
  - `class MySubset extends Set` rows (`subclass*`, ~12): builtin-super
    construction lineage — #2917, explicitly out of scope;
  - getOrInsert value rows comparing two boxed anys via `assert.sameValue`
    (~10): the #3056 boxed-compare lane, not dispatch;
  - `set-like-array` (~7): expando `size/has/keys` on vec-backed arrays;
  - `builtins.js` (7): Object.isExtensible/toString/getPrototypeOf on the
    method VALUE (function-object meta);
  - `set-like-class-mutation` / `set-like-iter-return` (~7): re-entrant
    mutation ordering + IteratorClose — documented out of scope.
- Equivalence: `tests/issue-3172.test.ts` 34 tests; regression batch
  (#2604/#2607/#2162-set-algebra/#3171) 149/149 green. Probe 29/29.
- The 14 `has/keys-is-callable` regressions from the first measurement were
  fixed in-branch (`__setrec_check_callable` reserve-then-fill IsCallable
  gate); final run is 0-regression.

## Implementation Plan — residual buckets as independently claimable plan-lets

(arch, 2026-07-12. The protocol layer landed — PR merged as
`src/codegen/collections-es2025.ts` (1,248 lines): `reserveSetRecFieldGetters`
(the reserve fn's actual name) at :569, `fillSetRecFieldGetters` finalize fill at :613,
`__setrec_check_callable` fill at :683, `ensureSetAlgebraAnyDispatch` at
:780, `ensureGetOrInsertKernels` at :160, `compileCollectionGetOrInsert` at
:342. Each bucket below is a separate S/M slice, one PR each; all
standalone-gated, zero host-lane bytes.)

### Plan-let R1 — class-based set-likes (~14 tests, M) — `allows-set-like-class`, `set-like-class-order`

**Gap**: `__setrec_field_<size|has|keys>` (fill at collections-es2025.ts:613)
reads only DATA properties off the argument. A set-like written as
`class MySetLike { get size() {...} has(k) {...} keys() {...} }` needs (a)
accessor `get size()` invocation and (b) METHODS on a closed class struct
materialized as callable values.

**Change**: in `fillSetRecFieldGetters`'s `ref.test` arm for closed class
structs, route the read through the same accessor-aware path
`__extern_get` uses (getter descriptor → call; see the accessor arm
object-runtime.ts ~:1127), and for method members mint the method as a
closure value via `closed-method-dispatch.ts`'s method-as-value machinery
(the #3098-adjacent closed-struct dispatch — grep
`closed-method-dispatch.ts:171` comment block for the HOF callback arm
pattern). The invocation side (`__setrec_call_has`/keys-iteration) already
dispatches through `__apply_closure` — only the field READ is the gap.

**Reuse**: `__extern_get`'s accessor arm (object-runtime.ts);
`closed-method-dispatch.ts` method minting; `__apply_closure`
(reserveApplyClosure, object-runtime.ts). Do NOT add a per-class glue.

**Tests**: `Set/prototype/*/allows-set-like-class.js`,
`set-like-class-order.js` (also asserts read/call ORDER: size → has → keys,
then keys() iteration last — the fill must preserve GetSetRecord step order).

### Plan-let R2 — `set-like-array` (~7 tests, RE-SCOPED: not S, capability missing)

**Gap**: expando `size`/`has`/`keys` properties written onto a vec-backed
array (`const a = [1,2]; a.size = 2; a.has = ...`). The `__setrec_field_*`
readers miss expando fields on vec carriers.

**CORRECTION (Fable review 2026-07-12)**: the previously-cited reuse — "the
vec-expando lookup `__extern_get` already performs" — **does not exist**.
`grep expando|sidecar src/codegen/object-runtime.ts` → 0 hits, and a
measured standalone probe (`const a: any = [1,2]; a.size = 42; return
a.size`) returns **0**, not 42: expando writes on vec-backed arrays are
dropped module-wide today, independent of set-records. So R2 is NOT a
one-call fill extension; the underlying capability (a vec→prop-map sidecar
for expando reads/writes in `__extern_set`/`__extern_get`) is missing.

**Action**: re-triage — file/point these ~7 rows at a separate
"standalone expando-props-on-vec-backed-arrays" capability issue (general
`__extern_set` vec arm writing into an associated `$Object` prop map, with
`__extern_get` reading it back), and make this R2 a dependent one-call fill
extension only AFTER that lands. Do not build the sidecar inside
collections code.

### Plan-let R3 — getOrInsert boxed-any value rows (~10 tests, S–M, may be a no-op here)

**Gap**: `assert.sameValue(map.getOrInsert(k, obj), obj)` — two boxed anys
compared by the harness comparator; the values round-trip tag-5 and compare
vacuously/wrongly. This is the **#3056 boxed-compare lane** (and the #3053
U3 carrier), NOT collection dispatch.

**Action**: verify per-row that the failure is the comparator (compile one
row with `JS2WASM_TAG5_CLASSIFIER=1`); if so, tag the rows to #3056/#3053 in
the lane baseline and do NOT patch collections code. Only genuinely-wrong
STORED values (identity lost through the map kernel itself,
`ensureGetOrInsertKernels` :160) belong here.

### Plan-let R4 — `builtins.js` function-object meta (7 tests, M)

**Gap**: `Object.isExtensible(Set.prototype.union)`,
`Object.getPrototypeOf(...)`, `.toString()` on the method VALUE — the
algebra methods need function-object meta surface when read as values.

**Change**: this is the same machinery as #3181 cluster A/B (builtin proto
method values with meta surface) — implement AFTER the #3181 pattern lands
and reuse its glue (`array-object-proto.ts` `registerNativeProtoBuiltin` +
`tryCompileStandaloneBuiltinProtoMemberMeta`, property-access.ts:1104) for
the Set brand. Do not build a Set-specific meta path first.

### Plan-let R5 — re-entrant mutation ordering + IteratorClose (~7 tests, M–L, lowest priority)

**Gap**: `set-like-class-mutation` (the argument's `has`/`keys` mutates the
receiver mid-algorithm — spec fixes `size` and snapshots per-method reads)
and `set-like-iter-return` (abrupt completion must call the keys iterator's
`return()` — IteratorClose).

**Change**: in `ensureSetAlgebraAnyDispatch` (:780) kernels: (a) read +
ToNumber `size` ONCE into a local before iteration (verify current fill
order — likely already correct from `size-is-a-number`); (b) snapshot the
receiver's backing entries where §24.2.4.x prescribes (intersection/
difference iterate `O.[[SetData]]` live — follow the per-method spec text,
not a blanket copy); (c) wrap the keys-iteration loop with an IteratorClose
arm on early exit — reuse the iterator-protocol close helper from
`iterator-native.ts` (the ITER close discipline the #3098 iterator steppers
use) rather than a new close path.

**Out of scope stays out**: `class MySubset extends Set` rows (~12) are
#2917 builtin-super lineage — do not touch here.

### Sequencing / ownership

R1 (M) → R5 (M–L) independent of each other; R3 is triage-first; R2 is
re-triage-first (blocked on the missing vec-expando capability — see the
correction above); R4 blocks on #3181 cluster A/B landing. Each PR: scoped
standalone sweep of
`built-ins/{Map,Set,WeakMap}/prototype` vs the 559/700 post-#3172 baseline,
0 host-lane regressions, `tests/issue-3172.test.ts` stays green.
