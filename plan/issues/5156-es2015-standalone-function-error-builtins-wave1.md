---
id: 5156
title: "ES2015 standalone: function-error-builtins conformance wave 1"
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
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-value-read.ts
  - src/codegen/native-proto-own-props.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/builtin-fn-meta.ts
  - src/codegen/symbol-native.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/function-proto-to-string.ts
  - src/codegen/callable-any-to-string.ts
  - src/codegen/coercion-engine.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/date-proto-to-primitive.ts
  - src/codegen/date-ctor-value-arg.ts
coercion-sites-allow:
  # Both new modules DELEGATE to the coercion engine's `__to_primitive` rather
  # than hand-rolling a matrix: §21.4.4.45 and §21.4.2.2 step 4 are exactly
  # "call ToPrimitive with this hint", so the call IS the spec step.
  - src/codegen/date-proto-to-primitive.ts
  - src/codegen/date-ctor-value-arg.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
---

# #5156 — ES2015 standalone: function-error-builtins conformance wave 1

Growth allowance rationale (2026-08-28): this change-set adds spec-mandated
own DATA/ACCESSOR properties to existing `$NativeProto` glue (Error family
`name`/`message`, `Error.prototype.stack`), reifies the `Symbol` namespace
object, adds the `Date.prototype[@@toPrimitive]` native body, and extends the
ToString/ToPrimitive cascades with proxy-callable and accessor-@@toPrimitive
arms — all net-new Wasm-emission code in the files listed above, following
patterns already present in each file.

## Problem

162 ES2015-bucket test262 tests under `built-ins/{Function,Error,NativeErrors,
Symbol,Date,isNaN,isFinite,Number,Boolean}` fail on `--target standalone`
(re-verified 2026-08-28 on branch head via `.tmp/run-standalone.mts`: 150 FAIL
+ 12 COMPILE_ERROR, 0 of the day-old baseline already fixed; run artifacts
`.tmp/es2015/wp-feb-out-{aa,ab}.txt`). The dominant defects are reflective
gaps in the standalone `$NativeProto` glue (data properties on builtin
prototypes trap with an illegal cast; per-NativeError prototype identity is
collapsed onto Error's), and the `Symbol` global not being reified as a
first-class namespace object. Every one of these blocks the 100% ES2015
standalone goal, and the same glue mechanisms are shared by the other wave-1
packages, so fixes here compound.

## Current failure clusters

Counts sum to 162. "root cause" names the deciding file:function; sample tests
are test262-relative paths under `test262/test/`.

| cluster | count | root cause (file:function) | sample tests |
| --- | --- | --- | --- |
| J. realm-dependent ($262.createRealm) — **blocked on harness decision, not wave-1 implementable** | 30 | `tests/test262-runner.ts` L2277 `createRealm` stub returns a global with NO builtins (`realm.global.Symbol` etc. is `undefined`); standalone is single-realm by design. DO NOT edit the runner in this issue — see step 9. | `built-ins/Symbol/iterator/cross-realm.js`, `built-ins/Function/proto-from-ctor-realm.js`, `built-ins/Boolean/proto-from-ctor-realm.js` |
| D. Error/NativeError prototype own data props + proto identity | 26 | (a) `src/codegen/array-object-proto.ts` L305/L324 `ERROR_PROTO_METHODS`/`NATIVE_ERROR_PROTO_METHODS` CSVs list methods only, so `Error.prototype.message`-style DATA-prop reads fall to the generic member path, which casts the `$NativeProto` struct to `$Object` → `RuntimeError: illegal cast in __module_init` (probe-verified: even `Error.prototype.message` traps); (b) `src/codegen/expressions/object-get-prototype-of.ts` L40-56 `ES5_OBJECT_PROTOTYPES` maps every NativeError to `"Error"`, so `Object.getPrototypeOf(new EvalError()) === Error.prototype`, NOT `EvalError.prototype` (probe-verified) — per-NativeError brands already exist (#2861 `ensureNativeErrorNativeProtoGlue`, array-object-proto.ts L2252). | `built-ins/NativeErrors/TypeError/prototype/message.js`, `built-ins/NativeErrors/EvalError/instance-proto.js`, `built-ins/Error/message_property.js` |
| B. `Symbol` namespace-object reification | 22 | Bare `Symbol` as a first-class value → `__get_builtin` standalone COMPILE_ERROR (or nullish in arg position); `src/codegen/builtin-static-gopd.ts` L357-362 explicitly excludes Symbol from the static-gOPD table ("own well-known-symbol data props" unhandled). Well-known-symbol ids already exist in `src/codegen/builtin-value-read.ts`. Also `new Symbol()` must throw TypeError; `isConstructor(Symbol)` must be false but `Symbol()` callable. | `built-ins/Symbol/iterator/prop-desc.js`, `built-ins/Symbol/length.js`, `built-ins/Symbol/not-callable.js` |
| G. Date @@toPrimitive protocol + toJSON | 21 | `Date.prototype[Symbol.toPrimitive]` reads `undefined` (probe-verified): Date's glue has no @@toPrimitive symbol member — `src/codegen/native-proto.ts` L657/L934 wires `Symbol.prototype[@@toPrimitive]` as the ONLY bracketed native-proto member (`seededNativeProtoSymbolMembersByBrand`). §21.4.4.45 native body missing; `new Date(obj)` arg coercion bypasses ToPrimitive/[[DateValue]] brand fast-path (`construct_with_date.js` proves `valueOf` is called on a Date-branded arg — must read [[DateValue]] without calling it); `Date.prototype.toJSON` is a loud refusal. | `built-ins/Date/prototype/Symbol.toPrimitive/hint-number-first-valid.js`, `built-ins/Date/construct_with_date.js`, `built-ins/Date/prototype/toJSON/to-object.js` |
| C. Symbol.prototype / symbol wrapper semantics | 16 | `Object.getPrototypeOf(Symbol('x'))` → `null` (probe-verified): symbol-typed args have no mapping in `object-get-prototype-of.ts` nor in the dynamic `__getPrototypeOf` arm (`src/codegen/object-runtime-prototype.ts`); ToObject(symbol) wrapper semantics (auto-boxing write must throw in strict / no-op sloppy), reflective `Symbol.prototype.{toString,constructor,[@@toStringTag]}` on symbol receivers. Overlaps in-progress #4776 (valueOf borrowed calls) — coordinate, do not duplicate. | `built-ins/Symbol/prototype/intrinsic.js`, `built-ins/Symbol/auto-boxing-strict.js`, `built-ins/Symbol/prototype/Symbol.toStringTag.js` |
| H. Reflect.construct distinct NewTarget residual (#3371 carriers) | 13 | 12 COMPILE_ERRORs cite #3371's deliberate refusals: "distinct NewTarget is not implemented for this target carrier" / "cannot preserve an arbitrary distinct NewTarget without a statically-resolved NewTarget.prototype". Bound-function [[Construct]] does not forward newTarget (`bind/instance-construct-newtarget-*`). 6 of the 13 (`NativeErrors/*/proto-from-ctor-realm.js`) are ALSO realm-blocked (cluster J). | `built-ins/NativeErrors/TypeError/proto-from-ctor-realm.js`, `built-ins/Function/prototype/bind/instance-construct-newtarget-boundtarget.js`, `built-ins/Date/subclassing.js` |
| E. Error.prototype.stack accessor | 10 | `Object.getOwnPropertyDescriptor(Error.prototype, 'stack')` → `undefined` → tests deref `.get` and throw. No own `stack` accessor pair in the Error glue. Accessor ("getter" kind) machinery already exists: `src/codegen/native-proto-value-read.ts` tier-1 `kind === "getter"` + `makeGlue` memberKind. | `built-ins/Error/prototype/stack/getter-not-a-constructor.js`, `built-ins/Error/prototype/stack/setter-receiver-is-proxy.js` |
| K. Function reflective misc | 10 | `Function.prototype[@@hasInstance]` value+descriptor WORK (probe-verified) but descriptor details are wrong (name must be `"[Symbol.hasInstance]"`, writable false); `Function.prototype.call` as reflective VALUE is a loud refusal ("not yet implemented in --target standalone"); `verifyProperty(Function.prototype, 'name', …)` dies in propertyHelper (same $NativeProto data-prop gap as cluster D); `isConstructor(Function)` false (Reflect.construct(Function) unsupported). | `built-ins/Function/prototype/Symbol.hasInstance/prop-desc.js`, `built-ins/Function/prototype/name.js`, `built-ins/Function/is-a-constructor.js` |
| F. Function.prototype.toString on Proxy-of-callable | 9 | `String(new Proxy(function(){}, {}))` → `"undefined"`: the ToString cascade (`src/codegen/coercion-engine.ts` `__extern_toString` closure arm / `callable-any-to-string.ts`) has no Proxy-carrier arm. #4492 already settled the NativeFunction constant + TypeError-for-non-callable posture in `src/codegen/function-proto-to-string.ts`. | `built-ins/Function/prototype/toString/proxy-function-expression.js`, `proxy-class.js`, `not-a-constructor.js` |
| I. ToPrimitive residual (accessor @@toPrimitive; ToNumber of functions) | 5 | #5102 (done) probes only OWN DATA `Symbol.toPrimitive` in the standalone ToPrimitive helper (`src/codegen/object-runtime.ts::ensureObjectRuntime`); an ACCESSOR-defined @@toPrimitive (`Object.defineProperty(obj, Symbol.toPrimitive, {get(){…}})`) is not probed (get-abrupt not propagated, valid-result's return value unused). `Number.prototype.toPrecision(function(){})` throws TypeError instead of ToNumber→NaN→RangeError. | `built-ins/isNaN/toprimitive-get-abrupt.js`, `built-ins/isFinite/toprimitive-valid-result.js`, `built-ins/Number/prototype/toPrecision/precision-cannot-be-coerced-to-a-number-in-range.js` |

## Implementation Plan

Target list: `.tmp/es2015/wp-function-error-builtins-current-fails.txt` (162
paths; regenerate a cluster's slice by grepping it). Probe per test:
`cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>` (split
lists >150; some tests take up to 20s). Steps are ordered by yield
(count descending among implementable clusters); each is independently
landable.

1. **Cluster D (26) — own data props on Error-family `$NativeProto` + per-NativeError proto identity.**
   - `src/codegen/native-proto-value-read.ts::resolveStandaloneProtoMemberValueClosure`:
     add a DATA-prop tier before tier-1 — for brand ∈ {Error, EvalError,
     RangeError, ReferenceError, SyntaxError, TypeError, URIError} and member
     ∈ {`name`, `message`}, return the constant string (`name` = ctor name,
     `message` = `""`) instead of falling through to the dynamic path (whose
     `$Object` cast of the `$NativeProto` struct is the "illegal cast in
     __module_init" trap). Mimic how `native-proto-own-props.ts` (#4248)
     special-cases `constructor` as own-but-not-in-CSV.
   - `src/codegen/native-proto-own-props.ts`: answer own-ness `1` for
     `name`/`message` on those brands (spec: own, writable:true,
     enumerable:false, configurable:true), and extend the #2885 descriptor
     synthesis (`object-runtime-descriptors.ts::__getOwnPropertyDescriptor` /
     builtin-proto gOPD path) to emit that data descriptor. `verifyProperty`
     also WRITES then deletes/restores: reuse the seeded-mutable-member
     ("companion entry") mechanism `native-proto-own-props.ts` describes for
     seeded DATA methods so redefinition/delete works; Date's seeded members
     are the existing analog.
   - `src/codegen/expressions/object-get-prototype-of.ts` L48-54: change
     `ES5_OBJECT_PROTOTYPES` NativeError rows from `"Error"` to their own
     names (brands exist — `ensureNativeErrorNativeProtoGlue`,
     array-object-proto.ts L2252). Mirror the same collapse in the dynamic
     `__getPrototypeOf` arm (`src/codegen/object-runtime-prototype.ts`) if the
     error-instance carrier's brand field also answers "Error" there — verify
     with a dynamically-typed probe first.
   - Edge cases: `Object.prototype.toString.call(EvalError.prototype)` must
     stay `[object Object]`; `EvalError.prototype.toString` must stay the
     inherited Error.prototype.toString singleton (tier-2 in the value-read
     resolver); do not break `NativeErrors/message_property_native_error.js`
     (`new TypeError("my-message").hasOwnProperty("message")` — instance own
     prop, `src/codegen/error-props.ts` / `error-instance-field-write.ts`).

2. **Cluster B (22) — reify the `Symbol` namespace object.**
   - `src/codegen/builtin-static-gopd.ts` L357-362: remove `"Symbol"` from
     the early-false exclusion and add its own-prop table: the 12 well-known
     symbols (data, writable:false, enumerable:false, configurable:false —
     values from the well-known-symbol id table already in
     `src/codegen/builtin-value-read.ts`), `for`/`keyFor` (method closures —
     registry exists, #2163 `src/codegen/symbol-native.ts::ensureSymbolRegistry`),
     `length` = 0 and `name` = `"Symbol"` (configurable:true per §17), and
     `prototype` (non-writable, = the Symbol glue singleton,
     `ensureSymbolNativeProtoGlue`). Follow the existing per-ctor table shape
     in the same file (#2984 Phase 3) and its `[Symbol.species]` accessor
     precedent (`"get [Symbol.species]"` singleton, L420-484) for
     `Symbol/species/*.js`.
   - Bare-`Symbol` VALUE read (aliasing `var S = Symbol`, arg position):
     extend `src/codegen/builtin-value-read.ts` /
     `src/codegen/builtin-fn-meta.ts::pushBuiltinFnSingletonValueInstrs` to
     mint a `Symbol` namespace singleton carrier (the existing builtin-fn
     singleton pattern used for ctor values) whose member reads answer the
     same table; `typeof Symbol` must be `"function"` and `Symbol("d")` via
     the alias must still call the ctor (see
     `src/codegen/function-ctor-reflective-call.ts` for the alias-call
     pattern).
   - `new Symbol()` → TypeError (§20.4.1: not a constructor):
     `src/codegen/builtin-ctor-callable.ts` / `expressions/new-super.ts` —
     follow whatever emits the TypeError for other non-constructable
     builtins; `isConstructor(Symbol)` must answer false through the
     Reflect.construct probe (harness isConstructor.js).
   - Edge cases: `Symbol/symbol.js` verifies the GLOBAL own property
     (`verifyProperty(this, "Symbol", …)` via fnGlobalObject) — needs the
     global-object descriptor path, not the namespace table; keep
     `Symbol.iterator` static folds (existing fast paths) byte-identical when
     the namespace object is never aliased.

3. **Cluster G (21) — Date @@toPrimitive + [[DateValue]] arg fast-path + toJSON.**
   - Wire `@@toPrimitive` into Date's glue as a bracketed symbol member:
     mimic the ONE existing precedent — Symbol.prototype[@@toPrimitive] in
     `src/codegen/native-proto.ts` (L657 + L934 bracketed-name handling,
     `seededNativeProtoSymbolMembersByBrand`). Native body implements
     §21.4.4.45: brand-check `this` (TypeError otherwise), hint must be one of
     "default"/"number"/"string" (TypeError otherwise — `hint-*-invalid.js`),
     then OrdinaryToPrimitive with "string" order for default/string, "number"
     order for number — reuse
     `src/codegen/coercion-engine.ts::runtimeToPrimitiveInstrs`. Descriptor:
     configurable:true, writable:false, enumerable:false; name
     `"[Symbol.toPrimitive]"`, length 1 (`length.js`/`name.js`/`prop-desc.js`).
   - `new Date(value)` single-arg (§21.4.2.2 step 4): if the arg carries the
     Date brand, read [[DateValue]] directly WITHOUT any method call
     (`construct_with_date.js` poisons `toString`/`valueOf`); else run
     ToPrimitive(value, default) honoring user `@@toPrimitive`
     (`value-symbol-to-prim-*.js` assert invocation count, this-value, and
     the single "default" argument), then ToNumber unless the primitive is a
     string. Site: wherever `new Date(x)` lowers its argument —
     `src/codegen/date-host-bridge.ts` / the Date ctor arm in
     `expressions/calls.ts` — currently emits a valueOf-first coercion.
   - `Date.prototype.toJSON` (§21.4.4.37): native body = ToObject(this),
     ToPrimitive(O, number); if result is a Number and not finite → null;
     else invoke `this.toISOString()` (existing native). `to-object.js` and
     `to-primitive-symbol.js` are the two failing rows; the current body is
     the #2984 catchable refusal.
   - What NOT to do: do not route through a new host import — the js-host
     lane already passes these; every body here must be Wasm-native.

4. **Cluster C (16) — symbol wrapper / Symbol.prototype intrinsic plumbing.**
   - `Object.getPrototypeOf(<symbol>)` → the Symbol glue singleton: add a
     symbol-typed arm in `src/codegen/expressions/object-get-prototype-of.ts`
     (mimic `tryNativeCollectionGpo` in the same file) and the corresponding
     runtime arm in `src/codegen/object-runtime-prototype.ts::__getPrototypeOf`
     for i31/boxed-symbol carriers (`prototype/intrinsic.js`).
   - Auto-boxing writes on symbol receivers: `sym.a = 0` must throw TypeError
     in strict code (all test262 module/strict harness code) and be a no-op
     returning undefined on read — route the symbol-receiver property-WRITE
     path (`src/codegen/property-access-dispatch.ts` #1467 region handles
     reads/`description`) to the strict-write TypeError used by primitive
     receivers elsewhere (`object-runtime-strict-set.ts` posture).
   - Reflective `Symbol.prototype.toString.call(sym)` / `.constructor` /
     `[@@toStringTag]`: coordinate with #4776 (in-progress, valueOf borrowed
     calls) — same brand + wrapper machinery
     (`src/codegen/symbol-proto-valueof.ts` is the pattern: brand-check +
     unwrap); `constructor` must be the reified `Symbol` from step 2;
     `@@toStringTag` = `"Symbol"` (configurable:true) via
     `seededNativeProtoSymbolTagsByBrand`.
   - `Symbol("x")` with a description whose ToString throws
     (`desc-to-string.js`, `for/to-string-err.js` — currently a null-pointer
     deref in `__closure_66`): the description/key coercion in
     `src/codegen/symbol-native.ts` (ctor + `__symbol_for_native`) must run
     full ToString (ToPrimitive-string) with abrupt propagation, not assume a
     string carrier. `keyFor/arg-non-symbol.js`: `Symbol.keyFor(x)` must
     TypeError for every non-symbol x.
   - Defer (document, don't attempt): `redefined-/removed-symbol-wrapper-
     ordinary-toprimitive.js` require MUTATING `Symbol.prototype[@@toPrimitive]`
     and observing fallback OrdinaryToPrimitive on wrappers — needs mutable
     native-proto companion entries for symbol-keyed members; note it in the
     PR if left red.

5. **Clusters E + K (20) — Error.prototype.stack accessor; Function reflective misc.**
   - `stack`: register an own ACCESSOR member on the Error glue (and inherit
     for NativeError brands per spec — it is own on `Error.prototype` only)
     with get/set closure singletons (get returns any string/undefined —
     tests only check descriptor shape, isConstructor(get) === false, and
     TypeError on `new get()`); the "getter" kind path in
     `resolveStandaloneProtoMemberValueClosure` + the @@species accessor
     singleton in `builtin-static-gopd.ts` L420-484 are the two patterns to
     copy. gOPD must return `{get, set, enumerable:false, configurable:true}`
     with identity-stable get/set.
   - `Function.prototype.call` as a VALUE (`this-val-not-callable.js`): give
     the Function glue's `call` (and `apply`/`bind` if trivially co-locatable)
     a real reflective body instead of the refusal — the direct-invocation
     lowering already exists; the reflective closure can delegate to the same
     apply machinery (`src/codegen/expressions/call-builtin-static.ts` L334+
     documents the current refusal posture).
   - `Function.prototype.name`/`length` verifyProperty: falls out of step 1's
     data-prop tier applied to the Function brand (name `""`... spec:
     `Function.prototype.name` is `""`, length 0).
   - `@@hasInstance` descriptor polish (`name.js`, `prop-desc.js`): name
     `"[Symbol.hasInstance]"`, writable:false — fix the descriptor the
     Function glue synthesizes (`ctx.nativeClosureMeta` naming, see the
     species singleton for the bracketed-name pattern).
   - `Function/is-a-constructor.js` + `bind/instance-construct-newtarget-self-*`:
     needs `Reflect.construct(Function, [])` and bound-ctor newTarget
     forwarding — shared with cluster H; take only if step 8 lands.
   - Skip here: `internals/Construct/base-ctor-revoked-proxy.js` needs
     `Proxy.revocable` (belongs to the proxy wave — #5140/#1355);
     `derived-return-val.js` (derived-ctor return TypeError vs
     ReferenceError) belongs to the class wave (#5139) — cross-reference,
     do not fix twice.

6. **Cluster F (9) — ToString of Proxy-of-callable → NativeFunction string.**
   - In the `__extern_toString` cascade (`src/codegen/coercion-engine.ts::
     installCompiledClosureToStringArm` / `src/codegen/callable-any-to-string.ts`):
     add a Proxy-carrier arm — if the carrier's (transitive) target is
     callable, return `NATIVE_FUNCTION_SOURCE` (exported by
     `src/codegen/callable-to-string.ts`, same constant #4492 settled on);
     if not callable, TypeError (`proxy-non-callable-throws.js`). The proxy
     carrier struct + target field live in
     `src/codegen/object-runtime-proxy.ts`.
   - `Function.prototype.toString` reflective body
     (`src/codegen/function-proto-to-string.ts`): accept the proxy carrier as
     callable `this` for the same two arms. `not-a-constructor.js` also needs
     isConstructor(toString) === false (step 8 machinery).
   - `GeneratorFunction.js`: toString of a dynamically-created generator
     function currently stringifies as `"null"` — make the closure arm answer
     NativeFunction for generator closures too.

7. **Cluster I (5) — accessor-defined @@toPrimitive + ToNumber(function).**
   - Extend the #5102 standalone ToPrimitive helper
     (`src/codegen/object-runtime.ts::ensureObjectRuntime`) from "probe own
     DATA `Symbol.toPrimitive`" to full GetMethod: also probe an ACCESSOR
     entry (invoke its getter, propagating abrupt completions —
     `toprimitive-get-abrupt.js`), and USE the call's return value as the
     primitive result when non-object (`toprimitive-valid-result.js` asserts
     the poisoned `valueOf`/`toString` are NOT reached). The descriptor-entry
     walk in `object-runtime-descriptors.ts` shows how accessor entries are
     stored.
   - `Number.prototype.toPrecision(<function>)`: the precision arg must go
     through ToNumber (→ NaN for a closure) then the §21.1.3.5 range check →
     RangeError; currently the closure arg short-circuits to TypeError. Fix
     in the toPrecision arg-coercion arm (grep its emitter for the TypeError;
     mimic how `toFixed` coerces its argument).

8. **Cluster H (13) — Reflect.construct newTarget residual carriers (#3371).**
   - #3371 is `done`; these 12 CEs are its documented residual refusals. The
     actionable, non-realm subset (~6: `bind/instance-construct-newtarget-*`,
     `bind/get-fn-realm*.js` (2 of which are realm-flavored but compile-fail
     first), `Date/subclassing.js`, `Error/prototype/stack/
     getter-foreign-new-target.js`): implement newTarget forwarding through
     BOUND-function [[Construct]] (the bound-fn carrier must store the target
     + forward the active newTarget, §10.4.1.2) and the Date/Error ctor
     carriers' newTarget-prototype read. Read #3371's `## Implementation
     Plan` first and extend its carrier matrix rather than inventing a new
     mechanism; keep the loud refusal for carriers still uncovered
     (absent-not-wrong).
   - The 6 `NativeErrors/*/proto-from-ctor-realm.js` stay red until cluster J
     unblocks (they need BOTH newTarget and a foreign realm).

9. **Cluster J (30) — realm-dependent: OUT OF SCOPE for this wave's code
   changes.** The `$262.createRealm()` stub (tests/test262-runner.ts L2277,
   #1523) returns a global with no builtins, so `other.Symbol` /
   `other.Function.prototype` are `undefined` and no compiler change can make
   these assertions pass. Editing the runner, skip lists, or baselines is
   forbidden in this issue. File the harness-realm decision as its own
   follow-up issue (allocate via `claim-issue.mjs --allocate`): either an
   enriched single-realm stub exposing the real builtins under
   `realm.global.*` (passes the 13 shared-well-known-symbol tests, but
   `Symbol/for/cross-realm.js`-style notSameValue rows stay red) or a
   genuine second-instance realm. Do NOT burn wave-1 effort here.

**What NOT to do (all steps):** no new host imports without a standalone
fallback (the js-host lane already passes all 162 — every fix is Wasm-native
emission); never edit `tests/test262-runner.ts`, skip lists, or
`scripts/*baseline*.json`; new codegen needing type info goes through
`ctx.oracle` (`src/checker/oracle.ts`), never the raw TS checker
(oracle-ratchet gate); prefer extending the existing glue/carrier mechanisms
cited above over new parallel ones; keep refusals loud where a body is not
implemented (absent-not-wrong — no silent `undefined`).

## Acceptance criteria

- All tests in `.tmp/es2015/wp-function-error-builtins-current-fails.txt`
  pass via the probe
  (`npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-function-error-builtins-current-fails.txt`),
  **except** the realm-blocked carve-out (cluster J, 30 tests + the 6
  doubly-blocked `NativeErrors/*/proto-from-ctor-realm.js` in cluster H),
  which requires the separate harness-realm follow-up issue (step 9). Wave-1
  implementation bar: the remaining ~126 tests pass; any deliberately-deferred
  edge rows (step 4's two wrapper-mutation tests) are named in the PR body.
- Every test in `.tmp/es2015/wp-function-error-builtins-passing-spotcheck.txt`
  still passes (same probe).
- Ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`.
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## Results (wave 1, 2026-08-28)

Measured with `npx tsx .tmp/run-standalone.mts --list <slice>` over the full
162-path target list, before and after, on this branch.

| | pass | fail | compile_error |
| --- | --- | --- | --- |
| before | 0 | 150 | 12 |
| after | **42** | 108 | 12 |

Spot-check list (40 already-passing rows): 40/40 still pass. Equivalence suite:
5 pre-existing failures, all `Compile failed: Type 'undefined' is not
assignable…` TypeScript diagnostics in the fixtures (`isNaN(void x)`, `yield`
as expression, nested-arguments) — none reachable from a codegen change; the
run then OOMed near the end, which `CLAUDE.md` documents for the full suite in
a constrained container.

### Fixed

- **Cluster D — NativeError prototype identity + Error-family data props (18).**
  `ES5_OBJECT_PROTOTYPES` now maps each NativeError to its OWN prototype, with a
  new arm keeping `Object.getPrototypeOf(<NativeError>.prototype) ===
  Error.prototype`. A new `NativeProtoBuiltinGlue.dataProps` carries the §20.5.3
  `name`/`message` string data properties: seeded into the brand companion with
  §17 attributes, answered as a constant by the static value read (which used to
  trap with "illegal cast in `__module_init`").
- **Cluster G — Date `@@toPrimitive` + `new Date(value)` (19).** New
  `date-proto-to-primitive.ts` implements §21.4.4.45 (hint validation, and the
  Date-specific rule that `"default"` uses the STRING order); `@@3` joins
  `DATE_PROTO_METHODS`, and the read-only initial descriptor is now keyed on the
  member rather than on the Symbol brand. `builtin-value-read.ts`'s
  `<B>.prototype[Symbol.<wk>]` element-access resolver was generalised from
  Map/Set `@@iterator` to any `@@<id>` CSV member. New `date-ctor-value-arg.ts`
  implements §21.4.2.2 step 4: [[DateValue]] read with no method call for a Date
  argument, otherwise ToPrimitive(value, "default") → String parses as
  `Date.parse`, anything else ToNumber.
- **Cluster I — accessor-defined `@@toPrimitive` (2).** `ensureObjectRuntime`'s
  #5102 probe now invokes an ACCESSOR entry's getter (abrupt completions
  propagate) instead of only reading a data entry.
- **Cluster B (partial) — `new Symbol()` (1).** `Symbol` joined
  `GLOBAL_NON_CONSTRUCTOR_FUNCTIONS` (§20.4.1).

### Not attempted / deferred

- **Cluster J (30) + the 6 doubly-blocked `proto-from-ctor-realm.js`** — the
  `$262.createRealm` stub, out of scope by the plan's step 9. In this container
  they surface as `JS2WASM_EVAL_ENGINE=quickjs … provider is not built`.
- **Cluster B (rest, ~21)** — the `Symbol` namespace OBJECT is still not
  reified, so every `verifyProperty(Symbol, …)` row stays red.
- **Clusters C, E, F, H, K** — untouched this wave.

### New findings worth their own issues

1. `Object.prototype.hasOwnProperty(<any builtin prototype>, "name")` answers
   **true unconditionally** and survives a `delete`, while `gOPD` correctly
   reports the property gone and `"name" in <proto>` is false. Reproduced on
   `Date.prototype`, `Object.prototype` and `RegExp.prototype`, so it predates
   this change-set. It is the sole reason the 6
   `NativeErrors/*/prototype/name.js` rows still fail (`verifyProperty`'s
   `isConfigurable` is `delete o[k]; return !hasOwnProperty(o, k)`), even though
   the value, the descriptor and the delete are all now correct.
2. A symbol-keyed WRITE to an object literal that compiled to a CLOSED struct is
   silently dropped: after `var b = { valueOf(){…} }; b[Symbol.toPrimitive] = f`,
   `gOPD(b, Symbol.toPrimitive)` is `undefined` and ToPrimitive still calls
   `valueOf`. This is why `isNaN/isFinite/toprimitive-valid-result.js` remain
   red; the same assignment on an EMPTY literal (an open `$Object`) works.

## References

- #3371 (done) — standalone Reflect.construct NewTarget; cluster H extends its carrier matrix.
- #1523 (done) — $262 host-object stub; cluster J's blocker lives there.
- #4776 (in-progress) — Symbol.prototype.valueOf borrowed calls; coordinate cluster C.
- #5102 (done) — isNaN @@toPrimitive abrupt (own DATA prop only); cluster I extends the same `ensureObjectRuntime` helper to accessor-defined @@toPrimitive.
- #5107 (done) — Symbol.prototype[@@toPrimitive] descriptor; #5118 (done) — Error ToString(Symbol) TypeError.
- #2861 — NativeError native-proto glue (brands cluster D relies on); #2984 — builtin static gOPD (cluster B's table home); #4248 — native-proto own-props hybrid ladder (cluster D's own-ness pattern); #2885 — descriptor synthesis identity; #4492 — Function.prototype.toString NativeFunction body (cluster F's base); #2163 — Symbol.for/keyFor registry; #1467 — symbol description accessor; #2175 — standalone builtin-prototype readers.
- #5139 (class wave) — `derived-return-val.js`; #5140 (proxy wave) — `base-ctor-revoked-proxy.js` / Proxy.revocable; listed there, excluded from this issue's bar.
