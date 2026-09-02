---
id: 5269
title: "ES2015 standalone: Function / Error / Symbol / String / JSON / Number built-ins — r2 residual pass"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-02
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5156, 5152, 4207, 4265, 4444]
loc-budget-allow:
  # 2026-09-01 r2 plan: every step below adds NEW emitted-code paths — a
  # reified `Symbol` namespace own-property table, a `Symbol.prototype`
  # `toString`/`@@toPrimitive` body + symbol-receiver write arm, a `$Proxy` arm
  # in the callable ToString cascade, an own `Error.prototype.stack` accessor
  # pair, native SuppressedError/AggregateError constructors, JSON codec
  # `$Proxy`/replacer/ToString(text) lanes, an open-object route for
  # `[Symbol.toPrimitive]` literals, Function.prototype.call/apply/bind bodies,
  # Number/Date reflective format bodies, and the normalize tables. Growth,
  # not refactor; granted for this change-set only.
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/builtin-ctor-own-props.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/builtin-fn-meta.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-value-read.ts
  - src/codegen/native-proto-own-props.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-own-props.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/member-set-dispatch.ts
  - src/codegen/callable-any-to-string.ts
  - src/codegen/coercion-engine.ts
  - src/codegen/function-proto-to-string.ts
  - src/codegen/function-proto-has-instance.ts
  - src/codegen/native-dynamic-instanceof.ts
  - src/codegen/reflect-construct-native.ts
  - src/codegen/native-construct.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/json-codec-native.ts
  - src/codegen/json-standalone.ts
  - src/codegen/literals.ts
  - src/codegen/symbol-native.ts
  - src/codegen/symbol-proto-valueof.ts
  - src/codegen/string-ops.ts
  - src/codegen/string-raw.ts
  - src/codegen/string-proto-substring.ts
  - src/codegen/error-props.ts
  - src/codegen/registry/error-types.ts
  - src/codegen/disposable-runtime.ts
  - src/codegen/promise-combinators.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - scripts/gen-normalize-tables.mjs
  - src/codegen/normalize-tables.ts
  - src/codegen/normalize-native.ts
  - src/codegen/number-proto-format.ts
  - src/codegen/error-stack-accessor.ts
  - src/codegen/symbol-proto-tostring.ts
func-budget-allow:
  # 2026-09-01: each is a kind-dispatch / arm-ladder function that gains one
  # more arm in the shape its existing arms already have (see the step that
  # names it). Add further entries here, with a dated line, if the gate names
  # another function — never edit scripts/*-baseline.json.
  - src/codegen/builtin-static-gopd.ts::tryEmitStandaloneBuiltinStaticGopd
  - src/codegen/builtin-ctor-own-props.ts::pushBuiltinCtorOwnPropSeed
  - src/codegen/array-object-proto.ts::makeGlue
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
  - src/codegen/native-proto.ts::ensureNativeProtoCompanionSeeder
  - src/codegen/expressions/object-get-prototype-of.ts::tryCompileEs5GetPrototypeOfValue
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/callable-any-to-string.ts::fillCallableExternToStringArm
  - src/codegen/reflect-construct-native.ts::fillReflectIsConstructor
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/builtins.ts::emitDateProtoMemberBody
  - src/codegen/json-codec-native.ts::emitJsonStringifyValue
  - src/codegen/literals.ts::objectLiteralForcesHostPath
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  # 2026-09-02 (Opus impl, Step G-5): the InternalizeJSONProperty proxy arm
  # gains the §7.2.2 IsArray step-3 recursion — a loop that unwraps a
  # proxy-of-a-proxy to its first non-proxy [[ProxyTarget]] before the
  # array-vs-object classification. Same arm shape, one more unwrap.
  - src/codegen/json-codec-native.ts::emitJsonParseTextReviver
---

# #5269 — ES2015 standalone: Function / Error / Symbol / String / JSON / Number built-ins (r2)

## Problem

The 2026-09-01 standalone baseline (loopdive/js2wasm-baselines, compiler sha
`d39779cb`, an ancestor of HEAD) lists 150 failing ES2015 rows across
`built-ins/Symbol/**` (42), `built-ins/Function/**` (35), `built-ins/String/**`
(29), `built-ins/Error/**` + `NativeErrors` + `ThrowTypeError` (~21),
`built-ins/JSON/**` (14), `Date` (6), `Number`/`Boolean`/`isNaN`/`isFinite`,
`AsyncFunction` (2) and `annexB/built-ins/{escape,unescape,String}` (5). Wave
1 (#5156 function/error/symbol/date, #5152 string — both landed via PR #5244)
built the mechanisms (Error-family `dataProps`, per-NativeError prototype
identity, Date `@@toPrimitive`, accessor `@@toPrimitive`, `String.prototype
[Symbol.iterator]`, runtime IsRegExp, astral case mapping); this is the
residual pass over what those waves' "Not attempted / deferred" sections left
open, plus the JSON residue #3176 did not take (its 2026-08-27 slice closed the
seven reviver-abrupt rows only).

**Re-verified on HEAD `c68dea0d2` (2026-09-01)** with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/builtins-head.txt --standalone`
(150 rows in-process, 15.5 min at load 8–16 on the shared 4-core box; raw
per-row verdicts: `.tmp/es2015/builtins-head-run1.tsv`):

| | pass | fail | compile_error |
|---|---|---|---|
| 150 in-process | **0** (nothing to drop) | 128 | 22 |

Five of the 22 CEs were compile TIMEOUTS under load; re-run alone on a quiet
box: `Function/prototype/name.js` **still times out at 33 s** (a genuine
slow-compile row — see cluster F), `AsyncFunction/is-a-constructor.js` is an
ordinary `fail`; the other three (`derived-return-val-realm`,
`stack/setter-cross-realm`, `Symbol/hasInstance/cross-realm`) are realm rows
and out of scope regardless.

**Target = 150 rows**, split into the per-cluster lists
`.tmp/es2015/builtins-cl-<X>.txt` (they partition the 150 exactly — verified
0 unclustered, 0 duplicates by `.tmp/es2015/builtins-cluster.py`).

Two things changed since the baseline and shape the plan:

1. **The `env::__new_SuppressedError` leak is RE-CLASSIFIED, not gone.**
   Baseline: 2 `host_import_leak` CEs (`NativeErrors/message_property_native_error.js`,
   `Error/prototype/stack/getter-subclass.js`). On HEAD both are RUNTIME
   failures with unrelated messages (`Expected obj[message] to equal
   my-message, actually undefined` / `Cannot access property on null` at the
   `stack` descriptor) — the same runner discrepancy #5267 measured (the runner
   instantiates against the host `env` instead of flagging the leak,
   `standaloneHostImportError`, `tests/test262-runner.ts:3700`). The leak is
   verified with the module's real import list (`imports-of.mts`, Step E-0),
   never with the runner's classification.
2. `Function/prototype/name.js` compiles for 33 s even on a quiet box (the
   runner's per-test budget is 15 s). It is counted in cluster F but the row
   cannot flip until the compile time is fixed (F-4).

Probe tooling: `npx tsx .tmp/probe-one.mts /abs/path/probe.js` (one file
through `runTest262File` on the standalone lane, 120 s budget);
`npx tsx .tmp/es2015/probes5267/imports-of.mts <file.js>` prints the compiled
module's real import list. Repros from this analysis:
`.tmp/es2015/probes5269/p1…p10*.js`, results in
`.tmp/es2015/builtins-probes-run1.txt`:

- `p1` `Symbol.prototype.toString.call(Symbol('66'))` evaluates to a NULL
  externref (the follow-up `String(r)` traps in `__str_concat`) — cluster B.
- `p2` `Function.prototype.call` read as a VALUE and then `.call`ed throws the
  glue refusal `Function.prototype.call is not yet implemented` — cluster M.
- `p3` `Object.getOwnPropertyDescriptor(Error.prototype, 'stack')` → undefined — cluster D.
- `p4` `JSON.stringify(new Proxy({a:1,b:1}, {}))` → `"null"` — cluster G.
- `p5` `Object.getOwnPropertyDescriptor(Symbol, 'iterator')` → the `__get_builtin`
  COMPILE error (the `builtin-static-gopd.ts:359` exclusion) — cluster A1.
- `p6` `Function.prototype.toString.call(new Proxy(function(){}, {}))` ALREADY
  returns a string; `…call(new Proxy({}, {}))` returns without throwing —
  cluster C-2 is the non-callable arm only.
- `p7` `escape({ toString(){throw}, valueOf(){throw}, [Symbol.toPrimitive](){…} })`
  reaches the poisoned `toString` — the literal is a closed struct — cluster H.
- `p8` strict `sym.a = 0` does not throw — cluster B-d.
- `p9` `Number.prototype.toPrecision.call(1, fn)` throws the glue refusal
  (`Number.prototype.toPrecision is not yet implemented`) — cluster J.
- `p10` the `nativeErrors.js` harness shape compiled through `compile(src,
  {target:"standalone"})` — its real import list is Step E-0's before-state
  (recorded in `builtins-probes-run1.txt`).

## Out of scope (owned elsewhere) — `.tmp/es2015/builtins-cl-X*.txt` (64)

| Rows | Owner | Why |
|---|---|---|
| `Date/subclassing.js`, `Error/prototype/stack/getter-foreign-new-target.js`, `bind/instance-construct-newtarget-boundtarget{,-bound}.js`, `bind/get-fn-realm{,-recursive}.js` (6) + `bind/instance-construct-newtarget-self-{new,reflect}.js` (2) — `X1-3371-newtarget` (8) | #3371 (reopened 2026-09-01, blocked on #2046) | the 6 are #3371's exact rows 14/15/30–33 (`call-namespace-static.ts:1620-1627` refusal); the 2 `self-*` rows need the same bound-carrier NewTarget forwarding (§10.4.1.2 step 5, `construct-bound.ts` + `new-target.ts`'s class-id global, which has no arm for a plain-function target) — hand them to #3371's bound-carrier slice, do not build a parallel mechanism |
| `String/prototype/{match,search,split,replace}/cstm-*.js`, `invoke-builtin-{match,search}*.js`, `split/this-value-tostring-error.js`, `split/limit-touint32-error.js` — `X2-5198-string-protocol` (15) | #5198 Slice D (in-progress; PR #5296 merged Slice A on 2026-08-30) | #5198's plan explicitly claims "String symbol-protocol dispatch (15 rows)" — `GetMethod(searchValue, @@match/…)` before the native RegExp fallback; these are exactly those 15 (the `Unsupported dynamic regular expression pattern` / #1474 `replace` refusal signatures). Nothing in this issue's list needs only the protocol dispatch without also being on that list |
| every row whose source calls `$262.createRealm()` — `X3-4274-realm` (39) | #4274 (true realms, ready) / #4634 | `tests/test262-runner.ts:2323 createRealm` returns a global with NO builtins (`realm.global.Symbol` is `undefined`), so `other.Function`, `other.TypeError`, `OSymbol.iterator` … all deref undefined (`Cannot access property on null or undefined at 3xx:44`). No compiler change can pass them; do not edit the runner here |
| `Function/internals/Construct/derived-return-val.js` — `X4-5139-class` (1) | #5139 (class wave) | derived-ctor return TypeError vs ReferenceError |
| `Function/internals/Construct/base-ctor-revoked-proxy.js` — `X5-5140-proxy-revocable` (1) | #5140 (proxy wave) | needs `Proxy.revocable` + [[Construct]] through a revoked proxy |

Also not touched here by rule: `Reflect.set` receiver (#2046), generator
carriers (#680/#2864). No row in the 150 belongs to those.

## Cluster table (HEAD-verified, 150 rows incl. X)

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---|---|---|---|
| G | JSON: Proxy values/replacers refused or mis-serialised; `ToString(text)`; symbol values | 13 | `src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall` JSON arm: the static `isArrayLike` gate (`:2585-2596`) refuses every array-TYPED value that is not a literal (a `new Proxy([], h)` is typed `never[]` → "#1599 not yet supported" CE); the replacer gate (`:2641-2646`) admits only callable / array-LITERAL replacers (Proxy or `{}` → CE); `JSON.parse()` with 0 args misses the `arguments.length >= 1` gate at `:2536` → generic `__get_builtin` CE, and a non-string static arg (`null`, `false`, `1`) hits the refusal at `:2790`; `json-codec-native.ts::emitJsonStringifyValue` (`:137`) has NO `$Proxy` arm (the internalize walk got one in #3176, `:3410-3630`) so `stringify(proxyOfObject)` prints `"null"` and a revoked proxy does not throw; `calls.ts:1900 tryEmitJsonStringifyPrimitive` has no ESSymbolLike arm (`stringify(sym)` → `"null"`); the internalize proxy arm tests the target once, not through a proxy-of-proxy (`revived-proxy.js`) | `JSON/stringify/value-array-proxy.js`, `replacer-array-abrupt.js`, `replacer-wrong-type.js`, `value-object-proxy.js`, `value-symbol.js`, `parse/text-non-string-primitive.js`, `parse/revived-proxy.js` |
| H | An object literal with a `[Symbol.toPrimitive]` computed key compiles to a CLOSED struct the runtime ToPrimitive walker never probes; a symbol-keyed WRITE onto such a struct is dropped | 11 | `src/codegen/literals.ts:1496 _hasRuntimeComputedKey` deliberately `continue`s over well-known-symbol keys, so `objectLiteralForcesHostPath` (`:1690`) keeps the literal on the closed-struct path with an `@@3` FIELD; the #5102 probe in `object-runtime.ts::ensureObjectRuntime` looks up `__box_symbol(3)` on `$Object`s only. The host (open-`$Object`) path already handles METHOD-form well-known keys (`:1220-1256`, `__box_symbol` + `__extern_set`) but the PropertyAssignment branch SKIPS computed keys (`:550-552`). `obj[Symbol.toPrimitive] = fn` on a closed-struct literal is silently dropped (#5156 "new finding 2"; `isNaN/isFinite/toprimitive-valid-result.js`, `Date/toJSON/to-primitive-symbol.js`) | `String/prototype/indexOf/searchstring-tostring-toprimitive.js` (5 indexOf rows), `annexB/built-ins/escape/to-primitive-observe.js` (4 escape/unescape rows), `isNaN/toprimitive-valid-result.js` |
| A1 | The `Symbol` namespace object is not reified: no own well-known-symbol / `for` / `keyFor` / `length` / `name` / `prototype` props, not a global own property | 10 | `src/codegen/builtin-static-gopd.ts:359` returns `false` for `builtinName === "Symbol"` (explicit exclusion: "OPEN own-property universe"); `builtin-ctor-own-props.ts::pushBuiltinCtorOwnPropSeed` (`:178`, seeds `length`/`name`/`prototype` on the #3006 `__builtin_ctor_<Name>` `$Object` carrier — `emitBuiltinConstructorIdentity`, `builtin-static-globals.ts:172`, whose name set includes `"Symbol"` at `:101`) has no Symbol row, so the dynamic `hasOwnProperty(Symbol, 'iterator')` propertyHelper makes answers false (`… should be an own property`). `Symbol/constructor.js` additionally needs `Object.getPrototypeOf(sym)` (B) and the glue `constructor` seed to be that carrier; `species/builtin-getter-name.js` needs the runtime gOPD over `Array`/`Map`/`Promise`/`RegExp` carriers with a DYNAMIC `Symbol.species` key (only the syntactic `gOPD(Array, Symbol.species)` form is synthesised, `builtin-static-gopd.ts:418-460`) | `Symbol/iterator/prop-desc.js`, `Symbol/symbol.js`, `Symbol/species/basic.js`, `Symbol/constructor.js`, `Symbol/species/builtin-getter-name.js` |
| A2 | `Symbol(desc)` / `Symbol.for(key)` description ToString order + abrupt; `Symbol.keyFor(non-symbol)`; `sym()` / `new sym()` | 4 | `literals.ts:2610 compileSymbolCall` coerces the description with a STRING-typed `coerceType` (no OrdinaryToPrimitive: `toString` returning `{}` must fall through to `valueOf` — `desc-to-string.js`); `call-namespace-static.ts:465-500` `Symbol.for` coerces the key to `ref $AnyString` then `ref.as_non_null` — a user `toString` that throws leaves a null and the harness's `Test262Error` closure derefs it (`for/to-string-err.js`, `RuntimeError: dereferencing a null pointer in __closure_66`); `:521-531` `Symbol.keyFor` coerces the arg to i32 with no §20.4.2.6 step-1 Type check (`keyFor/arg-non-symbol.js`); a call on a symbol-typed callee is not rejected (`not-callable.js`) | `Symbol/desc-to-string.js`, `Symbol/for/to-string-err.js`, `Symbol/keyFor/arg-non-symbol.js`, `Symbol/not-callable.js` |
| B1 | Symbol.prototype / symbol-wrapper semantics: gPO(symbol), `@@toStringTag`, reflective `toString` / `@@toPrimitive` bodies, auto-boxing writes, wrapper OrdinaryToPrimitive | 10 | `object-get-prototype-of.ts:281-284 tryCompileEs5GetPrototypeOfValue` has boolean/string/number arms via `ctx.oracle.staticJsTypeOf` but no `"symbol"` arm (→ `null`, then `Object.prototype.toString` refusal in `intrinsic.js`); runtime twin `object-runtime-prototype.ts::buildObjectPrototypeHelpers` (`__getPrototypeOf`, `:346`) has no `$Symbol`-carrier / wrapper arm. `array-object-proto.ts:2458 ensureSymbolNativeProtoGlue` calls `makeGlue(ctx, brand, "Symbol", SYMBOL_PROTO_METHODS)` WITHOUT the `symbolTag` argument (WeakMap passes `"WeakMap"`) so `Symbol.prototype[Symbol.toStringTag]` is undefined; the `makeGlue.emitMemberBody` ladder (`:2160-2200`) has no `Symbol`/`toString` or `Symbol`/`@@3` arm (only #4776's `valueOf`), so the reflective call answers a null externref (p1); `property-access-dispatch.ts:3650` handles only `description` on ESSymbolLike receivers — `Symbol.toPrimitive[Symbol.toPrimitive]` derefs null; symbol-receiver WRITES (`sym.a = 0`, `sym.toString = 0`) reach the generic member-set path and are silently accepted (strict must TypeError, sloppy no-op) | `Symbol/prototype/intrinsic.js`, `Symbol/prototype/Symbol.toStringTag.js`, `Symbol/prototype/toString/toString.js`, `Symbol/auto-boxing-strict.js`, `Symbol/prototype/Symbol.toPrimitive/this-val-symbol.js`, `…/removed-symbol-wrapper-ordinary-toprimitive.js` |
| B2 | `class X extends RegExp {}; X[Symbol.species] === X` | 1 | the inherited `@@species` accessor is answered for gOPD on the ctor (`builtin-static-gopd.ts:418-460`) but an element READ `X[Symbol.species]` on a user class extending a species owner (`SPECIES_OWNER_CTORS`) has no arm → undefined | `Symbol/species/subclassing.js` |
| C | `"" + new Proxy(fn, {})` stringifies to `undefined`; `Function.prototype.toString.call(nonCallableProxy)` does not throw; `isConstructor(Function.prototype.toString)` | 8 | the callable arms of the ToString cascade (`callable-any-to-string.ts:87 fillCallableAnyToStringArm` / `:205 fillCallableExternToStringArm`, `coercion-engine.ts installCompiledClosureToStringArm`) test closure structs only — a `$Proxy` carrier falls to the helper's object arms; `typeof-natives-finalize.ts:120-131` shows `__typeof_function` DOES answer the proxy's callable bit (field 5), so only the ToString arms lack the arm. `function-proto-to-string.ts:60 emitFunctionProtoToStringBody` guards with `__typeof_function` — correct — but the `.call(...)` transfer onto that glue closure never reaches it (cluster M); `not-a-constructor.js` also needs `new Function.prototype.toString()` → TypeError (native glue closures must not be admitted by `fillReflectIsConstructor`'s `constructibleClosureTypeIdxs` and the dynamic-`new` chain must throw, `new-super.ts:3880-3890`) | `Function/prototype/toString/proxy-function-expression.js`, `proxy-class.js`, `proxy-bound-function.js`, `proxy-non-callable-throws.js`, `not-a-constructor.js` |
| D | No own `Error.prototype.stack` accessor: `gOPD(Error.prototype,'stack')` is undefined, every row derefs `.get`/`.set` | 7 | `array-object-proto.ts:333 ERROR_PROTO_METHODS = ["toString"]`; `makeGlue` marks members `"method"`/`"getter"` only — the seeder (`native-proto.ts:622-680`) defines a getter with a NULL setter (`ref.null.extern` + `PROTO_ACCESSOR_DEFINE_FLAGS`, `__defineProperty_accessor(obj,key,get,set,f64 flags)`), so there is no accessor-PAIR kind at all; `builtin-static-gopd.ts` proto-gOPD synthesis has no `stack` arm | `Error/prototype/stack/getter-not-a-constructor.js`, `setter-receiver-is-proxy.js`, `setter-proxy-trap-rejects.js`, `setter-proxy-wrapping-prototype.js`, `getter-subclass.js` |
| E | `new nativeErrors[i]('my-message')` (a reified Error-family ctor CARRIER as callee) constructs an instance with no `message`; the same harness (`nativeErrors.js`) statically references `new/call SuppressedError(...)` and `AggregateError(...)`, which lower to `env::__new_SuppressedError` / `__new_AggregateError` host imports | 1 (+ prerequisite for D's `getter-subclass.js`) | dynamic `new` on a brand-marked `$Object` ctor carrier (#4120 `OBJ_FLAG_CONSTRUCTOR`, `builtin-callable-brand.ts:140-180` reads `$Object` field 4) reaches `native-construct.ts::fillNativeConstructDrivers` (`:248+`), whose only carrier-specific arm is `$Proxy` (`__proxy_construct_dispatch`); the carrier is then treated as an ordinary function → `__object_create(Get(callee,"prototype"))` and NO Error-family body runs, so `message` is never installed. Static `new TypeError(m)` is native (`new-builtin-globals.ts:1013-1024` → `registry/error-types.ts:158 emitWasiErrorConstructor` → in-module `__new_<Name>` building a `$Error_struct`); `new SuppressedError(...)` (`new-builtin-globals.ts:1169-1200`) and the call form (`calls.ts:7874-7897`) have no `noJsHost` arm and `ensureLateImport` the host ctor — `p10` measured `["function:env::__new_SuppressedError"]` on HEAD (AggregateError does not leak) | `NativeErrors/message_property_native_error.js` |
| F | Function reflective metadata: `Function.prototype.name` data prop, `@@hasInstance` descriptor (`w:false,c:false`, name `"[Symbol.hasInstance]"`), `isConstructor(Function)`; plus the 33 s compile of `name.js` | 4 | `makeGlue` (`array-object-proto.ts:2090-2115`) seeds `dataProps` for the Error family only, and `dataProps` carries string values with the METHOD flags (`PROTO_METHOD_DEFINE_FLAGS = 0xbd`, writable) — `Function.prototype.name` must be `""` with `writable:false`; `FUNCTION_PROTO_HAS_INSTANCE_MEMBER = "@@hasInstance"` (`function-proto-has-instance.ts:23`) is a NAMED sentinel, so `seededNativeProtoSymbolMembersByBrand` (`native-proto.ts:497`, `Number.isInteger(id)` filter) drops it → `hasOwnProperty(Function.prototype, Symbol.hasInstance)` is false and `nativeProtoMemberDisplayName` (`:800`) cannot name it `[Symbol.hasInstance]`; `fillReflectIsConstructor` (`reflect-construct-native.ts:214-270`) admits closures, TA ctors, proxies and brand-marked ctor carriers — `Function` as a value is not routed through `emitBuiltinConstructorIdentity` at the isConstructor probe (HEAD: `isConstructor(Function)` false) | `Function/prototype/name.js` (timeout), `Function/prototype/Symbol.hasInstance/prop-desc.js`, `…/name.js`, `Function/is-a-constructor.js` |
| M | `Function.prototype.call` / `apply` / `bind` as reflective VALUES are refusal bodies; OrdinaryHasInstance does not use the proxy/accessor-aware reads | 3 | `makeGlue.emitMemberBody` (`array-object-proto.ts:2160-2200`): `Function` brand answers only `toString` and `@@hasInstance`, everything else → `emitProtoMemberBodyRefusal` (`native-proto.ts:956` message "`Function.prototype.call is not yet implemented`", p2). `function-proto-has-instance.ts:49 emitFunctionProtoHasInstanceBody` → `native-dynamic-instanceof.ts:249 ensureNativeDynamicInstanceOf`: its chain walk reads `$Object` field 4 / `$NativeProto` brand directly (`:455`, `:651`) instead of the proxy-aware `__getPrototypeOf`, and `Get(C,"prototype")` (`:322-363`, `__extern_get`) does not propagate a throwing accessor for a closure receiver | `Function/prototype/Symbol.hasInstance/this-val-not-callable.js`, `value-get-prototype-of-err.js`, `this-val-poisoned-prototype.js` |
| I | String residue from #5152: `String.raw` accessor snapshot (3), reflective `substr` (1), real NFC/NFD/NFKC/NFKD (3) | 7 | `call-builtin-static.ts:805-825` routes the template through `materializeStructAsDynamicObject` (a value SNAPSHOT — accessors installed by `Object.defineProperty`/getter literals on `raw` are lost; `string-raw.ts` header shows the helper itself is accessor-aware via `__extern_get`); `emitStringProtoMemberBody` (`array-object-proto.ts:1005-1060`) has `substring`/`slice` arms (`string-proto-substring.ts`) but no `substr` → refusal TypeError instead of the receiver's throwing `toString`; `string-ops.ts:3630-3700` normalize arm validates the form but the transform is the identity ("wave 2 of #5152") | `String/raw/template-length-throws.js`, `String/raw/nextkey-is-symbol-throws.js`, `annexB/built-ins/String/prototype/substr/this-to-str-err.js`, `String/prototype/normalize/return-normalized-string.js` |
| J | Reflective `Number.prototype.toPrecision` and `Date.prototype.toJSON` are refusals | 3 | `makeGlue` ladder: `Number` answers only `valueOf` (`emitBoxedProtoValueOfBody`), so `toPrecision.call(1, fn)` throws the refusal TypeError before ToNumber→NaN→RangeError (the DIRECT-call arm `call-receiver-method.ts:2833-2900` does it right via `number_toPrecision(f64,f64)`, `number-format-native.ts:896`); `expressions/builtins.ts:1698 emitDateProtoMemberBody` answers getters only (`DIRECT_TS_GETTERS`/`CIVIL_GETTERS`), `toJSON` → null → refusal (`Date.prototype.toJSON is not yet implemented`), the direct-call `toJSON` lowering lives at `:2731-2830` | `Number/prototype/toPrecision/precision-cannot-be-coerced-to-a-number-in-range.js`, `Date/prototype/toJSON/to-object.js`, `…/to-primitive-symbol.js` |
| L | `new Error(msg).hasOwnProperty("message")` is false | 1 | error instances are `$Error_struct`s whose `message` is a struct FIELD, not a `$props` entry (`error-props.ts` header); `Object.prototype.hasOwnProperty` has no `$Error_struct` arm for the intrinsic `message` field — `carrier-bag-hasown.ts` records why `__hasOwnProperty` must not be widened generally (#4017's 684-pass blast radius), so the arm must be narrow | `Error/message_property.js` |
| K | `%AsyncFunction%` intrinsic (`(async function(){}).constructor`) | 2 | `.constructor` on an async closure value is undefined; no `%AsyncFunction%` ctor carrier, no `%AsyncFunction.prototype%` glue with `@@toStringTag "AsyncFunction"`; `isConstructor(AsyncFunction)` false | `AsyncFunction/is-a-constructor.js`, `AsyncFunction/AsyncFunctionPrototype-to-string.js` |
| X | out of scope (table above) | 64 | | |

## Implementation Plan

Ordered by yield and dependency; each step independently shippable. After each
step re-run its list(s) with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/builtins-cl-<X>.txt --standalone`
and the controls list. Type queries go through `ctx.oracle` (oracle-ratchet
gate; `staticJsTypeOf`, `declaredNameOf`, `variableInitializerOf`,
`signatureOf` already exist); every instruction template minted FRESH per arm
(#2169b/#1058 — a shared `Instr[]` aliased into two branches is remapped twice
and the stack-balance repair fails the whole compile); reserve-then-fill
funcIdx discipline (#1719/#2043) for anything filled at finalize; `ensureLateImport`
+ `flushLateImportShifts` before baking any funcIdx into `fctx.body`.

### Step G — JSON residue (13) — `builtins-cl-G-json.txt`

All in `src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall`
(JSON arm, `:2472-2830`) and `src/codegen/json-codec-native.ts`.

**G-1 `JSON.parse` ToString(text) (1: `parse/text-non-string-primitive.js`).**
The `(method === "stringify" || method === "parse") && expr.arguments.length >= 1`
gate (`:2536`) drops `JSON.parse()` to the generic `__get_builtin` CE; the
`isStringOrAny` check (`:2717-2722`) sends a `null`/`boolean`/`number`-typed
arg to the refusal (`:2790`). Under `useNativeJsonProvider`: (a) 0 args → push
the `"undefined"` string constant (`stringConstantExternrefInstrs`) and call
`__json_parse_text` (its SyntaxError on `undefined` text is the expected
throw — verify it is a catchable `SyntaxError` instance, not a trap); (b) a
non-string static arg → `emitArgAsNativeString` (`string-ops.ts:463`, the
§7.1.17 ToString with the Symbol TypeError) → `extern.convert_any` → the same
call. Keep the string/any route byte-identical.

**G-2 stringify: admit Proxy / dynamic array-typed values (5:
`value-array-proxy.js`, `value-array-proxy-revoked.js`, `value-array-abrupt.js`,
`value-object-proxy.js`, `value-object-proxy-revoked.js`).** The `isArrayLike`
refusal (`:2585-2596`) exists because a CLOSED typed vec (`number[]`) is not a
`$ObjVec`. Narrow it: a value whose expression (after `unwrapReflectConstructExpr`)
is `new Proxy(...)`, or an identifier whose `ctx.oracle.variableInitializerOf`
is `new Proxy(...)` (the pattern `object-get-prototype-of.ts:296-300` uses),
skips the array-typed refusal and goes to `emitJsonCodecValueAsAnyref` (`:296`).
Then add a `$Proxy` arm to the stringify walker (`emitJsonStringifyValue`,
`:137+`; the value-classification switch that already has `$Object`/`$ObjVec`/
boxed-primitive arms): copy the internalize walk's `proxyObjectArm` /
`proxyArrayArm` shape (`:3462-3630`: `L_PROXY_TARGET` read, IsArray through
the target's `$ObjVec`/`$__vec_base` test, `ownKeys` snapshot via the Proxy
front guards, per-key `__extern_get` so `get` traps run and abrupt completions
propagate) for SerializeJSONObject/Array; a revoked proxy (`[[ProxyHandler]]`
null — the same guard the internalize arm uses) → TypeError. `value-array-abrupt.js`
needs the `length` Get to go through the trap (the arm's `ToLength(Get(proxy,"length"))`
line at `:3546` is the template). IsArray must loop through proxy-of-proxy
targets (also fixes **G-5**).

**G-3 replacer classification at runtime (5: `replacer-array-abrupt.js`,
`replacer-array-proxy.js`, `replacer-array-proxy-revoked.js`,
`replacer-array-wrong-type.js`, `replacer-wrong-type.js`).** Replace the
`replacerCallable || isArrayLiteral` gate (`:2641-2646`) with: array LITERAL →
today's `emitJsonReplacerAllowList` fast path (unchanged); anything else
non-nullish → compile to externref and pass it as the `replacer` operand of
`__json_stringify_root_replacer(v, gap, replacer, allowList)`
(`json-codec-native.ts:1179-1200`); inside that root add a classifier
prologue: `__typeof_function(replacer)` → function replacer (existing path);
else IsArray (incl. through `$Proxy` targets — the same test as G-2) → build
the allowList at runtime per §25.5.2 step 4.b: `LengthOfArrayLike` via
`__extern_length` (a throwing `length` getter propagates —
`replacer-array-abrupt.js`), then for each `k` `Get(replacer, k)` through the
Proxy front guard; keep String/Number primitives and String/Number WRAPPER
objects (`WRAPPER_PRIMITIVE_KEY` slot, `object-runtime.ts`) as `ToString`,
skip everything else (`replacer-array-wrong-type.js`); else (a plain object,
`new String('str')`, `new Number(6.1)`) → ignore the replacer entirely
(`replacer-wrong-type.js`). Revoked proxy → TypeError.

**G-4 symbol values (1: `value-symbol.js`).** `calls.ts:1900
tryEmitJsonStringifyPrimitive`: add `ts.TypeFlags.ESSymbolLike` → `emitUndefined`
(`JSON.stringify(sym) === undefined`). In the codec's array/object element
serialisation the "value serialises to undefined" channel (the comment at
`json-codec-native.ts:36`/`:132`/`:1103` already names symbols) must recognise
the `$Symbol` carrier (`ctx.symbolTypeIdx`, `ensureSymbolCarrier`) → `null`
inside arrays, skipped as a property; symbol-KEYED entries are skipped by the
key walk (verify with the `obj[sym] = 1` assertion).

**G-5 `parse/revived-proxy.js` (1).** In the internalize proxy arm
(`:3410-3630`) unwrap `[[ProxyTarget]]` in a loop before the `$ObjVec` test so
a proxy whose target is itself a proxy of an array is classified as an array
(§7.2.2 IsArray step 3 recursion); the `visitedOther` assertion is the
object-vs-array walk choice.

Edge cases: keep `tryEmitJsonStringifyStatic`'s literal fold untouched; the
`gap` handling is orthogonal (all 13 rows use compact output); never route a
closed typed vec to the codec (G-2 is expression-shape-narrow on purpose).

### Step H — `[Symbol.toPrimitive]` object literals take the open-object path; symbol-keyed writes onto closed literals (11) — `builtins-cl-H-closed-literal-toprimitive.txt`

**H-1.** In `src/codegen/literals.ts::objectLiteralForcesHostPath` (`:1690`)
add one disjunct: the literal has a computed key that resolves to well-known
symbol id **3** (`Symbol.toPrimitive`, `getWellKnownSymbolId`) — property OR
method form. Do NOT widen to every well-known symbol: `_hasRuntimeComputedKey`
(`:1496`) keeps `[Symbol.iterator]()` literals closed on purpose and the
iterator OBJ arm reads that `@@1` field; `toPrimitive` is the one id whose
only consumer is the runtime `__to_primitive` probe (`object-runtime.ts`,
#5102, keyed `__box_symbol(3)`). Then make the host-path builder handle the
PropertyAssignment spelling: `compileObjectLiteralAsExternref` (`:473`)'s data
branch (`:550-552`) skips computed keys — add the `wellKnownSymId` branch the
METHOD branch already has (`:1220-1256`: `__box_symbol(id)` key +
`__extern_set`; `emitObjectLiteralMethodFn` for methods, the ordinary
`compileExpression(initializer, externref)` for a `function () {}` value).
`#4616`'s lockstep rule applies: the variable-declaration LOCAL TYPING
(`statements/variables.ts`) must make the identical decision — it consults
`objectLiteralForcesHostPath`, so extending that predicate is the single
edit; grep its other callers and confirm none pre-filters computed keys.

**H-2 symbol-keyed WRITE onto a closed literal (`isNaN/isFinite/toprimitive-valid-result.js`,
`Date/toJSON/to-primitive-symbol.js`).** Pre-scan pattern
(`native-ordinary-instanceof.ts:156 moduleInstallsCallableHasInstance` is the
template): if the module contains `<ident>[Symbol.toPrimitive] = …` where
`<ident>` is a `var`/`let`/`const` whose initializer is an object literal,
that literal also forces the host path (so the later `__extern_set` with a
`__box_symbol(3)` key lands in the open `$Object`). Verify with `p7` (third
assertion). Alternative if the pre-scan is refused by the reviewer: make the
symbol-keyed element-assignment path on a struct receiver migrate the struct
to its `$Object` twin (the #3468 closure-bag pattern) — costlier; prefer the
pre-scan.

Edge cases: `escape(obj)` / `unescape(obj)` (`annexb-escape-call.ts:41-90`)
coerce through `deps.toString` = the runtime ToString walker → after H-1 the
`@@toPrimitive` method is found; `to-primitive-err.js` expects a TypeError
when `@@toPrimitive` returns an object — the #5102 probe already throws for a
non-primitive result (verify, `indexOf/position-tointeger-errors.js` covers
the Symbol-result TypeError). `indexOf/searchstring-tostring-wrapped-values.js`
also asserts `Object("foo")` unboxing — passes once the literal reaches the
walker (measured in #5152 D: the walker handles wrappers). Controls:
`.tmp/es2015/builtins-controls.txt` rows `isNaN/toprimitive-get-abrupt.js`,
`indexOf/position-tointeger-wrapped-values.js` (the non-literal spellings).

### Step A — reify the `Symbol` namespace (A1 10 + A2 4) — `builtins-cl-A1-symbol-namespace.txt`, `builtins-cl-A2-symbol-arg-coercion.txt`

**A-1 own-property seed.** `src/codegen/builtin-ctor-own-props.ts::pushBuiltinCtorOwnPropSeed`
(`:178`; called from `emitBuiltinConstructorIdentity`,
`builtin-static-globals.ts:219`/`:543`) — add a `Symbol` table seeded onto the
`__builtin_ctor_Symbol` `$Object` carrier: the 12 well-known symbols as DATA
props `{writable:false, enumerable:false, configurable:false}` whose value is
`__box_symbol(<id>)` (ids from `builtin-value-read.ts:160-175`; the carrier
value must be `===` to what `Symbol.iterator` reads — the static read yields
an i32 id (`:411`) that boxes to the interned `$Symbol` carrier, so identity
holds); `for`/`keyFor` as builtin-fn singletons over `__symbol_for_native` /
`__symbol_keyfor_native` (`symbol-native.ts:546 ensureSymbolRegistry`) wrapped
in the lifted-closure ABI (`ensureStandaloneBuiltinStaticMethodClosure`,
`builtin-value-read.ts`, the `Math.*`/`Reflect.*` pattern) with `length` 1,
names `"for"`/`"keyFor"`; `length` 0 / `name` `"Symbol"` (the module's
existing §17 rows); `prototype` = the Symbol glue singleton
(`emitLazyNativeProtoGet(ctx, fctx, ensureSymbolNativeProtoGlue(ctx))`),
`{w:false, e:false, c:false}`.

**A-2 static gOPD.** `builtin-static-gopd.ts::tryEmitStandaloneBuiltinStaticGopd`:
delete `"Symbol"` from the `:359` exclusion and add a Symbol arm answering the
same table statically (the `MATH_CONSTANT_VALUES`/`NUMBER_CONSTANT_VALUES`
shape at `:328` for the data rows; the species singleton shape at `:418-460`
for the function rows). `verifyProperty` also WRITES (`Symbol.iterator = x`
must not stick — non-writable) and DELETES (must fail — non-configurable):
both are answered by the `$Object` runtime once the carrier holds the
attributes (the module header's probe evidence), provided the static member
READ `Symbol.iterator` is not folded when the module also WRITES it — keep the
fold (it is spec-correct: the write never sticks).

**A-3 `Symbol/symbol.js`** (`verifyProperty(this, "Symbol", …)` — GLOBAL own
property): the realm-global object descriptor path (`tryEmitRealmGlobalMember…`,
`calls.ts` #4491/#4500) must list `Symbol` among the global's own DATA props
`{w:true, e:false, c:true}` with the carrier as value — mirror whatever answers
`verifyProperty(this, "Array", …)` on HEAD (check `runtime-eval-intrinsic-own-props.ts`
/ `standalone-global-functions.ts:49-60` for the global-own-prop table).

**A-4 `Symbol/constructor.js`.** Needs B-a (gPO(symbol)) and the glue's
`constructor` seed (`native-proto.ts:618 pushCompanionConstructorSeed`) to
resolve to the SAME `__builtin_ctor_Symbol` carrier — it already uses
`emitBuiltinConstructorIdentity` for other brands; confirm Symbol is not
excluded there.

**A-5 `species/builtin-getter-name.js`.** Runtime gOPD over `Array`/`Map`/
`Promise`/`RegExp` ctor carriers with a dynamic `Symbol.species` key: seed the
`@@species` ACCESSOR entry (`__defineProperty_accessor`, getter =
`ensureStandaloneSpeciesGetterClosure` singleton, `builtin-fn-meta.ts:410`,
already named `"get [Symbol.species]"` via `nativeClosureMeta`) into
`pushBuiltinCtorOwnPropSeed` for `SPECIES_OWNER_CTORS`; the dynamic
`__getOwnPropertyDescriptor` then answers it like any accessor entry.

**A-6 arg coercion (A2).**
- `literals.ts:2610 compileSymbolCall` (standalone branch `:2660-2700`):
  replace the STRING-typed `coerceType` of the description with the runtime
  ToString walker (`emitArgAsNativeString`, `string-ops.ts:463`) so
  OrdinaryToPrimitive runs `toString` THEN `valueOf` when `toString` returns
  an object (`desc-to-string.js` counts `'toStringvalueOf'`), and a Symbol
  description still throws (#3481 arm kept).
- `call-namespace-static.ts:465-500` `Symbol.for`: same walker before
  `ref.as_non_null`; an abrupt `toString` must propagate as the user's
  exception (today the null is derefed later — `for/to-string-err.js`).
- `:521-531` `Symbol.keyFor`: when `ctx.oracle.staticJsTypeOf(arg) !== "symbol"`
  emit a runtime `ref.test ctx.symbolTypeIdx` on the externref arg (box the
  static i32 case as today) and `buildThrowJsErrorInstrs(TypeError)` otherwise
  (`keyFor/arg-non-symbol.js` covers null/undefined/string/number/boolean/object).
- `not-callable.js`: a call whose callee is `symbol`-typed (`staticJsTypeOf`)
  or a `$Symbol` carrier at runtime → TypeError "is not a function" — the
  static case in `calls.ts::compileCallExpression`'s callee classification
  (before the `__apply_closure` arm at `:8100`), the dynamic case in
  `__apply_closure`'s front guard (`object-runtime.ts:7378 fillApplyClosure`);
  `new sym()` → the `new-super.ts:3880-3890` TypeError arm already covers a
  non-constructible runtime value (verify).

### Step B — Symbol.prototype / wrapper semantics (B1 10 + B2 1) — `builtins-cl-B1-symbol-prototype-wrapper.txt`, `builtins-cl-B2-species-subclass.txt`

**B-a gPO(symbol).** `object-get-prototype-of.ts::tryCompileEs5GetPrototypeOfValue`
(`:281-284`): add `if (staticType === "symbol") return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Symbol")`
(`emitEs5IntrinsicPrototype`, `:140`, resolves through
`tryEnsureNativeProtoBrand` — confirm "Symbol" is accepted; it is a registered
brand via `ensureSymbolNativeProtoGlue`). Runtime twin in
`object-runtime-prototype.ts::buildObjectPrototypeHelpers` (`__getPrototypeOf`,
`:346`): `ref.test ctx.symbolTypeIdx` → the Symbol glue singleton; a `$Object`
whose `WRAPPER_PRIMITIVE_KEY` internal slot holds a `$Symbol` → same (the
`symbol-proto-valueof.ts` header describes that slot).

**B-b `@@toStringTag`.** `array-object-proto.ts:2458`: `makeGlue(ctx, brand, "Symbol", SYMBOL_PROTO_METHODS, "Symbol")`
— the tag seeder (`native-proto.ts:704-718`, `PROTO_SYMBOL_TAG_DEFINE_FLAGS`
= `{w:false,e:false,c:true}`) and `seededNativeProtoSymbolTagsByBrand` do the
rest (`Symbol.prototype.Symbol.toStringTag.js` verifies exactly those bits).

**B-c reflective bodies.** New `src/codegen/symbol-proto-tostring.ts` next to
`symbol-proto-valueof.ts` (#4776): `emitSymbolProtoToStringBody` =
thisSymbolValue prologue (copy `emitSymbolProtoValueOfBody`'s carrier/wrapper
arms + TypeError) → read the `$Symbol` id field → `emitSymbolToString`
(`symbol-native.ts:990`, SymbolDescriptiveString) → externref. Same module:
`emitSymbolProtoToPrimitiveBody` for member `@@3` (thisSymbolValue → return
the carrier; hint argument ignored). Wire both into `makeGlue.emitMemberBody`
(`array-object-proto.ts:2160-2200`) as `name === "Symbol" && member === "toString"` /
`member === "@@3"` arms BEFORE the wrapper-brand arms (`isWrapperBrandName`
does not include Symbol, so the ladder currently falls to the refusal; p1 shows
the `.call` transfer then yields a null — see M-1 for why the refusal did not
even surface).

**B-d symbol receivers.** `property-access-dispatch.ts:3650`: generalise the
ESSymbolLike-receiver arm from `description` only to any member: box the i32
id to the `$Symbol` carrier (`__box_symbol`) and read through the Symbol glue
(`emitLazyNativeProtoGet` + `__extern_get`), so `Symbol.toPrimitive[Symbol.toPrimitive]`
resolves the `@@3` closure and `sym.toString` the `toString` closure. WRITES:
in `expressions/assignment.ts` (the property-assignment entry that picks
`__extern_set_strict` vs `__extern_set` from `isStrictContext`, cited in
`object-runtime-strict-set.ts`'s header) add a receiver check
`ctx.oracle.staticJsTypeOf(target.expression) === "symbol"`: strict → evaluate
RHS, `buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot create property on symbol")`;
sloppy → evaluate RHS, drop, result = RHS (`auto-boxing-non-strict.js` then
reads `sym.a` → undefined through B-d's read arm). Element-access spellings
(`sym['a'+'b']`, `sym[62]`) go through the same entry — verify all three
`auto-boxing-strict.js` shapes.

**B-e wrapper OrdinaryToPrimitive (2, attempt LAST: `removed-…`/`redefined-symbol-wrapper-ordinary-toprimitive.js`).**
Needs (i) `delete Symbol.prototype[Symbol.toPrimitive]` and `Object.defineProperty(Symbol.prototype, Symbol.toPrimitive, …)`
to mutate the companion entry (`@@3` is seeded with `PROTO_SYMBOL_TAG_DEFINE_FLAGS`,
configurable — `redefined-…` currently fails with "Cannot assign to read only
property of a non-configurable property", so the define/delete path is
reading a different, non-configurable answer: chase the `symbol-keyed` own-prop
ladder in `native-proto-own-props.ts`), and (ii) `Object(sym) == 123` to run
`__to_primitive` on the WRAPPER through `Symbol.prototype`'s live `@@3` /
`valueOf` accessor entries rather than the static carrier fast path. Report
unflipped rows with their residual error in the PR body.

**B2 `species/subclassing.js`.** Element read `X[Symbol.species]` where `X` is
a class whose heritage chain reaches a `SPECIES_OWNER_CTORS` builtin: in
`property-access-dispatch.ts`'s well-known-symbol element-read arm return the
receiver (the inherited getter returns `this`); 1 row, do after B-a..d.

### Step C — Proxy in the callable ToString cascade; non-constructible native closures (8) — `builtins-cl-C-proxy-tostring.txt`

**C-1.** `callable-any-to-string.ts::fillCallableExternToStringArm` (`:205`,
the externref-side arm prepended to `__extern_toString`) and its any-side
twin (`:87`): add a `$Proxy` arm — `ref.test proxyTypeIdx` (`ctx.objectRuntimeTypes.proxyTypeIdx`)
→ read the callable bit (field 5, the exact read `typeof-natives-finalize.ts:120-131`
does) → callable → `NATIVE_FUNCTION_SOURCE` (`callable-to-string.ts`, the
#4492 constant); not callable → fall through to the object arms
(`[object Object]`). Covers the 6 `proxy-*.js` rows (`assertNativeFunction`
uses `"" + fn`, `nativeFunctionMatcher.js:213`).

**C-2 `proxy-non-callable-throws.js`.** `p6` shows the `.call` transfer DOES
reach a body for a callable proxy (a string comes back) but
`Function.prototype.toString.call(new Proxy({}, {}))` returns instead of
throwing. Trace the `.call` arm in `calls.ts::compileCallExpression`
(`:8037+`) for a `Function.prototype.toString` callee: one of the arms that
run before the generic `__apply_closure` route (`tryBorrowedPrototypeNullishThisThrow`,
`tryBorrowedPrototypeBrandThisThrow`, `reshapeSloppyPrimitiveThisArg`, or a
static NativeFunction fold in `callable-to-string.ts`) answers the constant
for ANY object receiver; make the non-closure/non-proxy-callable case reach
`emitFunctionProtoToStringBody`'s `__typeof_function` guard (which already
reads the proxy callable bit) so it throws.

**C-3 `not-a-constructor.js`.** (i) `fillReflectIsConstructor`
(`reflect-construct-native.ts:214`): `ctx.constructibleClosureTypeIdxs` is
populated from `function-instance-meta.ts:227` for USER function shapes;
confirm native glue closure struct types (`ensureStandaloneNativeMethodClosure`,
`native-proto.ts:826`) are never added — if they are, exclude them; (ii)
`new Function.prototype.toString()` → the dynamic-`new` chain must throw:
`new-super.ts:3880-3890` (`noJsHost && useRuntimeArgv`) does; the
`!useRuntimeArgv` arm (`:3870`) routes to the TA ctor probe and otherwise
returns NULL — make its decline throw the same TypeError when the runtime
value is a native closure (`ref.test` the glue closure type before the TA
probe).

### Step E — native construction through a reified Error ctor carrier; close the SuppressedError / AggregateError host imports (1 + prerequisite) — `builtins-cl-E-suppressederror-leak.txt`

**E-0 (measured 2026-09-01 — the leak is NOT gone).**
`npx tsx .tmp/es2015/probes5267/imports-of.mts .tmp/es2015/probes5269/p10-nativeerrors-harness-shape.js`
— the `nativeErrors.js` harness shape (`typeof SuppressedError !== 'undefined'`
guard + `new SuppressedError(...)`/`SuppressedError(...)` + the AggregateError
twins) compiles on HEAD with `success: true` and
`module imports: ["function:env::__new_SuppressedError"]` (`result.imports`
carries it with `intent.type === "builtin"`, paramCount 4). **`AggregateError`
does NOT leak** — its `new`/call forms already resolve natively for this
shape, so E-2 is SuppressedError only. Require `[]` after.

**E-1 dynamic `new` on a brand-marked Error-family ctor carrier.**
`native-construct.ts::fillNativeConstructDrivers` (`:248+`): before the
ordinary `__object_create(Get(callee,"prototype"))` path add an arm gated by
`buildBuiltinConstructorTestArm` (`builtin-callable-brand.ts:215`, reads
`$Object` field 4 `OBJ_FLAG_CONSTRUCTOR`) that dispatches on the carrier's
builtin NAME (the seeded `name` own prop, or better a brand id stored beside
the flag — check what `pushBuiltinCtorOwnPropSeed` records) to the in-module
`__new_<Name>` constructors that `emitWasiErrorConstructor`
(`registry/error-types.ts:158`) registers for the 7 Error-family names —
`message` then lands in the `$Error_struct` exactly as the static
`new TypeError(m)` path does (`new-builtin-globals.ts:1013-1024`). Non-Error
brands keep today's ordinary path. This is the `message_property_native_error.js`
row and also what `getter-subclass.js` (`class extends Ctor` over the carrier
array) needs after D.

**E-2 SuppressedError natively under `noJsHost(ctx)`.**
`new-builtin-globals.ts:1169-1200` (new form) and `calls.ts:7874-7897` (call
form): instead of `ensureLateImport("__new_SuppressedError"…)`, call a
defined func minted from the dispose driver's existing template — extract
`disposable-runtime.ts:566-603 buildSuppressedError` (`$Error_struct` with
`BUILTIN_TYPE_TAGS.SuppressedError`, `error`/`suppressed` on `$props`,
message string) into `ensureNativeSuppressedErrorCtor(ctx): funcIdx` taking
`(error, suppressed, message, options)` externrefs (message via the same
`_errorMessageToString` decode the Error family uses; `options.cause` via
`__error_prop_set`). Register the name in the E-1 brand dispatch so
`new allErrorConstructors[i](...)` works too. `typeof SuppressedError` must
stay `"function"` (the extern-class registration `extern-declarations.ts:238`
already makes the identifier a known global). Do NOT touch the AggregateError
arms (`:1102-1160`) — E-0 measured no leak there; if a later shape leaks
`__new_AggregateError`, `promise-combinators.ts:462
__combinator_new_aggregate_error(errorsVec)` is the native builder to reuse.

### Step D — own `Error.prototype.stack` accessor pair (7) — `builtins-cl-D-error-stack-accessor.txt`

**D-1 accessor-PAIR glue kind.** `native-proto.ts` `NativeProtoBuiltinGlue`
(`:145-200`): add `accessorProps?: ReadonlyArray<{ key: string; get: string; set: string }>`
(member names for two closures) and seed them in
`ensureNativeProtoCompanionSeeder` (`:560`, next to the `dataProps` loop at
`:687`) with `__defineProperty_accessor(obj, key, get, set, PROTO_ACCESSOR_DEFINE_FLAGS)`
— the getter-kind seeding at `:660-670` is the template, with a REAL setter
singleton instead of `ref.null.extern`. Register on the Error glue
(`array-object-proto.ts:2352`, `makeGlue(...)` for `"Error"` — the NativeError
glues inherit; `stack` is own on `%Error.prototype%` only):
`accessorProps: [{ key: "stack", get: "get stack", set: "set stack" }]`, the
closures minted through `ensureStandaloneNativeMethodClosure(ctx, brand, member, kind)`
(`native-proto.ts:826`) with `nativeClosureMeta` names `"get stack"` /
`"set stack"`, lengths 0 / 1, and `refusalBodyFallback: false` (bodies below).
`seededNativeProtoOwnMembersByBrand` (`:452`) must list `stack` so
`hasOwnProperty`/`delete` observe the companion entry.

**D-2 bodies** (new `src/codegen/error-stack-accessor.ts`, ABI: local 0 self,
1 `this`, 2 first arg):
- getter (§B.? error-stack-accessor proposal, the tests' `info`): `this` not an
  Object → TypeError; `ref.test` the `$Error_struct` type (`error-props.ts`'s
  carrier — `IS_ERROR_PROP_CARRIER` helper) → return a string constant
  (`""` is acceptable — the tests check `typeof === 'string'`); anything else
  (including a `$Proxy` wrapping an Error — no unwrapping, `getter-receiver-is-proxy.js`)
  → undefined.
- setter (SetterThatIgnoresPrototypeProperties): `this` not Object →
  TypeError; `this` is the Error glue singleton itself
  (`emitLazyNativeProtoGet` identity compare, `ref.eq`) → TypeError
  (`setter-proxy-wrapping-prototype.js` asserts a PROXY of it is NOT the
  home object and goes on to the traps); own descriptor absent
  (`__getOwnPropertyDescriptor(this, "stack")` — proxy-aware, runs the
  `getOwnPropertyDescriptor` trap) → `CreateDataPropertyOrThrow` =
  `__defineProperty_value(this, "stack", v, w|e|c)` through the Proxy
  `defineProperty` front guard; trap returns false → TypeError
  (`setter-proxy-trap-rejects.js`); present → `__extern_set_strict(this, "stack", v)`
  (the `set` trap; false → TypeError). Abrupt trap completions propagate
  (`setter-proxy-trap-throws.js`).

**D-3 gOPD synthesis.** `builtin-static-gopd.ts`'s proto-receiver arm
(`resolveBuiltinProtoGopdReceiver`, `builtin-value-read.ts`) → for
`(Error, "stack")` emit `__create_accessor_descriptor(get, set, FLAG_CONFIGURABLE)`
with the two identity-stable singletons (`pushBuiltinFnSingletonValueInstrs`,
the species shape at `:440-458`). `isConstructor(get)` false / `new get()`
TypeError = C-3.

### Step M + F — Function reflective values and metadata (M 3 + F 4) — `builtins-cl-M-function-call-value.txt`, `builtins-cl-F-function-reflective.txt`

**M-1 `call` / `apply` / `bind` bodies on the Function glue.** In
`makeGlue.emitMemberBody` add `name === "Function"` arms: `call` — variadic
ABI (`memberIsVariadic` → `(self, thisValue, ref null $vec_externref)`):
`__apply_closure(this, args[0] ?? undefined, args[1..])` (`object-runtime.ts:7288
reserveApplyClosure`, ABI `(fn, recv, argsVec) -> externref`; build the tail
vec with `ensureObjVecBuilders`); `apply` — `CreateListFromArrayLike(arg1)`:
nullish → empty vec, non-object → TypeError (`tryEmitApplyArgArrayTypeError`'s
message), else `__extern_length` + `__extern_get_idx` loop; `bind` — build the
`$__bound_fn{target: this, thisArg, boundArgs}` carrier
(`ctx.boundFnTypeIdx`, the struct `compileFunctionBind`, `calls.ts:8027`,
emits — extract its `struct.new` into a shared helper). `p2` is the probe.
Why this also fixes C-2 / `this-val-not-callable.js`: `<glueClosure>.call(...)`
resolves `.call` as a MEMBER of a function value → the Function glue's `call`
closure → its body now applies the receiver closure.

**M-2 OrdinaryHasInstance reads.** `native-dynamic-instanceof.ts::ensureNativeDynamicInstanceOf`
(`:249`): replace the direct `$Object` field-4 / `$NativeProto` brand reads in
the chain walk (`:455`, `:651`) with a call to `__getPrototypeOf`
(`object-runtime-prototype.ts:346`, proxy-aware — runs the `getPrototypeOf`
trap, `value-get-prototype-of-err.js`), and make `Get(C, "prototype")`
(`:322-363`) go through the accessor-aware `__extern_get` for closure
receivers so a throwing `prototype` getter installed with
`Object.defineProperty(f, 'prototype', {get(){throw}})` propagates
(`this-val-poisoned-prototype.js`; the #3468 closure property bag is where
that define lands — verify `__extern_get` on a closure consults the bag's
accessor entries).

**F-1 `Function.prototype.name`.** `makeGlue` (`array-object-proto.ts:2090-2115`):
extend `dataProps` entries to `[key, value, flags?]` and seed
`["name", "", PROTO_SYMBOL_TAG_DEFINE_FLAGS /* w:false,e:false,c:true */]`
(and `["length", 0]` — needs a numeric value path: `__box_number(0)` instead
of the string constant at `native-proto.ts:687-700`) for the `Function` brand;
`builtin-value-read.ts:825`'s static data-prop read handles string values —
add the number case. **F-4 the 33 s compile**: profile
`Function/prototype/name.js` (`node --cpu-prof` on `.tmp/probe-one.mts`) —
the test is 8 lines of `verifyProperty(Function.prototype, "name", …)`; the
cost is in the harness-driven dynamic descriptor paths over the Function
glue. Fix the hot spot (suspects: repeated `ensureFunctionNativeProtoGlue`
seeding per call site, or the `resolveBuiltinReceiverName` AST scan at
`builtin-static-gopd.ts:186-260` walking the whole file per query — memoise
per (ctx, name)). The row counts only when it compiles under 15 s.

**F-2 `@@hasInstance` descriptor.** Rename the sentinel
`FUNCTION_PROTO_HAS_INSTANCE_MEMBER` (`function-proto-has-instance.ts:23`) from
`"@@hasInstance"` to `"@@2"` (hasInstance id, `builtin-value-read.ts:171`) so
the generic `@@<id>` plumbing applies: `seededNativeProtoSymbolMembersByBrand`
(own-ness), `nativeProtoMemberDisplayName` (`native-proto.ts:800` → name
`"[Symbol.hasInstance]"`), the `<B>.prototype[Symbol.X]` element read
(`builtin-value-read.ts:895-935`). Descriptor bits `{w:false,e:false,c:false}`:
add a per-member flags hook to the glue (`memberDefineFlags?: (member) => number`)
consulted by the seeder (`native-proto.ts:672-676`, today `@@3` is the only
special case) and by the static gOPD synthesis. Update the two
`FUNCTION_PROTO_HAS_INSTANCE_MEMBER` consumers (`FUNCTION_PROTO_METHODS`,
`array-object-proto.ts:376`; the ladder arm at `:2180`).

**F-3 `isConstructor(Function)`.** The harness passes the bare `Function`
identifier as `newTarget` to `Reflect.construct(function(){}, [], Function)`:
`isStaticallyConstructible` (`call-namespace-static.ts:315-340`) lists the
builtin names — add `Function` (and `AsyncFunction` for K) so the static arm
answers; the runtime `fillReflectIsConstructor` brand arm already admits a
reified ctor carrier once `Function` reads as one (`emitBuiltinConstructorIdentity`
name set has it). If the row then hits the #3371 refusal (newTarget ≠
target with no static `.prototype`), it moves to X1 — report it.

### Step J — reflective `Number.prototype.toPrecision` / `Date.prototype.toJSON` (3) — `builtins-cl-J-number-date-reflective.txt`

**J-1.** New `src/codegen/number-proto-format.ts::emitNumberProtoFormatBody(ctx, fctx, member)`
for `toPrecision` (and `toFixed`/`toExponential` for free): thisNumberValue
prologue = `emitBoxedProtoValueOfBody`'s carrier/wrapper arms
(`boxed-proto-valueof.ts:199`), arg → runtime ToNumber (the coercion engine's
externref→f64 walker used by `coerceType(…, f64, "number")`; a closure → NaN),
then the exact range check the direct arm emits (`call-receiver-method.ts:2833-2900`,
RangeError instance) → `number_toPrecision(f64, f64)`
(`number-format-native.ts:896`; ensure the helper is registered —
`ensureNumberFormatNatives` at `:490`). Wire into the `makeGlue` ladder for
`name === "Number"`.

**J-2.** `expressions/builtins.ts:1698 emitDateProtoMemberBody`: add `toJSON`
(§21.4.4.37): `this` nullish → TypeError (ToObject); `tv = ToPrimitive(this, "number")`
via `runtimeToPrimitiveInstrs` (`coercion-engine.ts`); `tv` is a Number and
not finite → `null`; else `Invoke(O, "toISOString")` = `__extern_get(O, "toISOString")`
(for a `$Date` receiver the glue member; for a boxed number
`Number.prototype.toISOString` installed by the test — the native-proto
companion lookup that `__extern_get` on a boxed primitive already performs for
user-added members, verify with `to-object.js`'s `Number.prototype.toISOString = …`),
IsCallable else TypeError, `__call_fn_method_0`. `to-primitive-symbol.js` also
needs H-2.

### Step I — String residue (7) — `builtins-cl-I-string-residual.txt`

**I-1 `String.raw` identity (3).** `call-builtin-static.ts:805-825`: when the
template argument is an IDENTIFIER (not a literal), do not
`materializeStructAsDynamicObject` if its initializer literal took the open
path (`objectLiteralForcesHostPath` — the three tests' templates carry a
`get length()` / defineProperty'd `raw`, i.e. accessors → already `$Object`);
pass the ref through `extern.convert_any`. The helper (`string-raw.ts`) then
runs the `length`/index getters and propagates their abrupt completions.
`nextkey-is-symbol-throws.js`: `__str_raw`'s segment `__extern_toString`
(`string-raw.ts:26`) must throw for a `$Symbol` carrier — the #5152 D.2
throwing variant if it landed, else add a `ref.test ctx.symbolTypeIdx` →
TypeError before the generic ToString.

**I-2 `substr` reflective (1).** `emitStringProtoMemberBody` (`array-object-proto.ts:1005`):
add `if (member === "substr") return emitStringSubstringMemberBody(ctx, fctx, "substr")`
and teach `string-proto-substring.ts` the third mode: second arg is a COUNT
with the `0x7fffffff` absent sentinel and `__str_substr` (the direct arm at
`string-ops.ts:3001-3022` is the reference), sharing the
`emitStringProtoToStringFlat` receiver preamble (so the receiver's throwing
`toString` propagates — `this-to-str-err.js`).

**I-3 normalize (3, land LAST).** `scripts/gen-normalize-tables.mjs` (pattern:
`scripts/gen-case-tables.mjs`, Node's ICU as the offline oracle) emitting
`src/codegen/normalize-tables.ts`: canonical + compatibility decomposition
(flat `[cp, len, c0..c3]`), canonical combining class ranges, primary
composites `[a, b, ab]`, composition exclusions; new
`src/codegen/normalize-native.ts::ensureStrNormalize(ctx)` →
`__str_normalize(str, form:i32) -> str`: full decomposition (recursive,
Hangul algorithmic), canonical ordering (stable sort by CCC within runs),
composition for NFC/NFKC (Hangul + pairwise with exclusions); UTF-16 code
units in/out (`ensureStrToCharVecHelper` for code points). Replace the identity
at `string-ops.ts:3690-3700` with the helper call; the reflective arm of
#5152 B.2 (if present) calls the same helper.

### Step L — `hasOwnProperty(new Error(m), "message")` (1) — `builtins-cl-L-error-instance-message.txt`

`object-runtime-own-props.ts` (`__hasOwnProperty` / `__object_hasOwn`): add a
NARROW `$Error_struct` arm — `message` is own iff the struct's message field
is non-null (`new Error()` has no own message; `new Error("m")` does),
`cause` iff the cause slot is set; everything else falls to the `$props`
bag (`error-props.ts` `ERROR_PROP_BAG_LOOKUP`). Read `carrier-bag-hasown.ts`'s
header first: the arm is confined to the Error carrier so it cannot repeat
#4017's blast radius. gOPD/delete/write for `message` are answered by
`error-props.ts` already (`verifyProperty` then passes).

### Step K — `%AsyncFunction%` (2, stretch) — `builtins-cl-K-asyncfunction-intrinsic.txt`

Reify `AsyncFunction` like a builtin ctor: a brand in `builtin-brands.ts`, a
`$NativeProto` glue `makeGlue(ctx, brand, "AsyncFunction", [], "AsyncFunction")`
(`symbolTag` = `"AsyncFunction"`, `{w:false,e:false,c:true}`), an
`emitBuiltinConstructorIdentity("AsyncFunction")` carrier with `prototype` =
that glue; `.constructor` on an async closure value (`__extern_get` closure
arm — the `.constructor` synthesis `error-ctor-carrier.ts` describes for
error instances is the pattern) → the carrier; `isConstructor` via F-3;
`new AsyncFunction()` → the dynamic Function-ctor route (#4656 runtime-eval
carrier) with an async body. Attempt only after A–L are green.

### What NOT to do

- **No new host imports, ever.** Every body here is Wasm-native; the E step
  REMOVES two (`__new_SuppressedError`, `__new_AggregateError` under
  `noJsHost`). Verify with `imports-of.mts`, not with the runner's
  classification (finding 1 above).
- Never edit `tests/test262-runner.ts` (the `createRealm` stub included), skip
  lists, or `scripts/*baseline*.json`.
- No `--no-verify`; gates chained before every commit (below), also with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`.
- New type queries via `ctx.oracle` only; `oracle-ratchet-allow:` only for a
  genuine `ValType`-level question.
- Don't widen `__hasOwnProperty` generally (Step L is a `$Error_struct`-only
  arm; #4017 cost 684 passes).
- Don't widen H-1 to every well-known symbol — `toPrimitive` (id 3) only.
- Don't touch owned areas (X table): no `Reflect.construct` NewTarget work, no
  String `@@match/@@search/@@split/@@replace` dispatch (#5198 Slice D), no
  realms, no `Proxy.revocable`, no derived-ctor return semantics.
- Don't "fix" `String(sym)` to throw (only implicit ToString throws).
- Don't treat `Function/prototype/name.js` as passing until it compiles under
  the 15 s budget on a quiet box (F-4).

## Acceptance criteria

- Per-step lists green via
  `npx tsx scripts/run-test262-paths.mts .tmp/es2015/builtins-cl-<X>.txt --standalone`.
  Expected flips: G 13, H 11, A 14 (A1 10 + A2 4), B 9 (+2 B-e stretch), B2 1,
  C 8, E 1, D 7, M 3, F 4 (incl. the F-4 compile fix), J 3, I 7 (I-3 is the
  uncertain 3), L 1, K 2 (stretch) — **86 max, ≥ 70 is the bar** (B-e, I-3,
  K and F-4 are the uncertain part; report each unflipped row with its
  residual error in the PR body).
- Step E-0's import listing is `[]` for
  `.tmp/es2015/probes5269/p10-nativeerrors-harness-shape.js`.
- Controls: every row of `.tmp/es2015/builtins-controls.txt` (20 currently-passing
  siblings from the same directories — Symbol `@@toPrimitive` prop-desc/name,
  `Symbol.for`/`keyFor` registry rows, `Function.prototype.apply`/`bind`
  metadata, NativeError `instance-proto`/`is-a-constructor`, Error
  `no-error-data`/`toString/name`, JSON `revived-proxy-revoked`/
  `space-wrong-type`, `String.raw`/`indexOf`/`toPrecision` metadata,
  `Date.prototype.toJSON/called-as-function`, `isNaN/toprimitive-get-abrupt`,
  annexB escape/unescape; verified passing on HEAD 2026-09-01 via
  `run-test262-paths.mts … --standalone`, results in
  `.tmp/es2015/builtins-probes-run1.txt`) still passes, on both lanes
  (`--standalone` and the default js-host lane: the literal lowering (H), the
  JSON dispatch gates (G) and the `.call/.apply` arm (M) are shared code).
- Gates, chained: `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`
  (also with `LOC_GATE_BASE` set to the upstream-main tip).
- `pnpm run test:equivalence:gate` green (H changes an object-literal lowering
  decision and M changes the `.call/.apply` arm — both are exercised by the
  equivalence corpus).

## References

- #5156 / #5152 — wave-1 plans and their Results / "Not attempted" / "New
  findings" sections (the source of clusters A, B, C, D, F, H, I, J, L);
  landed via PR #5244.
- #3176 — standalone JSON codec (`json-codec-native.ts`; the 2026-08-27 slice
  added the internalize-walk Proxy arms Step G mirrors on the stringify side);
  #2166 PR-A/B/C/D — the codec's dispatch gates Step G narrows.
- #4207 / #4265 — transferred-method brand/coercion and the `Function.prototype`
  bucket diagnosis (`.call` transfer, `ToString` of callables) that Steps M
  and C extend; #4492 — NativeFunction constant; #4776 — `Symbol.prototype.valueOf`
  body (Step B's template); #4196 / #3140 — bound-function carrier (M-1 `bind`).
- #2984 / #3006 / #4120 — reified builtin ctor carriers and their own props
  (`builtin-ctor-own-props.ts`, `builtin-static-gopd.ts`), Step A's home;
  #2163 — native Symbol registry; #1467 — symbol description.
- #2861 / #4248 / #2885 — native-proto glue, own-props ladder, descriptor
  synthesis (Steps D, F); #3981 — native [[Construct]] driver (Step E-1);
  #1104 / #1473 — in-module `__new_<Error>` (Step E); #3234 — dispose driver's
  native SuppressedError (E-2's template).
- #5102 — `@@toPrimitive` probe (Step H's consumer); #4616 — the literal
  host-path gate and its lockstep rule.
- #5267 — sibling r2 plan (the runner host-import re-classification finding,
  same method).
- #3371, #5198, #4274 / #4634, #5139, #5140 — owners of the X rows.
- Handover: `plan/agent-context/es2015-standalone-session-handover.md`
  (method notes).
