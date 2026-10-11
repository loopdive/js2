---
id: 5151
title: "ES2015 standalone: collections conformance wave 1"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-09-28
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
  - src/codegen/declarations/param-return-inference.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
---

# #5151 — ES2015 standalone: collections conformance wave 1

Growth allowance rationale (2026-08-28): this change-set adds the observable
iterable-constructor protocol (adder [[Get]]+dispatch, iterator drive,
IteratorClose) for four collection constructors, reified live Map/Set
iterators, and the ctor/prototype reflection surface — all new standalone
codegen in the files listed above. No baseline edits.

Narrow #5151 parameter-boundary exception (2026-09-28): the independently
reviewed `Map`/`Set` size repair adds 63 lines to
`param-return-inference.ts` and 15 lines to `inferParamTypeFromCallSites`.
That growth is the ambient NativeProto representation proof plus the guarded
withdrawal that preserves an actual collection-prototype carrier when an
otherwise agreeing `$Map` ABI would null-cast it. It does not change a global
budget or either baseline; the exact entries above are limited to this issue's
leaf repair.

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
| G. Heterogeneous key/value representation | 1 | `new Map([[4,4],['foo3',3],[sym,2]])` then `map.get(1)` fails the original assertion with NaN instead of the stored string. Current source/WAT shows generic `anyref` storage and read, so an f64-coercion cause is not established. A separate historical `map.get(sym)` probe made an invalid module ("call[3] expected type (ref null 6), found anyref"); that symbol-key path remains distinct from the measured original row. | `built-ins/Map/prototype/set/append-new-values.js` |

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

### Step F — `size` reflection through dynamic descriptor calls (2 tests; residual)

Claim: `#5151:dynamic-size-descriptor` is held by
`ttraenkler/codex-5151-size-descriptor` on
`codex/5151-dynamic-size-descriptor` (upstream `issue-assignments`,
2026-09-28T01:44:58Z).

The previous plan assumed that a syntactic-variable receiver was the whole
gap. A fresh standalone fullscope shard instead records
`test/built-ins/Map/prototype/size/size.js` as a real runtime failure
(`TypeError: Cannot convert undefined or null to object`; result JSONL
SHA-256 `8ea77faa631251b39194860569dcbec7a2fc6386dc1851eedcb422e9c7144d41`).
That ledger has no inner stack or phase marker, so it does not identify the
throwing operation.

The focused, versioned diagnostic
`tests/issue-5151-map-size-descriptor.test.ts` uses the unannotated JavaScript
`propertyHelper.js` shape—`var __getOwnPropertyDescriptor =
Object.getOwnPropertyDescriptor` plus a receiver parameter—and independently
checks Map and Set. Its phase checks require a present descriptor, callable
getter, absent setter, `{ enumerable: false, configurable: true }`, matching
`propertyIsEnumerable(..., "size") === false`, and a getter that returns the
known collection size. The same source returns `9090909` under native Node
24.19.0 after an export-only VM transformation. In the standalone compiler it
returned `9091010`: direct literal Map and Set controls each reached phase 9,
while both captured lanes reached phase 10. Phase 10 is deliberately the
outer captured-path catch around the call plus descriptor inspection; it is
evidence of a failing captured lane, not proof that the call itself threw.
The complete command, source/oracle hashes, and terminal logs are retained in
`.tmp/5151-map-size-descriptor-20260928-034204/RECEIPT.md`.

**No production seam is approved from this result alone.** In particular, the
passing direct literals bypass both a dynamic-native-prototype descriptor path
and a first-class builtin-function call path. Do not widen
`resolveBuiltinProtoGopdReceiver` or add a `$NativeProto` descriptor arm until
the following bounded source-only diagnostic matrix had terminal evidence:

1. Keep the direct literal Map/Set controls, but add
   `Object.getOwnPropertyDescriptor(proto, "size")` on the same unannotated
   parameter shape. This separates syntactic receiver recognition from the
   captured-function path.
2. Add a captured-gOPD positive control over an ordinary object with a real own
   data property. It distinguishes failure to dispatch a first-class
   `Object.getOwnPropertyDescriptor` value from a descriptor gap specific to a
   native prototype receiver.
3. Interpret the matrix only at that boundary: a broken ordinary-object
   captured control points to first-class builtin-call handling; a passing
   ordinary control paired with a failed dynamic Map/Set descriptor points to
   native-prototype descriptor handling; a passing direct-parameter call with
   a failed captured Map/Set call leaves a captured-call-specific seam to trace.
   None of those outcomes alone authorizes a broad generic descriptor rewrite.

The discriminator is terminal. Its same-source native Node 24.19.0 oracle
returned `909090909`; the compiler test returned `1010101009` (exit 1), decoded
as direct-parameter Map `10`, direct-parameter Set `10`, captured Map `10`,
captured Set `10`, captured ordinary object `9`. Here `10` is the local catch
around the **gOPD call itself**, while `11` would have meant returned-descriptor
inspection failed. This rules out a generic first-class
`Object.getOwnPropertyDescriptor` call defect: the same captured value works
for an ordinary own data property.

### Emitted-WAT proof (terminal; no module execution)

The separately leased compile-only probe used the exact discriminator source
SHA-256 `60b2c938a55103a84a94e763d098f1eb92df1ebc53ac57289b5b592741ffd1ed`
and completed with exit 0, `success: true`, and `errors: []`. It emitted binary
SHA-256 `3d54f0db7d48c2140261694a12c81be3182b5dfa551f44c77085d6db0ddb87cd`
and WAT SHA-256
`ede2f9cb6565abe289e538a76e3204e7655cafc063296b49f1eef7a1e070d081`
(2,359,170 characters). Raw WAT and the mechanically indexed summary are
retained in `.tmp/5151-map-size-descriptor-20260928-034204/`; the probe did
not instantiate the module or invoke an export.

The WAT replaces the descriptor-arm hypothesis with an exact parameter-boundary
failure:

1. `$test` materializes non-null Map/Set `$NativeProto` singleton globals
   `162`/`204`, stores them, and calls `__protoidx_companion(25, 1)` /
   `__protoidx_companion(26, 1)` before either dynamic gOPD call. The native
   prototype/companion seed path therefore ran.
2. Both `directParameterSizePhase` and `capturedSizePhase` use WAT type `68`
   (`$directParameterSizePhase_type`), whose first parameter is
   `(ref null 64)` — the `$Map` carrier type. At each Map/Set prototype call,
   `$test` converts the native-prototype externref to anyref, performs
   `ref.test (ref 64)`, and takes the `else ref.null 64` branch before calling
   either function. The actual `$NativeProto` is thus discarded **before** the
   parameter reaches either gOPD spelling.
3. Both functions call native `__getOwnPropertyDescriptor` (WAT call `220`)
   with that null parameter. The callee first calls `__protoidx_own_recv`
   (call `137`); its `$NativeProto` test receives null, returns it unchanged,
   and the native gOPD nullish branch throws the observed TypeError.

This is a **dynamic native-prototype argument/parameter ABI boundary**, not a
missing `$NativeProto` descriptor arm and not a companion-seeding failure. Do
not widen `resolveBuiltinProtoGopdReceiver`, add a generic native descriptor
arm, or alter `native-proto-own-props.ts` for this residue. The full upstream
Map/Set `size.js` rows remain red; no focused diagnostic is acceptance.

### Parameter-narrowing seam and approved narrow slice

Source review identifies the producer of WAT type `68` precisely:

1. `src/codegen/declarations/param-return-inference.ts`:
   `inferParamTypeFromCallSites` reads each argument's checker type, calls
   `resolveWasmType`, and accepts a concrete ABI when the resulting physical
   `ValType`s agree. `inferImplicitAnyParamType` returns that result before
   body-usage fallback.
2. `src/codegen/index.ts:resolveWasmType` intentionally maps Map, Set,
   WeakMap, and WeakSet checker types to the shared `ctx.mapTypeIdx` `$Map`
   carrier. That remains correct for actual collection **instances**.
3. `src/codegen/declarations.ts:lowerParamType` consumes the inferred `$Map`
   unchanged. The normal direct-call reader (`call-identifier.ts` →
   `internal-call-argument.ts` → `type-coercion.ts`) then performs the observed
   `$NativeProto`-to-`$Map` guarded conversion and null fallback. Those readers
   are witnesses, not edit targets.
4. The runtime producer is
   `property-access-dispatch.ts:tryIdentifierNamespaceAndStaticReceiverRead`:
   an unshadowed, ambient `<Builtin>.prototype` whose brand is actually wired
   through `builtin-value-read.ts:tryEnsureNativeProtoBrand` is emitted as a
   `$NativeProto` externref.

The approved leaf repair belongs only in
`param-return-inference.ts`: while inferring an *unannotated implicit-any*
parameter from call sites, recognize the actual standalone collection-prototype
producer shape—transparent wrappers around a *resolved*, unshadowed ambient
`Map`/`Set`/`WeakMap`/`WeakSet` `.prototype` read—and withdraw a concrete
inference when that argument occurs. The parameter then remains `externref`,
preserving the native-prototype identity through the dynamic call boundary.
The group is deliberately the four constructors that share the `$Map` instance
carrier and whose native-prototype producer is wired; it is not a blanket rule
for all branded builtins or for all collection calls. A parameter whose observed
arguments are only actual Map/Set/WeakMap/WeakSet instances keeps its existing
`$Map` fast path.

The predicate must require a nonempty `ctx.oracle.declarationsOf` population
whose entries are all declaration-file ambient bindings. This deliberately
rejects an unresolved spelling, local `Map`/`Set` class, import, or rebinding
without adding a raw checker query. Direct producer evidence is enough for the
maintained `propertyHelper` shape. Do **not** follow arbitrary identifier
aliases in this slice: `isSingleAssignmentBinding` can prove a binding is
stable, but it does not itself prove that the alias's *storage ABI* has
preserved a NativeProto rather than already applying the same `$Map` cast. An
alias expansion therefore needs an independently demonstrated storage-carrier
path and is explicitly deferred rather than claimed by this parameter fix.

Collision/IR review found no owner of the call-site inference leaf. The code
scope is `param-return-inference.ts` plus the focused
`tests/issue-5151-map-size-descriptor.test.ts`; no `index.ts`, declarations,
IR, descriptor-runtime, or coercion change is authorized. The focused test is
the first acceptance gate. Its carrier controls require direct prototype
identity for all four supported collection prototypes, retain Map/Set and weak
collection instance behavior, and exercise both a local and a module-shadowed
`Map` spelling. A separate mixed-call-site control sends `Map.prototype` and a
real `Map` instance through the same implicit-any parameter: this proves the
NativeProto observation withdraws an otherwise agreeing `$Map` ABI rather than
only covering separate parameter functions. They do not claim identifier-alias
support. The original Map/Set `size.js` property-helper rows must still be run
unchanged before calling Step F complete.

#### Candidate focused receipt (terminal; not full acceptance)

On 2026-09-28, the repaired candidate completed the focused file once under
Node `v24.19.0`, one Vitest fork, and explicit 4096 MiB parent/fork limits:

```text
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 NODE_OPTIONS=--max-old-space-size=4096 VITEST_MAX_FORKS=1 /Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --max-old-space-size=4096 node_modules/vitest/dist/cli.js run tests/issue-5151-map-size-descriptor.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose
```

It exited `0` after 17.03 s: all four rows passed—the original propertyHelper-
style Map/Set descriptor regression, the direct/captured discriminator, the
four-prototype identity plus instance-behavior controls, and the module-shadow
control. The local-shadow control is part of the carrier source's fourth row.
The later-added mixed-call-site control is not part of this historical
four-row receipt and remains separately unverified at this point in the plan.
The terminal log, command, exit code, and before-run SHA receipt are retained
at `/private/tmp/js2-5151-candidate.wo2pMO/`. The before/after hashes matched:
test file `a3ac0189414174f59272500a94674e7893774851e4acf7e3324c2b65c808c42b`,
inference source `fb4f7a92df5743c2091fd897b2ed7d849a9e5336b82f5c1e7d38b09f3b938f4c`,
and this plan before recording the result
`504fa8a919845ac345d82197ce3b4f609daba87528d3f9e9f52423b065bb6228`.

This is candidate evidence only. A clean-base run of the byte-identical test
fixture and the unchanged upstream Map/Set `size.js` rows remain required; no
fullscope/Test262 claim follows from this receipt.

#### Matched clean-base A/B receipt (terminal; focused only)

The same fixture was then installed with `apply_patch` into the separate clean
baseline checkout `/Users/thomas/.codex/worktrees/map-size-baseline/js2`, at
the same base `37b11b28919ef22a428cb13aa31006850e331ecb`. Its fixture SHA-256
matched the candidate exactly (`a3ac0189414174f59272500a94674e7893774851e4acf7e3324c2b65c808c42b`);
its unmodified inference source SHA-256 was
`8e5cc75c8a80214dfa29a84078533cfeafc6afa19dde7bfb4221503cbadebb3a` before
and after the run. The identical Node 24.19.0 / one-fork / 4096 MiB command
above exited `1` after 16.75 s, with these exact transitions:

- propertyHelper-style descriptor source: baseline `9091010` → candidate
  `9090909`;
- direct/captured discriminator: baseline `1010101009` → candidate
  `909090909`;
- NativeProto identity and instance controls: baseline `99999` → candidate
  `999999999` (the four direct-prototype lanes were zero only on baseline;
  all four instance lanes and the local-shadow lane already returned `9`);
- module-shadow control: `9` → `9`.

The baseline command, terminal log, exit code, and source-hash receipt are
retained at `/private/tmp/js2-5151-baseline.33Kl5A/`. This proves the focused
repair is causally responsible for the three repaired lanes while preserving
the controls. It does **not** replace the planned unchanged upstream Map/Set
`size.js` validation.

#### Maintained-row registration incident (terminal; no verdict)

The first direct dynamic-runner attempt used a two-line filter spelling without
the runner's leading `test/` path component. The source comment called the
file entries "test-relative," but the actual registration identity at
`test262-shared.ts:585` is `relative(TEST262_ROOT, filePath)`, i.e.
`test/built-ins/...`. The original filter was preserved at
`.tmp/5151-test262-map-set-size.paths` with SHA-256
`ad66e42d2ba1ea5ee8bb19df257cf24a04f03fb0ad45ddf3bd45ad5cc1d89152`.

Candidate attempt `5151-candidate-20260928T023920Z-96539` therefore registered
zero callbacks and Vitest reported `No test suite found`. The shared module had
already opened its result file, so the durable JSONL exists but is zero bytes:
`benchmarks/results/test262-5151-candidate-results-5151-candidate-20260928T023920Z-96539.jsonl`.
It has no completion manifest and no recorded verdict; the completeness gate
correctly exited 2. This is a harness-scope incident, not candidate evidence.
The corrected v2 filter is a separately named pair of files with the actual
two identities and SHA-256
`07e369ea4c10d70032529908d3671496b4e9a43480f99d0e7eea66bfdf1deb53`.

#### Final revised focused A/B receipt (terminal; five rows only)

The final leaf revision replaces the new raw checker declaration lookup with
the nonempty, all-ambient-declaration `ctx.oracle.declarationsOf` proof and
adds a same-parameter mixed carrier control. Under Node `v24.19.0`, one
Vitest fork, and 4096 MiB parent/fork limits, the candidate passed all five
focused rows (exit 0, 18.67 s): the original propertyHelper descriptor source,
the direct/captured discriminator, four NativeProto identities plus instance
controls, the same implicit-any parameter receiving `Map.prototype` and a real
`Map`, and the module-shadow negative control. Its source hashes were inference
`ec49c4303a6a7418d7a9e8bbd4056aabe788db1258b0703e163ed45782b3a68b` and
fixture `32ff946252cc96e6fb22c8e2e3eccbdeaaf3934001b1f1f8c63391b3a88d7304`.
Receipt: `.tmp/5151-focused-candidate-final-20260928T024746Z-43158/full.log`.

Those behavioral receipts predate a mechanical Prettier-only source format
pass. The final formatted inference source SHA-256 is
`18128ef4dd1f2f93f2a09ab2e70546e45fbd2c7c1ccc3b5d6c496159f61e8fd2`;
the actual ratchet measurement is 1836 → 1899 lines (+63) and 407 → 422
functions (+15). The earlier `ec49c430…` hash remains a historical validation
receipt for semantically identical source, rather than being relabeled as the
final formatted artifact.

The byte-identical fixture ran in clean base
`37b11b28919ef22a428cb13aa31006850e331ecb`, whose unchanged inference source
SHA-256 was `8e5cc75c8a80214dfa29a84078533cfeafc6afa19dde7bfb4221503cbadebb3a`.
It exited 1 with the four expected negative lanes and one preserved module-
shadow positive lane: `9091010` → `9090909` (propertyHelper descriptor),
`1010101009` → `909090909` (discriminator), `99999` → `999999999` (direct
NativeProto identities while instance/local-shadow controls stay positive),
`9` → `99` (same-parameter prototype plus instance), and `9` → `9` (module
shadow). Baseline receipt:
`/Users/thomas/.codex/worktrees/map-size-baseline/js2/.tmp/5151-focused-baseline-final-20260928T024858Z-50943/full.log`.
This proves the narrow parameter-boundary repair and guards only, not full
collection conformance.

#### Final maintained Map/Set size A/B receipt (terminal; exactly two rows)

The original unmodified upstream files ran via maintained
`tests/test262-chunk-dynamic.test.ts`, never a custom wrapper. The v2 filter
contains the actual registration identities `test/built-ins/Map/prototype/size/size.js`
and `test/built-ins/Set/prototype/size/size.js`, with two unique entries and
SHA-256 `07e369ea4c10d70032529908d3671496b4e9a43480f99d0e7eea66bfdf1deb53`.
Both sides resolved the physical `test262/test` and `test262/harness` paths to
`/Users/thomas/Code/js2/.claude/worktrees/es2016-test262-standalone-parallel-0c0628/test262`,
at corpus HEAD and outer gitlink `b363f29d3c43c626dc852744ad64a0b48a003693`;
tracked corpus status was clean. The two test sources plus `propertyHelper.js`,
`assert.js`, and `sta.js` hashes are preserved in each log.

Each side used Node `v24.19.0`, standalone QuickJS full-runtime evaluation,
UTC, realm recycling, one Vitest fork, one compiler worker, and 4096 MiB
parent/fork/worker limits. The immutable artifact key was `2e2d7736713beeda`
with wasm SHA-256 `e9f8d30bc347dbc56f31b3389f7696eb6dedc9f05ea729781fc412f09a3e6b17`;
adapters were independently built and verified in each worktree cache.

Candidate exit was 0 with both rows passing. Its bundle/runtime hashes were
`2bc2d74e4a839cdea89113eb412a1a76a4aa0919a5f3a16cf134113ccc3fd001` and
`ff79916e43e1d5b9aab7680272804d5a70f83e6ae50b6fc157e337cdafd009e4`; fresh
adapter key `196217d0f1a1cc0a`; JSONL/manifest hashes
`c8e92dc2701b875ff1a05bb80bfa830d4a0fb6b86d0561c8e2db0a8d3de5bb81` and
`cfa611792ca189e37a0e06c34371c0cb759519540fd4b8911ef341f275b5d586`.
The validator recorded exactly 2 registered/recorded/canonical/started/settled
callbacks, zero exclusions, and both expected paths. Receipt:
`.tmp/5151-candidate-v2-20260928T025034Z-56699/full.log`.

Baseline exit was 1 with exactly those two rows failing at runtime with
`TypeError: Cannot convert undefined or null to object`. Its bundle/runtime
hashes were `68b95260c3a4a3be86a518c4a469fff7a5fe688221684945438bfae95b5c6879`
and `16c2de87f8cf3f0fa2cc38d0b2c04a5ec9122416787ddd61af2d98be3fee4914`;
fresh adapter key `924e58cf1a604265`; JSONL/manifest hashes
`21efb6a4ab36c7b9e219695c256bdfdfb26a0f49ab80df346e9c7ee352888804` and
`d3ff5f336d778344e526b13762adf8e979b37a213058d08a9a8b09335508d350`.
It has the same complete 2/2 invariants and zero exclusions. Receipt:
`/Users/thomas/.codex/worktrees/map-size-baseline/js2/.tmp/5151-baseline-v2-20260928T025200Z-57197/full.log`.
This is a bounded two-row causal A/B result; no other collections residual or
full-corpus claim follows from it.

#### Neighboring parameter-inference controls (terminal; one matched red control)

Under the same Node `v24.19.0`, one-fork, 4096 MiB configuration, the nearby
call-site inference controls passed 16/16: all six #318 basic inference cases,
the #2949 no-ABI-withdrawal case, the #2917 opaque/forwarded/destructured
withdrawal case, and all eight #3471 polymorphic/boxed plus numeric-preservation
cases. Receipt:
`.tmp/5151-neighbor-inference-20260928T025456Z-57935/full.log`.

The selected two-test #4491 vec-identity control is deliberately not counted
as green: its accessor case failed and its setter case passed (1F/1P, 17
unselected) on both candidate and clean baseline with byte-identical fixture
SHA-256 `1b4b483f3ddcea33c80434305df4ca3310a516509ff5a5e4eef0c2b6a2048444`.
The fixture defines a getter-only `arr[1]` and assigns `arr[1] = 4` at module
top level, so strict-module assignment can throw before the named read-through
assertion. This is an existing #4491 red control, not evidence about #5151;
its fixture was not changed. Baseline receipt:
`/Users/thomas/.codex/worktrees/map-size-baseline/js2/.tmp/5151-neighbor-4491-baseline-20260928T025606Z-58140/full.log`.

### Step G — mixed Map values (1 measured row; WAT diagnostic gate)

The exact frozen row is
`test/built-ins/Map/prototype/set/append-new-values.js`: numeric initial values
are followed by `map.set(1, 'valid')`, then the original body directly checks
`assert.sameValue(map.get(1), 'valid')`. The historical observation was `NaN`
rather than `'valid'`, but that result does not identify an f64-unbox or
symbol-key root cause by itself.

Source-only recheck at
`732d9f75e671237c3cdf3abf6ba848bedada9185` finds that
`tryCompileNativeMapMethodCall` in `src/codegen/map-runtime.ts` returns
`{ kind: "anyref" }` after native `__map_get`; its caller
`compileExternMethodCall` in `src/codegen/expressions/extern.ts` returns that
result unchanged. The prior local `map.get`-unbox prescription is therefore
withdrawn pending exact emitted-route evidence. This does not rule out a later
coercion, setter, callback, or comparison boundary.

Before any implementation or focused runtime claim, run the ignored,
compile-only diagnostic
`.tmp/5151/mixed-map-original-harness-wat-diagnostic.mts` under an explicit
compiler lease. It refuses a source/corpus mismatch and requires:

- source head `732d9f75e671237c3cdf3abf6ba848bedada9185` and clean relevant
  compiler/harness paths;
- Test262 gitlink `b363f29d3c43c626dc852744ad64a0b48a003693`, the exact raw
  fixture SHA-256, and a physical `test262/harness` checkout;
- the maintained `parseMeta` → `assembleOriginalHarness` →
  `CompilerPool.runTest` → `scripts/test262-worker.mjs::compileSingleSource`
  route. The driver imports the worker's generated compiler bundle and creates
  its same default incremental service; it reproduces the literal
  `originalHarness` compile with `fileName: test.js`, `sourceMapUrl:
  test.wasm.map`, metadata-derived `scriptGoal` and
  `inferModuleStrictArguments`, standalone `deferTopLevelInit`, and the
  wrapper's `hostBridge: always`. `emitWat: true` is the sole intentional
  compile-option difference.

The capture command must set `TEST262_TARGET=standalone` and
`TEST262_SEMANTIC_PROVIDERS=auto`, and a normal worker-entry bundle build must
have completed under the same lease first. The ignored driver refuses a missing
bundle, records its SHA-256 plus the worker-style bundle hash, and pins the
entry/worker/pool/caller source hashes. It intentionally does **not** recreate
an IPC fork with prior shard history, invoke worker `restoreBuiltins`, execute a
body, or write cache/verdict data; the receipt labels those WAT-only
instrumentation differences rather than claiming a runtime-equivalent result.

The initial v2 capture wrote the full raw and assembled sources plus WAT and
hashes for three separately labelled bodies: (1) byte-identical direct
original, (2) one immediate local binding between `map.get(1)` and the same
assertion, and (3) a same-harness all-string-value control that preserves the
original number/string/Symbol key shape. It did not instantiate Wasm or execute
a Test262 body, so its receipt is WAT provenance rather than a pass/fail
result. Compare the resulting `__map_get` call and direct/local consumer paths
before proposing any production seam. A source-evidenced ownership and
clearance check remains required for every implementation surface.

#### Compile-only WAT receipt (not a runtime verdict)

The leased capture completed on the pinned source/corpus pair above with exit
0. Its receipt is
`.tmp/5151/wat-732d9f75-a01/receipt.json` (SHA-256
`25452893d0955efeed6a1143f860fe16c2ae348c562b83ed0a66378c36c4b263`), and
records the worker-entry compiler-bundle SHA-256
`b0b5619d73931cd747ee3aa84fbd803cc07b95b2b3524241cb24d0c4af3de259`.
The byte-identical direct-original assembly has SHA-256
`06ce075cab920261f4bbdddf6b1997d43f19ad730f4bd36b9a87b382fa126204`, emitted
WAT SHA-256
`40b67db55921f94f01126e4f2552a6b93afc92f872b7920d2e4d40c078177476`, and
Wasm SHA-256
`7c90657c81111466b3862d1900c0893400e18421026750a3f4aa2489bb6ec8e2`.
The local-binding and homogeneous-value variants were also emitted and are
fully hashed in that receipt. All three compiles carried the worker's
`$DONOTEVALUATE` IR-fallback warning; none instantiated or executed a module.

The direct-original WAT rules out the previously presumed immediate
numeric-unbox seam, but no more. In the direct body, `__map_set` receives the
literal `"valid"` as its generic `anyref` value argument. The following
`__map_get` (WAT call index 550; definition `$__map_get`) returns `anyref`,
which flows through `extern.convert_any` directly into the assertion helper
`__call_m_sameValue_2` (call index 558). There is no intervening call to
`$__unbox_number` (call index 64). The all-string-value control has the same
direct `__map_get` to `sameValue` shape.

By contrast, the local-binding diagnostic deliberately emits
`extern.convert_any`, then `$__unbox_number`, then stores into its f64-typed
local/global. A stored string consequently takes string-to-number semantics
there; that is a property of the added binding, not evidence about the
unchanged original. Accordingly, this receipt withdraws the proposed direct
`map.get` unbox repair, does not establish a setter/storage/comparison/runtime
cause, and does not count as a passing or failing Test262 result. The next
gate is the separately leased maintained exact-manifest runtime execution of
the unchanged row with its selected Map set/get controls; interpret only its
complete callback-validated receipt before naming another implementation seam.

#### Current unchanged original plus controls (terminal baseline receipt)

That maintained runtime gate has now completed on the same source head and
corpus. Its four-path exact manifest has SHA-256
`119ae17ea77b1abe3941c4172b3c470c39f350089d00972e609ccf95a23215c2` and
contains the unchanged original plus the preselected passing controls
`Map/prototype/get/returns-value-different-key-types.js`,
`Map/prototype/set/replaces-a-value-returns-map.js`, and
`Map/prototype/set/this-not-object-throw.js`. The normal compiler/runtime-entry
build and QuickJS provider build plus `--require-cache` verification completed
in session 71304; compiler bundle SHA-256 is
`b0b5619d73931cd747ee3aa84fbd803cc07b95b2b3524241cb24d0c4af3de259`, runtime
bundle SHA-256 is
`fe6723fca3afd44501d6f54e60d2038f4f27deb1c6edadc9b542606acfde5fc4`, and the
verified adapter key is `a47f3210f9595e00` (adapter SHA-256
`8b96338e50a0c5a471c2b374f5ea8e1c9737caada447ee4f1020fdf9945a9ffb`).

The direct maintained `tests/test262-chunk-dynamic.test.ts` original-harness
run used standalone/auto/QuickJS under Node 24.19.0 with one fork/worker and
4096 MiB. Session 63749 terminated exit 1 after 18.19 s: the unchanged
`append-new-values.js` row still reports `SameValue(NaN, "valid")`, while all
three selected controls passed (3 pass, 1 fail, zero compile errors/skips).
The callback-complete JSONL is
`benchmarks/results/issue5151-map-current-original-controls-results-5151-current-732d9f-a01.jsonl`
(SHA-256
`646d4336970e8bc373d2d2e4e8d457689139e5588f1933b5b86d2f1ae45ccf3e`); its
matching one-of-one completion manifest has SHA-256
`96d3e878fbf6b5f546588305764c3c1d863ce91d20a1dcc1421da8bc9e24860e`.
The completeness validator exited 0 with four verdicts for four registered
expected paths and zero exclusions. This is a current baseline reproduction,
not a candidate-fix result or a whole-suite measurement.

#### Static Map-to-assertion trace and next discriminator (source/WAT only)

The current WAT capture does **not** locate a static string-to-number boundary.
`src/codegen/map-runtime.ts` stores the `set` value as the generic `anyref`
argument both in the update arm (`struct.set` at lines 817–835) and the insert
arm (`struct.new` at lines 878–891); `__map_get` reads that same `F_VALUE`
field as `anyref` (lines 721–772). The direct original's only final lookup is
WAT `call 550` at lines 130361–130368, followed by `extern.convert_any` and
`__call_m_sameValue_2`—not `__unbox_number`.

The assertion call adaptation is also visible rather than inferred. Module
initialization registers `assert.sameValue` closure 59 with declared arity 3
(WAT lines 129635–129652). Therefore `__call_m_sameValue_2`'s two-argument
fast arm is ineligible (its arity check is lines 124430–124452) and it sends
the two direct values through `__extern_method_call` (call 241). That helper
reaches `__apply_closure` (call 186), preserves the two argument-vector entries
as `externref`, pads only the omitted third `message` argument, and selects
`__call_fn_method_3` (call 652). Its ref-344 arm passes receiver, actual,
expected, and message directly to closure 59 (WAT lines 142988–143025).
Closure 59 forwards actual/expected to `_isSameValue`; closure 58 only calls
`__unbox_number` after **both** operands pass the numeric tests (WAT lines
125649–125661). This proves the emitted static route contains no visible
coercion from the stored string through the assertion comparison. It does not
attribute the observed runtime `NaN` to WasmGC, the provider, or another
runtime component.

#### Direct-expression discriminator (terminal; diagnostic-only)

The Node 24.19.0 original-harness oracle passed all six full assemblies
(receipt `.tmp/5151/node-oracle-732d9f75-a01/receipt.json`, SHA-256
`a5362feead024ede533da0fa07e57dd0691225f8b451b121cacb4b3d38d8c696`). A
fresh compile-only capture then completed with exit 0 at
`.tmp/5151/wat-732d9f75-a02/receipt.json` (SHA-256
`c4b5a5722db61e0821bc50815edaf7e96df52f8cbb18973abf0fa1c2c72c4c1e`). It
retains actual Wasm binaries as well as WAT, contains no imported functions,
and records the byte-identical original plus direct `typeof` and direct strict
equality variants. The original has one `$__map_get` call; each modified body
has two.

The paired maintained `CompilerPool` run completed with exit 0 at
`.tmp/5151/runtime-direct-732d9f75-a02/receipt.json` (SHA-256
`30ebc6b3d76c7777ba9f0020ffda57519b65785fe7689b2660ae4e4c83b3f671`) under
the same pinned source/corpus, standalone/auto, Node 24.19.0, one worker, and
4096 MiB. Its artifact, baseline, and WAT-to-executed-binary parity gates are
all null. The executed binary SHA-256 matches the paired capture for all three
direct bodies: original `7c90657c81111466b3862d1900c0893400e18421026750a3f4aa2489bb6ec8e2`,
`typeof` `512e68cfb9d5205e0d8dca5ba866ce599d67a82b05370b9df15c695647f15864`,
and strict-equality `f824679430095cccff160e78e1f33669bf61cbcdc65c17a7a6ddf55b9d6b81df`.
Thus this diagnostic rules out a debug-WAT versus executed-bytecode mismatch
for these bodies.

The unchanged original still fails `SameValue(NaN, "valid")`; all three
unchanged Map controls pass. The `typeof` variant reaches the real runtime
`$__typeof_string` check (WAT function index 77) without throwing its added
guard, then separately fails the retained original assertion. This establishes
only that the guard's own `map.get(1)` result is string-tagged; it does not
prove the string contents or the result of the later assertion's distinct
lookup. The strict-equality variant is not a value discriminator: its WAT is
`call $__map_get; drop; i32.const 1; if (throw)`, so the compiler folds
`map.get(1) !== "valid"` to true while preserving the call side effect. Source
review locates that fold in
`src/codegen/binary-ops-typed-dispatch.ts`: native `Map.get` reports bare
`anyref` (`map-runtime.ts:1725-1735`), while the string literal is a native
`ref`; the one-ref/one-primitive strict-equality fallback drops both and emits
the constant at lines 393-398. This is the separate direct-Map-get equality
gap already described by ready issue #3585, **“Standalone: `m.get(k) === lit`
false in direct call-result position (true via a local); an any-keyed Map
poisons even typed Maps module-wide”**. It is not evidence for the original
storage/read failure and authorizes no production change.

#### Borrowed-character-code diagnostic: rejected gate, no runtime verdict

The next bounded diagnostic adds
`String.prototype.charCodeAt.call(map.get(1), 0)` before the unchanged original
assertion, plus a known-literal borrowed-call control. No corpus or compiler
source was changed. Node 24.19.0 passed all eight original-harness assemblies
in `.tmp/5151/node-charcode-732d9f75-a01/receipt.json`; build/cache/reference
session 14296 terminated successfully with the same compiler bundle and
verified QuickJS adapter as above.

Compile capture session 72606 terminated with exit 1 at the diagnostic's
own validation gate: the literal control added one `__any_to_string` call
(61 versus the assumed 60), contrary to the predicted inline route. Preserve
the captures at `.tmp/5151/wat-charcode-732d9f75-a01`; do not interpret this as
a Test262 failure or a Map value observation. No paired runtime run occurred.

Inspection of the actual WAT explains why the prediction is invalid: both
variants materialize the reflected `charCodeAt` closure (`ref.func 560`) and
invoke it through `call_ref 187`. The direct variant supplies `__map_get`
followed by `extern.convert_any`; the literal supplies the native string
converted to externref. The reflected method body
`$__proto_method_-1073741804_charCodeAt` contains the runtime receiver
conversion and unsigned code-unit read. A global helper-call count is not a
substitute for verifying that caller-to-closure route. Correct the diagnostic
against this captured route, keep fresh output directories and binary parity,
and only then execute it under the shared lease. Even a passing 0x76 check
would establish only one code unit from a separate lookup, not full-string
equality or the later original assertion's lookup identity.

The corrected reflective-route gate subsequently completed in capture session
57867 (exit 0), followed by runtime session 61367 (exit 0). Receipts:

- Node eight-assembly oracle:
  `.tmp/5151/node-charcode-732d9f75-a01/receipt.json`, SHA256
  `dca0e0be6b3ad1717c477b7a0abdbbc48d0f157a4fd6d10bd88ec6dd0f8d449b`.
- Corrected WAT capture:
  `.tmp/5151/wat-charcode-732d9f75-a02/receipt.json`, SHA256
  `0ba43fe43b7eaee8fc23a3afbcd281a394a064d390a03d8280c27fa1772f1fd9`.
- Paired runtime diagnostic:
  `.tmp/5151/runtime-charcode-732d9f75-a01/receipt.json`, SHA256
  `33802688f08f06a64d595f022b43944d9496aaeaa1e06b8351a1c0391fe0546e`.

The runtime baseline, artifact, and captured/executed-binary parity gates are
all null (no gate failure). Both added character-code assertions complete
without throwing, then each retained original assertion fails with the same
`NaN` versus `"valid"` message. The direct character-code binary SHA256 is
`35ee7f90bf1306a2904cff5a3dc7c3cd7d0b4fec5a631c2386e21a074aac1dee`.
All three unchanged Map controls still pass. Diagnostic exit 0 means the
instrument's gates passed, not that the failing original or all eight bodies
passed. The observed prefix check supports code unit 0 being 0x76 through the
borrowed conversion route; it does not establish the remaining code units or
identify the cause of the original assertion failure. No production fix has
been made in this lane.

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
- **Step F is not accepted from a descriptor-read probe alone.** Run the
  unmodified upstream `test/built-ins/Map/prototype/size/size.js` and
  `test/built-ins/Set/prototype/size/size.js` with their real
  `propertyHelper.js` include. Their `verifyConfigurable` path destructively
  deletes `obj[name]` and verifies the missing own property, so acceptance must
  also preserve the runner's normal Map/Set prototype restoration for the
  following strict/repeated invocation. A static `configurable: true` read, or
  merely calling the getter, is insufficient evidence.
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
