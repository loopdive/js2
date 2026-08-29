---
id: 5151
title: "ES2015 standalone: collections conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/map-runtime.ts
  - src/codegen/set-runtime.ts
  - src/codegen/weak-collections-runtime.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/standalone-global-object-carriers.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/native-proto-own-props.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/proto-index-store.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# #5151 — ES2015 standalone: collections conformance wave 1

Growth allowance rationale (2026-08-28): this change-set adds the observable
iterable-constructor protocol (adder [[Get]]+dispatch, iterator drive,
IteratorClose) for four collection constructors, reified live Map/Set
iterators, and the ctor/prototype reflection surface — all new standalone
codegen in the files listed above. No baseline edits.

## Problem

76 ES2015-bucket test262 tests under `built-ins/{Map,Set,WeakMap,WeakSet}`
fail on the standalone target (re-verified 2026-08-28 on head via
`.tmp/run-standalone.mts`: all 76 from the day-old baseline still fail — same
set, but the old `env::WeakMap_new`/`env::Set_entries` host-import compile
errors are gone; every failure is now a runtime semantic gap in the
Wasm-native `$Map` runtime, #1103/#2162). The gaps are concentrated in the
observable constructor-iterable protocol, manual iterator objects, and the
constructor/prototype reflection model — all blocking the 100% ES2015
standalone goal.

## Current failure clusters

Counts sum to 76 = the full `.tmp/es2015/wp-collections-current-fails.txt`.
All root causes probe-verified on head (probes in `.tmp/es2015/probes5151/`,
run with `npx tsx .tmp/probe-one.mts <abs-path>`).

| Cluster | Count | Root cause (file:function) | Sample tests |
| ------- | ----- | -------------------------- | ------------ |
| A. Constructor iterable protocol not observable | 38 | `src/codegen/expressions/new-super.ts` — the Map arm (`:4084`), Set arm (`:4139`) and `tryCompileNativeWeakCollectionNew` (`:3806`) only handle no-arg / array-literal / array-typed argument shapes, and (except Set) seed via direct `__map_set` calls that bypass the observable `this.set`/`this.add` [[Get]]+Call. A general iterable falls through to the QuickJS eval-tier demotion (throws its own `TypeError: object is not iterable`, wrong error identity) or, for Map, a null-deref (`new Map(undefined)` traps: the Map arm has no nullish-arg branch, unlike the WeakMap arm `:3821`). Probe `ctor-proto.js`: custom `[Symbol.iterator]` never invoked, then RuntimeError null deref. | `built-ins/Map/iterable-calls-set.js` · `built-ins/Map/iterator-next-failure.js` · `built-ins/WeakMap/iterable-with-symbol-keys.js` · `built-ins/WeakSet/get-add-method-failure.js` |
| C. Ctor/prototype object model | 13 | Three independent gaps: (1) `src/codegen/standalone-global-object-carriers.ts:38` `STANDALONE_GLOBAL_CONSTRUCTOR_NAMES` lists only ES5 ctors — no Map/Set/WeakMap/WeakSet, so `verifyProperty(this, 'Map')` finds no own property (probe `vp-map.js`: own=false, desc=undefined). (2) `src/codegen/expressions/object-get-prototype-of.ts:19` `ES5_FUNCTION_PROTOTYPE_CTORS` lacks Map/Set/WeakSet → `Object.getPrototypeOf(Map)` is null (WeakMap already fixed there, #4781 arm at `:184`). (3) same file `:198-220`: the `getPrototypeOf(X.prototype) → Object.prototype` arm is deliberately narrowed to `Function.prototype` only → `getPrototypeOf(Map.prototype) !== Object.prototype`. Plus `Map.prototype[Symbol.iterator]` not an own property / not identity-equal to `.entries` (read alias exists: `tryCompileStandaloneBuiltinProtoIteratorRead`, `property-access.ts:4779`, #4731). | `built-ins/Map/map.js` · `built-ins/Set/prototype-of-set.js` · `built-ins/WeakMap/properties-of-the-weakmap-prototype-object.js` · `built-ins/Map/prototype/Symbol.iterator.js` |
| B. Manual `entries()/keys()/values()` iterators | 13 | `src/codegen/map-runtime.ts:2094` `emitCollectionIteratorVec` materializes an eager externref `$Vec` snapshot; a manual `.next()` on it returns nullish (probe `map-next.js`) or throws `called value is not a function` (Set, probe `set-entries.js`) because the generic `.next()` dispatch (`call-receiver-method.ts` ~L3585) never routes to the live `$MapIter` stepper `__map_iter_new`/`__map_iter_next` that already exists (`map-runtime.ts:1102/:1113`, used only by the for-of dyn-dispatch `ITER_KIND_MAPSET` `:2605`). Same defect as #5147 cluster B/D — #5147 Steps 0/B/D are the predecessor; this cluster is expected to mostly flip when they land. Collections-specific residue: live stepping through `clear`/`delete` mutation (tombstone-stable walk, spec 24.1.5) and the `entries` `[k,v]` pair-array shape. | `built-ins/Map/prototype/entries/returns-iterator.js` · `built-ins/Set/prototype/values/values-iteration-mutable.js` · `built-ins/Map/prototype/delete/does-not-break-iterators.js` |
| H. proto-from-ctor-realm | 4 | `Reflect.construct(Map, [], C)` with `C.prototype = null` must fall back to `GetFunctionRealm(C)`'s `%Map.prototype%` (§9.1.14). Standalone `Reflect.construct` cannot carry an arbitrary NewTarget (same limitation recorded in #5148 cluster 7d / #5139); `$262.createRealm().global` aliases to the current global (`property-access-dispatch.ts:307-334`), so the test reduces to same-realm identity — but `new other.Function()` + the construct path null-derefs today. | `built-ins/Map/proto-from-ctor-realm.js` · `built-ins/WeakSet/proto-from-ctor-realm.js` |
| E. Call without `new` must throw | 3 | `Map()` / `Set()` / `WeakMap()` return an object instead of throwing TypeError (probe `no-new.js`). The exact fix already exists for WeakSet: `tryCompileWeakSetCallWithoutNew` (#4732, `src/codegen/expressions/new-builtin-globals.ts:1722`, wired at `calls.ts:6962`) — WeakSet's own undefined-newtarget test passes; the other three names were never added. | `built-ins/Map/undefined-newtarget.js` · `built-ins/Set/set-undefined-newtarget.js` |
| D. `@@species` read/write fidelity | 2 | Only the gOPD surface models `get [Symbol.species]` (`src/codegen/builtin-static-gopd.ts:371-430` — descriptor correctly shows get:function/set:undefined, probe `species-desc.js`). A direct READ `Map[Symbol.species]` misses that arm and returns undefined, and an ASSIGNMENT lands as an expando and reads back changed — `verifyNotWritable(Map, Symbol.species, …)` sees a successful write (probe `species-write.js`: before!==Map, write visible). The symbol key also stringifies as its internal id ("obj[5]") in the failure message. | `built-ins/Map/Symbol.species/symbol-species.js` · `built-ins/Set/Symbol.species/symbol-species.js` |
| F. `size` accessor reflection through propertyHelper | 2 | Direct `gOPD(Map.prototype, 'size')` works (accessor with get, `array-object-proto.ts:1710`), but propertyHelper holds the receiver in a VARIABLE — `var p = Map.prototype; gOPD(p,'size')` returns undefined (probe `size-verify.js`: TypeError "Cannot convert undefined or null to object") because the gOPD arm resolves only syntactic `Map.prototype` receivers. Additionally `propertyIsEnumerable.call(Map.prototype,'size')` wrongly answers true (probe `size-verify2.js`) — §17 says non-enumerable. | `built-ins/Map/prototype/size/size.js` · `built-ins/Set/prototype/size/size.js` |
| G. Heterogeneous key/value representation | 1 | `new Map([[4,4],['foo3',3],[sym,2]])` then `map.get(1)` returns NaN instead of the stored string (value coerced through an f64-typed lane); adding a `map.get(sym)` read makes the module INVALID wasm ("call[3] expected type (ref null 6), found anyref", probe `het-get.js`) — `coerceMapKeyToAnyref` (`map-runtime.ts:1424`) / the `__map_get` result lane mishandle symbol keys and mixed value unions. | `built-ins/Map/prototype/set/append-new-values.js` |

## Implementation Plan

Execute clusters in the order below (count-descending, with H last: it is the
hardest and lowest-count large cluster). All work is standalone/`nativeStrings`
codegen; the JS-host lane is untouched. Use `ctx.oracle` for any new type
queries (oracle-ratchet gate, #1930/#3273) — never raw `ctx.checker.*`.
Re-run per-cluster with
`npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-collections-current-fails.txt`.

### Step A — observable iterable-constructor drive (38 tests)

Files: `src/codegen/expressions/new-super.ts`, `src/codegen/map-runtime.ts`,
`src/codegen/weak-collections-runtime.ts`.

1. **Generalize the adder dispatch to all four ctors.** The pattern to mimic
   is already in the Set literal arm: `prepareNativeSetAdderDispatch`
   (`new-super.ts:3721`) checks whether `Set.prototype.add` was patched and
   `emitNativeSetAdderCall` (`:3774`) routes through the patched closure. Add
   the same pre-consumption adder [[Get]] to the Map arm (`:4100`, key
   `Map.prototype.set`) and both weak arms in
   `tryCompileNativeWeakCollectionNew` (`:3856`, `:3877`). Spec order
   (§24.1.1.1 steps 7-8): Get(adder) happens BEFORE GetIterator — a throwing
   `Object.defineProperty(Map.prototype,'set',{get(){throw}})` must abort
   before the iterable is touched (`get-set-method-failure` rows), and a
   non-callable adder throws TypeError before iteration
   (`*-not-callable-throws` rows).
2. **Add the general iterator drive.** New shared emitter (suggest
   `emitNativeCollectionCtorIterableDrive` in `map-runtime.ts`) used by all
   four ctor arms when the single argument is not one of the fast shapes:
   GetIterator via the native `__iterator` ladder (`iterator-native.ts`
   `buildIteratorBody` — the same machinery for-of uses; it already handles
   custom `[Symbol.iterator]` objects), then loop: IteratorStep → for
   Map/WeakMap require the item be an object and Get(item,'0'/'1') (non-object
   item → native TypeError + IteratorClose, `iterator-items-are-not-object*`
   rows) → Call(adder, coll, args). Abrupt completion from `next()`, `value`
   get, entry gets, or the adder must propagate as the ORIGINAL error
   (`Test262Error` identity — never the eval-tier's own TypeError) after
   IteratorClose (`iterator-close-after-*-failure` rows: close return()'s own
   abrupt is swallowed in favor of the adder's error,
   `iterator-close-failure-after-set-failure`). `iterator-is-undefined-throws`:
   a nullish `@@iterator` → TypeError.
3. **Nullish args on the Map arm.** Mirror the WeakMap `nullishArg` branch
   (`:3821`) in the Map arm so `new Map(undefined)` / `new Map(null)` produce
   the empty native map instead of falling through (fixes the
   `map-no-iterable`/`set-no-iterable` null-deref/eval-tier rows).
4. **Weak-key checks ride the adder.** With the drive calling the real
   `__weakmap_set`/`__weakset_add`, the CanBeHeldWeakly rejection for
   primitive keys is #4785's in-progress work (`weak-collections-runtime.ts`)
   — do not duplicate it; `iterator-items-keys-cannot-be-held-weakly` needs
   only "TypeError thrown by adder propagates + IteratorClose" from this step.
   Symbol keys (`iterable-with-symbol-*`) must survive
   `coerceMapKeyToAnyref` — see Step G before testing those two rows.
5. **What NOT to do:** no new host imports (the runner fails any module with
   host imports — `standaloneHostImportError`); do not route the fallback to
   the QuickJS eval tier (wrong error identity is exactly the current bug); do
   not regress the fast literal paths (they stay, guarded behind an
   "adder unpatched" runtime check like the existing Set `modeLocal` branch).

### Step C — ctor/prototype reflection model (13 tests)

Files: `src/codegen/standalone-global-object-carriers.ts`,
`src/codegen/expressions/object-get-prototype-of.ts`,
`src/codegen/array-object-proto.ts`, `src/codegen/native-proto-own-props.ts`.

1. Append `"Map", "Set", "WeakMap", "WeakSet"` to
   `STANDALONE_GLOBAL_CONSTRUCTOR_NAMES` (`standalone-global-object-carriers.ts:38`).
   The carrier value comes from `emitBuiltinConstructorIdentity`
   (`builtin-static-globals.ts:166`; all four names are already in
   `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` `:84`). Descriptor flags 0x05 =
   {writable, ~enumerable, configurable} exactly as the existing seed loop
   emits. Fixes `map.js`/`set.js`/`weakmap.js`/`weakset.js`.
2. Add `"Map", "Set", "WeakSet"` to `ES5_FUNCTION_PROTOTYPE_CTORS`
   (`object-get-prototype-of.ts:19`) — or fold them into the #4781 WeakMap
   arm (`:184`). Fixes the three `prototype-of-*` rows.
3. Extend the deliberately-narrow `Function.prototype` arm (`:198-220`) with a
   collection arm: syntactic `X.prototype`, X ∈ the four names,
   `isGlobalBuiltinIdentifier`-guarded → `emitEs5IntrinsicPrototype(ctx, fctx,
   expr, "Object")` (identity-stable — same singleton `Object.prototype`
   emits, which is why the current failure is a non-identical `[object
   Object]`). All four collection prototypes inherit directly from
   %Object.prototype%, so the caveat that blocked a blanket branch
   (TypedArray/Error chains) does not apply. Fixes the four
   `properties-of-the-*-prototype-object` rows.
4. Seed `@@iterator` as an OWN property on the Map/Set native proto pages
   (`ensureMapNativeProtoGlue`/`ensureSetNativeProtoGlue`,
   `array-object-proto.ts:2287/:2299`), with the SAME closure singleton the
   `entries` (Map) / `values` (Set) member read yields so
   `Map.prototype[Symbol.iterator] === Map.prototype.entries` holds by
   `ref.eq`. The read-side alias (#4731,
   `tryCompileStandaloneBuiltinProtoIteratorRead`, `property-access.ts:4779`)
   already resolves the value; the own-property/descriptor surface
   ({w:T,e:F,c:T}) is what's missing. Follow the #4786 @@toStringTag seeding
   pattern in the same file. #4731 (in-progress) owns the not-a-constructor
   rows — coordinate, don't duplicate.

### Step B — reified live iterators for entries/keys/values (13 tests)

Predecessor: **#5147 Steps 0/B/D** (native `CreateIterResultObject`, generic
`.next()` stepping on native carriers, own `next` on the iterator-prototype
singletons). That issue's plan already routes Map/Set `.next()` through
`__map_iter_next` (`map-runtime.ts:1113`). Do NOT re-implement; this step is
the collections-side completion:

1. Make `compileNativeCollectionIterator` (`map-runtime.ts:2073`) return a
   carrier holding a live `$MapIter` (`__map_iter_new`, `:1102`) instead of the
   eager `emitCollectionIteratorVec` snapshot when the result escapes to a
   manual-`.next()` consumer. Keep the vec path for the for-of lowering (its
   dyn-dispatch `ITER_KIND_MAPSET` arm `:2607` already steps live).
2. `__map_iter_next` walks the entries vector by index with tombstone skips —
   this gives the mutation rows (`clear/map-data-list-is-preserved`,
   `delete/does-not-break-iterators`, `values-iteration-mutable`) for free;
   verify against those three rows specifically after wiring.
3. `entries` results: the `.value` must be a real 2-element array (`.length`
   read, index reads) — build via the `$ObjVec` pair builders already used at
   `emitCollectionIteratorVec:2120` (`ensureObjVecBuilders`); Set `entries`
   yields `[v, v]`.

### Step E — call-without-new TypeError (3 tests)

File: `src/codegen/expressions/new-builtin-globals.ts` (+ dispatch in
`calls.ts:6962`). Clone `tryCompileWeakSetCallWithoutNew` (`:1722`, #4732)
into a table-driven arm over {Map, Set, WeakMap, WeakSet}: same
ambient-global + `ctx.classSet` shadow guards, evaluate args for side
effects, `emitThrowTypeError("Constructor <Name> requires 'new'")`. ~30 lines.

### Step D — `@@species` value read + write-protection (2 tests)

Files: `src/codegen/property-access.ts` (computed symbol read),
`src/codegen/expressions/assignment.ts` or the expando write path,
`src/codegen/builtin-static-gopd.ts` (reuse its accessor closure).

1. Route the direct computed read `<Ctor>[Symbol.species]` (Ctor ∈ collection
   names, unshadowed) to the species getter result — the ctor identity carrier
   itself — reusing the identity-stable getter closure builtin-static-gopd.ts
   already mints (`:420-430`). Mimic how
   `tryCompileStandaloneBuiltinProtoIteratorRead` intercepts a symbol-keyed
   computed read before the generic `__extern_get` path.
2. Make the assignment `<Ctor>[Symbol.species] = v` a silent no-op (accessor
   without setter, non-strict test code): evaluate RHS for side effects, drop,
   do NOT store an expando readable by a later read.

### Step F — `size` reflection through variable receivers (2 tests)

Files: `src/codegen/builtin-static-gopd.ts`, `src/codegen/native-proto-own-props.ts`.
1. Let the `gOPD(<recv>, 'size')` arm accept a receiver VARIABLE whose value
   is a native proto page (propertyHelper's internal `var obj = …`), not just
   syntactic `Map.prototype` — resolve via `ctx.oracle.declaredNameOf` /
   `variableInitializerOf` (see the ES5_OBJECT_PROTOTYPES lookup in
   `object-get-prototype-of.ts:246` for the pattern), falling back to the
   runtime `$NativeProto` brand.
2. Fix `propertyIsEnumerable.call(<proto page>, 'size')` → false (accessor is
   {e:F,c:T} per §17); the own-props enumeration surface is
   `native-proto-own-props.ts` (#4786 touched the same file for
   @@toStringTag).

### Step G — heterogeneous key/value lanes (1 test + unblocks A4)

File: `src/codegen/map-runtime.ts` (`coerceMapKeyToAnyref:1424`,
`compileCollectionElementArg:1548`, the `__map_get` result unwrap in
`tryCompileNativeMapMethodCall:1597`).
1. Fix the symbol-key seed emitting an invalid module (probe `het-get.js`:
   "call[3] expected type (ref null 6), found anyref" — a `$Symbol` ref pushed
   where `(ref null $AnyValue)`-shaped coercion was expected). Add a symbol
   arm to `coerceMapKeyToAnyref` mirroring its string/number boxing arms;
   validate with `/analyze-wat` on the probe.
2. Fix `map.get(k)` returning through an f64 lane when the map's value union
   is mixed (string stored, NaN read back): the get result must stay anyref
   and unbox per dynamic tag, not per the oracle's first-seen element type.

### Step H — proto-from-ctor-realm (4 tests, LAST)

Blocked on the standalone Reflect.construct NewTarget limitation shared with
#5148 (cluster 7d) / #5139. Given `$262.createRealm().global` aliases to the
current global (`property-access-dispatch.ts:307`), a narrow arm suffices:
`Reflect.construct(<collection ctor>, [], C)` in standalone → construct the
native `$Map` with the right brand, and answer
`Object.getPrototypeOf(result)` with the native proto page (the same
`emitLazyNativeProtoGet` singleton `other.Map.prototype` resolves to) when
`C.prototype` is not an object. If the shared Reflect.construct work has not
landed when the rest of this issue is done, split these 4 rows into a
follow-up issue rather than blocking the wave — they are the only
cross-cutting rows here.

### Global constraints (all steps)

- **No new host imports without a standalone fallback** — the probe runner
  hard-fails any module emitting `env::*` imports (#2961).
- **Never edit** `tests/test262-runner.ts`, skip lists, or
  `scripts/*baseline*.json` (main is the baselines' sole writer).
- New type queries go through `ctx.oracle` (`src/checker/oracle.ts`);
  `oracle-ratchet-allow:` only for genuine wasm-lowering `ValType` questions.
- Run all ratchet gates chained before every commit (CLAUDE.md "Hooks and
  ratchet gates"), incl. the CI-base simulation (`LOC_GATE_BASE`).

## Acceptance criteria

- All 76 tests in `.tmp/es2015/wp-collections-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-collections-current-fails.txt`
  (SUMMARY shows pass:76; H's 4 rows may be split to a follow-up issue per
  Step H, in which case 72/76 + the filed follow-up is acceptance).
- Every test in `.tmp/es2015/wp-collections-passing-spotcheck.txt` (40 rows)
  still passes via the same probe.
- All source-ratchet gates pass (`check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`).

## References

- #5147 (ready, same sprint) — iterators wave 1; its Steps 0/B/D are the
  predecessor for cluster B (`.next()` stepping, iterator-prototype `next`).
- #4785 (in-progress) — WeakMap/WeakSet CanBeHeldWeakly primitive rejection;
  Step A4 depends on it, do not duplicate.
- #4731 (in-progress) — Set iterator not-a-constructor + @@iterator read
  alias; Step C4 builds on its read path.
- #4781 (in-progress) — WeakMap `getPrototypeOf` ctor identity; Step C2
  extends its arm to Map/Set/WeakSet.
- #4732 (done) — WeakSet call-without-new; Step E clones its arm.
- #4786 (done) — weak-collection @@toStringTag; pattern for Steps C4/F2.
- #5116 (in-progress) — Map/Set prototype @@toStringTag (adjacent surface).
- #5148 / #5139 — sibling waves; share the Reflect.construct NewTarget
  limitation cited in Step H.
- #2162 / #1103 (done) — the native `$Map` runtime this wave completes;
  #3171 — collection brand tags + `size` accessor glue.

## Results

**25 of the 76 target rows now pass (0 before).** Measured with
`npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-collections-current-fails.txt`
on this branch; the 76-fail before-count was re-measured on this worktree's HEAD
with the same command (the plan's day-old baseline still held). The 40-row
`wp-collections-passing-spotcheck.txt` stayed 40/40.

Note on the environment: four rows (`prototype-of-*`, `proto-from-ctor-realm`)
first reported "quickjs provider is not built" rather than their real failure.
That was a missing `.test262-cache` in the fresh worktree, not a code state —
the before-count above was taken with the cache linked in.

### Landed

| Cluster | Rows fixed | Change |
| ------- | ---------- | ------ |
| C — ctor/prototype reflection | 11 | Map/Set/WeakMap/WeakSet added to `STANDALONE_GLOBAL_CONSTRUCTOR_NAMES` (own property on the realm object); all four added to the `Object.getPrototypeOf(<Ctor>) === Function.prototype` arm (was WeakMap-only); `getPrototypeOf(<Ctor>.prototype) === Object.prototype` arm widened from `Function.prototype` to the four collection prototypes, which all inherit directly from %Object.prototype%. |
| E — call without `new` | 3 | `tryCompileWeakSetCallWithoutNew` made table-driven over all four ctors (it was WeakSet-only). |
| A — ctor iterable protocol, partial | 11 | (1) `new Map(undefined)`/`new Map(null)`/`new Set(null)` are spec-empty — the nullish branch the WeakMap arm already had. (2) `Get(coll, "set"/"add")` + not-callable TypeError before the iterable is touched, for all four ctors, including the throwing-getter row (the companion `[[Get]]` runs the user accessor, so `Test262Error` keeps its identity). (3) Map/WeakMap/WeakSet literal seeding now routes through the user-patched adder with the real `«k, v»` / `«v»` arguments and the collection as `this`, mirroring the Set arm. |

The **root cause behind (2) and (3)** was outside the constructors:
`__protoidx_brand_off` (`proto-index-store.ts`) classified a `$Map` carrier as
`Set` and nothing else, so `Map.prototype.set = …` and the two weak twins were
invisible to every receiver-aware prototype consult — the Map receiver answered
`Object`, whose companion has no `set`. All four `COLLECTION_KIND` values now
map to their own brand offset. Nothing outside the collections uses that arm.

### Not done — follow-ups

- **Cluster B (live `keys/values/entries` iterators, 13 rows) — attempted and
  reverted.** A live `$__IterRec` carrier of kind `ITER_KIND_MAPSET` was built
  and it works (`iterator.next().value/.done` read correctly under direct
  comparisons), plus a `__map_iter_step` wrapper that packs the `entries`
  `[k, v]` pair. It flipped **zero** test262 rows because of a SEPARATE blocker:
  in a module that drives a native iterator, `assert.sameValue(result.done, …)`
  throws `TypeError: called value is not a function` whenever the argument is a
  property read on the iterator result. Hoisting the read into a variable first
  (`var d = result.done; assert.sameValue(d, …)`) passes, so the value is
  correct and the CALL is what breaks. The same failure reproduces on unmodified
  HEAD with an ARRAY iterator (`arr[Symbol.iterator]().next()`) in a
  Map-containing module, so it is pre-existing and belongs to #5147's surface,
  not to the collections. Three candidate late-import-shift sites were patched
  speculatively and all produced a byte-identical module, so the shift theory is
  disproved — the next step is to find which arm actually emits that call.
  Repro files: `.tmp/es2015/probes5151b/t3.js` (fails) vs `t6.js` (passes).
- **Cluster A residue (27 rows)** — the general iterator drive
  (`iterator-*-failure`, `iterator-items-are-not-object*`,
  `iterable-calls-set` with a non-literal iterable) still needs
  `emitNativeCollectionCtorIterableDrive` per Step A2.
- **Clusters D, F, G, H (9 rows)** — untouched.
- **Symbol keys** (`iterable-with-symbol-*`, 2 rows) — the adder now fires but
  the key arrives as its internal numeric id, so Step G's
  `coerceMapKeyToAnyref` symbol arm is still the blocker.
