---
id: 5268
title: "ES2015 standalone: Array + Object built-ins — r2 residual pass (136 rows)"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-01
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
func-budget-allow:
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
