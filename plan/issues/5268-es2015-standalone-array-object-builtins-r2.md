---
id: 5268
title: "ES2015 standalone: Array + Object built-ins — r2 residual pass (136 rows)"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-03
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5145, 5148, 4491, 4492, 4444]
# 2026-09-01 (fable-es6 planning pass): every step below adds a spec arm to an
# existing standalone native (a Proxy receiver arm, a `$Vec`/closure-carrier
# symbol-key arm, a ToObject wrapper, an accessor pair, an IsArray unwrap) in
# the files listed. Growth is expected and granted for this change-set only;
# new mechanisms go in NEW files (named per step) rather than in the god-files.
# 2026-09-02 (Opus implementation pass): step 1 landed the `__proto__` accessor
# pair. Two of its wiring sites were not on the planner's list, and both are
# pure WIRING of the new `object-proto-proto-accessor.ts` module — the §10.4.7
# immutable-prototype correction at the `Reflect.setPrototypeOf` call site, and
# the setter-native swap at the `o.__proto__ = v` assignment arm. The semantics
# live in the new module, not in these god-files.
# 2026-09-02 (Opus, step 2): `object-ops.ts` grows by ONE condition — the
# `Object.{keys,values,entries}` receiver test now also admits a value whose
# provenance is a Proxy, which routes it to the native enumerator instead of the
# closed-struct expansion. The predicate itself lives in the new
# `proxy-value-provenance.ts`.
# 2026-09-03 (fable-es6 r3 planning pass, "## Implementation Plan — r3"): the
# r3 steps put every new algorithm in a NEW module — `array-from-native.ts`
# (§23.1.2.1/§23.1.2.3), `object-assign-integrity.ts` (the fold-driven
# integrity precheck), `array-unscopables-native.ts` (the @@unscopables
# singleton) — and grow the files below by WIRING only: one call per arm
# (`call-builtin-static.ts` Array.from/Object.assign arms, `builtin-value-read.ts`
# two switch cases), one factory per trap-read site (`object-runtime-proxy.ts`
# lazy trap fetch for a Proxy-typed handler), one carrier arm per native
# (`object-runtime-descriptors.ts` gOPS `$Vec`/closure/Proxy arms,
# `object-runtime.ts` index reads on closure/wrapper carriers,
# `object-runtime-enumeration.ts` `$AnyStr` assign source), one guarded cast
# (`index.ts` `__call_valueOf` closure-extern arm), one Get before the
# classifier (`object-proto-tostring.ts`). `extern-declarations.ts` /
# `global-environment.ts` are listed because ONE of them is the producer of the
# `env::toString` getter import the r3 step R3-2.1 locates by stack trace; the
# fix there is a single `sourceShadowsGlobalName` guard. Per-step budgets are in
# the r3 section; `total` is deliberately not granted.
loc-budget-allow:
  - src/codegen/object-ops.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/assignment.ts
  - src/runtime.ts
  - src/codegen/array-species.ts
  - src/codegen/array-concat-spec.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/array-like-native.ts
  - src/codegen/iterator-native.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime-integrity.ts
  - src/codegen/object-integrity-carrier.ts
  - src/codegen/object-proto-tostring.ts
  - src/codegen/object-proto-symbol-tag.ts
  - src/codegen/object-proto-annex-b-accessors.ts
  - src/codegen/vec-overlay-keys.ts
  - src/codegen/vec-props.ts
  - src/codegen/array-length-define.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls-guards.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/declarations/import-collector.ts
  # r3 (2026-09-03) — wiring-only growth, see the r3 section per step
  - src/codegen/native-proto-instance-method-read.ts
  - src/codegen/expressions/call-object-builtins.ts
  - src/stdlib/object-runtime.ts
  - src/codegen/index.ts
  - src/codegen/carrier-bag-visibility.ts
  - src/codegen/builtin-prototype-brand.ts
  - src/codegen/array-methods.ts
  - src/codegen/vec-length-set.ts
  - src/codegen/vec-constructor-carrier.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/global-environment.ts
  - src/codegen/registry/imports.ts
# 2026-09-02 (Opus implementation pass): the two step-1 wiring sites above are
# each one arm inside an already-oversized dispatcher; splitting either is a
# separate refactor with its own blast radius.
# 2026-09-02 (Opus, step 2): `compileObjectKeysOrValues` grows by the one
# Proxy-provenance condition; `ensureObjectRuntime` by the FIVE lines that call
# the new `fillObjectIntegrityProxyArms` fill, in the same finalize slot as
# `fillObjectAssignProxySourceArm`. Both algorithms live in
# `object-integrity-proxy.ts`.
# 2026-09-02 (Opus, step 2): the ONE new coercion site is `__is_truthy` on a
# Proxy trap's booleanish result — §7.3.16 step 2 ("If status is false, throw"),
# §7.3.17 step 1 and §7.3.25's `desc.[[Enumerable]]` test. That helper IS the
# coercion engine's ToBoolean entry, and it is the same call the existing
# `__object_isExtensible` Proxy front-guard makes (`object-runtime-proxy.ts`);
# nothing here hand-rolls a ToString/ToNumber/equality matrix.
coercion-sites-allow:
  - src/codegen/object-integrity-proxy.ts
  # r3 (2026-09-03): `__array_from`'s GetMethod truthiness (`__is_truthy` on
  # the `@@iterator` read, the same call `buildArrayFromIterNBody` makes) and
  # the ToBoolean of a trap result in the lazy handler-proxy fetch; both are
  # the coercion engine's own entry, never a hand-rolled matrix.
  - src/codegen/array-from-native.ts
  - src/codegen/object-runtime-proxy.ts
# 2026-09-03 (Opus, r3 step R3-5c): `emitToPrimitiveMethodExports` grows by the
# IsCallable guard OrdinaryToPrimitive step 5.b.i requires — the two closure
# dispatch modes read a method FIELD and `ref.cast` it unguarded, so a
# `valueOf: null` slot TRAPPED ("illegal cast in __call_valueOf") instead of
# being treated as an absent method. The guard is one `ref.test` per mode plus
# the shared `guardedThen` wrapper; it cannot be lifted out of the recursive
# `buildDispatch` closure, which is what the +39 lines are.
func-budget-allow:
  - src/codegen/index.ts::emitToPrimitiveMethodExports
  - src/codegen/object-ops.ts::compileObjectKeysOrValues
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/array-species.ts::emitArraySpeciesCreate
  - src/codegen/array-concat-spec.ts::compileArrayConcatNativeSpecFromReceiverAndArgsVec
  - src/codegen/array-object-proto.ts::emitArrayProtoMemberBody
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  - src/codegen/object-runtime-integrity.ts::buildObjectIntegrityMutationHelpers
  - src/codegen/object-runtime-proxy.ts::fillProxyDispatch
  - src/codegen/object-proto-tostring.ts::emitObjectProtoToStringClassifier
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/calls-guards.ts::emitObjectCoercion
  # r3 (2026-09-03) — per-function growth named in the r3 section; if the
  # gate reports a different qualified name for a nested builder (e.g. the
  # `emitDispatchForMethod` arrow inside index.ts), replace the key with the
  # gate's own spelling rather than widening the list.
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/object-proto-tostring.ts::emitObjectProtoOrRefusal
  - src/codegen/object-proto-tostring.ts::emitObjectProtoToStringClassifier
  - src/codegen/array-concat-spec.ts::compileArrayConcatNativeSpecFromExprs
  - src/codegen/array-concat-spec.ts::emitConcatSource
  - src/codegen/carrier-bag-visibility.ts::fillCarrierBagVisibility
  - src/codegen/carrier-bag-visibility.ts::buildBuiltinFnSetRefusalArm
  - src/codegen/array-like-native.ts::emitArrayLikeNativeMemberBody
  - src/codegen/array-length-define.ts::maybeEmitVecLengthDefine
  - src/codegen/vec-length-set.ts::fillVecLengthDynamicArms
  - src/codegen/array-methods.ts::tryCompileArrayFlatNativeDepth1
  - src/codegen/index.ts::emitDispatchForMethod
  - src/codegen/object-runtime-proxy.ts::buildProxyRuntime
---

# #5268 — ES2015 standalone: Array + Object built-ins, r2 residual pass

Growth-allowance rationale (2026-09-01, planning pass): see the frontmatter
comment. The heavy new pieces are asked to live in new modules —
`src/codegen/object-proto-proto-accessor.ts` (step 1), `src/codegen/to-object-native.ts`
(step 3), `src/codegen/object-integrity-proxy.ts` (step 2) — so the listed
god-files only grow by wiring.

## Problem

After wave 1 (#5145 array, #5148 object-builtins; both merged) and the
2026-08-29 second passes, **159 ES2015-bucket rows under `built-ins/Array/**`
and `built-ins/Object/**` still fail in `--target standalone`**. Baseline:
`loopdive/js2wasm-baselines` standalone lane at compiler sha `d39779cb`
(2026-09-01), an ancestor of HEAD `0d9bfedee` (the 9 commits in between are
docs/CI only).

**Re-verified on HEAD 2026-09-01** with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/arrobj-head.txt --standalone`
(in-process, 159 rows; output `.tmp/es2015/arrobj-head-run1.txt`):
**0 pass · 149 fail · 10 compile_error — nothing to drop.** Per-row signatures
match the baseline except: (a) 5 `compilation timeout` rows and 7
`quickjs provider is not built` rows — all 11 `$262.createRealm` rows plus
`concat_spreadable-function.js` — an artifact of a 4-core box shared by six
agents and of the missing eval artifact, not compiler state (a `--isolate`
re-run of six rows timed out the same way at 15–26 s/compile); (b) the 5
`Object/prototype/toString/symbol-tag-*-builtin.js` rows, which the baseline
records as the `env::toString` host-import leak (compile_error) and the
in-process runner records as the runtime refusal
`Object.prototype.toString is not yet implemented` — both are the same missing
piece (step 5), and the leak reproduces from the CLI (below).

23 rows are owned elsewhere (see "Out of scope"); **136 rows are in scope**,
partitioned into the clusters below. Row lists: `.tmp/es2015/arrobj-clusters.tsv`
(path → cluster) and one `.tmp/es2015/arrobj-cl-<x>.txt` per cluster (the
letter in lower case: `arrobj-cl-a.txt` … `arrobj-cl-s.txt`, `-d2`, `-x0`…`-x3`).

## Clusters (HEAD 2026-09-01; counts partition the 159 exactly)

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|------:|----------------------------|--------------|
| A | `Object.prototype.__proto__` accessor pair missing (B.2.2.1) | 14 | No reflective accessor exists: `Object.getOwnPropertyDescriptor(Object.prototype,'__proto__')` → `undefined`, so `desc.get`/`desc.set` derefs throw ("Cannot access property on null or undefined at 3xx:11", 10 rows). `#5148` cluster 2a, deliberately not done there because `$NativeProto` glue models `memberKind: "getter"\|"method"` only (`native-proto.ts`, no set-half). The 4 semantic rows (`set-cycle`, `set-non-extensible`, `set-abrupt`, `set-cycle-shadowed`) need the setter to route through the THROWING `[[SetPrototypeOf]]` (`object-runtime-prototype.ts:708` `__object_setPrototypeOf_status`) and through the Proxy `spo` dispatch (`object-runtime-proxy.ts:1088`). | `prototype/__proto__/get-ordinary-obj.js`, `prop-desc.js`, `set-cycle.js` |
| B | `[[SetPrototypeOf]]` refusals on `%Object.prototype%` and cycle through Proxy/`$NativeProto` links | 4 | §10.4.7 immutable-prototype exotic: `Object.prototype` is a `$NativeProto`, not an `$Object`, so `__object_setPrototypeOf` (`object-runtime-prototype.ts:591`) has no flag slot to refuse on; `set-failure-cycle` walks a chain containing a Proxy whose `[[GetPrototypeOf]]` must be consulted per hop (`buildProtoDispatch`, `object-runtime-proxy.ts` ~L440). #5148 "cluster 2b residual — MODEL gap". | `prototype/setPrototypeOf-with-different-values.js`, `setPrototypeOf/set-failure-cycle.js` |
| C | Native ToObject + `Object.assign` fidelity | 14 | (C1, 7) no native §7.1.18 ToObject: `calls-guards.ts:660 emitObjectCoercion` keeps the "historical identity fallback" for standalone (L795-806), so `Object(true)`/`Object(sym)`/`Object.assign(true, …)` return the primitive; `__object_assign` (`object-runtime-enumeration.ts:1384`) only rejects nullish (L1130-1148); `Object.getOwnPropertySymbols(undefined)` (`call-builtin-static.ts:3317`) has no RequireObjectCoercible. (C2, 7) `__object_assign`'s `Set(to,k,v,true)` (via `__extern_set_strict`, `object-runtime-strict-set.ts`) is not reached for closed-shape struct targets (a `{a:1}` literal frozen via `emitStoredObjectIntegrityCall`, `call-object-builtins.ts:80`, carries no flags on the struct), a frozen object's ACCESSOR refuses its own setter (§10.1.5.3 must call it), no `$AnyStr` source arm (`Override-notstringtarget`), later-source override of a number-typed key yields `NaN` (`ObjectOverride-sameproperty`). | `assign/Target-Boolean.js`, `symbol_object-returns-fresh-symbol.js`, `assign/target-is-sealed-property-creation-throws.js` |
| D | Symbol-keyed own-property reflection on `$Vec` and closure carriers | 7 | `__getOwnPropertySymbols` (`object-runtime-descriptors.ts:3384`) has ONE receiver arm — `$Object` via `__obj_ordered_symbols`; a `$Vec` receiver returns `[]` (its symbol keys live in the #3537 expando bag / #3251 overlay, and `vec-overlay.ts:2704` explicitly says "a Symbol key has no overlay entry"; `vec-overlay-keys.ts:354` screens symbols out of NAMES, correctly, but nothing enumerates them for SYMBOLS). `__object_getOwnPropertyDescriptors` (self-hosted, `src/stdlib/object-runtime.ts:60`) walks `__getOwnPropertyNames` only — never symbols (`symbols-included`). `Object.entries` on a symbol-keyed literal yields the symbol entry (`symbols-omitted`). Function receivers: closure-carrier bag (`closure-props.ts`, #3468) does not surface a redefined-enumerable `length` in creation order. `getOwnPropertyNames(arr)` fabricates hole indices after `defineProperty(arr,"length",{value:2})`. #5148 cluster 3b/6 — its "fresh carrier" diagnosis was refuted; the real defect is the missing `$Vec` arm. | `getOwnPropertySymbols/order-after-define-property.js`, `getOwnPropertyDescriptors/symbols-included.js`, `keys/order-after-define-property-with-function.js` |
| D2 | Well-known-symbol own props of Array intrinsics | 3 | `Array.prototype[@@unscopables]` object is never materialised (`builtin-value-read.ts:180` interns the id only); `Array[@@species]` has the gOPD answer (`builtin-static-gopd.ts:279`, `SPECIES_OWNER_CTORS`) but a WRITE `Array[Symbol.species] = v` is not refused (accessor without setter → silent no-op / strict TypeError). | `prototype/Symbol.unscopables/value.js`, `Symbol.species/symbol-species.js` |
| E | `Object.*` statics bypass the Proxy MOP | 17 | Only `__extern_get/set/has`, `__delete_property`, `__getOwnPropertyDescriptor`, `__getPrototypeOf`/`setPrototypeOf`, `__object_isExtensible`/`preventExtensions`, `__object_keys`, `__getOwnPropertyNames`, `__obj_define_from_desc` carry the `$Proxy` front-guard (`object-runtime-proxy.ts:1733-2298`). NOT guarded: `__object_freeze`/`__object_seal` (`object-runtime-integrity.ts:100`, flag-setting natives — SetIntegrityLevel's per-key loop never runs, and a `$Proxy` receiver falls into the #4032 carrier-bag arm at L134, so traps never fire and `preventExtensions` abrupts are swallowed), `__object_isFrozen`/`isSealed` (`object-integrity-carrier.ts:573`), `__object_values`/`__object_entries` (`object-runtime-enumeration.ts:845/948` — and `object-ops.ts:4210` routes a `$Proxy`-typed arg to them, but `new Proxy(obj, new Proxy(handler, check))` reaches `emitObjectArgNullGuard` (`object-ops.ts:599`) via the static-struct arm at L4360 → "Object method called on null"), `__getOwnPropertySymbols`, `__object_getOwnPropertyDescriptors` (must omit keys whose gOPD trap answers undefined), `Object.defineProperties` (`object-runtime-descriptors.ts:1326` refuses `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`), `__isPrototypeOf` (`object-runtime-prototype.ts:803` walks raw `$proto` fields, `ref.eq` only — no `[[GetPrototypeOf]]` trap per hop). `Object.keys(proxy)` after the ownKeys trap must run per-key `[[GetOwnProperty]]` (EnumerableOwnProperties) — `proxy-non-enumerable-prop-invariant-3` expects 0 keys and gets 1; `proxy-keys.js` traps (`illegal cast` in `__module_init`) when the trap result is an array-LIKE object with getters (CreateListFromArrayLike in `buildOwnKeysDispatch`, `object-runtime-proxy.ts` ~L1110). | `freeze/abrupt-completion.js`, `entries/observable-operations.js`, `isPrototypeOf/arg-is-proxy.js` |
| F | Symbol-keyed expandos on FUNCTION / wrapper / RegExp carriers | 9 | `Holder[Symbol.species] = C` on a function, `Boolean.prototype[@@isConcatSpreadable]`, `re[@@isConcatSpreadable]`, `strWrapper[@@isConcatSpreadable]` do not read back through `__extern_get`: the closure-carrier side table (`closure-props.ts`, #3468) and the wrapper/RegExp carriers have string-keyed bags only. #5145 "Deliberately NOT done — Symbol-keyed properties on FUNCTION / wrapper carriers (~14 tests)", its cluster 2c. The 4 `create-proxy.js` rows additionally read `constructor` THROUGH a `$Proxy` receiver (`__extern_get` proxy guard exists) and then `[@@species]` on the function carrier — the function-carrier read is the missing half. | `map/create-proxy.js`, `concat/Array.prototype.concat_spreadable-function.js`, `concat/…_boolean-wrapper.js` |
| G | Reflective `Object.prototype.toString` residual + `env::toString` leak | 9 | (G1, 5) `toString.call(<WeakSet\|WeakMap\|Promise\|generator\|Symbol()\|Math\|JSON>)` with `var toString = Object.prototype.toString`: the runtime classifier `emitObjectProtoToStringClassifier` (`object-proto-tostring.ts:236`) has no arm for those carriers (header L185-200 lists them as deliberately unlisted) → loud refusal at L627; AND steps 14/15 are consulted only by the compile-time `.call` fold (`calls.ts:8883` → `emitObjectProtoToStringWithSymbolTag`), never by the reflective body (`emitObjectProtoOrRefusal`, L661), so `delete WeakSet.prototype[Symbol.toStringTag]` cannot change the answer. **Leak repro** (`.tmp/es2015/probes/ts2.js`, CLI `--standalone`): the module imports `env::toString` (declared, never called — a collector-registered import; imports manifest intent `{type:"builtin",name:"toString",paramCount:0}`) because script-level `var toString` merges with the ambient global `toString` and the collector registers the ambient function; `Object.prototype.toString.call(wm)` (ts3) has NO imports. (G2, 2) `get-symbol-tag-err` (abrupt @@toStringTag getter must propagate on the reflective path) and `symbol-tag-override-primitives` (`Boolean.prototype[@@toStringTag]='test262'` must be seen through ToObject(true)'s prototype). (G3, 2) `proxy-array`/`proxy-revoked-during-get-call`: the `$Proxy` arm is an explicit refusal (L493-502) because IsArray must unwrap to the target and throw on a revoked proxy — shares cluster I's `__extern_is_array` Proxy arm. NOT the #4119-blocked part: #4119 is blocked on TypedArray/ArrayBuffer/Symbol.prototype IDENTITY rows and the `$NativeProto` parent-chain `Get`; none of these 9 receivers is a `$NativeProto`. | `toString/symbol-tag-weakset-builtin.js`, `toString/get-symbol-tag-err.js`, `toString/proxy-array.js` |
| H | `toLocaleString` must `Invoke(O,"toString")` / per-element `.toLocaleString()` | 4 | `Object.prototype.toLocaleString` is folded to `toString` statically (`builtin-prototype-brand.ts:536` only guards nullish `this`); `Array.prototype.toLocaleString` shares `join` (`array-methods.ts:2332-2340`) and never invokes the element's own `toLocaleString`, so a patched `Boolean.prototype.toLocaleString` is not observed. #5148 cluster 7a / #5145 cluster 9. | `Object/prototype/toLocaleString/primitive_this_value.js`, `Array/prototype/toLocaleString/primitive_this_value_getter.js` |
| I | IsArray (§7.2.2) over `$Proxy`: unwrap + revoked TypeError | 4 | `fillExternIsArray` (`object-runtime.ts:8199`) implements "the non-Proxy subset of IsArray" (its own header) — no `$Proxy` arm at all. `ArraySpeciesCreate` step 3 (`emitArraySpeciesCreate`, `array-species.ts:261`) starts at `Get(O,"constructor")` (L275) with no IsArray step before it, so a revoked proxy receiver reads `constructor` (must throw first: `create-revoked-proxy.js` asserts `ctorCount === 0`). | `isArray/proxy-revoked.js`, `map/create-revoked-proxy.js` |
| J | concat protocol residuals | 12 | In `array-concat-spec.ts`: (a) `arguments` carrier after `defineProperty(args,"length",{value:6})`: indices 3-5 are absent but `__extern_has_idx` answers true and the read yields `ref.null` → `null` instead of a hole/`undefined` (3 rows; the `__arguments_vec` length-override arm is `object-runtime.ts:11060-11110`); (b) `$Hole` marker escapes an output reader (`concat_spreadable-sparse-object`, "uncaught Wasm-GC exception"; hole substrate `array-concat-spec.ts:127/357`); (c) `ToLength(Get(E,"length"))` on an object length: `valueOf:null` → `__call_valueOf` dispatcher (`index.ts:9324 emitDispatchForMethod`) `ref.cast`s a null field to a closure type → illegal cast (must skip non-callables per OrdinaryToPrimitive); `{valueOf:null,toString:null}` must throw TypeError (`concat_array-like-to-length-throws`); a proxy-backed `length` answers 0 so the step-5.c.iii check (L230) never fires (`arg-length-exceeding-integer-limit`); (d) IsConcatSpreadable on an ARRAY with a falsy non-nullish `@@isConcatSpreadable` (`null`/`false`/`0`/`NaN`) must NOT spread — the L205-224 arm treats `null` as "absent → IsArray" (`is-concat-spreadable-val-falsey`); (e) `is-concat-spreadable-get-order`: the species `constructor` read must precede the `@@isConcatSpreadable` read of the receiver; (f) TypedArray carriers: `[].concat(ta)` spreads the TA (IsArray answers true for a `$__ta_view`, or the TA's `@@isConcatSpreadable` expando is not readable) — 2 rows, needs only the IsArray answer `false` for TA carriers plus the TA expando read; (g) `is-concat-spreadable-proxy` traps in `__module_init` (Proxy with a `get` trap as the concat ARGUMENT). | `concat/Array.prototype.concat_sloppy-arguments.js`, `concat/is-concat-spreadable-val-falsey.js`, `concat/…_array-like-length-to-string-throws.js` |
| L | `Array.from` / `Array.of` completion | 18 | Unchanged from #5145 cluster 3 (not started there): direct-call arms in `call-builtin-static.ts:1147-1420` cover string/generator/Set/Map/iterable-no-mapFn (#2169c, L1369) and `__array_from_mapped` (#3206, L1408 → `iterator-native.ts:1006`); no array-like (non-iterable) arm — `__iterator` throws `value is not iterable` (`iterator-native.ts:2121`); mapFn called with 3 args via `__hof_map` (`iter-map-fn-args` measures `args[0].length === 2`); `__array_from_mapped` sizes the result from garbage on iterator sources ("requested new array is too large", `iter-map-fn-err`); no IteratorClose on abrupt (`closeCount`); no this-constructor protocol (`Array.from.call(C, …)`, `Array.of.call(T, …)`); element writes are `Set` not `CreateDataPropertyOrThrow` (`of/does-not-use-prototype-properties`, `return-abrupt-from-data-property-using-proxy`); the reflective/value form hits the generic refusal `builtin-value-read.ts:1664` (`${key} is not yet implemented`) because the closure switch at L976 has no `Array.from`/`Array.of` case. | `from/source-object-length.js`, `from/iter-cstm-ctor-err.js`, `of/construct-this-with-the-number-of-arguments.js` |
| M | `keys`/`values`/`entries` not callable as values | 3 | `array-object-proto.ts:904` refusal in `emitArrayProtoMemberBody` (L845): `emitArrayLikeNativeMemberBody` (`array-like-native.ts:546`) covers push/reverse/unshift only; the HOF route (L872) excludes these. #5145 cluster 5. | `prototype/keys/returns-iterator-from-object.js` |
| N | ArraySetLength (§10.4.2.4) define/set semantics | 3 | `maybeEmitVecLengthDefine` (`array-length-define.ts:111`) handles primitive-coercible values only (header: object-valued descriptor "DEFERRED"); `vec-length-set.ts` (the `arr.length = v` arm) does not call ToNumber twice nor throw on a non-writable length made non-writable DURING coercion (`coercion-order-set`); `no-value-order` throws "Cannot redefine property: enumerable attribute". #5145 cluster 6. | `length/define-own-prop-length-coercion-order.js` |
| O | Species result write vs `$Vec` dense-slot read | 4 | #5145 measured: `Object.defineProperty(q, 0, …)` on a `$vec` followed by `verifyProperty(q, 0, …)` fails on clean HEAD — the overlay descriptor read answers the defined value while the harness's dynamic `obj[name]` read answers the stale dense slot (`vec-overlay.ts` consult at L2698 vs the typed-lane read). Not a species bug. | `map/target-array-with-non-writable-property.js` |
| P | `ArrayCreate(len)` RangeError for `len ≥ 2^32` | 3 | The receiver length reaches the species prologue through an **i32** vec field (`array-species.ts` `externLength` dep is f64, but the vec fast path truncates `2^32` to 0 before it) — #5145 "needs a wider length carrier". Also `slice/create-proxied-array-invalid-len` (length read through a Proxy `get` trap → same RangeError). | `map/create-species-undef-invalid-len.js` |
| Q | `flat`/`flatMap` native arm missing | 4 CE | `Codegen error: Array.prototype.flat() is not yet supported in --target standalone` (#2717; `tryCompileArrayFlatNativeDepth1`, `array-methods.ts` ~L9996, #3363 accepts homogeneous receivers only) — these rows need the depth-1 arm to accept a species-created heterogeneous target and route writes through `__defineProperty_value`. | `flat/target-array-non-extensible.js` |
| R | Array algorithms must route `HasProperty`/`DeletePropertyOrThrow` through the MOP | 3 | `compileArrayCopyWithin` (`array-methods.ts` ~L2298) reads/deletes via raw vec ops on a `$Proxy` receiver instead of `__extern_has`/`__delete_property` (both carry the Proxy guard); `splice/property-traps-order-with-species` asserts the full trap sequence. #5145 cluster 7 (deferred there). | `copyWithin/return-abrupt-from-has-start.js` |
| S | `hasOwnProperty`: ToPropertyKey before ToObject | 1 | `tryBorrowedPrototypeNullishThisThrow` (`builtin-prototype-brand.ts`, table L536) throws for `.call(null, key)` BEFORE evaluating the key's ToPrimitive (§20.1.3.2 step 1 is `? ToPropertyKey(V)`); `compilePropertyIntrospection` (`object-ops.ts:4563`) has the same order for the dynamic receiver. #5148 cluster 7b. | `prototype/hasOwnProperty/topropertykey_before_toobject.js` |

In-scope total: 136. Sum check: A14 + B4 + C14 + D7 + D2 3 + E17 + F9 + G9 +
H4 + I4 + J12 + L18 + M3 + N3 + O4 + P3 + Q4 + R3 + S1 = 136.

### Out of scope (owned elsewhere) — 23 rows, listed so nobody re-derives them

| # | Rows | Owner / reason |
|---|------|----------------|
| X0 | 11 × `*proto-from-ctor-realm*` (`Array/proto-from-ctor-realm-{zero,one,two}`, `from/`, `of/`, `{concat,filter,map,slice,splice}/create-proto-from-ctor-realm-non-array`, `Object/proto-from-ctor-realm`) | `$262.createRealm` rows — realm/eval-engine lane; locally they fail as `quickjs provider is not built`. |
| X1 | `Object/subclass-object-arg.js` | #3371 (blocked) — standalone `Reflect.construct` distinct NewTarget. |
| X2 | 8 × §10.5.11 ownKeys result-invariant rows (`getOwnPropertyNames/proxy-invariant-*` ×2, `getOwnPropertySymbols/proxy-invariant-*` ×4, `keys/proxy-non-enumerable-prop-invariant-{1,2}`) | Proxy-internal validators: `object-runtime-proxy.ts:408` (#5140) implements only the target-independent half and defers the descriptor-model rules ("ownKeys key-set exactness") to #1355 slice G; the Proxy lane (#5196 in-progress, PR #5389) owns them. Do NOT re-implement here. |
| X3 | `slice/create-revoked-proxy.js`, `concat/is-concat-spreadable-proxy-revoked.js`, `concat/is-concat-spreadable-is-array-proxy-revoked.js` | `handle.revoke()` INSIDE a closure traps `illegal cast in __closure_N ← __call_fn_method_3 ← __apply_closure`: the `$__proxy_revoker` callable carrier has its arm on `__apply_closure` only (`object-runtime.ts:7662-7685`), not on the `__call_fn_method_<N>` dispatchers minted by `closure-exports.ts:1353`. That is the `Proxy.revocable` subtree (#5196 owns 7 `revocable/` rows with the same carrier). Check `git log origin/main --grep=5196` before starting; if #5196 has not added the arm, the 12-line mirror of L7662-7685 into `emitClosureCallExportN` is an acceptable adoption here — but say so in the PR and cross-link. |

Other owned areas confirmed absent from this list: `Reflect.set` receiver
(#2046), generator carriers (#680/#2864), TypedArray algorithms (#4449/#4490).

## Implementation Plan

Ordered by yield per unit of work; every step is independently shippable
(one PR per step or per pair is fine). After each step re-run that step's
sub-list AND `.tmp/es2015/arrobj-controls.txt` (20 rows, all pass on HEAD —
verified 2026-09-01, `.tmp/es2015/arrobj-controls-run1.txt`). Probe:
`npx tsx scripts/run-test262-paths.mts <list> --standalone` (in-process; use
`--isolate` only for rows that poison the realm — none of the 159 does; and
note that on a loaded 4-core box `--isolate`'s ~15 s compile budget times out
ordinary rows, so run it when the box is quiet or not at all). Type queries go
through `ctx.oracle` (`src/checker/oracle.ts`); raw `ctx.checker` trips the
oracle ratchet.

### Step 1 — `__proto__` accessor pair + throwing setter (clusters A + B; 18 rows; list `arrobj-cl-a.txt` + `arrobj-cl-b.txt`)

New module `src/codegen/object-proto-proto-accessor.ts`, copying the shape of
`object-proto-annex-b-accessors.ts` (#4479: two natives, reflective closures
with spec `.name`, gOPD wiring in `builtin-static-gopd.ts:279
tryEmitStandaloneBuiltinStaticGopd`).

1. Natives `__object_proto_get(this)` = RequireObjectCoercible(this) →
   `__getPrototypeOf(ToObject(this))` (reuse `__getPrototypeOf`, which carries
   the Proxy `gpo` guard, `object-runtime-proxy.ts:1944`); and
   `__object_proto_set(this, proto)` = RequireObjectCoercible(this); if `proto`
   is neither Object nor null → return undefined; if `this` is not an Object →
   return undefined; else `status = __object_setPrototypeOf_status(this, proto)`
   (`object-runtime-prototype.ts:708`, the #5148 pure predicate) — if false,
   throw TypeError (`buildThrowJsErrorInstrs(ctx, "TypeError", …)`, the exact
   mechanism `__object_assign`'s nullish guard uses at
   `object-runtime-enumeration.ts:1142`); else perform the write via
   `__object_setPrototypeOf` (L591). Route a `$Proxy` receiver to
   `__proxy_spo_dispatch` (`object-runtime-proxy.ts:1088`) BEFORE the status
   check so `set-abrupt.js`'s `setPrototypeOf` trap abrupt escapes.
2. Reflective closures named `"get __proto__"` / `"set __proto__"`
   (`get-fn-name.js`, `set-fn-name.js`); the gOPD answer for
   `(Object.prototype, "__proto__")` is `{get, set, enumerable:false,
   configurable:true}` (`prop-desc.js`). The #4479 module shows exactly where
   the four Annex-B names were wired — add `__proto__` beside them.
3. Cluster B needs two model fixes in `__object_setPrototypeOf_status`:
   (a) **immutable-prototype exotic**: when `obj` is the `%Object.prototype%`
   `$NativeProto` (brand test via `NATIVE_PROTO_BRAND_FIELD`, pattern
   `object-proto-tostring.ts:440-455`) and `proto` is not null → answer
   false (§10.4.7.1: only same-value succeeds; the three
   `setPrototypeOf-with-*` rows also assert `Reflect.setPrototypeOf(...) ===
   false`, so this must be the predicate, not the call site);
   (b) **cycle walk through Proxy links** (`set-failure-cycle.js`,
   `set-cycle-shadowed.js`): the §10.1.2.1 step-8 loop must stop with
   `done=true` when a link is a Proxy (its `[[GetPrototypeOf]]` is not the
   ordinary one) — today the walk reads raw `$proto` fields. Edge: a chain
   that reaches a `$NativeProto` (`$parent` null) ends there.

Edge cases: `Object.prototype.__proto__ = x` with `x` primitive returns
undefined (no throw); `({}).__proto__ = null` succeeds; the getter on a
primitive receiver boxes first (`get-to-obj-abrupt` expects the ToObject
TypeError for null/undefined only).

### Step 2 — Proxy MOP in the Object statics (cluster E; 17 rows; `arrobj-cl-e.txt`)

New module `src/codegen/object-integrity-proxy.ts` holding one
post-registration fill per native, following `fillObjectAssignProxySourceArm`
(`object-runtime-enumeration.ts:1590`: `definedFuncAt` → `body.unshift(ref.test
$Proxy → arm)`, idempotence check, FACTORY instr arrays — never share an
`Instr[]` between two arms, #5188 followUp 4). Call it from the same finalize
site that calls `fillObjectAssignProxySourceArm`.

1. `__object_freeze` / `__object_seal` (`object-runtime-integrity.ts:100`):
   Proxy arm = real §7.3.16 SetIntegrityLevel: `__proxy_prevext_dispatch(p)`
   (abrupt propagates — `freeze/abrupt-completion.js`; ToBoolean false →
   TypeError), then `keys = __proxy_ownkeys_names_dispatch(p)` (returns the
   trap result AFTER CreateListFromArrayLike, string+symbol keys in trap
   order), then per key: sealed → `__proxy_define_dispatch(p, k,
   {configurable:false})`; frozen → `d = __proxy_gopd_dispatch(p, k)`; skip
   undefined; accessor → `{configurable:false}`, data →
   `{configurable:false, writable:false}` (build the descriptor object with
   `__new_plain_object` + `__extern_set`, the way `array-species.ts`'s result
   swap builds descriptors). The trap-order rows
   (`proxy-no-ownkeys-returned-keys-order`, `proxy-with-defineProperty-handler`)
   assert exactly this sequence. IMPORTANT: put the Proxy arm ABOVE the
   #4032 carrier-bag arm at L134, otherwise the `$Proxy` falls into the bag
   path silently.
2. `__object_isFrozen` / `__object_isSealed` (`object-integrity-carrier.ts:573`,
   `emit(...)`): Proxy arm = §7.3.17 TestIntegrityLevel:
   `__proxy_isext_dispatch` true → false; then ownKeys + per-key gopd; any
   configurable (or, frozen, writable data) → false.
3. `__object_values` / `__object_entries` (`object-runtime-enumeration.ts:845/948`):
   Proxy arm = EnumerableOwnProperties: `__proxy_ownkeys_names_dispatch`,
   then for STRING keys `d = __proxy_gopd_dispatch`; skip undefined/
   non-enumerable; `v = __proxy_get_dispatch(p, k, p)`. Log order in
   `entries/observable-operations.js` is `ownKeys, gopd:a, get:a, gopd:b, …`.
   Also fix the call site: `object-ops.ts:4360/4478` reach
   `emitObjectArgNullGuard` when the argument's TS type is the target's
   struct (`new Proxy(object, …)` is typed as `object`'s literal type) —
   gate on `ctx.oracle` proving a literal shape, and route anything else
   (including Proxy-constructed values) to the L4210 native path.
4. `__object_keys` post-trap enumerability (`proxy-non-enumerable-prop-invariant-3`):
   after `__proxy_ownkeys_keys_dispatch` returns the trap list, filter through
   `__proxy_gopd_dispatch` per key (EnumerableOwnProperties step 4.a) — this is
   NOT the §10.5.11 invariant (X2); it is `Object.keys`'s own algorithm.
   `proxy-keys.js` (illegal cast in `__module_init`): the ownKeys trap returns
   an array-LIKE `$Object` with getters; `buildOwnKeysDispatch`'s
   CreateListFromArrayLike (`object-runtime-proxy.ts` ~L1120) must read
   `length` and indices through `__extern_get` (getter-aware), not
   `__extern_get_idx` on a cast vec. Confirm with a 6-line repro first.
5. `__getOwnPropertySymbols` (`object-runtime-descriptors.ts:3384`): Proxy arm
   = ownKeys result filtered to `$Symbol` carriers. `__object_getOwnPropertyDescriptors`
   (self-hosted `src/stdlib/object-runtime.ts:60`): switch the key source from
   `__getOwnPropertyNames` to an ownKeys helper that yields strings AND symbols
   (also needed by step 4), and SKIP keys whose descriptor is undefined
   (`proxy-undefined-descriptor.js`).
6. `Object.defineProperties(proxy, props)` (`object-runtime-descriptors.ts:1326`
   refusal `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`): when the TARGET is a
   `$Proxy`, apply per key through `__proxy_define_dispatch` in ownKeys order
   of `props` (`defineProperties/proxy-no-ownkeys-returned-keys-order.js`).
7. `__isPrototypeOf` (`object-runtime-prototype.ts:803`): replace the raw
   `struct.get $proto` hop with `__getPrototypeOf(cur)` (Proxy `gpo` guard
   included) so `isPrototypeOf/arg-is-proxy.js` sees the trap.
8. `keys/property-traps-order-with-proxied-array.js`: an ARRAY target behind a
   Proxy — same ownKeys/gopd sequence; verify after 1-7, it may flip for free.

### Step 3 — Native ToObject + `Object.assign` (cluster C; 14 rows; `arrobj-cl-c.txt`)

1. New `src/codegen/to-object-native.ts`: native `__to_object(v: externref)
   -> externref` for standalone/wasi — dispatch on the boxed tag: number →
   `__new_Number(f64)` (`object-runtime.ts:2952`), string → `__new_String`
   (L2968), boolean → `__new_Boolean` (L2996), `$Symbol` carrier → a wrapper
   `$Object` holding the carrier in the `WRAPPER_PRIMITIVE_KEY` slot (pattern
   `wrapper-proto-value-of.ts`), object/closure/proxy → identity,
   null/undefined → TypeError "Cannot convert undefined or null to object".
   Route (a) `emitObjectCoercion`'s standalone fallthrough
   (`calls-guards.ts:795-806`, currently identity) — this fixes
   `Object(sym)` (`symbol_object-returns-fresh-symbol.js`: `Object(symA) !==
   symA`, `typeof === "object"`); (b) `__object_assign`'s target
   (`object-runtime-enumeration.ts:1130-1148`, replace the nullish-only guard
   with `__to_object`) — fixes `Target-{Number,Boolean,String,Symbol}` and
   `OnlyOneArgument` (return value must be the wrapper); (c)
   `Object.getOwnPropertySymbols(x)` (`call-builtin-static.ts:3317`) — apply
   `__to_object` to the argument (TypeError on nullish,
   `non-object-argument-invalid.js`).
2. `Object.assign` copy loop (`object-runtime-enumeration.ts:1384`, strict set
   at L767): (a) closed-shape struct targets — `Object.freeze({a:1})` compiles
   through `emitStoredObjectIntegrityCall` (`call-object-builtins.ts:80`) into
   the flag natives, but a literal that stays a static struct never carries the
   flags where `__extern_set_strict` looks; the smallest fix is to make the
   `assign` call site coerce a target whose `ctx.oracle` fact is a literal
   struct through the same "route to `$Object`" that `Object.defineProperty`
   uses for added props (`object-ops.ts:4275 hasAddedDefineProp`), so
   `target-is-{frozen,sealed,non-extensible}-*-throws.js` reach the flagged
   `$Object`. (b) frozen ACCESSOR: `__extern_set_strict` reports REFUSED for an
   accessor on a frozen object — §10.1.5.3 step 2/3: an accessor with a setter
   CALLS the setter regardless of the frozen flag (only data properties are
   write-refused); fix in `object-runtime-strict-set.ts` (accessor check before
   the frozen/writable check) — `target-is-frozen-accessor-property-set-succeeds`,
   `target-is-non-extensible-existing-accessor-property` (note the second one
   also needs the symbol-keyed setter, cluster D's carrier work is not required —
   `{ set [sym](v){} }` is an `$Object`). (c) string source: add an `$AnyStr`
   source arm that copies index keys `"0".."len-1"` (`Override-notstringtarget`).
   (d) `ObjectOverride-sameproperty` (expected `"c"`, got `NaN`): the second
   source's `a: "c"` overrides the first's `a: 1` — the target's `a` was typed
   number by the first source and the string write coerces; route the write
   through `__extern_set_strict` with an externref value, never through a typed
   field store.

### Step 4 — Symbol keys on `$Vec`/closure carriers + intrinsic symbol props (clusters D + D2; 10 rows; `arrobj-cl-d.txt` + `arrobj-cl-d2.txt`)

1. `__getOwnPropertySymbols` (`object-runtime-descriptors.ts:3384`): add a
   `$__vec_base` arm that enumerates the #3537 expando bag's symbol keys
   (`vec-props.ts:440-470` shows the bag lookup: `bagLookupIdx` → `$Object`;
   reuse `__obj_ordered_symbols` on the bag) — the bag DOES store symbol keys
   (5148 measured plain symbol-keyed writes work); then a closure arm
   through the #3468 side table (`closure-props.ts` — compose via its exported
   readers, do not edit the file; ownership note in the `vec-props.ts` header).
   Fixes `getOwnPropertySymbols/order-after-define-property.js` (array half),
   `getOwnPropertyDescriptors/symbols-included.js` (with step 2.5's key
   source), `getOwnPropertyDescriptors/order-after-define-property.js`.
2. `Object.entries` must OMIT symbol keys (`entries/symbols-omitted.js`): the
   static-struct arm at `object-ops.ts:4360` enumerates literal fields
   including computed-symbol ones — filter fields whose key is a symbol (the
   `ctx.oracle` literal-shape fact knows the key kind).
3. Function receivers: `Object.keys(fn)` / `Object.entries(fn)` after
   `fn.a = 1; Object.defineProperty(fn, "length", {enumerable: true})` must
   yield `["length", "a"]` — `bagKeysTail` (`carrier-bag-visibility.ts:196`)
   only lists bag expandos; a redefined-enumerable builtin own property
   (`length`, `name`) must be emitted FIRST (creation order predates expandos).
4. `getOwnPropertyNames(arr)` after `defineProperty(arr,"length",{value:2})`:
   `vec-overlay-keys.ts` (RC2 in its header) enumerates `0..length-1` — use
   the hole-aware presence helper (`vec-overlay-presence.ts`) so holes are not
   fabricated.
5. D2: materialise `Array.prototype[@@unscopables]` as a null-prototype
   `$Object` with the ES2015 seven names (`copyWithin, entries, fill, find,
   findIndex, keys, values`; keep the ES2016+ `includes`… out unless the value
   test reads them — `value.js` asserts the full modern list, read it first)
   with `{writable:false, enumerable:false, configurable:true}`; expose through
   `tryEmitStandaloneBuiltinStaticGopd` (`builtin-static-gopd.ts:279`) and the
   `Array.prototype` companion read. For `Array[@@species]` make the write
   `Array[Symbol.species] = v` a refused accessor write (strict → TypeError,
   sloppy → no-op) via the existing `$NativeProto` write refusal path used for
   builtin getters.

### Step 5 — Reflective `Object.prototype.toString` + `env::toString` leak (cluster G; 9 rows; `arrobj-cl-g.txt`)

1. **Leak first (CE → fail is not a fix; the leak must close natively).**
   Repro: `npx tsx src/cli.ts .tmp/es2015/probes/ts2.js --standalone -o
   .tmp/es2015/probes/out2` → `imports: env::toString` (script:
   `var toString = Object.prototype.toString; var wm = new WeakSet();
   toString.call(wm)`); the same with `Object.prototype.toString.call(wm)` has
   no imports. The import is DECLARED but never called in the WAT, i.e. it is
   registered by the collector (`declarations/import-collector.ts`) for the
   ambient global `toString` that the script-level `var toString` merges with
   (the CLI prints `warning: Duplicate identifier 'toString' (2×)`). Locate the
   registration with a temporary `if (name === "toString") console.trace()` in
   `registry/imports.ts addImport` — then make a script-scope `var` of the
   same name SHADOW the ambient global for the collector, the way
   `standalone-global-functions.ts:97 ensureAmbientParseHelper` already keeps
   user bindings apart from realm builtins ("shadow-save protocol"). Re-verify
   with the CLI (0 imports) before touching the classifier. Never add
   `toString` to the host-import allowlist.
2. Reflective body: make `emitObjectProtoOrRefusal` (`object-proto-tostring.ts:661`)
   consult `ensureObjectProtoSymbolTagFn` (`object-proto-symbol-tag.ts:80`)
   FIRST — a real `[[Get]]` of `@@toStringTag` through `__extern_get`
   (Proxy-trapping, getter-abrupt-propagating: fixes `get-symbol-tag-err.js`
   and makes `delete WeakSet.prototype[Symbol.toStringTag]` observable) — and
   only then run the classifier. For a PRIMITIVE receiver (`toString.call(true)`,
   `symbol-tag-override-primitives.js`) the Get must go through the wrapper's
   prototype: box via step 3's `__to_object` before the Get.
3. Classifier arms for the carriers the header (L185-200) leaves unlisted,
   ONLY as the step-13 fallback AFTER the @@toStringTag Get declined: WeakSet,
   WeakMap, Promise, generator objects, `$Symbol` primitive/wrapper, `Math`,
   `JSON` → `[object Object]` (their own tag property having been deleted or
   replaced by a non-string is exactly why the tests expect the default).
   Use the owning brand predicates (`ref.test` on the registered
   `$__WeakSet`/`$__Promise`/generator carrier types, `__typeof_symbol`) —
   never a blanket "else Object" (the module header forbids it; keep the loud
   refusal as the tail).
4. Proxy arm (`proxy-array.js`, `proxy-revoked-during-get-call.js`): §20.1.3.6
   step 4 `IsArray(O)` — use step 6's `__extern_is_array` Proxy arm (unwrap to
   target, TypeError on revoked), then step 14's Get through the proxy.
   Why this is not the #4119-blocked part: #4119 is blocked on TypedArray /
   ArrayBuffer / `Symbol.prototype` IDENTITY assertions and on a `$NativeProto`
   own-plus-parent `Get`; none of these 9 receivers is a `$NativeProto`, and the
   `Get(O, @@toStringTag)` here is on ordinary carriers whose chain
   `__extern_get` already walks.

### Step 6 — IsArray over `$Proxy` + species step 3 (cluster I; 4 rows; `arrobj-cl-i.txt`)

`fillExternIsArray` (`object-runtime.ts:8199`): prepend a `$Proxy` arm — if
revoked (`F_PTARGET` null; the revoked test the `__proxy_*_dispatch` helpers
already emit) → throw TypeError; else recurse on the target (bounded loop, a
proxy-of-proxy is `proxy-array.js`'s third assertion). Then in
`emitArraySpeciesCreate` (`array-species.ts:261`) emit `IsArray(O)` BEFORE
`Get(O,"constructor")` (L275): non-array → default lane; the call itself throws
for a revoked proxy, which is what `{map,filter,splice}/create-revoked-proxy.js`
assert (`ctorCount === 0`, `cbCount === 0`). `Array.isArray(proxy)` direct call
(`call-builtin-static.ts:667`) already routes an externref arg to
`emitArrayIsArrayExternrefPredicate` → same native.

### Step 7 — Symbol-keyed expandos on function / wrapper / RegExp carriers (cluster F; 9 rows; `arrobj-cl-f.txt`)

The #3468 closure side table (`closure-props.ts`) and the wrapper/RegExp
carriers key by native string. Add a symbol-key lane the same way `$Object`'s
`$PropEntry` stores a `$Symbol` carrier key (compare `__obj_hash`'s symbol arm,
`object-runtime.ts` ~L1551): `__extern_get`/`__extern_set` on a closure
externref with a `$Symbol` key must reach the side table. Compose through the
`buildVecOrClosure*` layering named in the `vec-props.ts` header — do not
edit `closure-props.ts` directly if its exports suffice. Verify with the
10-line repro `function H(){}; H[Symbol.species] = 1; H[Symbol.species]`
before the test list. Then `{map,filter,slice,splice}/create-proxy.js`
(species chain `proxy → array.constructor (fn) → fn[@@species]`) and the four
`concat_spreadable-{function,reg-exp,boolean-wrapper,string-wrapper}.js` rows
flip; the string-wrapper row additionally spreads code units through
`__extern_get_idx` on the wrapper (string-exotic index reads exist:
`string-exotic-own-props.ts`).

### Step 8 — concat residuals (cluster J; 12 rows; `arrobj-cl-j.txt`), in `array-concat-spec.ts`

(a) arguments carrier: the L11060-11110 length-override arm in
`object-runtime.ts` answers the redefined `length` (6) but `__extern_has_idx`
must answer false for `3..5` (they were never supplied) and the spreadable loop
must then write a HOLE (the `$Hole` marker), which the output readers map to
`undefined` — never `ref.null`.
(b) `$Hole` escape (`concat_spreadable-sparse-object`): audit the readers the
header (L83-88) names; the escaping path is the `Array.prototype.concat.call(obj, …)`
entry `compileArrayConcatNativeSpecFromExprs` (L348) whose result flows into
`compareArray` — make sure `ctx.usesNativeConcatHoleSubstrate` (L357) is set
before the object-runtime finalize that patches the readers.
(c) ToLength on an object `length`: fix the `valueOf` dispatcher minted by
`emitDispatchForMethod("valueOf","__call_valueOf")` (`index.ts:9324`) to
`ref.test` the closure type before `ref.cast` and treat a non-callable slot as
absent (OrdinaryToPrimitive step 5.b.i `IsCallable`), then throw TypeError when
neither `valueOf` nor `toString` is callable (`concat_array-like-to-length-throws`,
`…-length-to-string-throws`). For `arg-length-exceeding-integer-limit` the
Proxy-backed `length` read must go through `__extern_get` (Proxy guard) so
the step-5.c.iii check at L230 sees `MAX_SAFE_INTEGER`.
(d) `is-concat-spreadable-val-falsey`: at L205-224 distinguish ABSENT
(`undefined` singleton → IsArray) from a present falsy value (`null`, `false`,
`0`, `NaN` → ToBoolean → not spreadable): test `__extern_is_undefined` only,
not `ref.is_null`.
(e) `is-concat-spreadable-get-order`: emit the species prologue (its
`constructor` Get) before the receiver's `@@isConcatSpreadable` Get — the
receiver-first ordering in `compileArrayConcatNativeSpecFromExprs` (L370-380)
already stashes the receiver; move the spreadable read after the prologue.
(f) TypedArray carriers (`concat_{large,small}-typed-array`): `__extern_is_array`
must answer false for `$__ta_view` (it is not in `collectStandaloneArrayCarrierTypeIdxs`
— verify, `object-runtime.ts:8162`), and the TA's `@@isConcatSpreadable`
expando must be readable (TA carriers have an expando field, #3177) — if the
expando read needs #4449-owned TA internals, defer these 2 rows and say so.
(g) `is-concat-spreadable-proxy` (illegal cast in `__module_init`): Proxy as a
concat ARGUMENT with a `get` trap — the spreadable read at L205 must go through
`__extern_get` (Proxy guard), not a `ref.cast $Object` fast path; 6-line repro
first.

### Step 9 — `Array.from` / `Array.of` (cluster L; 18 rows; `arrobj-cl-l.txt`)

Follow #5145 Step 4 verbatim (it was never started; its sub-steps 4a-4f are
still exact): array-like source arm beside the L1369 iterable drain
(`GetMethod(items,@@iterator)` undefined → `len = ToLength(Get(items,"length"))`,
`Get(items,k)` via `__extern_length`/`__extern_get_idx`); 2-arg mapper variant
(`iter-map-fn-args`); this-constructor protocol via `reserveNativeConstructDriver`
(the driver `array-species.ts` already uses for `Construct(C, «len»)`) for both
`from` and `of`; writes through `__defineProperty_value` with
`CREATE_DATA_PROPERTY_FLAGS` (`array-species.ts:~L90`) — that is what
`of/does-not-use-prototype-properties`, `of/return-abrupt-from-data-property-using-proxy`
and `from/iter-set-elem-prop-non-writable` check — then `Set(A,"length",n)`
with `__extern_set_strict` (`iter-set-length-err` expects the poisoned `length`
setter's abrupt); IteratorClose on abrupt mapper/define (`iter-set-elem-prop-err`,
`iter-map-fn-err`) — reuse the for-of IteratorClose emission in
`iterator-native.ts`; fix `__array_from_mapped` (`iterator-native.ts:1006`)
sizing (grow-on-push); reflective/value form: add `case "Array.from"` /
`"Array.of"` to the closure switch in `ensureStandaloneBuiltinStaticMethodClosure`
(`builtin-value-read.ts:962`, beside `Array.isArray` at L977) with bodies that
call the same native core, so `Array.from.call(C, items)` / `this-null.js`
stop hitting the L1664 refusal. `source-array-boundary` (MAX_VALUE etc.) is the
mapper receiving a boxed f64 — check the value crossing once the 2-arg mapper
exists.

### Step 10 — small clusters (H, M, N, O, P, Q, R, S; 25 rows)

- **M (3)** `arrobj-cl-m.txt`: in `emitArrayProtoMemberBody`
  (`array-object-proto.ts:845`) give `keys`/`values`/`entries` a body: ToObject
  guard (copy the #4394 guard at L872-885), then mint the native array iterator
  over `__extern_length`/`__extern_get_idx` (the direct `a.values()` lowering in
  `iterator-native.ts` has the state struct; factor its core). The test also
  asserts `Object.getPrototypeOf(iter) === %ArrayIteratorPrototype%`.
- **H (4)** `arrobj-cl-h.txt`: `Object.prototype.toLocaleString` → emit
  `Invoke(O,"toString")` through the dynamic member-call path (`__extern_get` +
  `__call_fn_method_0`), not the static fold; `Array.prototype.toLocaleString`
  → per element `Invoke(elem,"toLocaleString")` joined by `,` (a new arm beside
  `compileArrayJoinExtern`, `array-methods.ts:5404`); a primitive `this` boxes
  through `__to_object` (step 3).
- **N (3)** `arrobj-cl-n.txt`: ArraySetLength in `vec-length-set.ts` /
  `array-length-define.ts:111`: ToNumber(value) TWICE (both hints observed,
  `coercion-order-set`), RangeError on mismatch, TypeError when `length` became
  non-writable during coercion (strict) / `false` from `Reflect.set`; the
  `no-value-order` row: `defineProperty(arr,"length",{writable:true})` with no
  `value` must not touch enumerable.
- **O (4)** `arrobj-cl-o.txt`: make the typed-lane `obj[name]` read consult the
  #3251 overlay when a descriptor exists for that index (the consult at
  `vec-overlay.ts:2698` is gated on `overlayRouteActive` — the #4491 wave-4
  "frozen-element pin only reproduces when the module contains a `delete
  obj[k]`" finding is the same gate). Reduce with the species-free repro from
  #5145's results first.
- **P (3)** `arrobj-cl-p.txt`: carry the species `len` as f64 from the
  receiver's dynamic `length` (`__extern_length`, already an
  `ArraySpeciesDeps` member) instead of the i32 vec field when the receiver is
  externref; `len ≥ 2^32` in the DEFAULT lane → RangeError "Invalid array
  length" (`buildThrowJsErrorInstrs(ctx,"RangeError",…)`).
- **Q (4 CE)** `arrobj-cl-q.txt`: extend `tryCompileArrayFlatNativeDepth1`
  (`array-methods.ts` ~L9996, #3363) to accept a species-created target: run
  `emitArraySpeciesCreate` first and write through `emitArraySpeciesResultSwap`.
  Turn the compile-time refusal into a runtime path; never leave a CE that
  could become a wrong answer.
- **R (3)** `arrobj-cl-r.txt`: `compileArrayCopyWithin` dynamic-receiver arm
  → `__extern_has` / `__delete_property` / `__extern_get` / `__extern_set_strict`
  per §23.1.3.4 steps 17-18 (all four carry the Proxy guard); the splice
  trap-order row asserts the full sequence and may need step 2's ownKeys
  plumbing — do it last.
- **S (1)** `arrobj-cl-s.txt`: in `tryBorrowedPrototypeNullishThisThrow`
  (`builtin-prototype-brand.ts`) and `compilePropertyIntrospection`
  (`object-ops.ts:4563`), for `hasOwnProperty` evaluate `ToPropertyKey(key)`
  (`__to_property_key`) BEFORE the receiver's RequireObjectCoercible throw; the
  test observes `hint === "string"` on the key.

### What NOT to do

- **No new `env::*` host imports and no allowlist edits** — the runner fails
  any standalone module that emits one (`standaloneHostImportError`,
  `tests/test262-runner.ts:3700`). The `env::toString` leak (step 5.1) is
  closed by binding resolution, never by importing `toString`.
- Never edit `tests/test262-runner.ts`, any skip list, `HANGING_TESTS`, or
  `scripts/*-baseline.json` / `scripts/ir-fallback-baseline.json`.
- Never `--no-verify`; run the five ratchet gates before every commit
  (Acceptance below), chained with `&&`, never piped.
- Do not touch the owned areas in "Out of scope": no `$262.createRealm`
  plumbing, no `Reflect.construct` NewTarget (#3371), no §10.5.11 invariant
  validators (#1355 slice G / #5196), no TypedArray algorithms (#4449/#4490).
  If step 8(f) needs TA internals, defer those 2 rows and say so in the PR.
- Do not widen `object-proto-tostring.ts`'s tail to a silent `[object Object]`
  default — its header forbids exactly that; every new arm is brand-tested.
- Do not edit `closure-props.ts` directly (#3468 ownership note in the
  `vec-props.ts` header) — compose through its exports.
- Raw `ctx.checker.getTypeAtLocation` is ratcheted — `ctx.oracle` only.
- No shared `Instr[]` between two arms (aliased arrays are double-remapped
  by the finalize walks — #5188 followUp 4); every arm builder is a factory.
- Do not hand-pick issue ids for follow-ups; `claim-issue.mjs --allocate`.

## Acceptance criteria

Expected flips per step (row counts are the cluster sizes; a step is accepted
when its sub-list is green except rows explicitly deferred in the PR body with
the reason):

| Step | Sub-list | Expected flips |
|------|----------|---------------:|
| 1 | `arrobj-cl-a.txt` + `arrobj-cl-b.txt` | 18 |
| 2 | `arrobj-cl-e.txt` | 17 |
| 3 | `arrobj-cl-c.txt` | 14 |
| 4 | `arrobj-cl-d.txt` + `arrobj-cl-d2.txt` | 10 |
| 5 | `arrobj-cl-g.txt` (the 5 `symbol-tag-*-builtin` rows must go CE → pass in ONE step; CE → fail is not accepted) | 9 |
| 6 | `arrobj-cl-i.txt` | 4 |
| 7 | `arrobj-cl-f.txt` | 9 |
| 8 | `arrobj-cl-j.txt` | 12 (10 if the 2 TA rows are deferred) |
| 9 | `arrobj-cl-l.txt` | 18 |
| 10 | `arrobj-cl-{h,m,n,o,p,q,r,s}.txt` | 25 |
| **total** | `.tmp/es2015/arrobj-head.txt` minus the 23 out-of-scope rows | **136** (target ≥ 110 for the wave; every not-done row named with its reason) |

- **Controls**: all 20 rows in `.tmp/es2015/arrobj-controls.txt` still pass
  after every step (verified 20/20 on HEAD 2026-09-01; a regression here is a
  regression, not drift). Re-run the FULL 159-row `arrobj-head.txt` once at the
  end; the 23 out-of-scope rows must keep their current signature (no CE →
  wrong-answer demotion).
- **Pins**: `tests/issue-5268-<step>.test.ts` per landed step, shaped like
  `tests/issue-4492-builtin-as-value.test.ts` (compile with
  `{ target: "standalone" }`, assert `result.imports` is empty, run through the
  `__stdout_*` channel); each pin verified to FAIL on the pre-change tree
  (file-copy A/B, per CLAUDE.md), and the step-5 pin asserts the import list is
  empty for the `var toString = Object.prototype.toString` shape.
- **Gates** (run bare, never piped, before every commit; also with
  `LOC_GATE_BASE=$(git rev-parse upstream/main)` to simulate CI's merge
  preview):
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`
- **Equivalence**: `pnpm run test:equivalence:gate` green (and
  `npm test -- tests/equivalence.test.ts`).
- Results section appended to this file per landed step (before/after counts
  from the probe, deferred rows with reasons), status → `done` in the last
  implementation PR (self-merge path).

## References

- #5145 (in-review, merged in PR #5173/#5213) — array wave 1: species
  substrate (`array-species.ts`), its "Deliberately NOT done" list is clusters
  F, O, P, J(a,b) here; its clusters 3/5/6/7/9 are L, M, N, R, H/D2.
- #5148 (in-review, merged) — object-builtins wave 1: its "Not done" list is
  clusters A, B, C, D, E, G, H, S here; its cluster-3b diagnosis was refuted
  there (symbol-key identity survives; the `$Vec` arm is what is missing).
- #4491 (ES5 defineProperty MOP residual) — overlay/typed-lane read gate
  (cluster O), `vec-index` findings; #4492 (builtin protos on exotic receivers)
  — R3 "runtime ToString terminal has no §20.1.3.6 brand classifier" is the
  same seam as cluster G; #4444 ES5 standalone campaign umbrella.
- #4119 § "2026-09-01 ES2015 residual reopen" — the BLOCKED `toString` rows
  (TypedArray/ArrayBuffer/Symbol.prototype identity, `$NativeProto` parent
  `Get`); cluster G is deliberately the non-`$NativeProto` complement.
- #3251 (in-progress epic, S1 done 2026-07-18) — array descriptor overlay
  substrate (`vec-overlay*.ts`, on main); clusters D/O sit on it.
- #5140 / #5196 — Proxy waves: own §10.5.11 invariants (X2) and `revocable` (X3).
- #3371 (blocked) NewTarget (X1); #2046 Reflect receiver (not in this list).
- #3468 closure-own-property side table (`closure-props.ts`) — cluster F's
  substrate; #3537 vec expando bag — cluster D's; #4032 integrity bag arm —
  the arm cluster E's Proxy arm must precede.
- #2717 / #3363 — flat native depth-1 arm (cluster Q); #2961 — standalone
  host-import leak scan (cluster G's CE signature); #4749 —
  `fillObjectAssignProxySourceArm`, the fill-arm pattern for step 2.
- Handover: `plan/agent-context/es2015-standalone-session-handover.md`
  (§ "Method notes": twin-implementation collisions — run `check:dead-exports`
  after any supersede; second passes over a plan on current main are a cheap
  lever).
- Measurement artifacts (gitignored, this checkout): `.tmp/es2015/arrobj-head.txt`
  (159), `arrobj-head-run1.{txt,tsv}` (HEAD run), `arrobj-clusters.tsv`,
  `arrobj-cl-*.txt`, `arrobj-controls.txt` + `arrobj-controls-run1.txt`,
  `probes/ts{1..4}.js` + `probes/ts-probe2.out` (the `env::toString` repro),
  `arrobj-cluster.py` (the partition, re-runnable).

## 2026-09-02 implementation (Opus)

Steps 1, 2 (partial) and 6 landed, plus two pieces of step 3. Measured with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/arrobj-head.txt --standalone`
on branch `worktree-agent-a9c998ea769df422c`.

### Integration measurement (the authoritative one)

Both sides run on the SAME tree — branch tip `47f0973f1e`, which merges
`origin/main` `f64beb1a03` (so it carries PR #5461's runner standalone-leak
check, the #5224 buffers wave and PR #5469's post-#5224 regression fix). The
base side is that tree with this change-set's ten source files checked out from
`origin/main` and its three new modules moved aside; the after side is the tree
as committed. Nothing else differs.

| 159-row head list | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| `origin/main` (f64beb1a03) | 1 | 148 | 10 |
| this branch (47f0973f1e) | **22** | 127 | 10 |

**21 rows flipped, ZERO new non-pass rows, and the compile_error SET is
identical on both sides** (`comm` over both sorted non-pass lists: 21 lines on
the base-only side, 0 on the after-only side). The single row `origin/main`
already passes is one the buffers/for-of waves fixed, not one of ours.

`.tmp/es2015/arrobj-controls.txt`: **20 / 20** on the merged tree.

Equivalence gate on the same tree: 24 failing / 1718 passing / 24
known-failures in baseline — "No new equivalence regressions", exit 0. All
five source ratchets (loc / func / coercion-sites / oracle-ratchet /
dead-exports) green; `pnpm run typecheck` (TS7) clean.

Existing suites for the touched areas were A/B'd rather than merely run, and
every failure they show is STANDING RED on `origin/main` with an identical
failure set: `issue-3661-freeze-seal-descriptor-readback` (2),
`issue-3403-object-integrity-var-key` (1, the host lane),
`issue-4492-wave5` (5, its three self-declared "residual R1/R2/R3" groups) and
`issue-4492-builtin-as-value` (1). `es5-array-isarray-arguments`,
`issue-4616-patched-isarray-recursion`, `issue-2984-species` and
`issue-3420-species-result-store` are fully green on both sides.

### A note on compile-timeout noise

The box ran at load 6–23 on 4 shared cores throughout, and a slow row is
reported as `compile_error: compilation timeout`. Every such row in this work
was re-run ALONE and A/B'd before being believed: `concat_spreadable-number-
wrapper.js` (a control) timed out at 28.7 s on the base tree and 32.4 s on
this one, and `splice/create-proto-from-ctor-realm-non-array.js` at 22.7 s
vs 27.3 s — i.e. the timeouts track load, not the change-set. Do not read a
`compile_error` in a shared-box run as a compiler refusal without that check.

### Earlier per-step measurement (pre-merge base `ef6aec3322`)

The same 159-row list was 0 pass / 154 fail / 5 CE at the branch point, so the
per-step numbers below are quoted against that base; they compose to the same
21 rows.

### Step 1 — `Object.prototype.__proto__` accessor pair (commit `a7e974ee09`)

`arrobj-cl-{a,b}.txt` (18 rows): **0 pass / 18 fail → 12 pass / 6 fail.**
Controls 20/20.

New `src/codegen/object-proto-proto-accessor.ts`: the `__object_proto_get` /
`__object_proto_set` natives, the two identity-stable reflective closures
(`get __proto__` / `set __proto__`, §17 names, `.length` 0/1), the gOPD arm, and
the §10.4.7 immutable-prototype predicate for `%Object.prototype%`. Four wiring
sites: the gOPD dispatch and the `Object.setPrototypeOf` status check
(`call-builtin-static.ts`), the `.call` arm for a descriptor-traced accessor
(`calls.ts`), the `Reflect.setPrototypeOf` boolean
(`call-namespace-static.ts`), and the syntactic `o.__proto__ = v` assignment
(`assignment.ts`).

NOT done, with the measured reason:

- `get-ordinary-obj`, `set-ordinary-obj`, `set-non-extensible` — a plain object
  LITERAL lowers to a closed struct, so its implicit `%Object.prototype%`
  terminal is invisible to the runtime `__getPrototypeOf` walk, and the
  compile-time `Object.getPrototypeOf` fold (`object-get-prototype-of.ts`,
  object-literal arm) does not know the REFLECTIVE setter wrote. The native does
  re-apply the two-encodings distinction for an open `$Object` receiver
  (`OBJ_FLAG_NULL_PROTO` clear ⇒ answer `%Object.prototype%`), which is why
  `get.call(Object.create(proto))` and `get.call(Object.create(null))` are both
  right; the closed-struct half needs the literal's carrier to change.
- `set-cycle-shadowed` — `Object.create(proxy)` canonicalizes the proxy to its
  TARGET (`canonicalizeProtoArg` → `__proxy_get_target`), so by walk time the
  Proxy link the §10.1.2.1 step-8 loop must STOP at is already gone.
- `set-abrupt` — the trailing `Object.getPrototypeOf(subject)` on a Proxy needs
  the same implicit-terminal answer as the first bullet.
- `prop-desc` — `verifyProperty(Object.prototype, "__proto__", …)` needs
  `__proto__` in `OBJECT_PROTOTYPE_OWN_NAMES` (which changes the `in` answer for
  every ordinary receiver) plus a working `delete` on `Object.prototype`.

### Step 6 — IsArray over a Proxy (commit `885b615ba0`)

`arrobj-cl-i.txt` (4 rows): **0 pass / 4 fail → 1 pass / 3 fail.** Controls
20/20. Regression check: the 41 `Array/prototype/*/create-species*.js` +
`Symbol.species*.js` rows are 38/3 on BOTH trees with an identical non-pass set
(file-copy A/B).

`fillExternIsArray` gained the §7.2.2 step-3 arm (bounded target unwrap,
TypeError on a revoked proxy); new `src/codegen/proxy-value-provenance.ts`
answers "may this expression be a Proxy" syntactically, because TypeScript types
`new Proxy(t,h)` and `Proxy.revocable(t,h).proxy` as the TARGET's type and an
array target folded `Array.isArray` to the constant `true`;
`emitArraySpeciesCreate` runs §10.4.2.3 steps 2-3 before `Get(O,"constructor")`.

NOT done: `{map,filter,splice}/create-revoked-proxy.js`.
`Array.prototype.map.call(proxy, cb)` never reaches `emitArraySpeciesCreate` at
all (measured `ctorCount === 0, cbCount === 0`, no throw) — the reflective
`$NativeProto` member-call path is the gate on them, not the species prologue.
Arming `arraySpeciesDirty` for `Object.defineProperty(o,"constructor",…)` was
tried, changed nothing, and was reverted rather than shipped as dead weight.

### Step 2 (partial) — the Proxy MOP inside the Object statics

`arrobj-cl-e.txt` (17 rows): **0 pass / 17 fail → 6 pass / 11 fail.**

New `src/codegen/object-integrity-proxy.ts` holds §7.3.16 SetIntegrityLevel,
§7.3.17 TestIntegrityLevel and §7.3.25 EnumerableOwnProperties over a `$Proxy`
as three natives, plus `__proxy_own_keys_all` (the trap result when an `ownKeys`
trap is present; names ++ the target's own symbols when it is not). Eight
front-guards: `__object_{freeze,seal,isFrozen,isSealed,isFrozen_obj,
isSealed_obj,values,entries}`.

Regression + yield check on the 280-row
`built-ins/Object/{freeze,seal,isFrozen,isSealed,values,entries}` set:
**245 pass / 35 fail → 253 pass / 26 fail, with ZERO new failures.** Two of the
eight fixed rows are outside this issue's list —
`Object/{freeze,seal}/throws-when-false.js`.

`Object.{values,entries}` on a Proxy is a genuine SILENT-WRONG-ANSWER fix that
the two test262 rows do not credit: a `$Proxy` failed `__object_values`'
`ref.test $Object`, so it answered the EMPTY vec and fired no trap. File-copy
A/B on the same probe: with the arm removed `log=` / `len=0`; with it,
`log=|ownKeys|gopd:a|get:a|…` / `len=3`.

NOT done, with the measured reason:

- `{values,entries}/observable-operations.js` — the mechanism is correct; a
  hand-written probe reproducing the test's exact source (including
  `allowProxyTraps` and the `new Proxy(handler, check)` nested handler) prints
  the full expected trap log. Something in the runner's `wrapTest` rewriting
  makes the wrapped module take a different path; not diagnosed.
- `{freeze,seal}/proxy-with-defineProperty-handler.js` — the per-key define DOES
  run in the right order with the right descriptor shape (probe:
  `definedKeys=foo,Symbol()`); the test then fails on
  `seenDescriptors[key] = descriptor` inside the trap closure not persisting to
  the captured EMPTY object literal — an unrelated closed-struct-capture defect.
- `defineProperties/proxy-*`, `keys/proxy-*`, `getOwnPropertyDescriptors/proxy-*`,
  `isPrototypeOf/arg-is-proxy` — plan steps 2.4-2.7, not started.

### Step 3 (two pieces only)

- `Object.getOwnPropertySymbols(undefined|null)` now throws the §20.1.2.11
  ToObject TypeError instead of answering `[]` — 1 row
  (`non-object-argument-invalid.js`).
- `Object.assign(<primitive>, …)` routes its target through the same §7.1.18
  emission `Object(x)` uses, so the result is the wrapper — 1 row
  (`OnlyOneArgument.js`). The other four `Target-*` rows now fail one assertion
  LATER, on `result.valueOf()`: a wrapper `$Object` has no `$NativeProto`
  [[Prototype]] link, so a DYNAMIC `.valueOf()` reaches
  `Object.prototype.valueOf` (which returns `this`) rather than
  `Number.prototype.valueOf`. `native-proto-instance-method-read.ts` already
  serves that read, but only for (brand, member) closures the module has
  ALREADY minted — and these modules never name `Number.prototype.valueOf`.

### 2026-09-02 adversarial review — four findings, all FIXED

An independent skeptic reproduced four defects against the pristine merge-base
AND `origin/main`, with ~20 A/B probes across both lanes. All four are fixed on
this branch; none was merely documented. Commits `bc111a1d30` (F1+F2) and
`b3deafa2f4` (F3+F4). Six new pins, including the first JS-HOST-lane runner in
the focused test — F1 was a host-lane COMPILE ERROR, which a standalone-only
pin cannot see.

| # | What was wrong | Resolution |
| --- | --- | --- |
| **F1** (high) | The `Object.{keys,values,entries}` Proxy-provenance arm had NO `ctx.standalone` gate, and its body resolves `__object_<method>` from `ctx.funcMap` — a native the JS-host lane lacks. `var p = new Proxy({a:1},{}); var q = p; Object.keys(q)` was a host-lane `Codegen error: absoluteFuncIndex: unresolved call target`; base prints "a". | Gated on `ctx.standalone`. The two sibling sites were gated already; this one was the outlier. |
| **F2** (medium) | Standalone: routing an ALIAS of a proxy binding to the runtime enumerator answered `[]`, because `var qt = pt` nulls the alias — a widening defect present on `origin/main` too — where base's compile-time expansion still printed the keys without loading the value. | New `isDirectProxyBinding` (expression itself, or ONE identifier hop) replaces the alias-following trace at this site. `Array.isArray` keeps the wider trace deliberately: its target is a runtime predicate correct for every value, and the array-typed twin is not nulled (measured). Repairing the nulling is left alone — it is a value-representation defect, not a conformance one. |
| **F3** (medium) | `__proxy_set_integrity` forwarded a per-key `[[DefineOwnProperty]]` unconditionally; with no `defineProperty` trap that reaches `__obj_define_from_desc` on the target, which APPENDS on a closed-struct target. `Reflect.ownKeys(t)` read `a,b,a,b`, `getOwnPropertyNames(t).length` 4, and a later `Object.isFrozen(proxy)` threw on the duplicate-key invariant. | The forward now happens only when a `defineProperty` trap exists (without one it is unobservable). The helper stopped claiming the receiver outright — it answers "I did the spec-VISIBLE trap work, now run your ordinary body too", so the level still lands in the #4032 bag where base put it. `__proxy_test_integrity` gained the mirror rule: it runs its loop for the trap calls but VOTES only when a `defineProperty` trap recorded the level per key, else returns a `-1` "not handled" sentinel. Without that second half the fix traded a TypeError for an all-`false` isFrozen/isSealed matrix. |
| **F4** (low) | The syntactic `o.__proto__ = v` went to the §B.2.2.1 setter native regardless of whether the receiver INHERITS that accessor, so `Object.create(null)` + `preventExtensions` threw where base and a sloppy host ignore it. | Gated on the existing `hasExplicitNullObjectPrototype` proof. Fixed, not documented. |

**Probe A/B after the fixes.** All fourteen review probes (`f3`, `f3b`, `f3c`,
`f3d`, `f4`, `f2`, `f1b`, `p13` standalone; `v1`/`v3`/`v4`/`v5`/`v6`/`h2` host)
print BYTE-IDENTICAL output on this branch and on the reviewer's pristine
`base-main` tree — except the two where the improvement is the point: `f3d`
fires the `getOwnPropertyDescriptor` trap per key in ownKeys order
(`0,foo,Symbol(s)`, matching node) where base fires none, and `p13` runs the
full EnumerableOwnProperties sequence where base silently answers `[]`.

**Re-validated integration** (both sides on the tree that merges `origin/main`
`1c8ee381a9`; base = that tree with this change-set's ten source files from
`origin/main` and its three new modules moved aside):

| 179 rows (`arrobj-head.txt` + `arrobj-controls.txt`) | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| `origin/main` | 21 | 148 | 10 |
| this branch | **42** | 127 | 10 |

21 rows flipped, ZERO new non-pass rows, **identical compile_error set** — so
the review fixes cost nothing (the non-pass set is unchanged from the
pre-review measurement) and no standalone host-import leak was introduced. Of
the 10 shared CEs, 5 are the cluster-G `env::toString` leak that step 5 owns,
4 are cluster Q's `flat`/`flatMap` refusal, and 1 is the out-of-scope
`subclass-object-arg`. Controls **20/20**.

Touched-area suites A/B'd again on the new base: an IDENTICAL 9-failure set
(`issue-3661` ×2, `issue-3403` host lane ×1, `issue-4492-wave5` ×5,
`issue-4492-builtin-as-value` ×1) — all standing red on `origin/main`.

**Two gaps the review surfaced that remain open on BOTH trees** (measured, and
stated so they are not mistaken for fixed): `Object.freeze(proxy)` does not
make the target's own data properties non-writable (`t.a = 99` still lands;
node throws), and an ordinary `__proto__` write on an extensible
null-prototype object does not create the own `__proto__` data property node
reports.

### 2026-09-02 round-2 adversarial review — six findings

A second skeptic re-reviewed the F1-F4 fixes with ~45 probes (node vs lane vs
base, both lanes). Verdict: ship-with-notes, one confirmed new wrong
observable. **Four items fixed, two documented** — the two documented ones are
BASE PARITY, i.e. this change-set neither caused nor worsened them.

| # | Item | Resolution |
| --- | --- | --- |
| **R2-1** (medium, must-fix) | `Object.freeze/seal(proxy)` whose `defineProperty` trap forwards via `Reflect.defineProperty` — the canonical and test262 shape — DOUBLED the closed-struct target's own-key list (`Reflect.ownKeys(t)` → `a,b,a,b`, length 4, gopd trap firing 4× on a later `isFrozen`). Lane-new: base fired no trap and so never reached it. | **Fixed at the primitive, not the arm.** `__carrier_bag_push_keys` pushed every live bag key without checking whether the caller had already listed it as a STATIC own key. §10.1.11 OrdinaryOwnPropertyKeys is a key LIST and a list has no duplicates. The skeptic's r4 CONTROL — `Reflect.defineProperty({a:1,b:2}, "a", d)` with no proxy at all — read `a,b,a` on **base too**, which is what identifies the defect as the merge rather than the arm; it now reads `a,b` and a genuinely new key still appends. |
| **R2-2** (low) | The `-1` "not handled" sentinel returned BEFORE §7.3.17 step 1 `[[IsExtensible]]` and step 3 `[[OwnPropertyKeys]]`, so `isFrozen`/`isSealed` skipped two OBSERVABLE trap calls that can also throw. | **Fixed.** Both calls run first; the sentinel is decided after. node's `isext|ownKeys` sequence reproduced. |
| **R2-3** (documented → **fixed**) | `isDirectProxyBinding` admitted the `Proxy.revocable(…).proxy` hop, which the alias-nulling defect nulls, so `Object.keys(proxy)` answered `[]`. | **Fixed rather than named.** Base answers `"a"`, so this was a lane-new SILENT wrong answer — the worst of the three outcomes. The predicate is now `new Proxy(…)` only (expression, or one identifier hop). `tracesToProxyValue` keeps the hop: its consumer is a runtime predicate correct for every value. |
| **R2-4** (low) | The `Object.getOwnPropertySymbols` nullish ToObject guard was emitted on the JS-host lane too — same behaviour, different bytes. | **Fixed.** Standalone-gated, so the focused test's "every arm is standalone-gated" claim holds. Verified: the host-lane module for a gOPS program is now sha-IDENTICAL to base (`d6164f8790013a7f`, 3182 bytes). |
| **R2-5** (documented) | Three F3 comments credited the #4032 carrier bag with holding a `$Proxy`'s integrity level. | **Comments corrected in place.** `__integrity_bag` answers null for a `$Proxy` (it covers the vec, closure and Error carriers only); the verdict comes from the COMPILE-TIME integrity fold at the call site (`frozenVars`/`sealedVars`/`nonExtensibleVars`), with the native's non-`$Object` terminal behind it. That is what base answered, which is why the fall-through preserves base's verdicts. |
| **R2-6** (documented) | `hasExplicitNullObjectPrototype` proves null-prototype from the INITIALIZER only, so an object that is given a prototype later via `setPrototypeOf` and then made non-extensible swallows the §B.2.2.1 TypeError. | **Named, not fixed — base parity.** Probe `Object.create(null)` + `setPrototypeOf(o, Object.prototype)` + `preventExtensions(o)` + `o.__proto__ = {z:1}`: `no-throw` on this tree AND on `origin/main`; node throws. Proving the receiver's LIVE prototype needs flow analysis the syntactic proof does not have. |

**Two gaps R2-1 surfaced that stay open, on BOTH trees** (so the r1/r2 pins
deliberately assert the trap and key lines but NOT `Object.isFrozen(target)`):
a closed-struct carrier does not let a bag entry SHADOW a static field's
descriptor, so the forwarded define does not change what
`getOwnPropertyDescriptor(target, k)` reports; and `Object.isExtensible` on a
non-syntactic receiver answers from the compile-time fold, so the forwarded
`[[PreventExtensions]]` is not visible either. Both are why `t.a = 99` still
lands where node throws — measured identically on base.

**Re-validated at the round-2 merge point** (`origin/main` 77ca8fbaae merged
in as 1eafc91f99). Head list + controls, both sides run on the same merged
tree: base 21 pass / 147 fail / 11 CE, branch 42 pass / 124 fail / 13 CE — 21
rows flipped to pass, ZERO new non-pass rows, controls 20/20. Focused test
23/23. Typecheck clean, five ratchet gates green, equivalence gate exit 0 (24
failing / 1718 passing, all 24 in the baseline). The eight touched-area vitest
suites were re-A/B'd at THIS merge point rather than reusing the earlier
measurement: 9 failed / 73 passed on both sides, and the nine FAIL names are
byte-identical (`#3403` host-lane defineProperty ×1, `#3661` ×2, `#4492
wave-5` ×5, `#4492 builtin-as-value` ×1) — all standing red on `origin/main`.

**A note on compile-timeout noise, again.** The final after-run reported 13
`compile_error` rows against the base's 10; the three extra are all
`compilation timeout` at load 11-12 on 4 shared cores
(`filter/create-proto-from-ctor-realm-non-array` 29.5 s,
`of/proto-from-ctor-realm` 15.9 s, `concat_spreadable-function` 18.0 s), all
already non-pass, and all re-run alone to confirm. The other 10 are the same
set on both trees: 5 cluster-G `env::toString` leaks (step 5 owns them), 4
cluster-Q `flat`/`flatMap`, 1 out-of-scope `subclass-object-arg`.

### Steps 4, 5, 7, 8, 9, 10 — not started

No work was done on clusters D, D2, F, G, H, J, L, M, N, O, P, Q, R, S. Three
findings from reconnaissance that a follow-up should not re-derive:

- **Step 5 (cluster G) is bigger than "add classifier arms".** Five of its nine
  rows want `delete <Builtin>.prototype[Symbol.toStringTag]` to be OBSERVABLE
  and `symbol-tag-generators-builtin.js` additionally wants
  `[object GeneratorFunction]` / `[object Generator]` tags plus a
  configurable-and-deletable `@@toStringTag` on the generator prototype. The
  classifier arms alone will not flip them.
- **Cluster M's three rows are an ITERATOR-IDENTITY problem, not a body
  problem.** Each asserts
  `Object.getPrototypeOf(iter) === %ArrayIteratorPrototype%`, so giving
  `keys`/`values`/`entries` a reflective body without a reified
  `%ArrayIteratorPrototype%` moves the failure rather than fixing it.
- **The four `Object.assign/Target-*` rows are one shared blocker**, described
  in the step-3 section above: a DYNAMIC `.valueOf()` on a wrapper `$Object`.
  Fixing that one seam flips all four at once.

## Implementation Plan — r3 (2026-09-03)

Written by the planning lane against `origin/main` `bee5ddd535` (the checkout
branch `claude/es6-test262-standalone-g10c7u` is exactly that commit). The
implementer works in its own worktree from this text; nothing below has been
implemented.

### Census and root-cause groups (137 rows, `.tmp/census0903/array+object.tsv`)

Baseline: `.test262-cache/test262-standalone-current.jsonl` rows stamped
2026-09-03 09:07 UTC (`oracle_lane: honest`), ES2015 bucket per
`website/public/benchmarks/results/test262-file-editions.json`. 127 `fail` + 10
`compile_error`. **23 rows are the r2 "Out of scope" set and stay out**: X0 11
realm rows (`*proto-from-ctor-realm*` — note CI reaches the realm assertion,
`Expected SameValue(«[object Array]», «[object Object]»)`, so `$262.createRealm`
works in CI; the failure is the realm lane's `other.Array.prototype` identity,
not ours), X1 `subclass-object-arg` (CE, #3371), X2 8 §10.5.11 invariant rows,
X3 3 `revoke()`-inside-closure `illegal cast … __call_fn_method_3` rows. **114
rows are in scope**, grouped by the error column (one defect per group, not per
path prefix):

| Group | Rows | Shared error signature | Root cause (one line) |
|---|---:|---|---|
| L `Array.from`/`Array.of` | 17 | `Array.from is not yet implemented` ×7, `Array.of …` ×2, `value is not iterable` ×2, `Expected a Test262Error but got a TypeError` ×3, `args[0].length … 3 vs 2`, `closeCount 0 vs 1`, `requested new array is too large`, `arr[0] undefined vs true`, `source-array-boundary` | No §23.1.2.1 native: the value/`.call` form hits the generic throw body (`builtin-value-read.ts:1717`), the 1-arg direct call drains through `__iterator` only (`call-builtin-static.ts:1416`, no array-like arm), the 2-arg call composes drain-THEN-map (`iterator-native.ts:1883`) so the mapper gets 3 args, never IteratorCloses, and drains an infinite iterator before mapping. |
| C `Object.assign` + ToObject residual | 12 | `Return value should be …` ×4, `Expected a TypeError … no exception` ×3 (frozen/sealed/non-ext targets), `Cannot assign to read only property`, `Cannot convert undefined or null to object`, `length should be 4 … 0`, `NaN vs "c"`, `Object(symA)` identity | (a) wrapper `$Object`'s dynamic `.valueOf()` reaches `Object.prototype.valueOf` (r2 note); (b) compile-time integrity fold (`ctx.frozenVars`, `call-builtin-static.ts:1737`) is invisible to `__object_assign`; (c) no `$AnyStr` source arm, typed-field store on override, no standalone `Object(sym)` wrapper (`calls-guards.ts:773` is host-gated). |
| J `concat` protocol | 12 | `[1,2,3,null,null,null] vs …undefined` ×3, `is-concat-spreadable-val-falsey`, `get-order`, `illegal cast in __call_valueOf`, `array-like-to-length-throws`, `arg-length-exceeding-integer-limit`, `uncaught Wasm-GC exception`, TA ×2, `is-concat-spreadable-proxy` illegal cast | `array-concat-spec.ts:204-228` treats `null` as absent; species prologue runs after the receiver's `@@isConcatSpreadable` Get; `__extern_has_idx` on an `arguments` carrier answers the length OVERRIDE; `index.ts:9194-9225` `closure-extern` arm `ref.cast`s a non-closure `valueOf`. |
| E Proxy MOP in Object statics (r2 step 2 residual) | 11 | `Expected SameValue(«""», «"\|ownKeys\|…"»)` ×2, `Expected SameValue(«1», «0»)`, `Actual [ownKeys, getOwnPropertyDescriptor] and expected [get, set, has, …]`, `Cannot access property on null … 3xx:18` ×2, `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`, `illegal cast … __module_init_chunk_1`, `key is not present`, `Actual [0, foo] and expected [0, foo, Symbol()]`, `isPrototypeOf … false vs true` | Traps are read off the handler ONCE at `new Proxy` (`object-runtime-proxy.ts:1511-1537` `readTrap`), so a handler that is itself a Proxy (`new Proxy(handler, check)`) contributes NO traps — that is the "wrapTest mystery" of the r2 note (the hand probe used a plain handler); plus r2 steps 2.4-2.7 never started. |
| D+D2 symbol keys on `$Vec`/closure carriers + intrinsic symbol props | 10 | `Actual [] and expected [Symbol(a), Symbol(b)]` ×2, `obj has 2 symbol-keyed descriptors … 0`, `first entry has value symValue`, `[a, length] vs [length, a]`, `[] vs [name, a]`, `[0, 1, length, a] vs [length, a]`, `Symbol() should be an own property`, `Cannot access property … 858:18`, `Expected obj[5] NOT to be writable` | `__getOwnPropertySymbols` has one `$Object` arm (`object-runtime-descriptors.ts:3323-3333`); the self-hosted gOPDs walks names only (`src/stdlib/object-runtime.ts:59-72`); `Array.prototype[@@unscopables]` never materialised; `Array[@@species]` write not refused. |
| G reflective `Object.prototype.toString` + `env::toString` leak | 9 | `standalone target emitted host imports: env::toString` ×5 (CE), `Object.prototype.toString is not yet implemented` ×2, `get-symbol-tag-err`, `[object Boolean] vs [object test262]` | Leak: a script-level `var toString` registers a `(func (result externref))` import named `toString` (reproduced below); classifier (`object-proto-tostring.ts:236`) has no WeakSet/WeakMap/Promise/generator/Symbol/Math/JSON arms and the reflective body (`emitObjectProtoOrRefusal` L661) never does the `@@toStringTag` Get. |
| F symbol/index expandos on function/wrapper/RegExp carriers + species via Proxy | 9 | `Actual [1,2,3] and expected []` (function), `[true] vs []`, `[y,u,c,k,…] vs []`, `[] vs []` (reg-exp), `[object Array] vs [object Object]` ×4 (`create-proxy`), `concat/create-proxy` | index reads (`__extern_has_idx`/`__extern_get_idx`/`__extern_length`) have no closure/wrapper/RegExp carrier arm; the 5 `create-proxy` rows need a repro (see F step). |
| A/B `__proto__` residual | 6 | see r2 step-1 "NOT done" list | closed-struct literal has no runtime `%Object.prototype%` terminal; `Object.create(proxy)` canonicalises the link; `prop-desc` needs `__proto__` in `OBJECT_PROTOTYPE_OWN_NAMES`. |
| H `toLocaleString` | 4 | `"true" vs "boolean"` ×2, `"true,false" vs "boolean,boolean"` ×2 | `x.toLocaleString()` folded statically; element Invoke must observe a patched `Boolean.prototype.toString` through the seeded companion (`__protoidx_get_r`). |
| I/P reflective HOF on a Proxy receiver | 6 | `Expected a TypeError … no exception` ×3 (`create-revoked-proxy`), `Expected a RangeError` ×3 | `Array.prototype.{map,filter,splice}.call(proxy, cb)` goes `emitArrayProtoMemberBody` L896 → `__hof_<m>` with NO species prologue and no `ArrayCreate` RangeError (r2 step-6 "NOT done" finding). |
| M/N/O/Q/R/S | 18 | as r2 table | unchanged from r2 step 10; O and M re-diagnosed below. |

Sum: 17+12+12+11+10+9+9+6+4+6+18 = 114. ✓

### Verification on current main (2026-09-03, load 0.4-2)

`npx tsx scripts/run-test262-paths.mts .tmp/es2015/r3/sample.txt --standalone`
(14 rows, one per big group; output `.tmp/es2015/r3/sample-run1.txt`):

```
=== counts ===
{ fail: 13, compile_error: 1 }
fail  Array/from/source-object-length.js            TypeError: value is not iterable
fail  Array/of/construct-this-with-the-number-of-arguments.js  Array.of is not yet implemented in --target standalone
compile_error  Object/prototype/toString/symbol-tag-weakset-builtin.js  standalone target emitted host imports: env::toString (#2961)
fail  Object/prototype/toString/get-symbol-tag-err.js   Expected a Test262Error to be thrown but no exception was thrown at all
fail  Object/entries/observable-operations.js       Expected SameValue(«""», «"|ownKeys|getOwnPropertyDescriptor:a|get:a|…"»)
fail  Object/assign/Target-Boolean.js               Return value should be true … at L15: result.valueOf()
fail  Object/assign/target-is-frozen-data-property-set-throws.js  Expected a TypeError … no exception
fail  Array/prototype/concat/Array.prototype.concat_spreadable-function.js  Actual [1, 2, 3] and expected []
fail  Array/prototype/concat/Array.prototype.concat_sloppy-arguments.js  Actual [1, 2, 3, null, null, null]
fail  Array/prototype/concat/is-concat-spreadable-val-falsey.js  result.length … 2 vs 1
fail  Object/getOwnPropertySymbols/order-after-define-property.js  Actual [] and expected [Symbol(a), Symbol(b)]
fail  Object/prototype/toLocaleString/primitive_this_value.js  «"true"» vs «"boolean"»
fail  Array/prototype/keys/returns-iterator-from-object.js  Array.prototype.keys is not yet callable as a value
fail  Array/prototype/map/target-array-with-non-writable-property.js  0 value should be 2
```

Every sampled row fails exactly as the baseline records — nothing to drop.
Controls: `.tmp/es2015/arrobj-controls.txt` re-run in two 10-row batches
(`.tmp/es2015/r3/controls-run1.txt`): **20 / 20 pass** on `bee5ddd535`.

Leak repro (CLI, one compile): `npx tsx src/cli.ts .tmp/es2015/probes/ts2.js
--standalone -o .tmp/es2015/r3/out2` → `WebAssembly.Module.imports` =
`[{"module":"env","name":"toString","kind":"function"}]`; the WAT carries
`(import "env" "toString" (func $toString_import (type 17)))` with
`(type $type17 (func (result externref)))` and a `$__mod_toString` module
global — i.e. a ZERO-ARG externref GETTER import named after the identifier
(not `global_toString`), never called from any body. The `global_<name>`
family in `extern-declarations.ts:1459-1530,1594-1626` is already
standalone-gated, so this comes from a different producer.

### Ground rules for every step

- Probe: `npx tsx scripts/run-test262-paths.mts <list> --standalone`, lists
  ≤ 15 rows, one compile process at a time; `--isolate` only when a row hangs.
  Compile timeouts under load are artifacts — re-run alone before believing one.
- Type facts through `ctx.oracle` (`src/checker/oracle.ts`) only; a raw
  `ctx.checker.getTypeAtLocation` trips `check:oracle-ratchet`. The steps below
  name the oracle entry where a type question arises.
- New mechanisms go in NEW modules (named per step); the god-files listed in
  the frontmatter grow by WIRING only. Every `Instr[]` handed to two bodies is
  a factory (#5188 followUp 4). `FunctionContext` literals carry
  `labelMap: new Map()` (+ `isGenerator?`).
- No new `env::*` import, no allowlist edit, no runner/skip-list/baseline edit.
- **Every step's acceptance names PASSING shapes at risk and how they are
  checked** — this is the r2 lesson (5 of 6 waves shipped regressions the row
  list could not see). Two checks are used throughout: **byte-identity** (the
  JS-host lane module for a named control program is sha-identical to base —
  compile with `{ target: "gc" }` on both trees, compare `sha1(wasm)`) and
  **control programs run on BOTH lanes** (standalone + host) and diffed
  against base output. Capture `.tmp/base-<file>.ts` copies at the FIRST edit
  (CLAUDE.md file-copy A/B) so every base run is one `cp` away.
- Gates before every commit, bare and chained:
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`,
  plus once with `LOC_GATE_BASE=$(git rev-parse upstream/main)`.

### Step R3-1 — native `Array.from` / `Array.of` (group L; 17 rows; risk: medium)

**Root cause.** There is no §23.1.2.1/§23.1.2.3 algorithm in the module: the
direct 1-arg call drains only iterables (`call-builtin-static.ts:1416-1447`
calls `__iterator` → `value is not iterable` on `{length:4,…}`), the 2-arg
call composes `__array_from_iter_n` THEN `__hof_map` (`iterator-native.ts:1873-1903`),
which drains before mapping (infinite `{done:false}` → "requested new array is
too large"), calls the mapper with `(v, i, recv)` (3 args), and never closes
the iterator; the value/`.call` form takes the `default:` branch of
`ensureStandaloneBuiltinStaticMethodClosure` (`builtin-value-read.ts:1280-1299`,
throw body at L1717). `Array.of.call(T, …)` likewise.

**Files / functions.**

1. NEW `src/codegen/array-from-native.ts` (≈ 420 LOC): `ensureNativeArrayFrom(ctx)`
   registers `__array_from(C, items, mapFn, thisArg) -> externref` and
   `ensureNativeArrayOf(ctx)` registers `__array_of(C, argsVec) -> externref`
   (both standalone-only, append-only defined funcs via `mintDefinedFunc` /
   `pushDefinedFunc`, deps resolved BY NAME after `ensureObjectRuntime`,
   `ensureNativeIteratorRuntime`, `addUnionImportsViaRegistry`,
   `reserveApplyClosure`, and `reserveNativeConstructDriver(ctx, 0, …)` +
   `(ctx, 1, …)` — `native-construct.ts:143`, driver name `__native_construct_<arity>`,
   params `(C, newTarget, …args)`). Body of `__array_from`, in spec order:
   - `C` null/undefined ⇒ the default lane (a fresh `$ObjVec` via `__objvec_new`);
     else `usingCtor = __is_constructor(C)` (the predicate `array-species.ts`
     already resolves as `deps.isConstructor`).
   - `mapFn` undefined ⇒ `mapping = false`; else `__typeof_function(mapFn)`
     false ⇒ `buildThrowJsErrorInstrs(ctx, "TypeError", "Array.from: mapFn is not callable")`.
   - `usingIterator = GetMethod(items, @@iterator)`: `ref.test $Vec` OR
     `__is_truthy(__extern_get(items, __box_symbol(1)))` (id 1 = `@@iterator`,
     the same test `buildArrayFromIterNBody` makes at `iterator-native.ts:2033-2058`,
     including the present-but-nullish arm that must reach `__iterator`'s
     TypeError). Nullish `items` ⇒ TypeError "Cannot convert undefined or null
     to object" (ToObject, step 7 of the array-like branch — but GetMethod on
     nullish throws first, so ONE nullish guard at the top is spec-equivalent).
   - Iterator branch: `A = usingCtor ? __native_construct_0(C, null) : $ObjVec`;
     `iter = __iterator(items)`; loop `k`: `(done, v) = __iterator_next(iter)`;
     done ⇒ `Set(A,"length",k)` (custom-C lane: `__extern_set_strict(A,"length",box(k))`;
     `$ObjVec`: nothing) and return; `mapped = mapping ? __apply_closure(mapFn, thisArg, [v, box(k)]) : v`
     — build the 2-slot `$ObjVec` with `__objvec_new`/`__objvec_push` so the
     mapper observes `arguments.length === 2` (`iter-map-fn-args`);
     `CreateDataPropertyOrThrow(A, k, mapped)`: `$ObjVec` lane ⇒ `__objvec_push`
     (no prototype consult — `of/does-not-use-prototype-properties`); custom-C
     lane ⇒ `__defineProperty_value(A, ToString(k), mapped, CREATE_DATA_PROPERTY_FLAGS)`
     + the following plain `__extern_set` exactly as `emitArraySpeciesResultSwap`
     does at `array-species.ts:423-451` (copy that comment's reason).
     **IteratorClose on abrupt** (`iter-map-fn-err`, `iter-set-elem-prop-err`,
     `iter-set-elem-prop-non-writable`): wrap the mapper call + define in a
     `try_table` with a `catch_all_ref` clause (`src/ir/types.ts:592`; shape
     precedent `named-this-call.ts:306-325` — EMPTY block type, result parked
     in a local), handler = `__iterator_return(iter)` then `throw_ref`.
   - Array-like branch: `len = __extern_length(items)` (ToLength incl. the
     observable valueOf/toString walk); `A = usingCtor ? __native_construct_1(C, null, box(len)) : $ObjVec`;
     loop `k < len`: `v = __extern_get_idx(items, k)` (an absent index reads
     `undefined` — `source-object-length` expects an OWN `undefined`, not a
     hole, so push the undefined singleton, never `$Hole`); same map/define as
     above (no IteratorClose here); then `Set(A,"length",len)`.
   - `__array_of(C, argsVec)`: `len = argsVec.len`; `A = usingCtor ? construct_1(C, box(len)) : $ObjVec`;
     per k `CreateDataPropertyOrThrow` as above (custom-C lane must THROW when
     the define is refused — `of/return-abrupt-from-data-property-using-proxy`
     expects the Proxy `defineProperty` trap's Test262Error to escape, which
     `__defineProperty_value` on a `$Proxy` already forwards); `Set(A,"length",len)`.
2. `src/codegen/expressions/call-builtin-static.ts` — the `Array.from` arm
   (L1188-1541): under `ctx.standalone`, REPLACE the #2169c drain block
   (L1416-1447) and the #3206 mapped block (L1470-1513) with one emission:
   `items` → externref, `mapFn` → externref (inline arrow/function via
   `compileArrowAsClosure` exactly as L1482-1490, else `compileExpression`),
   `thisArg` → externref or `ref.null.extern`, `ref.null.extern` for `C`, then
   `call __array_from`. **Keep every arm above L1416 byte-for-byte**: the
   native-string (#1470, L1225), native-generator (#2169, L1254), Set (L1288),
   Map (L1322) and typed-vec `array.copy` (L1346-1409) fast paths return
   before the new call, so `Array.from(typedVec)`, `Array.from("str")`,
   `Array.from(set)` keep their carriers. The `Array.of` arm (L1543+): keep
   the native `Array.of(a,b,c)` vec build; nothing changes for direct calls.
   Type question here — none new (`argTsType` at L1195 is pre-existing;
   do not add `ctx.checker` calls; `ctx.oracle.staticJsTypeOf` is the entry
   if the implementer needs a primitive-vs-object fact).
3. `src/codegen/builtin-value-read.ts` `ensureStandaloneBuiltinStaticMethodClosure`
   (L996): add `case "Array.from"` (paramTypes = 3 × externref, returnType
   externref, body = `call __array_from(<receiver>, arg1, arg2, arg3)`) and
   `case "Array.of"` (variadic: mirror `String.fromCharCode` at L1183-1207 —
   paramTypes = `[ref_null $argvVec]` from `ensureExtrasArgvGlobal`, body =
   `call __array_of(<receiver>, vec)`; add `"Array.of"` to the variadic
   publication test at L1742 so any-callee call sites emit the variadic arm).
   **The receiver slot is the open question the implementer must settle with
   a 5-line probe FIRST**: static value closures are minted with params
   `[__self, arg0…]` (`makeBuiltinClosureFctx`, L524) — no `this` param — while
   `__call_fn_method_N` installs the caller's `this` in the `__current_this`
   module global before the `call_ref` (`closure-exports.ts:1338-1345`,
   `context/types.ts:986`). Probe `var f = Array.from; f.call(C, [])` with a
   body that returns `__current_this`; if the global carries `C`, read it
   there; if not, mint these two closures with a leading receiver slot the
   way proto-member closures do (`this` = param 1, `array-object-proto.ts:865`)
   and route `.call` through the same wrapper type. `iter-cstm-ctor.js`
   asserts `thisVal === result` and `args.length === 0`, which pins the answer.
4. `iterator-native.ts`: leave `ensureNativeArrayFromMapped` in place for one
   PR (it is still referenced from `call-builtin-static.ts` until step 2 lands);
   after step 2 it is dead → `check:dead-exports` will flag it; delete it in
   the same PR (−64 LOC) rather than leaving an unreferenced export.

**Rows claimed (17):** all `built-ins/Array/from/*` and `built-ins/Array/of/*`
rows in the TSV except the two X0 `proto-from-ctor-realm.js`.
`source-array-boundary.js` (mapper receives `1.7976931348623157e+308`,
expected `undefined` for `array[this.arrayIndex]`) is the mapper's `this`
(`thisArg`) — verify after the 2-arg mapper exists; if it is a boxed-f64
crossing defect, name it and defer.

**Growth grant:** `src/codegen/array-from-native.ts` (new, no grant needed),
`src/codegen/expressions/call-builtin-static.ts` +40 (wiring, net negative
after the two removed arms), `src/codegen/builtin-value-read.ts` +45,
`builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure` +30 lines.

**Order-preservation constraints.** §23.1.2.1 order: mapFn callability check
BEFORE `GetMethod(items,@@iterator)`; `Construct(C)` (iterator lane, zero
args) BEFORE the first `next`; `Construct(C,«len»)` (array-like lane) AFTER
`Get(items,"length")`; per element `Get`/`next` → map → define; `length`
set LAST and through `[[Set]]`, not define (`iter-set-length-err`). The
mapper receives exactly `(value, k)`.

**Acceptance.**
- The 17 rows above flip; `.tmp/es2015/r3/from-of.txt` (implementer writes
  it from the TSV) 0 pass → ≥ 15 pass, every not-flipped row named with the
  measured reason.
- **Passing shapes at risk, checked on BOTH trees:** (i) the `#3206`
  consumer — `Array.from({length: 3}, (_, i) => i * 2)` and
  `Array.from(new Set([1,2]), x => x + 1)` print identically; run
  `built-ins/TypedArray/prototype/map/` (any 10 rows — they go through
  `harness/testTypedArray.js` `makeArray = Array.from({length:n}, fn)`) and
  require an identical pass set; (ii) `Array.from("héllo")`,
  `Array.from(gen())`, `Array.from(new Map([[1,2]]))`, `Array.from([1,2,3])`
  (typed vec copy) — byte-identical standalone modules (the arms above the
  new call must not move); (iii) host lane: `tests/issue-4492-builtin-as-value.test.ts`
  style compile of `var f = Array.from; f([1])` with `{target:"gc"}` is
  sha-identical to base (the new cases are inside `ctx.standalone`);
  (iv) `built-ins/Array/from/iter-map-fn-this-arg.js`,
  `get-iter-method-err.js`, `of/creates-a-new-array-from-arguments.js`
  (controls) stay green.
- Pin: `tests/issue-5268-r3-array-from.test.ts` — standalone compile of the
  four shapes (array-like, iterable+mapFn+throw with `closeCount`,
  `Array.from.call(C, iterable)`, `Array.of.call(C, 1, 2)`), `result.imports`
  empty, verified to FAIL on the pre-change tree by file-copy A/B.

### Step R3-2 — `env::toString` leak + reflective `Object.prototype.toString` (group G; 9 rows; risk: medium)

**Root cause.** (a) A script-level `var toString = …` makes a
`(func (result externref))` getter import named `toString` appear in the
module (repro above) — the r2 note's diagnosis ("the collector registers the
ambient function") is confirmed in effect but the producer is NOT any of the
`global_<name>` loops (all standalone-gated). (b) The reflective body never
performs the §20.1.3.6 step-14 `Get(O, @@toStringTag)`; steps 14/15 exist only
in the compile-time `.call` fold (`object-proto-symbol-tag.ts:155
emitObjectProtoToStringWithSymbolTag`).

**Files / functions.**

1. Locate the producer: add a TEMPORARY `if (name === "toString") throw new
   Error(new Error().stack)` at the top of `addImport`
   (`src/codegen/registry/imports.ts:51`) and compile
   `.tmp/es2015/probes/ts2.js --standalone`; the stack names the site. Two
   candidates by signature (zero params, externref result, bare name): a
   declared-global getter thunk keyed by identifier text, or the
   `emitRealmGlobalPrimitiveMethodWriteback` neighbourhood
   (`global-environment.ts:61-95`, the ONLY code that special-cases a script
   `toString`/`valueOf` binding). Fix at the producer: a name that
   `sourceShadowsGlobalName(sourceFile, name)` (`source-function-members.ts:135`)
   reports as rebound by THIS program must not register an ambient import
   under `ctx.standalone`/`ctx.wasi`. Re-verify: 0 imports for `ts2.js`, AND
   the module still prints `[object …]` (the `$__mod_toString` global path is
   what the body actually uses). Remove the throw.
2. `object-proto-tostring.ts:661 emitObjectProtoOrRefusal`: before the
   classifier, emit `tag = __extern_get(recv, __box_symbol(4))` (id 4 =
   `Symbol.toStringTag`, `array-object-proto.ts:3840`) — a real `[[Get]]`, so
   a throwing getter propagates (`get-symbol-tag-err.js`) and a Proxy `get`
   trap fires; if `tag` is a native string (`ref.test $AnyString`) → return
   `"[object " + tag + "]"` (`__str_concat`), else fall into the classifier.
   For a PRIMITIVE receiver (`symbol-tag-override-primitives.js`,
   `toString.call(true)`), the Get must see the wrapper prototype: box first
   through `__new_Boolean`/`__new_Number`/`__new_String`
   (`object-runtime.ts:2952-2996`, the same natives `emitObjectCoercion` calls)
   — only when `__typeof_boolean/number/string` says so; `null`/`undefined`
   keep steps 1-2.
3. Classifier arms (`emitObjectProtoToStringClassifier`, L236): add
   brand-tested arms for WeakSet, WeakMap, Promise (`ref.test` on the
   registered `$__WeakSet`/`$__WeakMap`/`$Promise` types), `$Symbol`
   carrier/wrapper, and the `Math`/`JSON` namespace carriers → all answer
   `[object Object]` ONLY as the step-13 default AFTER the @@toStringTag Get
   above declined (their own tag was deleted/replaced, which is exactly why
   the rows expect the default). Keep the loud refusal as the tail — the
   module header forbids a blanket default.
4. Proxy arm (`proxy-array.js`, `proxy-revoked-during-get-call.js`): replace
   the explicit refusal at L493-502 with §20.1.3.6 step 4 `IsArray(O)` through
   `__extern_is_array` (its `$Proxy` arm landed in r2 step 6: unwrap to target,
   TypeError on revoked), then the step-14 Get through the proxy (the `get`
   trap in `proxy-revoked-during-get-call` revokes the proxy DURING the Get —
   the spec answer is still `[object Array]` because `builtinTag` was fixed in
   step 4; do not re-run IsArray after the Get).

**Rows claimed (8 of 9):** the 5 `symbol-tag-*-builtin.js` (must go CE → pass;
`symbol-tag-generators-builtin.js` additionally wants `[object GeneratorFunction]`
/ `[object Generator]` + a deletable generator-prototype tag — if that needs
the generator carrier's own `@@toStringTag`, name it and DEFER that one row),
`get-symbol-tag-err.js`, `symbol-tag-override-primitives.js`,
`proxy-array.js`, `proxy-revoked-during-get-call.js`.

**Growth grant:** `object-proto-tostring.ts` +90,
`object-proto-tostring.ts::emitObjectProtoOrRefusal` +25,
`object-proto-tostring.ts::emitObjectProtoToStringClassifier` +40; the
producer file of the leak +10 (name it in the PR; if it is
`extern-declarations.ts` or `global-environment.ts` the grant below covers
it).

**Order constraints.** Steps 1-2 (null/undefined) → 3 ToObject → 4 IsArray →
5-13 builtinTag → 14 Get(@@toStringTag) → 15 string test. Do NOT move the
Get before IsArray (revoked-proxy rows).

**Acceptance.**
- The 8 rows flip; the 5 CE rows are checked for `imports.length === 0` from
  the CLI, not only for the runner verdict.
- **Passing shapes at risk:** the compile-time `.call` fold is untouched —
  `Object.prototype.toString.call([])`, `.call(null)`, `.call(new Date())`,
  `.call(function(){})`, `.call(Object.prototype)`, `.call(Error.prototype)`
  (the `NATIVE_PROTO_ORDINARY_BRANDS` rows) printed on both trees, standalone;
  the stored-method idiom `arr.getClass = Object.prototype.toString; arr.getClass()`
  for Array/Number/String/Boolean/Date/RegExp/Error/Map/Set receivers printed
  on both trees; `built-ins/Object/prototype/toString/symbol-tag-non-str-proxy-function.js`
  and `proxy-revoked.js` (controls) stay green; `built-ins/Object/prototype/toString/`
  (≤ 15 rows sampled, including the 5 `S15.2.4.2_*`) identical pass set;
  host lane sha-identical for a `toString.call(x)` program.
- Pin: `tests/issue-5268-r3-proto-tostring.test.ts` asserts the import list
  is EMPTY for the `var toString = Object.prototype.toString` shape and the
  `@@toStringTag` getter throw propagates.

### Step R3-3 — `Object.assign` integrity + wrapper `valueOf` + `Object(sym)` (group C; 12 rows; risk: medium)

**Root cause.** Three seams: (a) a wrapper `$Object` created by
`emitObjectCoercion` has no `$NativeProto` link, so the DYNAMIC
`result.valueOf()` resolves to `Object.prototype.valueOf` (r2 step-3 note);
`native-proto-instance-method-read.ts` answers the wrapper case on
`__extern_get` only, and only for closures ALREADY minted (its demand gate,
L27-40). (b) `Object.freeze/seal/preventExtensions(<literal>)` is a
compile-time fold (`ctx.frozenVars`/`sealedVars`/`nonExtensibleVars`,
`call-builtin-static.ts:1726-1737`; R2-5 in this file) invisible to
`__object_assign`. (c) no `$AnyStr` source arm; a same-key override writes
through a typed field (`ObjectOverride-sameproperty` → `NaN`); `Object(sym)`
standalone is identity (`calls-guards.ts:773` arm is `!noJsHost`-gated).

**Files / functions.**

1. Wrapper method identity (4 rows `Target-{Boolean,Number,String,Symbol}`):
   in `emitObjectCoercion` (`calls-guards.ts`, the four wrapper arms) and the
   `Object.assign` primitive-target route (`call-builtin-static.ts:3629-3633`),
   after emitting the wrapper, SEED the `valueOf` and `toString` closures for
   that brand — `ensureStandaloneNativeMethodClosure(ctx, brand, "valueOf", "method", { refusalBodyFallback: true })`
   (`native-proto.ts`; brand via `BUILTIN_BRAND_TABLE`), so
   `unshiftExternGetProtoMethodArm` finds them; then give the METHOD-CALL
   path the same answer: the `__extern_method_call` `$Object` arm's
   proto-miss terminal (in `object-runtime.ts` — search the `registerNative("__extern_method_call"`
   site) must consult a new `native-proto-instance-method-read.ts` export
   `wrapperBrandMethodLookupInstrs(ctx, …)` (factor the `wrapperClassify`
   ladder at L193-225 so both arms share ONE ladder) before answering
   `Object.prototype.valueOf`. `Target-Symbol` needs 4 below.
2. Integrity fold → runtime precheck (3 + 2 rows): NEW
   `src/codegen/object-assign-integrity.ts` (≈ 140 LOC) exporting
   `emitObjectAssignIntegrityPrecheck(ctx, fctx, targetLocal, sourcesLocal, level)`
   where `level ∈ {frozen, sealed, nonExtensible}` comes from the call-site
   fold (`integrityVarKey(ctx, targetIdentifier)` ∈ `ctx.frozenVars`/…, the
   same test `assignment.ts:2898,4489` makes). Emitted at
   `call-builtin-static.ts:3674` just before `call __object_assign`: for each
   source (the `$ObjVec` built at L3666-3673) and each of
   `__object_keys(src)` ++ `__getOwnPropertySymbols(src)`:
   `d = __getOwnPropertyDescriptor(target, key)`; accessor `d` (has `set`) →
   allowed (§10.1.5.3 calls the setter: `target-is-frozen-accessor-property-set-succeeds`,
   `target-is-non-extensible-existing-accessor-property`); `frozen` and data
   `d` → TypeError "Cannot assign to read only property"; `sealed`/`nonExtensible`
   and `d` undefined → TypeError "Cannot add property, object is not extensible".
   Only emitted when the fold KNOWS the level (a plain target keeps today's
   bytes). `target-is-non-extensible-existing-accessor-property` currently
   dies earlier with "Cannot convert undefined or null to object": probe
   `var t = Object.preventExtensions({ set foo(v){} }); print(t == null)` —
   `emitStoredObjectIntegrityCall` (`call-object-builtins.ts:80`) is returning
   a null externref for an accessor-carrying literal; fix it to return its
   argument (§20.1.2.17 step 3) before the precheck can help.
3. `__object_assign` sources (`object-runtime-enumeration.ts:1107-1330`):
   (a) `$AnyStr` source arm — copy index keys `"0"…"len-1"` via
   `__extern_set_strict` (`Override-notstringtarget`: three string sources
   onto a Number wrapper, later sources override); (b) `ObjectOverride-sameproperty`:
   the `$Object` arm already writes through `__extern_set_strict` (L1318-1326),
   so the `NaN` comes from the TARGET being a closed struct with a typed `a`
   field — route a target whose `ctx.oracle` literal-shape fact has only
   primitive-typed fields the way `compileObjectAssignArg` (`calls.ts:687`)
   routes a literal (build as `$Object`); confirm with a 4-line probe before
   editing (the fix may be in `compileObjectAssignArg`, not the native).
4. `Object(sym)` standalone wrapper (`symbol_object-returns-fresh-symbol`,
   half of `Target-Symbol`): in `calls-guards.ts:773` add the `noJsHost` arm —
   `__new_plain_object()` + `__defineProperty_value(obj, WRAPPER_PRIMITIVE_KEY, extern(symbolCarrier), 0)`
   (the `[[PrimitiveValue]]` slot convention `native-proto-instance-method-read.ts:70`
   documents; the carrier from `ensureSymbolCarrier`/`__box_symbol`), typeof
   answers `"object"` because it is a `$Object`.

**Rows claimed (12):** all `built-ins/Object/assign/*` rows in the TSV +
`built-ins/Object/symbol_object-returns-fresh-symbol.js`.

**Growth grant:** `object-assign-integrity.ts` new; `call-builtin-static.ts`
+25 (wiring, shared with R3-1's grant); `calls-guards.ts` +35,
`calls-guards.ts::emitObjectCoercion` +30; `native-proto-instance-method-read.ts`
+40; `object-runtime.ts` +25 (the one method-call consult);
`object-runtime-enumeration.ts` +60 (string-source arm),
`object-runtime-enumeration.ts::buildObjectEnumerationHelpers` +60;
`call-object-builtins.ts` +8.

**Order constraints.** §20.1.2.1: ToObject(target) first (already), then per
source in order, per key in `[[OwnPropertyKeys]]` order (strings, then
symbols), `Get` then `Set(…, true)`. The precheck of step 2 must observe the
SAME key order and must run the source `Get` only once (do not read the
value in the precheck — descriptors of the TARGET only).

**Acceptance.**
- The 12 rows flip.
- **Passing shapes at risk, both trees:** `Object.assign({}, {a:1}, {b:2})`,
  `Object.assign(target, null, undefined, {c:3})`, `Object.assign([], [1,2])`,
  `Object.assign({}, "ab")` (host lane prints `{0:"a",1:"b"}` — after 3(a)
  standalone must match), a frozen literal WITHOUT assign (`Object.freeze(o); o.x = 1`
  strict throw, sloppy no-op) — byte-identical standalone modules (the
  precheck is gated on `assign` + a fold hit); the wrapper seeding must not
  change `(new Number(1)).toString()`/`Number.prototype.toString === (new Number()).toString`
  (`tests/issue-4248*` suite green, A/B'd); `built-ins/Object/assign/Target-Undefined.js`
  (control) stays green; host lane sha-identical for an `Object.assign(a, b)`
  program (`{target:"gc"}`).
- Pin `tests/issue-5268-r3-object-assign.test.ts`: frozen-data throw,
  frozen-accessor setter called, `Object.assign(true, {}).valueOf() === true`,
  `Object(sym) !== sym && typeof Object(sym) === "object"`.

### Step R3-4 — Proxy MOP residual in the Object statics (group E; 9 of 11 rows; risk: high)

**Root cause.** Traps are read off the handler ONCE, at `new Proxy` time
(`object-runtime-proxy.ts:1511-1537`, the `readTrap("get")…readTrap("construct")`
sequence into `$ProxyTraps`). §10.5.* does `GetMethod(handler, "<trap>")` at
EVERY operation, so a handler that is itself a Proxy (`new Proxy(handler,
check)` — `{values,entries}/observable-operations.js`,
`keys/property-traps-order-with-proxied-array.js`, and R's
`splice/property-traps-order-with-species.js`) contributes no traps today (the
`$Proxy` handler fails `readTrap`'s `$Object` read → empty log). This is the
r2 "wrapTest mystery": the hand probe used a plain handler. Plus r2 steps
2.4-2.7 (never started).

**Files / functions.**

1. Lazy trap lookup for a Proxy-typed handler: in `object-runtime-proxy.ts`,
   at `new Proxy` (L1511) record a `handlerIsProxy` i32 (append a field to
   `$Proxy` or reuse a spare flag bit — the struct layout is minted in the
   same file; pick the option that keeps `F_PTARGET`/`F_PHANDLER`/`F_REVOKED`
   indices stable) and at every `trap = p.ptraps.<field>` read site
   (L316, L565, L883, L966, L1194, L1315 and the ownKeys/gopd/gpo/spo/isext/
   prevext/define sites that share the pattern) route through ONE new factory
   `trapFetchInstrs(field, name)`: `handlerIsProxy ? GetMethod via __extern_get(handler, "<name>")` (which
   dispatches the handler-proxy's own `get` trap) `: p.ptraps.<field>`. The
   ordinary-handler path is byte-identical (the flag is 0). GetMethod: a
   present non-callable trap is a TypeError, `undefined`/`null` is absent
   (§7.3.9, the rule L129/L377 already document).
2. r2 step 2.4 — `Object.keys(proxy)` post-trap enumerability
   (`proxy-non-enumerable-prop-invariant-3`): in `buildOwnKeysDispatch`'s
   `Object.keys` forward (L732; `forwardName === "__object_keys"`), after the
   trap list is materialised, filter each STRING key through
   `__proxy_gopd_dispatch(p, k)`, keeping only `enumerable === true`
   (§7.3.25 step 4.a). `proxy-keys.js` (`illegal cast … __module_init_chunk_1`):
   the ownKeys trap returns an array-LIKE `$Object` with numeric GETTERS; the
   CreateListFromArrayLike loop at L768+ reads entries with `__extern_get_idx`
   — confirm with a 6-line repro whether it is that read or the later
   `__objvec` cast that traps, then read `length`/indices through
   `__extern_get` with a string key (getter-aware) when the result is not a
   `$ObjVec`.
3. r2 step 2.5 — `__getOwnPropertySymbols` Proxy arm: ownKeys result filtered
   to `$Symbol` carriers (`object-runtime-descriptors.ts:3305`, prepend the
   arm with the `fillObjectIntegrityProxyArms` `install()` idempotence shape,
   `object-integrity-proxy.ts:949-970`); and `__object_getOwnPropertyDescriptors`
   (`src/stdlib/object-runtime.ts:59-72`, self-hosted TS): switch the key
   source to names ++ `__getOwnPropertySymbols(obj)` and SKIP a key whose
   `__getOwnPropertyDescriptor` answers `undefined` (`proxy-undefined-descriptor`);
   this also serves D's `symbols-included` and
   `getOwnPropertyDescriptors/order-after-define-property` once R3-6 gives
   gOPS its `$Vec` arm. (`__getOwnPropertySymbols` must be added to the
   `calleeTypes` map at L110-114.)
4. r2 step 2.6 — `Object.defineProperties(o, proxy)`: at the
   `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` refusal (`object-runtime-descriptors.ts:1326`)
   add a `$Proxy` PROPS arm: keys = `__proxy_own_keys_all(props)`
   (`object-integrity-proxy.ts:174`), per key `d = __proxy_gopd_dispatch`,
   skip undefined, collect, then define in order. The row only asserts the
   gopd trap ORDER `["0","foo",sym]`.
5. r2 step 2.7 — `__isPrototypeOf` (`object-runtime-prototype.ts:777-781`):
   replace the raw `struct.get $proto` hop with `__getPrototypeOf(cur)`
   (Proxy `gpo` guard) — one call per hop, `ref.eq` unchanged.

**Rows claimed (9):** `{values,entries}/observable-operations.js`,
`keys/proxy-non-enumerable-prop-invariant-3.js`, `keys/proxy-keys.js`,
`keys/property-traps-order-with-proxied-array.js`,
`getOwnPropertyDescriptors/proxy-{no-ownkeys-returned-keys-order,undefined-descriptor}.js`,
`defineProperties/proxy-no-ownkeys-returned-keys-order.js`,
`isPrototypeOf/arg-is-proxy.js`. **DEFERRED (2):**
`{freeze,seal}/proxy-with-defineProperty-handler.js` — r2 measured the trap
sequence correct and the failure in a closed-struct capture
(`seenDescriptors[key] = descriptor` not persisting into a captured empty
literal); that is a value-representation defect outside this issue.

**Growth grant:** `object-runtime-proxy.ts` +120,
`object-runtime-proxy.ts::fillProxyDispatch` +60,
`object-runtime-proxy.ts::buildProxyRuntime` (or whichever function owns
L1500-1570 — name it in the PR) +20; `object-runtime-descriptors.ts` +70,
`object-runtime-descriptors.ts::buildObjectDescriptorHelpers` +50;
`src/stdlib/object-runtime.ts` +15; `object-runtime-prototype.ts` +10,
`object-runtime-prototype.ts::buildObjectPrototypeHelpers` +10.

**Order constraints.** Trap lookup order per operation is observable
(`property-traps-order-with-proxied-array` expects exactly
`["ownKeys","getOwnPropertyDescriptor"]` from the HANDLER proxy's `get`
trap, in that order, and nothing else — so the lazy fetch must read only the
trap the operation needs, never pre-fetch). EnumerableOwnProperties:
`ownKeys`, then per key `gopd` → `get`.

**Acceptance.**
- The 9 rows flip.
- **Passing shapes at risk, both trees:** `built-ins/Proxy/` — the largest
  blast radius in this plan: run the 60-row sample
  `built-ins/Proxy/{get,set,has,ownKeys,getOwnPropertyDescriptor,defineProperty}/`
  (first 10 of each, in 15-row batches) and require an IDENTICAL pass set;
  `built-ins/Object/seal/seal-proxy.js` (control) green; the 280-row
  `Object/{freeze,seal,isFrozen,isSealed,values,entries}` set r2 measured
  (253/26) must not lose a row (run in 15-row batches or the subset touched);
  `tests/issue-5268*.test.ts` (r2's 23 pins) green; an ordinary-handler
  program (`new Proxy({a:1}, { get(t,k){ return 42 } })`) compiles to a
  byte-identical standalone module (the lazy path is flag-gated); host lane
  sha-identical.
- Pin `tests/issue-5268-r3-proxy-handler-proxy.test.ts`: the nested-handler
  log for `Object.entries`, and `Object.keys` post-trap filtering.

### Step R3-5 — concat residuals (group J; 10 of 12 rows; risk: low-medium)

r2 step 8 is still exact; the sub-items below are re-anchored to today's code.

1. (d) `is-concat-spreadable-val-falsey` (1 row, one line): `array-concat-spec.ts:212-216`
   tests `ref.is_null ∨ __extern_is_undefined`; §23.1.3.1.1 step 3 is "if
   `spreadable` is not undefined, return ToBoolean" — drop the `ref.is_null`
   term (a present `null` is falsy, not absent). Risk: a receiver whose
   reflective read returns `ref.null` for ABSENT — verify `__extern_get` on a
   `$Vec`/closure/`$Object` miss returns the undefined singleton, not
   `ref.null`, with a 3-line probe; if any carrier answers `ref.null` for a
   miss, keep the null term for that carrier only.
2. (e) `is-concat-spreadable-get-order` (1 row): in
   `compileArrayConcatNativeSpecFromExprs` (L348-380) emit the species
   prologue (`emitArraySpeciesCreate`, L375) BEFORE `emitConcatSource` runs
   the receiver's `@@isConcatSpreadable` Get; the receiver is already stashed
   in a local, so only the call order moves.
3. (c) `concat_array-like-length-to-string-throws` / `-to-length-throws` /
   `arg-length-exceeding-integer-limit` (3 rows): `index.ts:9194-9225`
   (`closure-extern` arm of `emitDispatchForMethod`) `ref.cast`s the field to
   `entry.closureTypeIdx` unguarded — a `valueOf: null` field traps. Add
   `ref.test` and treat a non-closure slot as ABSENT (fall to the next
   candidate / `toString`); when neither is callable `__to_primitive` must
   throw TypeError (§7.1.1.1 step 6) — check `__class_to_primitive`'s tail
   does, else add it. For the Proxy-backed `length` (`arg-length-exceeding…`)
   the read at L232 is `__extern_length(src)` — confirm its `$Proxy` arm
   reaches the `get` trap (it should via `__extern_get`); the L235-244
   overflow check then fires.
4. (a) `concat_{strict,sloppy,sloppy-with-dupes}-arguments` (3 rows):
   `__extern_has_idx` on a `__arguments_vec` whose `length` was overridden to
   6 answers true for 3..5 — in the `__extern_has_idx` arguments arm
   (`object-runtime.ts`, the consumer of `ARGUMENTS_LENGTH_OVERRIDE_FIELD`
   next to L11158-11190) compare the index against the PHYSICAL vec length
   (field 0), not the override; the concat loop then pushes `$Hole` and the
   patched output readers map it to `undefined` (`compareArray` reads through
   `__extern_get_idx`).
5. (b) `concat_spreadable-sparse-object` (1 row, "uncaught Wasm-GC exception"):
   `[].concat({length: 5, [@@isConcatSpreadable]: true})` then
   `compareArray(new Array(4000), [].concat(obj))` — repro the 5-element case
   alone first; the exception is thrown, not a marker escape — suspect
   `holeSentinelInstrs` (L285) reaching a reader that `throw`s on `$Hole`.
   Name the reader in the PR.
6. (g) `is-concat-spreadable-proxy` (1 row): the argument is a Proxy with a
   `get` trap; the spreadable read at L208-211 already goes through
   `__extern_get`; the `illegal cast in __module_init_chunk_0` is therefore
   downstream — `__extern_length`/`__extern_get_idx` on the `$Proxy` — 6-line
   repro, then add the `$Proxy` forward to whichever helper casts.
7. (f) `concat_{large,small}-typed-array` (2 rows) — **DEFERRED** unless
   `__extern_is_array` answering `false` for `$__ta_view` plus the TA expando
   read needs no #4449-owned internals; check `collectStandaloneArrayCarrierTypeIdxs`
   (`object-runtime.ts` ~L8162) first and say which in the PR.

**Rows claimed (10)**, 2 deferred. **Growth grant:** `array-concat-spec.ts` +30,
`array-concat-spec.ts::compileArrayConcatNativeSpecFromExprs` +15,
`array-concat-spec.ts::emitConcatSource` +10; `index.ts` +25 (the guarded
cast); `object-runtime.ts` +20 (shared with R3-3).

**Order constraints.** §23.1.3.1: `ArraySpeciesCreate(O, 0)` (its
`constructor` Get) FIRST, then per E: `Get(E,@@isConcatSpreadable)` →
`IsArray(E)` only if undefined → `Get(E,"length")` → per index `HasProperty`
then `Get`.

**Acceptance.** The 10 rows flip; **passing shapes at risk:**
`built-ins/Array/prototype/concat/` (≤ 45 rows, in 15-row batches) identical
pass set on both trees — this file was the r2 control
`concat_spreadable-number-wrapper.js`/`create-species-non-extensible-spreadable.js`/`concat_array-like.js`
home; `[].concat([1,[2]], 3)`, `arr.concat()` on a typed vec, `Array.prototype.concat.call(obj, …)`
printed on both trees; `"" + {valueOf(){return 1}}` / `+{toString(){return "2"}}` / `String({})`
(the `__call_valueOf` dispatcher consumers) printed on both trees in BOTH
lanes — the `index.ts` arm is not standalone-gated, so the host lane needs a
sha or output diff too.

### Step R3-6 — symbol keys on `$Vec`/closure carriers + intrinsic symbol props (groups D + D2; 9 of 10 rows; risk: medium)

1. `__getOwnPropertySymbols` (`object-runtime-descriptors.ts:3305-3383`): add
   BEFORE the `$Object` test a `$__vec_base` arm — `bag = __vec_bag_lookup(obj)`
   (`vec-props.ts:64`, `VEC_BAG_LOOKUP`); non-null → run the SAME
   `__obj_ordered_symbols` loop on the bag — and a closure arm via
   `__closure_bag_lookup` (`closure-props.ts:85`, compose through
   `ctx.funcMap.get`, do not edit that file). Rows:
   `getOwnPropertySymbols/order-after-define-property.js` (array half),
   with R3-4.3 also `getOwnPropertyDescriptors/{symbols-included,order-after-define-property}.js`.
2. `Object.entries` omits symbol keys (`entries/symbols-omitted.js`): the
   static-struct arm at `object-ops.ts:4360` enumerates literal fields
   including a computed-symbol one; filter by the `ctx.oracle` literal-shape
   fact's key kind (never `ctx.checker`). Also the `Object.defineProperty(obj, nonEnumSym, …)`
   in that test forces the runtime path — check which path the row takes
   before editing.
3. Function receivers (`keys/entries/order-after-define-property-with-function.js`,
   2 rows): `Object.defineProperty(fn, "length", {enumerable: true})` lands
   `length` in the closure bag AFTER `a`; §10.1.11.1 order is creation order,
   and `length`/`name` were created at function creation. In
   `__carrier_bag_push_keys` (`carrier-bag-visibility.ts:250 buildBagPushKeys`
   → the `CARRIER_BAG_PUSH_KEYS` native filled at L442
   `fillCarrierBagVisibility`) for CLOSURE carriers emit the builtin own names
   the bag marks enumerable (`length`, then `name`) FIRST, then the remaining
   bag keys in insertion order.
4. `getOwnPropertyNames(arr)` after `defineProperty(arr,"length",{value:2})`
   fabricates `0,1` (`getOwnPropertyNames/order-after-define-property.js`):
   `vec-overlay-keys.ts` (RC2 in its header) enumerates `0..length-1`; use
   the hole-aware presence helper (`vec-overlay-presence.ts`) so an index
   with no slot and no overlay entry is not listed.
5. D2 `Array.prototype[@@unscopables]` (`Symbol.unscopables/{value,prop-desc}.js`):
   NEW `src/codegen/array-unscopables-native.ts` (≈ 90 LOC) with
   `emitArrayUnscopablesSingleton(ctx, fctx)` copying the lazy-global pattern
   of `emitIteratorPrototypeSingleton` (`array-object-proto.ts:3799-3880`):
   a null-prototype `$Object` (`__object_create(null)` or `__new_plain_object`
   + `OBJ_FLAG_NULL_PROTO`) with the full modern name list the `value.js`
   row asserts (read the file: `at, copyWithin, entries, fill, find, findIndex,
   findLast, findLastIndex, flat, flatMap, includes, keys, toReversed, toSorted,
   toSpliced, values`), each `{writable:true, enumerable:true, configurable:true}`
   via `__defineProperty_value` flags `0b111`; wire the element-access read
   `Array.prototype[Symbol.unscopables]` (the builtin-proto symbol-member read
   in `builtin-value-read.ts` — `getWellKnownSymbolId("unscopables")` = 11 at
   L182 already interns the id) and the gOPD arm in `builtin-static-gopd.ts`
   beside `tryEmitStandaloneBuiltinSpeciesGopd` (L444) with
   `{writable:false, enumerable:false, configurable:true}`.
6. `Array[Symbol.species] = v` refusal (`Symbol.species/symbol-species.js`):
   `verifyNotWritable` writes through `__extern_set` onto the ctor carrier;
   extend `buildBuiltinFnSetRefusalArm` (`carrier-bag-visibility.ts:328`) to
   refuse a `@@species` key (symbol id from `getWellKnownSymbolId("species")`)
   on `SPECIES_OWNER_CTORS` carriers (`builtin-static-gopd.ts:384`) — sloppy
   no-op, strict TypeError through the shared result channel
   (`SET_RESULT_REFUSED`).

**Rows claimed (9):** all group D/D2 rows except
`getOwnPropertyDescriptors/order-after-define-property.js` IF R3-4.3's
symbol source does not flip it — say so.

**Growth grant:** `array-unscopables-native.ts` new;
`object-runtime-descriptors.ts` (shared with R3-4) ;
`carrier-bag-visibility.ts` +50, `carrier-bag-visibility.ts::fillCarrierBagVisibility` +30,
`carrier-bag-visibility.ts::buildBuiltinFnSetRefusalArm` +15;
`vec-overlay-keys.ts` +20; `object-ops.ts` +15,
`object-ops.ts::compileObjectKeysOrValues` +15; `builtin-value-read.ts` +25
(shared with R3-1); `builtin-static-gopd.ts` +30.

**Acceptance.** The rows flip. **Passing shapes at risk, both trees:**
`Object.getOwnPropertySymbols({[s]:1})`, `Object.keys(fn)` after `fn.a=1`
(no `length` redefine → `["a"]` unchanged), `Object.getOwnPropertyNames([1,2])`
→ `["0","1","length"]`, `Object.keys(arr)` on a sparse `[1,,3]`, `for-in`
over an array with expandos — printed on both trees; the r2 pins
`tests/issue-5268*.test.ts` and `built-ins/Object/getOwnPropertySymbols/object-contains-symbol-property-with-description.js`
+ `Object/entries/return-order.js` (controls) green; `with (arr) { … }` —
`with-has-binding-native.ts` reads `@@unscopables` at runtime, so
`language/statements/with/unscopables-*.js` (≤ 10 rows) must keep an
identical pass set once the object is real (today they see `undefined`).

### Step R3-7 — reflective HOF on a Proxy receiver: species prologue + `ArrayCreate` RangeError (groups I + P; 6 rows; risk: medium)

**Root cause** (r2 step-6 "NOT done", confirmed by reading):
`Array.prototype.{map,filter,splice,slice}.call(proxy, …)` is served by
`emitArrayProtoMemberBody` (`array-object-proto.ts:871`) → the `__hof_<m>`
route at L896-925 (map/filter) or the refusal (splice), which never runs
`ArraySpeciesCreate`, so neither the revoked-proxy TypeError from `IsArray`
(`create-revoked-proxy` ×3, `ctorCount === 0` asserted) nor the `len ≥ 2^32`
RangeError (`create-species-undef-invalid-len` ×2, `create-proxied-array-invalid-len`)
can fire.

**Edits.** In `emitArrayProtoMemberBody` (map/filter branch, before the
`call hofIdx` at L923): after the ToObject guard, `len = __extern_length(this)`
(f64), then `emitArraySpeciesCreate(ctx, fctx, deps, [local.get 1], [local.get len])`
(`array-species.ts:264`; `deps` via the same `prepareArraySpeciesDeps` the
direct `map` lowering uses at `array-methods.ts:4999`) — a null result means
the default lane: emit the §10.4.2.2 `ArrayCreate` check `len > 2^32-1 ⇒
RangeError "Invalid array length"` (`buildThrowJsErrorInstrs(ctx, "RangeError", …)`)
BEFORE the loop; a non-null species object → run the HOF into a `$ObjVec`
then `emitArraySpeciesResultSwap` (L380). Give `splice` and `slice` the
same prologue via a new arm in `array-like-native.ts emitArrayLikeNativeMemberBody`
(L546; `splice` needs the §23.1.3.31 loop — if that is more than ~120 LOC,
claim only the `slice` row and defer `splice/create-{revoked-proxy,species-undef-invalid-len}`
with that reason).

**Rows claimed (up to 6):** `{filter,map,splice}/create-revoked-proxy.js`,
`{map,splice}/create-species-undef-invalid-len.js`,
`slice/create-proxied-array-invalid-len.js`.

**Growth grant:** `array-object-proto.ts` +60,
`array-object-proto.ts::emitArrayProtoMemberBody` +45; `array-like-native.ts`
+80 (slice arm), `array-like-native.ts::emitArrayLikeNativeMemberBody` +10.

**Order constraints.** §23.1.3.18 map: ToObject → `Get(O,"length")` →
IsCallable(cb) → ArraySpeciesCreate → loop. IsArray(O) inside
ArraySpeciesCreate must throw for a revoked proxy BEFORE `Get(O,"constructor")`
(already the r2 step-6 shape) and BEFORE the first callback.

**Acceptance.** The rows flip; **passing shapes at risk, both trees:**
`Array.prototype.map.call(arguments, String)` (the #4394 harness idiom —
`compareArray.format`), `Array.prototype.map.call({length:2,0:1,1:2}, x=>x*2)`,
`Array.prototype.filter.call("abc", c => c > "a")`, `[1,2].map(x=>x)` (direct,
must be byte-identical — the direct lowering is untouched); the 41-row
`create-species*.js` + `Symbol.species*.js` set r2 measured at 38/3 must stay
38/3 or better with the same 3 non-pass; controls `filter/create-non-array.js`,
`slice/create-species-poisoned.js` green.

### Step R3-8 — `toLocaleString` must `Invoke` (group H; 4 rows; risk: low)

`Object.prototype.toLocaleString` (§20.1.3.5) is `Invoke(this,"toString")`;
`Array.prototype.toLocaleString` (§23.1.3.32) per element
`Invoke(elem,"toLocaleString")`. The Array side already has the `localized`
arm (`array-methods.ts:5425 ensureElementToLocaleStringInvoke`, used at
L5485/L5737); the failing rows patch `Boolean.prototype.toString` (or a
GETTER for it) and expect the element's `toLocaleString` → `toString` chain to
see the patch. Edits: (1) `builtin-prototype-brand.ts:536` — for
`<primitive>.toLocaleString()` on a boolean/number/string receiver (static
fold today), when the module has a dirty `Boolean/Number/String.prototype`
companion (`seededNativeProtoOwnMembersByBrand(ctx)` non-empty for that brand,
`native-proto.ts`), emit `__extern_method_call(box(x), "toString")` instead of
the fold; (2) `ensureElementToLocaleStringInvoke` — confirm it dispatches
`toLocaleString` through `__extern_method_call` (which reaches the seeded
companion via `__protoidx_get_r`) and that the inherited
`Object.prototype.toLocaleString` fallback in that native calls
`Invoke(elem,"toString")` rather than `__extern_toString` — the GETTER row
(`primitive_this_value_getter`) additionally needs the accessor to run with
`this` = the boxed primitive (the `__reflect_get_receiver` route
`closure-props.ts:850-857` describes).

**Rows:** the 4 `toLocaleString/primitive_this_value*.js`. **Grant:**
`builtin-prototype-brand.ts` +25, `builtin-prototype-brand.ts::tryBorrowedPrototypeNullishThisThrow` +0
(new helper beside it), `array-methods.ts` +30. **At risk:** `[1,2].toLocaleString()`,
`(1234.5).toLocaleString()`, `true.toLocaleString()` with NO patched proto —
byte-identical (gated on a dirty companion); `built-ins/Array/prototype/toLocaleString/`
(≤ 15 rows) identical pass set; host lane untouched (`!ctx.standalone && !ctx.wasi` return at L1989 stays).

### Step R3-9 — small clusters, ordered (groups N, S, Q, R, M, A/B, F, O)

- **S (1 row, low)** `hasOwnProperty/topropertykey_before_toobject.js`:
  `tryBorrowedPrototypeNullishThisThrow` (`builtin-prototype-brand.ts:681`)
  compiles+drops the args (L719-722) BEFORE throwing, but the key's
  `ToPrimitive` (`hint === "string"` observed) never runs because the drop
  is of the raw value: for `hasOwnProperty`/`propertyIsEnumerable` call
  `__to_property_key` on argument 1 (dropping its result) before the throw;
  `compilePropertyIntrospection` (`object-ops.ts:4644-4676`) already routes the
  dynamic receiver to `__hasOwnProperty`, which must ToPropertyKey before its
  own nullish throw — check that native's order too. At risk:
  `hasOwnProperty.call("ab", "0") === true`, `({}).hasOwnProperty(sym)` — both trees.
- **N (3 rows, medium)** ArraySetLength: `maybeEmitVecLengthDefine`
  (`array-length-define.ts:111`) returns `false` for an object-valued `value`
  (L199) and the dynamic `fillVecLengthDynamicArms` (`vec-length-set.ts:87`)
  applies ONE `__to_primitive` (L118-125); §10.4.2.4 steps 3-4 call
  `ToUint32(Desc.[[Value]])` AND `ToNumber(Desc.[[Value]])` — two ToPrimitive
  hints `number` (`coercion-order-set` expects `["number","number"]`), then
  RangeError on mismatch, then (step 12-13) if `length` is non-writable NOW
  (it became so inside `valueOf`) → return false / strict TypeError. Add the
  second coercion + the post-coercion writability re-check in both the
  static arm (route object values to the dynamic native instead of `false`)
  and the dynamic arm; `no-value-order`: a descriptor with no `value` must
  not touch `enumerable` — `Object.defineProperty([], "length", {configurable:true})`
  is a TypeError ("Cannot redefine") and `{enumerable:true}` via
  `Reflect.defineProperty` is `false`, `{get(){}}` TypeError, `{writable:true}`
  on a non-writable length TypeError — today the enumerable path throws the
  wrong message. Grant: `array-length-define.ts` +40,
  `array-length-define.ts::maybeEmitVecLengthDefine` +25; `vec-length-set.ts`
  +40, `vec-length-set.ts::fillVecLengthDynamicArms` +40. At risk:
  `arr.length = 0`, `arr.length = 2**32-1`, `Object.defineProperty(arr,"length",{value:2})`,
  `arr.length = "3"`, `arr.length = new Number(1)` (S15.4.5.1_A1.3_T1/T2),
  propertyHelper `verifyWritable(array,"length")` — printed on both trees;
  `built-ins/Array/length/` (≤ 15 rows) identical pass set.
- **Q (4 CE, medium)** `flat`/`flatMap` species targets: extend
  `tryCompileArrayFlatNativeDepth1` (`array-methods.ts:10278`) to run
  `emitArraySpeciesCreate` first and write through `emitArraySpeciesResultSwap`
  when `ctx.arraySpeciesDirty` (the same gate the direct `map` lowering uses at
  L4999), so the CE (the `#2717` refusal at L10404's fallthrough) becomes a
  runtime path; never leave a CE that could become a wrong answer — if the
  heterogeneous target cannot be handled, keep the refusal for THAT shape.
  Grant: `array-methods.ts` +60 (shared with R3-8),
  `array-methods.ts::tryCompileArrayFlatNativeDepth1` +30. At risk:
  `[[1],[2]].flat()`, `[1,2].flatMap(x=>[x,x])`, `[[1,[2]]].flat(2)` (must
  still refuse or answer identically) — both trees.
- **R (2 of 3 rows, medium)** `copyWithin` reflective: `compileArrayCopyWithin`
  (`array-methods.ts:9711`) is vec-only; the rows use
  `Array.prototype.copyWithin.call(proxy, 0, 0)` and today hit the
  "not yet callable as a value" refusal (that is the TypeError the rows
  report). Add `copyWithin` to `emitArrayLikeNativeMemberBody`
  (`array-like-native.ts:551`) with §23.1.3.4 steps 3-18 over
  `__extern_length` / `__extern_has` / `__extern_get` / `__extern_set_strict` /
  `__delete_property` (all Proxy-guarded). `splice/property-traps-order-with-species.js`
  — **DEFERRED**: needs R3-4.1 (nested handler proxy) AND a full splice
  trap sequence. Grant: `array-like-native.ts` +110 (shared with R3-7). At
  risk: `[1,2,3,4,5].copyWithin(0,3)` direct (byte-identical) and control
  `copyWithin/return-abrupt-from-target-as-symbol.js`.
- **M (3 rows, medium)** `Array.prototype.{keys,values,entries}.call(obj)`:
  give the three a body in `emitArrayProtoMemberBody` (L927 refusal): mint a
  native `$__IterRec` over the array-like exactly as the direct `[].values()`
  lowering does (`array-methods.ts:1296` region / `iterator-native.ts`), and
  make `Object.getPrototypeOf(<that record>)` answer
  `emitArrayIteratorPrototypeSingleton` (`array-object-proto.ts:3882`): the
  routing is keyed on the STATIC type `ArrayIterator<T>` (header L3782-3785)
  — `Array.prototype.keys.call(obj)` is typed `IterableIterator<number>`, so
  the runtime `__getPrototypeOf` needs a `$__IterRec` arm answering the
  Array singleton global (`ctx.builtinObjectGlobals.get("__native_array_iterator_prototype")`).
  Grant: `array-object-proto.ts` (shared with R3-7) +40;
  `object-runtime-prototype.ts` +20 (shared with R3-4). At risk:
  `[].values()`, `Object.getPrototypeOf([].values()) === Object.getPrototypeOf([][Symbol.iterator]())`,
  `getPrototypeOf(new Map().entries())` distinct — control
  `values/returns-iterator.js` + `tests/issue-3013*` green on both trees.
- **A/B residual (6 rows) — DEFERRED** with the r2 measured reasons: the
  closed-struct literal's runtime `%Object.prototype%` terminal (3 rows +
  `set-abrupt`) is a carrier change; `set-cycle-shadowed` needs
  `canonicalizeProtoArg` to stop unwrapping a Proxy link (a `__object_create`
  model change with a Proxy-lane owner, #5196); `prop-desc` needs
  `__proto__` in `OBJECT_PROTOTYPE_OWN_NAMES` (changes every `in` answer) plus
  `delete` on `Object.prototype`. Re-evaluate after R3-4.
- **F (9 rows) — 4 claimed, 5 need a repro first.** The four
  `concat_spreadable-{function,reg-exp,boolean-wrapper,string-wrapper}.js`
  rows: `[].concat(fn)` with `fn[@@isConcatSpreadable]=true; fn[0..2]=…`
  spreads to `[]` — `__extern_length(fn)` answers the arity 3 (correct), then
  `__extern_has_idx`/`__extern_get_idx` on a closure carrier have no bag
  consult. Add the closure/wrapper/RegExp carrier arms to those two natives
  (`object-runtime.ts`, the `objArrayLikeArms` region — compose through
  `buildClosurePropGetMissArm` (`closure-props.ts:157`) and the wrapper
  `[[PrimitiveValue]]` string-exotic reader `string-exotic-own-props.ts`);
  `Function.prototype[0] = 1` (inherited index) then also needs the
  `__protoidx_get_r` consult that `__closure_prop_get` already has. The five
  `create-proxy.js` rows (`array.constructor = function(){}; array.constructor[@@species] = Ctor;
  Array.prototype.map.call(new Proxy(new Proxy(array,{}),{}), …)`): after
  R3-7 the species prologue runs; `vecConstructorArmInstrs`
  (`vec-constructor-carrier.ts:131-153`) DOES consult the bag for an own
  `constructor`, and `__closure_prop_get` DOES read symbol keys from the bag
  (`$Object`), so the r2 diagnosis ("string-keyed bags only") is not
  supported by the code — run the 8-line repro (proxy → `Get("constructor")`
  → `Get(@@species)`) through the proxy-of-proxy `get` forward and name the
  failing hop before editing. Grant: `object-runtime.ts` +60 (total with
  R3-3/R3-5), `object-runtime.ts::ensureObjectRuntime` +20. At risk:
  `fn.length`, `fn[0]` (undefined), `"abc"[1]`, `new String("ab")[0]`,
  `/x/[0]` — both trees; `built-ins/Function/prototype/` (≤ 10 rows) identical.
- **O (4 rows) — DEFERRED.** `emitArraySpeciesResultSwap` already does
  define + plain `[[Set]]` (L423-451, with the comment naming this exact
  test); the read `r[0]` still answers the stale dense slot because the
  overlay entry from the species constructor's `defineProperty(q, 0, {writable:false})`
  shadows it and the later `[[Set]]` is refused by the (now writable, but
  overlay-resident) entry — a `vec-overlay.ts` define-vs-slot coherence
  question (#3251/#4491 territory). Reduce with the species-free repro from
  #5145 and route to the overlay owner.

### Step order and honest yield

| Order | Step | Rows | Risk | Why here |
|---|---|---:|---|---|
| 1 | R3-1 Array.from/of | 17 | medium | new module, biggest yield, typed fast paths untouched |
| 2 | R3-5 concat (10) | 10 | low-med | mostly one-line fixes in one 523-LOC file |
| 3 | R3-2 toString + leak | 8 | medium | closes 5 CEs; leak fix is a gate on every later CE claim |
| 4 | R3-3 assign/wrapper | 12 | medium | one new module + seeding; precheck is fold-gated |
| 5 | R3-6 symbols/D2 | 9 | medium | additive arms |
| 6 | R3-7 reflective HOF species | 6 | medium | contained in two files |
| 7 | R3-8 toLocaleString | 4 | low | gated on a dirty companion |
| 8 | R3-9 S, N, Q, R, M, F(4) | 4+3+4+2+3+4 = 20 | low-med | independent small edits |
| 9 | R3-4 Proxy handler-proxy + 2.4-2.7 | 9 | **high** | last: widest blast radius (`built-ins/Proxy`), needs its own PR |
| — | DEFERRED: E ×2, J(f) ×2, R ×1, A/B ×6, F ×5 (until repro), O ×4, G ×1 | 21 | | reasons above |

Planned: 17+10+8+12+9+6+4+20+9 = 95 of 114 in-scope rows (target ≥ 80 for
the wave); 19 deferred with named reasons (21 listed above minus the two
F/G rows that are "claim after repro"). One PR per step (R3-9 may batch by
file); R3-4 alone in its PR.

### Frontmatter grants (r3)

Added to the YAML below with a dated rationale: new files need no grant;
the listed god-files grow by wiring only. `total` is NOT granted — if the
change-set's net LOC exceeds the headroom, split the PR, do not widen the
grant.

## 2026-09-03 implementation (Opus) — step R3-1 (`Array.from` / `Array.of`)

New `src/codegen/array-from-native.ts`: `__array_from_native(C, items, mapFn,
thisArg, mapFnGiven)` (§23.1.2.1) and `__array_of_native(C, argsVec)`
(§23.1.2.3), standalone/WASI only. Two wiring sites in
`src/codegen/expressions/call-builtin-static.ts`: the direct `Array.from(…)`
arm (which REPLACES the #2169c drain-only lowering and the #3206
`__array_from_mapped` composition, both removed from that call site) and a new
arm for the spelled-out `Array.from.call(…)` / `Array.of.call(…)`.

### Measurement (base = branch point `5c8a182901`, materialised with
`git archive` into `.tmp/basetree`; both trees run with the same runner)

`built-ins/Array/{from,of}/**` — the WHOLE directory, 63 rows, in four batches:

| 63 rows | pass | non-pass |
| --- | ---: | ---: |
| base `5c8a182901` | 29 | 34 |
| this change-set | 49 | 14 |

**20 rows flipped to pass, ZERO new non-pass** (`comm` over both sorted
non-pass lists: 20 lines base-only, 0 lane-only). Of this issue's own 17-row
claimed list, **10 pass**; the other 10 fixed rows are `from`/`of` rows the
census had recorded as failing for the same root cause but outside the r3
group (e.g. `calling-from-valid-*`, `does-not-use-set-for-indices`,
`return-abrupt-from-{contructor,setting-length}`).

`.tmp/es2015/arrobj-controls.txt`: **20 / 20**.

### Two regressions found by the directory sweep and fixed before committing

Both were caught only because the sweep covered rows the claimed list never
mentions — the r2 lesson, reproduced:

- **`Array.from(x, null)` stopped throwing.** An externref null is BOTH "no
  mapfn argument" and the compiled `null` literal, so a value-shape test could
  not tell them apart (`mapfn-is-not-callable-typeerror.js`). Fixed by making
  the arity a fifth `i32` parameter — the decision travels WITH the call
  instead of being re-derived from the value.
- **`source-object-iterator-1.js` (a closed-struct literal with an inline
  `[Symbol.iterator]()`) stopped propagating its iterator's abrupt.** The
  `@@iterator` property probe answers false for a closed struct (its members
  are struct fields, not `$Object` entries), so the source fell into the
  array-like walk and read as length 0. Fixed by also taking the iterator
  branch when the source has no `length` at all — which is exactly what the
  pre-change drain-only lowering did for that shape.

### Regression checks beyond the row list

- `built-ins/TypedArray/prototype/map/` (12 rows) + 3 `Array/prototype/concat`
  rows: **identical pass set on both trees** (9/6, same six names) — the
  harness's `makeArray = Array.from({length:n}, fn)` still lands the same way.
- Behaviour control `.tmp/p/ctl2.js` (string / array / Set / Map / generator /
  `{length}`+mapFn / `Array.of` / spread / an explicit array iterator) printed
  BYTE-IDENTICAL on both trees for every line that base could reach; base
  THREW at the array-like line, which is the fix.
- **JS-host lane byte identity**: an `Array.from`/`Array.of` program and an
  `Array.from.call(C, …)` program both compile to sha-identical modules on the
  two trees (`d57eefc224…`, 6994 bytes; `b0d7257138…`, 6256 bytes) — every new
  arm is behind `noJsHost(ctx)`.
- No `env::*` import in any standalone probe (asserted in the pin).

### Not done, with the measured reason

- `from/iter-cstm-ctor.js`, `from/source-object-constructor.js` — the
  CONSTRUCTOR runs (probe: `callCount === 1`, zero args) and `A` is its result,
  but `result instanceof C` / `result.constructor === C` still answer false:
  TypeScript types `Array.from.call(C, items)` as `any[]`, so the identity
  reads fold on the ARRAY type before any runtime value is consulted. A
  static-type problem, not an algorithm one.
- `from/source-object-length.js` — `a[2]` for a deleted index answers `NaN`
  instead of `undefined`; the undefined sentinel is being read back through a
  number-typed lane.
- `from/source-array-boundary.js` — the mapper's `thisArg` (`this` at module
  scope) does not carry through `__apply_closure`.
- `of/does-not-use-prototype-properties.js` — its FIRST assertion is on the
  DIRECT `Array.of(true)` (untouched by this change) after
  `Object.defineProperty(Array.prototype, "0", {set})`; the accessor on the
  prototype defeats the read.
- `of/return-abrupt-from-data-property-using-proxy.js` — the constructor
  returns a Proxy and `__defineProperty_value` does not reach its
  `defineProperty` trap (cluster E territory).
- `Array.from(<Set|Map>, mapFn)` still routes to the host `env.__array_from`
  (the `isNonArrayBuiltinCollection` exclusion is kept deliberately) — same as
  base, and the reason the first control probe leaked an import on BOTH trees.
- The VALUE form (`var f = Array.from; f(x)`) deliberately keeps its existing
  refusal. A closure body cannot see the `.call` receiver — measured: a body
  that simply returns `__current_this` answers `undefined` for
  `Array.from.call(C, x)`, because the dispatch goes
  `__call_m_call_2 → __extern_method_call` and never through a
  `__call_fn_method_N` that installs it. Reifying the value would therefore
  have turned a loud refusal into a SILENT wrong answer for
  `f.call(C, items)`, so the `.call` support is at the (syntactic) call site
  and the value read is left at base parity.

Pin: `tests/issue-5268-r3-array-from.test.ts` (7 cases, imports asserted
empty). Verified against the base tree: the base run OOMs the vitest worker on
the IteratorClose case — the base defect there is an unbounded drain
("requested new array is too large") — and the other cases are red on base by
the row/probe evidence above (`alike=` threw on the base control run; every
`.call` row reported "Array.from is not yet implemented in --target
standalone"; `iter-map-fn-args` measured `args[0].length` 3).

Gates: all five green, and green again with
`LOC_GATE_BASE=$(git rev-parse origin/main)`. TS7 typecheck clean.

## 2026-09-03 implementation (Opus) — step R3-5 (concat residuals, partial)

Two of the plan's six concat sub-items landed; the rest are named below with
what stopped them.

### (d) §23.1.3.1.1 step 3 — a PRESENT falsy `@@isConcatSpreadable`

`array-concat-spec.ts`: the absence test accepted a wasm `ref.null` as
"absent" and fell back to `IsArray`, so `item[@@isConcatSpreadable] = null`
spread a two-element array. Step 3 keys on UNDEFINED only. Measured before
removing the term (`.tmp/p/e1.js`, standalone): `__extern_get` answers the
UNDEFINED singleton for a key it does not find — on a `$Vec`
(`[3,4][@@isConcatSpreadable]` prints "undefined") as well as an `$Object` —
while a stored `null` prints "null", so the null term was pure over-reach.
Row: `is-concat-spreadable-val-falsey.js`.

### (c, half) OrdinaryToPrimitive step 5.b.i `IsCallable`

`src/codegen/index.ts` `emitToPrimitiveMethodExports`: the `closure-extern`
and `closure` dispatch modes read the method FIELD and `ref.cast` it to the
closure struct type unguarded, so a `valueOf: null` slot TRAPPED. Base:
`illegal cast … at __call_valueOf ← __class_to_primitive ← __to_primitive ←
__extern_length`. Now `ref.test`-guarded; a non-closure slot takes the same
`else` an absent entry takes, i.e. the next candidate. Row:
`Array.prototype.concat_array-like-length-to-string-throws.js`.

**Not done, same item:** `{valueOf: null, toString: null}` must throw a
TypeError (`concat_array-like-to-length-throws.js`); today `__class_to_primitive`'s
tail returns the OBJECT unchanged and `__extern_length` reads it as 0. Adding
the throw there changes every silent ToPrimitive fall-through in the compiler,
not just this row — it needs its own measurement pass.

### Measurement

`built-ins/Array/prototype/concat/**`, the whole directory, 69 rows, base and
branch on the same tree in five batches:

| 69 rows | pass | non-pass |
| --- | ---: | ---: |
| base `5c8a182901` | 43 | 26 |
| this change-set | 45 | 24 |

**2 rows flipped, ZERO new non-pass.** `.tmp/es2015/arrobj-controls.txt`
20 / 20.

The `index.ts` guard is NOT standalone-gated, so the JS-host lane was checked
directly: a ToPrimitive program (`valueOf` / `toString` / a `valueOf: null`
length) compiles to a sha-IDENTICAL host module on both trees
(`43575a2c0a…`, 6666 bytes) and prints identical output on both lanes. Six
ToPrimitive-adjacent vitest suites A/B'd: 35 passed / 1 failed on this tree,
and that one failure (`es5-standalone-callable-tostring` — "a function
declaration does not stringify as [object Object]") is STANDING RED on the
base tree with the same name.

### Not started in this step

(a) the `arguments` carrier's `__extern_has_idx` vs its `length` override
(3 rows), (b) the `$Hole` escape, (e) `is-concat-spreadable-get-order` — the
species prologue already precedes the receiver's spreadable Get in
`compileArrayConcatNativeSpecFromExprs`, but `ctx.arraySpeciesDirty` is not
armed by `Object.defineProperty(arr, "constructor", …)`, so no `constructor`
Get happens at all and the row's expected first log line never appears —
(f) the two TypedArray rows, (g) `is-concat-spreadable-proxy`.

Pin: `tests/issue-5268-r3-concat.test.ts` (2 cases) — both verified to FAIL on
the base tree (`.tmp/basetree`).
