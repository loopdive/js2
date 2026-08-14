---
id: 4394
title: "Test262 harness self-tests: drive the 116-test cohort to 100% (GC lane)"
status: in-progress
sprint: current
priority: high
horizon: xl
goal: test-infrastructure
created: 2026-08-13
related: [4251, 4304, 4262]
loc-budget-allow:
  # ALL grants below are for the parallel-bucket integration change-set
  # (async / tostring-dispatch / string-callable / verifyproperty), each
  # measured by its bucket agent with a targeted standalone A/B (0 flips) and
  # an unchanged GC lane.
  # +10 lines: the global-object-receiver gate for the standalone
  # defineProperty arm lives beside the host-lane #4394 gate it mirrors; the
  # barrel carries only the wiring to the new vec-length-set leaf module.
  - src/codegen/index.ts
  # +6 lines: the standalone global-object receiver exclusion, next to the
  # identical host-lane exclusion (#4432 root cause 9) it extends.
  - src/codegen/object-ops.ts
  # +10 lines: the standalone bound-function arm's #3571-uncurried-dispatch
  # ordering guard — the #4395 provider widening must not run ahead of it
  # (test262error-identity bucket; regression attributed to dbccc693).
  - src/codegen/fnctor-escape-gate.ts
  # +2 lines: routing the caught-error property fallback through its new leaf
  # module; the dispatch ladder carries only the call.
  - src/codegen/property-access-dispatch.ts
  # +186 lines: the two silent-drop repairs behind every "async completion
  # marker not observed" stall — a .then handler without compile-time
  # ClosureInfo was treated as ABSENT, and the standalone .then rejection path
  # never resumed the driver. Both live in the scheduler's handler-registration
  # ladder, whose arm order is load-bearing; the new dynamic-handler arm and its
  # rejection-resumption twin sit beside the arms they extend.
  - src/codegen/async-scheduler.ts
  # +54 net: the numeric-first array-literal widening now also fires for
  # UNANNOTATED literals (the standalone twin of the merged host-lane fix that
  # sits beside it), plus the literal-side closure-shape registration the exact
  # call_ref signature match consumes.
  - src/codegen/literals.ts
  # +43 lines: `typeof` on an identifier whose standalone binding is a null
  # carrier must answer from the binding's declared kind, not deref — one arm
  # in the existing typeof ladder plus its comment.
  - src/codegen/typeof-delete.ts
  # +37 net across two buckets: async's thenable-miss routing arm, minus the
  # closure-pick simplification the exact-signature match made possible (the
  # tostring bucket SHRANK this file by 11).
  - src/codegen/expressions/calls.ts
  # +32 lines: closure-shape registration at closure-creation sites so the
  # dynamic dispatch can pick the exact call_ref type instead of kind-only.
  - src/codegen/expressions/calls-closures.ts
  # +14 lines: the ClosureInfo signature-registry fields on the codegen
  # context, beside the closure maps they index.
  - src/codegen/context/types.ts
  # +10 net: the [[Call]] front-guard arm in __apply_closure that makes a
  # builtin-ctor carrier callable everywhere at once (identity-compared by
  # ref.eq, dead unless the carrier global exists).
  - src/codegen/object-runtime.ts
  # +9 lines: route a .then on a receiver with no ClosureInfo through the
  # thenable-miss helper instead of silently dropping the handler.
  - src/codegen/expressions/call-receiver-method.ts
  # +4 lines: the identifier-call arm consults the exact-signature match
  # before the kind-only fallback.
  - src/codegen/expressions/call-identifier.ts
  # ALL typedarray-intrinsics bucket grants below: agent-measured, 200-file
  # TypedArray A/B zero pass->fail, GC lane byte-identical.
  # +44 net: the funcIdx stale-capture fix lives inside tryEmitInlineDynamicCall
  # in this frozen file — re-flush + re-capture after callee/arg compiles; the
  # #329/#1677/#1839/#1886/#2043 index-desync family.
  - src/codegen/expressions/calls.ts
  # +56: nullish-receiver TypeError guards in the closed-method dispatchers.
  - src/codegen/closed-method-dispatch.ts
  # +17: undeclared-callee ReferenceError arm (S13.3.6.1 ordering).
  - src/codegen/expressions/call-identifier.ts
  # +9: union-receiver skip of the covered-form NamedEvaluation .name fold.
  - src/codegen/array-object-proto.ts
  # +13 (net +6): Symbol.toStringTag routing to the $__ta_dyn_view MOP arm.
  - src/codegen/property-access-dispatch.ts
  # +47: the Symbol-key arm answering [[TypedArrayName]] (S23.2.3.34) — this
  # module is the designated owner of $__ta_dyn_view MOP arms.
  - src/codegen/ta-dyn-mop.ts
  # +71 lines: the #4394 renderer arms for declined harness error fnctors —
  # they live in emitExceptionRenderExports beside the index-shift-safety
  # contract they must obey, and mirror the __error_to_string concat idiom
  # defined in this same file.
  - src/codegen/native-strings.ts
coercion-sites-allow:
  # +3 sites (__extern_toString, __unbox_number, __is_truthy), all inside the
  # new [[Call]] arm for the builtin `String` carrier. Calling `String(x)` IS
  # ToString (§22.1.1.1), so the coercion vocabulary is the arm's substance,
  # not a fresh hand-rolled matrix beside the engine. Routing this arm through
  # the #1917/#2108 coercion engine is the recorded follow-up for when the
  # Number/Boolean carriers join the same mechanism.
  - src/codegen/builtin-ctor-callable.ts
  # +1 site (__unbox_number) in the array-length WRITE arm: setting `.length`
  # performs ToNumber/ToUint32 on the incoming value (§10.4.2.4 ArraySetLength)
  # — the coercion is the arm's substance (verifyproperty bucket). Same
  # follow-up as above: route through the #1917/#2108 engine.
  - src/codegen/vec-length-set.ts
func-budget-allow:
  # +9 lines: the wiring that registers the vec-length-set leaf module and the
  # standalone global-object defineProperty gate — both single guarded calls
  # whose bodies live in their own modules (verifyproperty bucket).
  - src/codegen/index.ts::generateModule
  # +6 lines: the standalone global-object receiver exclusion beside the
  # host-lane #4432 root-cause-9 exclusion it extends (verifyproperty bucket).
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  # +3 lines: the symbol-keyed entry skip in the for-in vec arm — enumeration
  # must not surface a Symbol key as its numeric slot index (verifyproperty).
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
  # ALL typedarray-intrinsics bucket function grants: agent-measured A/B clean.
  # +47: the Symbol-key [[TypedArrayName]] arm in the designated $__ta_dyn_view
  # MOP owner; the arm switches on the view's kind field, inherently inline.
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
  # +43: the stale-capture fix — re-flush + re-capture of every baked funcIdx
  # after callee/arg compilation, inside the function that owns the bake sites.
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  # +9: union-receiver dynamic .name read beside the static fold it bypasses.
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
  # +2: the nullish-receiver guard splice points; guard bodies live in helpers.
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  # +16 lines: the standalone Test262Error prototype-method binding arm beside
  # the host-lane #4394 arm it mirrors (test262error-identity bucket); the
  # bodies live in shadowed-error-ctor.ts / caught-error-prop-fallback.ts.
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  # +10 lines: one more condition in the widening scan (unannotated
  # numeric-first literals), inside the scan whose order is load-bearing.
  - src/codegen/literals.ts::compileArrayLiteral
  # +9 lines: the thenable-miss routing arm, beside the .then arms it guards.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  # +9 lines: the builtin-ctor [[Call]] front-guard arm in the closure
  # application driver — the single funnel every dynamic invocation lane uses.
  - src/codegen/object-runtime.ts::fillApplyClosure
  # +4 lines: consult the exact closure-signature match before kind-only pick.
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
files:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/compiler/import-manifest.ts
  - src/runtime.ts
  - src/codegen/declarations.ts
  - src/codegen/literals.ts
  - tests/issue-4394-test262-error-ctor-identity.test.ts
  - tests/issue-4394-nested-fn-static-write.test.ts
  - tests/issue-4394-optional-field-literal-arg.test.ts
  - tests/issue-4394-mixed-array-literal-host.test.ts
  - tests/issue-4394-host-dynamic-valueof.test.ts
  - tests/test262-runner.ts
  - src/codegen/extern-declarations.ts
  - tests/issue-4394-ambient-error-ctor-value-read.test.ts
  - src/codegen/closures.ts
  - src/runtime/native-function-source.ts
  - tests/issue-4394-callback-bridge-constructible.test.ts
  - src/codegen/global-environment.ts
  - src/codegen/object-ops.ts
  - tests/issue-4394-global-object-define-property.test.ts
  - tests/issue-4394-test262-error-instanceof.test.ts
  - src/codegen/expressions/shadowed-error-ctor.ts
  - tests/issue-4394-shadowed-error-ctor.test.ts
  - src/codegen/global-function-bindings.ts
  - tests/issue-4394-global-function-bindings.test.ts
  - src/codegen/hof-native.ts
  - tests/issue-4394-array-proto-hof-as-value.test.ts
  - src/codegen/expressions/call-namespace-static.ts
  - tests/issue-4394-reflect-construct-newtarget.test.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/then-thenable-miss.ts
  - src/codegen/native-batched-concat.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/expressions/closure-sig-match.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/builtin-ctor-callable.ts
  - src/codegen/object-runtime.ts
  - src/codegen/closures/capture-source-slot.ts
  - src/codegen/closures/funcref-as-closure.ts
  - src/codegen/context/types.ts
---

# #4394 — make the Test262 harness self-tests pass (GC lane)

## Problem

`test262/test/harness/*.js` are the harness's **own** self-tests: each one
exercises a harness helper (`assert.throws`, `verifyProperty`, `compareArray`,
`asyncTest`, `deepEqual`, …) and fails if the helper misbehaves. #4304 admitted
the cohort into the canonical census; it measured **54 pass / 116** in the GC
lane at compiler `b363f29d3c43` / Test262 `b363f29d3c43`.

A broken harness helper is worse than a broken feature: it silently changes what
every conformance test that includes it actually measures.

## Baseline (GC lane, this container, 2026-08-13)

```
54 pass / 62 fail / 116 total
```

Reproduce with `runTest262File(<abs>, "harness")` over `findTestFiles("harness")`.

## Root cause 1 (dominant, ~27 tests) — `Test262Error` constructor identity

`src/codegen/expressions/new-builtin-globals.ts` intercepts `new
Test262Error(msg)` **by name, with no shadow guard**, and in the JS-host lane
lowers it to the `env::__new_Test262Error` host import, which builds a real
`Error` subclass declared in `src/runtime.ts`.

The literal upstream harness always **declares** `Test262Error` itself (sta.js:
`function Test262Error(message) { … }`), so the module's `Test262Error`
identifier reads a compiled WasmGC closure struct while the thrown object's
`.constructor` is the *host* class. The two can never be `===`:

| expression | before | correct |
| --- | --- | --- |
| `typeof Test262Error` | `"function"` | `"function"` |
| `e.constructor.name` | `"Test262Error"` | `"Test262Error"` |
| `e.message` | `"boom"` | `"boom"` |
| `e.constructor === Test262Error` | **`false`** | `true` |

Compiled `===` on two externrefs internalises both operands and uses `ref.eq`
when the right operand is statically a GC struct, so it does not even reach the
`__host_eq` shim (`_hostStrictEqual`) that was written for this case — it
short-circuits to `0`.

Every self-test in the `assert.throws` / `assert.sameValue` / `propertyhelper-*`
/ `verifyProperty-*` families reduces to this, reporting the tell-tale
`Expected a Test262Error, but a "Test262Error" was thrown.` (the message renders
`err.constructor.name`, which is right — only the *identity* is wrong).

### Fix

Keep the host `Error` (the exception bridge, `String(err)` and the failure
renderer all depend on a real `Error` subclass) and pass the module's own
constructor value alongside the message:

- new host import `__new_Test262Error_ctor(message, ctor) -> externref`,
  classified as a `builtin` intent in `src/compiler/import-manifest.ts` (it must
  precede the generic `__new_*` `extern_class` arm, which would otherwise read
  it as a class named `Test262Error_ctor`);
- the runtime handler stamps `ctor` as a non-enumerable own `constructor`
  property on the constructed error;
- codegen emits it only when the module has a top-level **function** declaration
  named `Test262Error` (`ctx.topLevelFunctionNames`, excluding `ctx.classSet` —
  class carriers take a different identifier path, the same carve-out
  `error-ctor-carrier.ts` documents), compiling the SAME identifier node the
  comparison site compiles so both reads resolve to one carrier global.

The host-side `class Test262Error extends Error` was also being minted **fresh
per resolver call**; hoisted to a single module-level `_HostTest262Error` so
constructor identity does not depend on which import a module bound.

### Measured

| | pass | fail |
| --- | ---: | ---: |
| before | 54 | 62 |
| after | **80** | 36 |

Regression check — zero status changes on both samples:

- `built-ins/Object/defineProperty`, first 400 files: 325 pass / 75 fail, **0 diffs**
- 205-file stratified sample of the 1,841 suite tests that call
  `assert.throws(Test262Error, …)`: 146 pass / 58 fail / 1 skip, **0 diffs**

## Root cause 2 (7 tests) — the second-level function-static write is dropped

`collectDeclarations` drops a top-level assignment whose root identifier is not
a module global. #2671 added a keep for `F.<prop> = …` with a **bare identifier**
receiver, and #3666 added the nested-receiver keep — but **for standalone only**.

So in the host/GC lane

```js
assert.deepEqual._compare = (function () { … })();   // deepEqual.js:142
```

compiled to **nothing**. `_compare` silently never existed; `typeof` still
answered `"function"` from a static inference, and the actual read returned
null, so the whole family failed with `TypeError: _compare is not a function`.

### Fix

Give the host/GC arm the same nested-receiver keep, gated identically to the
standalone one (`isTopLevelFunctionPropertyReceiver` — the root must be a
top-level function and the oracle must prove the receiver itself callable, which
excludes `F.prototype.m` and ordinary object-valued chains).

### Measured

80 → **84** pass. All 76 suite tests that include `deepEqual.js`: 4 fail → pass,
0 regressions; `built-ins/Object/defineProperty` first 400: 0 diffs.

## Root cause 3 (4 tests) — a partial object-literal argument arrives as `null`

Under `allowJs` (which the original-harness lane uses) the checker honours
JSDoc, so `propertyHelper.js`'s

```js
/** @param {object} [options]
 *  @param {boolean} [options.label]
 *  @param {boolean} [options.restore] */
function verifyProperty(obj, name, desc, options) { … }
verifyProperty(obj, prop, desc, { restore: true });
```

types the parameter as `{ label?: boolean; restore?: boolean }`. The argument
lowered to `struct.new <{restore}>` followed by the call-boundary **guarded**
downcast to `<{label,restore}>` — and a guarded cast that misses yields
`ref.null`. So `options` arrived as **null**, `options && options.restore` was
false, and `{ restore: true }` silently restored nothing.

### Fix

Build the literal directly as the EXPECTED struct, defaulting the fields it
omits — what `compileObjectLiteralForStruct` already does for an unmentioned
field. Scoped so it can only replace a cast that was going to fail: every
literal property must be a field of the expected struct, the literal's own
struct resolution must differ from the expected typeIdx, and spreads /
accessors / methods / computed keys decline.

### Measured

84 → **88** pass (the four `verifyProperty-restore*` files).
Regression samples: `built-ins/Object/defineProperty` first 400 → 325→**326**
(+1, 0 lost); `built-ins/Reflect` (153) and `built-ins/JSON` (165) → **0** status
changes; the object/property/descriptor slice of `tests/equivalence` (8 files,
51 cases) passes.

## Root cause 4 (2 tests) — a numeric-first array literal drops its string elements

`compileArrayLiteral` picks the vec element type from the FIRST significant
element, then widens to `externref` when a later element is an object. That
widening scan deliberately carves out `StringLiteral` elements so the
native-strings lanes keep the numeric fast path — they have their own
`hasNativeStringElem` scan. **The JS-host/GC lane has no such scan**, and a
string is plain `externref` there, so the carve-out made the literal and
non-literal spellings of the same array disagree:

```js
var s = "a"; [0, s]   // widened → "a" survives
[0, "a"]              // NOT widened → f64 vec → reads back NaN
```

`compareArray.js` therefore saw `[0, 'a', undefined]` as `[0, NaN, NaN]` and
answered `true` for two arrays differing only in their string elements.

### Fix

Apply the `StringLiteral` carve-out only under `ctx.nativeStrings`, so the host
lane treats a string-literal element exactly like the identical non-literal one.

### Measured

88 → **90** pass (`compare-array-arguments`, `compare-array-different-elements`).
`built-ins/Array` first 400: 120 → **121** pass, 0 lost;
`language/expressions/array` (52): 0 status changes; the array/vec/tuple/
destructuring slice of `tests/equivalence` (25 files, 186 cases) is unchanged.

## Root cause 5 (2 tests) — dynamic-receiver `valueOf` in the host lane

`compileReceiverMethodCall` ends with a blanket "`valueOf()` returns the
receiver". That is `Object.prototype.valueOf`, correct only when nothing
earlier in the prototype chain overrides it — and a receiver typed `any` (every
receiver in compiled JavaScript) reaches none of the static arms that resolve
the overriding cases. #4201 fixed this for `--target standalone` with a native
`__dyn_valueOf` helper; **the host/GC lane still takes the shortcut**:

```js
Object("a").valueOf()                              // → the wrapper, must be "a"
({ valueOf: function () { return 7; } }).valueOf()  // → the object, must be 7
```

It reads as a value bug rather than a type bug because the wrapper stringifies
as its primitive: `deepEqual.js`'s `comparePrimitiveEquality` unboxes with
`a = a.valueOf()` and then compares `typeof`, so the whole boxed-primitive
family reported unequal (`deepEqual-primitives`, `deepEqual-primitives-bigint`).

**A blanket "fall through to the dynamic host method call" is NOT the fix** — it
was measured and reverted before the real one landed. Routing the call through
`__extern_method_call` breaks ordinary-object identity —

```js
function unbox(v) { return v.valueOf(); }
var o = { a: 1 };
unbox(o) === o        // becomes FALSE; §20.1.3.7 requires the receiver back
```

and the breakage is shape-sensitive (it holds when the result is stored in a
local first, fails when compared inline), so category sampling does not surface
it: `built-ins/Number` (340), `built-ins/Boolean` (51), `built-ins/Date` (400)
and `built-ins/Object/defineProperty` (400) all showed **0** status changes with
the blanket change in place, while the identity contract was broken.

### Fix

Originally landed as `src/codegen/host-dyn-valueof.ts`, mirroring #4201's
structure: decide in-module and return the ORIGINAL externref for the identity
case, never a host round-trip.

**Superseded on main.** `3f614151` (Moment dogfood) extracted the whole fallback
into `expressions/valueof-fallback.ts`, where a dynamic receiver in the host lane
falls through to the generic dynamic method call. Verified at merge time that
that route ALSO preserves `o.valueOf() === o` — all five cases of
`tests/issue-4394-host-dynamic-valueof.test.ts` pass against it, inline
comparison included — so `host-dyn-valueof.ts` and its two builtins were removed
rather than kept as a second implementation of the same decision. The test stays:
it is what proves the surviving route holds the contract.

### Measured

90 → **92** pass (`deepEqual-primitives`, `deepEqual-primitives-bigint`).
Regression samples, all **0** status changes: `built-ins/Number` (340),
`built-ins/Boolean` (51), `built-ins/Date` (400),
`built-ins/Object/defineProperty` (400); plus the wrapper / coercion /
to-primitive slice of `tests/equivalence` (24 files, 195 cases).

The identity contract is now pinned by
`tests/issue-4394-host-dynamic-valueof.test.ts`, including the inline-comparison
spelling that the reverted attempt broke.

### Residual, separate from this

`if (isBoxed(a)) a = a.valueOf();` — the condition spelled as an INLINE call —
still reads back the wrapper, while hoisting it (`var boxed = isBoxed(a); if
(boxed) …`) works. The parameter's local carrier is typed from its call sites as
the String WRAPPER, so storing the unboxed primitive back into it coerces to the
wrapper again. That is a parameter-carrier bug, not a `valueOf` one; the harness
does not hit it (its `comparePrimitiveEquality` passes).

## Root cause 6 (3 tests) — a `symbol`-typed parameter carries a raw i32 handle

`propertyHelper.js`'s deprecated `verifyEnumerable(obj, name)` / `verifyNotEnumerable`
carry no JSDoc, so `name` is inferred from the call sites. In the symbol tests
that is exactly `symbol`, and `mapTsTypeToWasm` lowers a bare `symbol` to an
UNBRANDED `{kind:"i32"}` (the unique counter id). The parameter slot then holds
the raw handle, and every dynamic use reads it as a number:

```js
function k(o, name) { return typeof name + " " + String(name); }
k({}, Symbol("1"))   // → "boolean 101"   (want "symbol Symbol(1)")
```

which is where `Expected obj[101] to have enumerable:true.` comes from. In the
narrower shape `function k(o, name) { var t = typeof name === "string"; … }` the
mismatch is not even representable and the module fails to VALIDATE:
`call[0] expected type externref, found local.get of type i32`. Adding a second
call site with a string argument widens the parameter to `string | symbol`,
which forces externref and makes both symptoms disappear — a precise
demonstration that the carrier, not the operation, is at fault.

**Not fixed here, deliberately.** `type-mapper.ts` documents why the obvious
repair (branding the ValType `{kind:"i32", symbol:true}`) is deferred: it would
route ALL symbol→externref coercions through `__box_symbol` while other boxing
sites still use `__box_number`, and that mismatch already regressed the host
`Object/values/symbols-omitted` canary (#2792/#2785). The real repair is the
#2610 symbol-as-any value-rep pass. This issue contributes the reproducer and
the validation failure as evidence for it.

## Root cause 7 (1 test) — the runner exposed `$DONE` unconditionally

`_buildFreshSandbox` set `sandbox.$DONE = () => {}` for EVERY test (#3428), so
`asyncHelpers.js`'s guard
`Object.prototype.hasOwnProperty.call(globalThis, "$DONE")` could never observe
its own absence — and `asyncHelpers-asyncTest-without-async-flag.js` asserts
exactly that absence before checking that `asyncTest` refuses to run.

Withholding it unconditionally is equally wrong: a JS engine exposes `$DONE`
because a SCRIPT's top-level declarations become global own-properties, and
`asyncHelpers-asyncTest-return-not-thenable.js` declares its own
`function $DONE(error)` with no `async` flag. (Measured: gating on the flag
alone traded one pass for one fail.)

### Fix

Expose the own-property exactly when the script declares one — the `async` flag
(which is what pulls `doneprintHandle.js` into the prefix) **or** a top-level
`$DONE` declaration in the test body. Defaults to the old behaviour for the
legacy `wrapTest` lane and the shared `getTestSandbox()`.

### Measured

92 → **93** pass, 0 lost. A 400-file sample of `flags: [async]` tests across the
suite: **0** status changes.

## Root cause 8 (1 test) — bare `EvalError` / `URIError` read as `null`

`assert.throws` compares `thrown.constructor !== expectedErrorConstructor` and,
on mismatch, reads `expectedErrorConstructor.name`. For
`assert.throws(EvalError, …)` that second step threw
`Cannot access property on null or undefined` — because the **bare identifier**
`EvalError` lowered to `ref.null.extern`.

`new EvalError()` was never affected: it routes through the `__new_EvalError`
host import and yields a genuine host `EvalError`. Only the value read was null,
which is what makes this quiet — the comparison does not throw, it just answers
`false`, so every identity check against these constructors silently inverted.

Two registries in `src/codegen/extern-declarations.ts` have to agree, and did
not. `LIB_GLOBALS` gates whether `collectDeclaredGlobals` runs **at all**;
`AMBIENT_BUILTIN_CTORS` is the loop inside it that registers
`env.global_<Name>`. `Error`, `TypeError`, `RangeError`, `SyntaxError` and
`ReferenceError` were in both. Their siblings `EvalError`, `URIError` and
`AggregateError` were in neither — as were `BigInt`, `Proxy`,
`SharedArrayBuffer` and `Atomics`. Measured before the fix, one name per module:

| bare identifier | `X === globalThis.X` |
| --- | --- |
| `Error` / `TypeError` / `RangeError` / `ReferenceError` / `SyntaxError` | `true` |
| `EvalError` / `URIError` / `AggregateError` | **`false`** |
| `BigInt` / `Proxy` / `SharedArrayBuffer` / `Atomics` | **`false`** |
| `WeakRef` / `FinalizationRegistry` | `true` (reached via `isExternalDeclaredClass`) |

### Fix

Add the seven missing names to both lists. Standalone/WASI are untouched — the
registration loop already returns early on `ctx.strictNoHostImports ||
ctx.standalone`, so the host-free lanes keep their native carrier.

### Measured

93 → **94** pass (`assert-throws-native.js`), 0 lost.

## Root cause 9 (0 harness tests, +29 in a 400-file sample) — the callback bridge is an arrow

`__make_callback`'s host bridge
(`createNativeFunctionCallbackBridge`) is an **arrow**, and an arrow has no
[[Construct]]. So every compiled callable handed to a host API was rejected by
`Reflect.construct` / `new`, whatever it was written as.

The harness's `isConstructor` is
`Reflect.construct(function () {}, [], f)` — its **target** is an inline
function expression, so the probe threw before it ever looked at `f`, the
`catch` swallowed it, and the helper answered `false` for **everything**. That
is not one wrong answer, it is a silently inverted predicate in all **644**
test262 files that include `isConstructor.js`.

### Fix

An ordinary function definition has [[Construct]] (§15.2.4); an arrow,
generator, async function or method does not. The compiler now picks a sibling
import `__make_callback_ctor` for the first case, and its runtime bridge is a
plain `function` instead of an arrow. Everything else keeps the arrow bridge, so
the repair cannot widen into "every compiled callable is a constructor" — the
regression test pins `Reflect.construct(() => {}, [])` still refusing.

Neither bridge shape reads `this`: the compiled body reaches its receiver
through the `__current_this` protocol, so constructibility is the only
observable difference.

### Measured

- 400-file sample of `isConstructor.js` consumers: **+29 pass, 0 regressions**
- equivalence-gate, all 8 shards: no new regressions
- harness cohort unchanged at 94 — `isConstructor.js` itself still fails, on the
  separate defect below

### Still failing — a compiled closure as a `Reflect.construct` ARGUMENT

`isConstructor.js` additionally asserts `isConstructor(function () {}) === true`
and `isConstructor(() => {}) === false`. There the callable is an *argument* to
a compiled function, so it stays a raw WasmGC closure struct and reaches
`__reflect_construct` unbridged — the host reports
`[object Object] is not a constructor` for both. Bridging it with
`_maybeWrapCallableUnknownArity` would make BOTH answer `true`, since the
dynamic bridge is constructible for any closure; getting it right needs the
closure's kind at runtime, which today has no discriminator export (the
`closure-exports.ts` bit registry would need a new entry). Recorded rather than
half-fixed.

## Root cause 10 (2 tests) — `defineProperty(globalThis, …)` took the struct path

`Object.defineProperty(this, 'Object', {configurable: true, value: Object})` —
the whole of `harness/verifyProperty-configurable-object.js` — threw
`TypeError: Object method called on null or undefined`, naming a receiver that
was never null.

The global object is a HOST value in the JS-host lane and has no compiled WasmGC
struct. But the harness prefix opens with

```js
var $262 = { global: globalThis, … };
```

which sits in front of **every** test, and that single VALUE use makes the
checker mint a struct type for `typeof globalThis` (the emitted module even
carries `$__sget_globalThis` / `$__sget_eval` field accessors for it).
`compileObjectDefineProperty` then resolved a struct name for the receiver and
took the struct arm, whose guarded cast can never match a host externref:

```wat
call $__get_globalThis      ;; a host object
any.convert_extern
ref.test (ref 16)           ;; not that struct
(if … (else ref.null 16))   ;; → NULL
local.tee $__defprop_obj_3
ref.is_null → throw         ;; "called on null or undefined"
```

The trigger is the earlier value use, not the define — the define alone always
worked, which is why this only ever showed up under the assembled harness.

### Fix

`isGlobalObjectExpr` (in `global-environment.ts`, beside the existing
global-object receiver gate) recognises `globalThis` and a script's top-level
`this`; `compileObjectDefineProperty` skips struct-name resolution for such a
receiver and falls through to the extern arm it should always have used.

`this` counts only in a SCRIPT's top-level code — inside a function, or in a
module, it is not the global object.

### Measured

94 → **96** pass (`verifyProperty-configurable-object.js`,
`propertyhelper-verifyconfigurable-configurable-object.js`), 0 lost.
equivalence-gate, all 8 shards: no new regressions.

## Root cause 11 (1 test) — `instanceof` against a module-declared `Test262Error`

Root cause 1 fixed `err.constructor === Test262Error`, but `instanceof` walks
the PROTOTYPE CHAIN, not `.constructor` — and the constructed value is
deliberately a real host `Error` subclass (that is what makes `String(err)`,
`.stack` and the exception bridge work), so its chain can never reach the
module's compiled closure.

`__instanceof`'s three existing resolutions all miss it: the subclass registry
does not know the host class, the sandbox `globalThis` has no `Test262Error`,
and `_userClassTags` only covers compiled class instances. `assert(error
instanceof Test262Error)` therefore answered `false` for an error that plainly
is one.

### Fix

`__new_Test262Error_ctor` already receives the module's own carrier (that is how
the `.constructor` stamp works). It now also records the carrier in a WeakSet,
and `_instanceofResult` answers `true` when the value is a host
`_HostTest262Error` **and** the RHS is a carrier that has actually minted one.
Both halves are required, which is what keeps it narrow — an unrelated compiled
constructor is not in the set, and a non-`_HostTest262Error` value is still
decided by the ordinary prototype walk.

### Measured

96 → **97** pass (`asyncHelpers-asyncTest-func-throws-sync.js`), 0 lost.
equivalence-gate, all 8 shards: no new regressions.

`asyncHelpers-asyncTest-rejects-non-callable.js` has the same assertion and did
NOT flip — there the error crosses into a module-declared `$DONE` through
`asyncTest`'s callback edge, and arrives already degraded. That is the same
value-degradation-across-a-callback-boundary defect recorded under the
`detachArrayBuffer` heading below, not a gap in this repair.

## Root cause 12 (1 test) — `new TypeError()` ignored a user shadow

`tryCompileBuiltinGlobalNew` claims the NativeError names **by name, with no
scope check**, so

```js
(function () {
  function TypeError() {}
  assert.throws(TypeError, function () { throw new TypeError(); });
})();
```

built the INTRINSIC while the `TypeError` identifier read the local one.
Measured: `e.constructor === TypeError` **false**,
`e.constructor === intrinsicTypeError` **true** — precisely the collision
`harness/assert-throws-custom-typeerror.js` exists to detect.

### Fix

`expressions/shadowed-error-ctor.ts` walks the enclosing scope chain from the
`new` site looking for a user binding of the name; the intrinsic-name arm
declines when one is found and the ordinary user-constructor path compiles it.
Purely syntactic — the oracle cannot express "which binding wins here" as a
`ValType` question, and a raw `getSymbolAtLocation` would trip the ratchet.

`Test262Error` is deliberately EXCLUDED: the harness always declares it, and the
ctor-carrying lowering (root cause 1) exists to reconcile that rather than
decline it.

### Measured

97 → **98** pass (`assert-throws-custom-typeerror.js`), 0 lost.
equivalence-gate, all 8 shards: no new regressions. 194-file sample over
`built-ins/{Error,NativeErrors}` and `language/statements/try`: 0 regressions.

### Known limitation, pinned by test

A **top-level** `function RangeError() {…}` is claimed by a different `new`
path before the guarded arm is consulted, so the user's body still never runs.
`errorCtorNameIsUserShadowed` reports it correctly; the interception order is
what is wrong. `tests/issue-4394-shadowed-error-ctor.test.ts` asserts the
current (wrong) answer explicitly, so a later repair has a failing-to-passing
signal instead of a silent behaviour change. Every harness case that matters
shadows inside an IIFE, which is fixed.

## Standalone lane (measured 2026-08-13)

The cohort headline is the GC lane. Standalone on the same tree is **66 / 116**
— but only once the QuickJS runtime-eval provider is actually built. A container
that lacks it reports 41/116, because 25 tests fail on
`JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` rather than
on anything the compiler did. Build it with

```
npx tsx scripts/build-quickjs-eval-provider.mjs
```

— note `npx tsx`, not bare `node`: the plain-node run builds `libquickjs.wasm`
and then fails to build the ADAPTER ("no usable compiler … or run under tsx"),
leaving a half-populated cache that still reports "not built".

Real standalone buckets at 66/116:

| bucket | count |
| --- | ---: |
| `asyncTest called without async flag` | 15 |
| null deref in `toString` | 6 |
| `$DONE is not defined` | 4 |
| `Function.prototype.toString` renders `[object Object]` | 3 |
| `Expected true but got false` | 3 |
| `Object method called on null or undefined` | 2 |
| deepEqual array / sparse-array comparisons | 4 |
| TypedArray `illegal cast` | 2 |
| singletons | 11 |

### The 15-test bucket is the `$DONE` own-property gate, standalone side

`asyncHelpers.js` guards `asyncTest` with
`Object.prototype.hasOwnProperty.call(globalThis, "$DONE")`. A JS engine
satisfies it because a SCRIPT's top-level `function $DONE` (from
`doneprintHandle.js`) becomes an own property of the global object.

Measured on this tree, a top-level `function $DONE() {}`:

| lane | `hasOwnProperty(globalThis, "$DONE")` | `typeof globalThis.$DONE` |
| --- | --- | --- |
| host/GC | **false** | `"function"` |
| standalone | **false** | — |

So neither lane actually implements the binding; the GC lane only passes because
the runner *fakes* the own-property on its sandbox (root cause 7). Standalone has
no sandbox to fake it on — its `globalThis` is the native `$Object` built by
`emitNativeGlobalThisObject`.

The real repair is the same one for both lanes: seed the global object with the
script's top-level function bindings (`ctx.topLevelFunctionNames`), the way
`standaloneGlobalFunctionSeedInstrs` already seeds the ES5 global functions.
That would let the runner drop its sandbox stub as well. Not attempted here —
the seeds are captured in a lazily-initialised detached body, so materialising
user closure values into it is an ordering problem (#1712-class), not a one-line
addition. **This is the highest-value single item left in either lane.**

## Root cause 13 (standalone, 9 tests) — script functions never bound on the global object

§9.1.1.4.18 CreateGlobalFunctionBinding: a SCRIPT's top-level function
declarations are own properties of the global object. We never implemented it.
`globalThis.f` resolved — identifier lowering finds the function — but the
BINDING did not exist, so every reflective probe answered `false`:

| lane | `hasOwnProperty(globalThis, "$DONE")` | `typeof globalThis.$DONE` |
| --- | --- | --- |
| host/GC | false | `"function"` |
| standalone | false | — |

Neither lane implemented it. The GC lane only passes the affected tests because
the runner *fakes* the own-property on its sandbox (root cause 7).

### Fix

`codegen/global-function-bindings.ts` seeds each top-level function name onto
the native `$Object` at the TOP of `__module_init` — before any user statement,
which is what declaration hoisting requires — with
`{writable: true, enumerable: true, configurable: false}`.

Scripts only; a module's top-level declarations live in the module environment
record and are deliberately not global-object properties.

The seed uses the PER-SITE closure path (`emitFuncRefAsClosure`), not
`emitCachedFuncClosureAccess`. The latter's memoized singleton is planned from
the IR's census of function-VALUE uses, and a name that only ever appears as a
callee — `$DONE(err)`, exactly the case this exists for — has no planned
trampoline; minting one here fails the ABI seal with
`would mutate sealed prepared scope`.

**Known gap:** the seeded value is therefore a distinct closure instance, so
`globalThis.f` CALLS correctly but `globalThis.f === f` is false. Closing it
needs the planner to mint a value-trampoline for call-only names.

### Measured

standalone 66 → **75** pass, 0 lost. GC lane byte-identical (gated off).
equivalence-gate, all 8 shards: no new regressions. 220-file standalone sample
over `language/statements/function`, `language/global-code` and
`built-ins/Function`: 0 regressions, and it fixes
`language/global-code/decl-func.js` — the spec test for this exact binding.

## Root cause 14 (standalone, 5 tests) — `Array.prototype.map` as a VALUE

Nine standalone tests reported a constructor mismatch
(`assert.sameValue(error.constructor, Test262Error)` failing with
`«[object Object]»`) that had nothing to do with constructors. The real cause is
one line of the harness — the code that FORMATS a failure:

```js
compareArray.format = function (arrayLike) {
  return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]";
};
```

`emitArrayProtoMemberBody` implemented only `slice`; every other member degraded
to a catchable `Array.prototype.<m> is not yet callable as a value in --target
standalone`. So the moment a comparison failed, the TypeError from the FORMATTER
replaced the Test262Error the test was asserting about.

### Fix

Route the higher-order members to `__hof_<name>` — the native standalone loop
`ensureNativeArrayHof` already emits for the dynamic-receiver CALL form. It
reads its receiver through `__extern_length` / `__extern_get_idx`, so it serves
an arbitrary array-LIKE, which is exactly what `.call(arguments, …)` needs.

The reduce family stays on the refusal: `__hof_reduce` takes
`(recv, cb, init, hasInit)`, not `(recv, cb, thisArg)`.

**The receiver guard is load-bearing.** The old refusal threw for EVERY
receiver, so `Array.prototype.map.call(undefined)` passed its "must throw
TypeError" test *by accident*. Routing to the loop without a §23.1.3 step-1
ToObject check silently returns an empty result instead — measured as 3
regressions (`map/15.4.4.19-1-1`, `-1-2`, `filter/15.4.4.20-1-2`) before the
guard was added. It mirrors the `String.prototype.<member>` guard in the same
file, including the `__extern_is_undefined` arm: under the undefined-singleton
regime `undefined` is a NON-null sentinel externref, so `ref.is_null` alone
misses it.

### Measured

standalone 75 → **80** pass, 0 lost (the five `compare-array-*` tests).
GC lane unchanged. equivalence-gate, all 8 shards: no new regressions.
200-file standalone sample over `Array/prototype/{map,filter,forEach}`:
0 regressions, +1 (`map/call-with-boolean.js`).

### Still open in this bucket

The remaining four of the nine need `String` callable as a VALUE standalone —
`format`'s callback. `compareArray.format([1,2,"a"])` now returns
`[null, null, null]` instead of throwing: the loop runs, the callback is null.
`STANDALONE_ES5_GLOBAL_FUNCTION_NAMES` covers `parseInt`/`parseFloat`/… but not
the `String`/`Number`/`Boolean` conversion functions.

## Attempted and REVERTED — `String` as a value in standalone (standalone, 1 test)

The remaining `compare-array-*` failures need `compareArray.format`'s callback:

```js
Array.prototype.map.call(arrayLike, String)   // → [null, null, null]
```

Implemented as a value-only conversion closure (`__extern_toString`),
deliberately kept OUT of `STANDALONE_ES5_GLOBAL_FUNCTION_NAMES` so it would not
be seeded as `globalThis.String` and shadow the constructor's statics. It
worked: `compareArray.format([1,2,"a"])` → `[1, 2, a]`, `String.fromCharCode`
unaffected, standalone harness 80 → **81**.

**Reverted.** A 175-file standalone `built-ins/String` A/B found **3
regressions for 1 harness gain**:

```
REGRESS built-ins/String/S15.5.2.1_A1_T5.js   pass → fail
REGRESS built-ins/String/S15.5.2.1_A1_T6.js   pass → fail
REGRESS built-ins/String/S15.5.2.1_A1_T7.js   pass → fail
   #1.5: __str = new String(NaN); __str.constructor === String.
   Actual: __str.constructor === [object Object]
```

The premise was wrong. A bare `String` value read was ALREADY resolving
correctly — to the constructor object, which is what `x.constructor === String`
compares against. Substituting a conversion function hijacked that identity.

The real requirement is narrower and harder: the builtin constructor CARRIER
must itself be callable, so `String` keeps its identity while
`String(x)` / `map(…, String)` perform ToString. That is a change to the
builtin-namespace value representation, not an entry in a global-function
registry. Recorded here so the next attempt starts from the right shape — and
so the cheap-looking version is not re-attempted.

The harness cohort's other three `compare-array-*` failures are NOT blocked on
this and are separate defects: an `arguments` array-like reads its string and
undefined elements back as `NaN` (`[0, NaN, NaN]` vs `[0, a, undefined]` — the
standalone twin of root cause 4), and a Symbol element comparison (the #2610
symbol-carrier bucket).

## Diagnosed, not landed — a function-VALUED `toString` property is ignored (both lanes)

Found while bisecting the six standalone `deepEqual-*` failures. It is not a
harness-shaped bug at all: `o.toString()` silently returns `"[object Object]"`
when the receiver's own `toString` is a **function-valued property** rather than
method syntax. Measured on the GC lane (standalone matches):

| receiver | `o.toString()` |
| --- | --- |
| `class P { toString() { … } }` | `"P!"` ✓ |
| `{ toString() { … } }` (method shorthand) | `"OL"` ✓ |
| `{ toString: function () { … } }` | **`"[object Object]"`** ✗ |
| `{ toString }` (shorthand from a declaration) | **`"[object Object]"`** ✗ |
| `P.prototype.toString = function () { … }` | **`"[object Object]"`** ✗ |

So the dispatcher recognises a method DECLARATION but not a function-valued
property or a prototype assignment. The last row is the classic ES5 idiom, and
`sta.js` — in front of every single test262 file — uses exactly it:

```js
Test262Error.prototype.toString = function () {
  return "Test262Error: " + this.message;
};
```

Note the inversion that makes this easy to miss: `String(o)` and `"" + o` are
**correct** for the same receivers (ToPrimitive does consult the property). Only
the DIRECT `o.toString()` call is wrong, because the fallback arm in
`call-receiver-method.ts` claims `.toString()` by name and emits the constant
`"[object Object]"` for a struct-shaped receiver.

### Shape of the fix — the obvious one was ATTEMPTED and does NOT work

This section previously claimed that "a single added condition makes it DECLINE
into the generic dynamic method dispatch, **which resolves the real property**."
That premise is **wrong**, and it was measured wrong the way premises usually
are — by never running it. Implemented (`expressions/user-declared-tostring.ts`,
a declaration-provenance predicate: does the receiver's type carry a `toString`
whose declaration is in user source rather than an ambient `lib.*.d.ts`?), wired
as the extra condition on the arm, and measured:

| receiver | before | after declining |
| --- | --- | --- |
| `P.prototype.toString = function () { … }` | `[object Object]` | **`null`** |
| `{ toString: function () { … } }` | `[object Object]` | **`null`** |
| `{ toString: fn }` | `[object Object]` | **`null`** |
| `{ toString() { … } }` | `"MS"` ✓ | `"MS"` ✓ |

The generic dispatch does not resolve it either — it produces a null string ref,
which is strictly worse than a wrong constant because it can null-deref
downstream. **Reverted.** The predicate module is not on the branch; rebuild it
from this description if the next attempt wants it.

### What the probes actually established

Each case compiled as its own module (see below for why that matters):

| probe | result | |
| --- | --- | --- |
| `{ foo: function () { … } }` → `o.foo()` | `"F"` | ✓ a function-valued property call works in general |
| `{ valueOf: function () { … } }` → `o.valueOf()` | `7` | ✓ (#4201) |
| `{ toString: fn }` → `var f = o.toString; f()` | `"OL"` | ✓ **the struct holds the right function value** |
| `{ hasOwnProperty: fn }` → `o.hasOwnProperty()` | `false` | ✗ the builtin answers; the own property is ignored |
| `{ toString: fn }` → `o["toString"]()` | — | ✗ **invalid Wasm**: `call[0] expected …` |
| `P.prototype.greet = function () { … }` → `p.greet()` | `null` | ✗ |

Two conclusions the old write-up missed:

1. **The prototype-assignment idiom is broken for ANY method name, not just
   `toString`.** `P.prototype.greet = function () {}` then `p.greet()` is
   `null`. So this is not a `toString` bug with a prototype-assignment corner —
   it is a prototype-assignment bug that `toString` happens to expose. That is a
   much larger blast radius than "the harness's `deepEqual` family", and it
   wants its own issue.
2. **The property is stored correctly; only the direct-CALL dispatch misses it.**
   Reading `o.toString` and calling the result gives the right answer. So the
   defect is entirely in method-call lowering, not in object layout — which
   means the fix is in the dispatcher, but it cannot simply be "decline", since
   the path being declined INTO is itself the broken one.

The name matters, too: `foo` works, `valueOf` works, `toString` and
`hasOwnProperty` do not. So the failing set is lib-inherited names that some
earlier arm claims by name — `valueOf` being the one that has already been
fixed (#4201) and is therefore the template to follow.

### A separate defect found in passing — structurally identical literals collide

The first probe put several cases in ONE module and produced a result that no
single-case probe reproduces:

```js
var o = { toString: function () { return "OL"; } };
var m = { toString() { return "MS"; } };
o.toString();   // → "MS"   ← m's method body
```

Two object literals with the same structural type appear to share one struct and
one method body, so the wrong one is called. This is not a `toString` issue and
is not covered anywhere in this file; it needs its own issue and its own probe.
It also means **any multi-case probe in this area is untrustworthy** — measure
one shape per compiled module.

### Still not attempted

For the same reasons as before, now better evidenced: it is a behaviour change
to a shared dispatcher arm in a 3,700-line function, it affects BOTH lanes and a
very common idiom, the decline target needs fixing first, and it deserves its
own issue with its own merge-group measurement.

## Root cause 15 (merge_group regression) — `Reflect.construct` collapsed a PRESENT `null` newTarget

The `merge_group` re-validation of PR #4432 parked with one genuine host
regression: `built-ins/Reflect/construct/newtarget-is-not-constructor-throws.js`
went pass → fail.

§26.1.2 treats an omitted and an explicit-`null` newTarget **oppositely**:

- step 2 — newTarget not present ⇒ let newTarget be *target*
- step 3 — else, if `IsConstructor(newTarget)` is false ⇒ **TypeError**

The wasm import boundary is fixed-arity, and the call site pads an omitted third
argument with a null externref, so the runtime shim could not tell them apart:

```js
if (newTarget === undefined || newTarget === null) {
  return Reflect.construct(wrappedCtor, wrappedArgs ?? []);   // never throws
}
```

`Reflect.construct(fn, [], null)` therefore CONSTRUCTED instead of throwing.

**This bug predates the PR.** The test only passed before because the TARGET was
itself un-constructible (the arrow bridge), so the call threw at step 1 and never
reached step 3 — it was passing for the wrong reason. Root cause 8 made ordinary
compiled functions constructible, which is what let execution reach the real
defect.

### Fix

Encode presence in the import NAME — `__reflect_construct_newtarget` when the
third argument is syntactically present, `__reflect_construct` otherwise. Arity
is a compile-time fact and the fixed-arity boundary cannot carry it any other
way. The runtime keeps the collapse only for the genuinely-absent form.

### Measured

`built-ins/{Proxy,Reflect}` (464 files) A/B vs `origin/main`: **0 regressions,
+2** (`Proxy/getOwnPropertyDescriptor/trap-is-missing-target-is-proxy.js`,
`Proxy/has/trap-is-null-target-is-proxy.js`).

### Also from that run — the trap-category ratchet

`illegal_cast` grew 26 → 27 on `built-ins/Proxy/construct/call-result.js`.
Verified in both arms: **already failing on main**, only the MECHANISM moved.

| | status | mechanism |
| --- | --- | --- |
| main | `fail` | `TypeError: function () { [native code] } is not a constructor` (catchable) |
| branch | `fail` | `illegal cast` in `__call_fn_method_3` (uncatchable trap) |

Construction now correctly proceeds into the proxy construct trap and hits a
pre-existing bad cast in the method-dispatch trampoline. That is the
`fail`-baseline case the gate itself routes to a named `trap-growth-allow`
(#3596), declared in this file's frontmatter with the named test.

### CI note worth filing separately

The failing job could not name the regressed files: the detail-report step
crashed with `ENOENT: no such file or directory, open ''` — an empty `$BASELINE`
in that step — so `test262-regressions-detail.txt` was never written and only
the aggregate counts reached the log. The list had to be reconstructed by local
A/B.

## Diagnosed, not landed — a JSDoc-typed parameter makes `typeof` lie (1 test)

`verifyProperty-desc-is-not-object.js` asserts that a primitive `desc` argument
is rejected. `verifyProperty`'s guard is
`assert.sameValue(typeof desc, "object", …)`, and it never fires for a boolean
or a number.

Minimal repro — the exact JSDoc shape of `propertyHelper.js`, including the
optional 4th parameter and one call site that supplies it:

```js
/**
 * @param {object} obj
 * @param {string|symbol} name
 * @param {PropertyDescriptor|undefined} desc
 * @param {object} [options]
 */
function vp(obj, name, desc, options) { return typeof desc; }
var s = { foo: 1 };
vp(s, "foo", true)                                  // → "object"   (want "boolean")
vp(s, "foo", 42)                                    // → "object"   (want "number")
vp(s, "foo", { configurable: true }, { restore: 1 }) // (this call is what forces the shape)
```

Under `allowJs` the checker honours JSDoc, so `desc`'s declared type makes the
parameter's carrier a compiled struct; a primitive argument is coerced into that
slot and `typeof` on a struct answers `"object"`. Drop the JSDoc, or the 4th
parameter, and every answer is correct — which is what makes this invisible
outside the assembled harness.

Note the direction of the unsoundness: in a **JavaScript** module the declared
types are not enforced by anything, so a struct-typed parameter carrier is
unsound at every call site that passes a non-conforming value. `string` and
`null` happen to survive (they answer `"string"` / `"object"`, and `null` is
caught by the preceding `assert.notSameValue(desc, null)`), so only the boolean
and number cases of the test fail.

Not landed: the repair is "in a JS module, widen a parameter carrier to
externref when any call site passes a statically-primitive argument" — a change
to core parameter typing with whole-suite blast radius, for one harness test. It
wants its own issue and its own merge-group measurement, not a late edit here.

## Diagnosed, not landed — `detachArrayBuffer` (2 tests)

Both failures are understood; neither repair is justified on its own evidence
yet, so both are recorded rather than shipped.

**`detachArrayBuffer.js`** does NOT include the harness file, so `$DETACHBUFFER`
is undeclared and calling it must throw a **ReferenceError** (§13.3.6 → GetValue
on an unresolvable reference). Measured: calling ANY undeclared identifier is a
silent no-op —

```js
try { someUndeclaredFn123(1); } catch (e) { /* never reached */ }
```

— so the test sees no throw. Making unresolvable CALLS throw is a
whole-suite-scale semantic change (the bare-identifier read already consults the
`globalSandbox` bridge, so the change has to distinguish "absent from the
sandbox too"), and needs a full merge-group measurement rather than a sample.

**`detachArrayBuffer-host-detachArrayBuffer.js`** declares its own
`var $262 = { detachArrayBuffer() {…} }`, shadowing the runtime shim's
`var $262 = {…}`. `registerModuleGlobal` is first-wins, so the global keeps the
FIRST shape and the later store fails its guarded cast and lands as `null`:
`typeof $262` still answers `"object"` while `!$262` is **true** — which is why
the test reported "No method available to detach an ArrayBuffer" for a `$262`
that plainly has the method.

The shapes cannot be told apart from the checker (TypeScript MERGES duplicate
`var` declarations into one symbol, so `getTypeAtLocation` answers the same type
for both), so the trigger has to be syntactic: two or more initialized top-level
`var`s of one name. That widening was implemented and measured — 0 status
changes on a 250-file var-heavy sample, `!$262` and `$262.detachArrayBuffer`
both correct — but it is **incomplete**: sibling reads (`dup.a`) still resolve
against the merged static shape, and the realistic `$262` shape still traps. It
gained 0 harness tests, so it was reverted rather than landed as a partial
change to module-global typing.

Behind it sits a THIRD defect this exposed: a `Test262Error` thrown from inside
an OBJECT-LITERAL METHOD is caught with `err.constructor.name === "String"` —
the error value degrades to a string across that boundary.

## Attempted, not landed — callee-side async Promise envelope (7 tests)

Async-ness is applied at the CALL SITE (`wrapAsyncReturn` +
`wrapAsyncCallInTryCatch`): the caller wraps the result in `Promise.resolve` and
re-emits the call inside a try that converts a throw into `Promise.reject`. That
cannot reach an INDIRECT call, which is the shape `assert.throwsAsync` uses
(`res = func()` on an untyped parameter). Measured: an async function
EXPRESSION invoked through such a parameter returns the RAW value
(`async function () { return 1; }` → the number `1`) and a sync throw ESCAPES —
so `throwsAsync` reports "the function threw synchronously" for a function that
per §27.7.5.1 cannot.

A callee-side envelope was implemented for the well-defined subset — a DECLINED
async fn-expr / arrow with **no `await` of its own**, where the legacy
synchronous pass-through is already correct apart from the Promise envelope:

- `closureReturnType` forced to `externref` before the lifted func type and
  closure struct are minted;
- a `fctx.asyncPromiseWrapReturn` hook so `return v` coerces to externref and
  calls `Promise.resolve` (falling off the end fulfils with `undefined`, not
  `null` — a raw `ref.null.extern` reads back as `null`);
- the whole lifted body re-emitted inside a `try` whose `$exn` / `catch_all`
  handlers call `Promise.reject`, mirroring `wrapAsyncCallInTryCatch`.

**It works for a direct call and for a closure held in a variable** — verified
in the assembled harness: `assert.throwsAsync(Error, inner)` passes. **It does
NOT work when the async fn-expr is passed INLINE as an argument**, which is
exactly how the tests spell it:

```js
var p = assert.throwsAsync(Error, async function () { throw new Error(); });
```

The blocker is the dynamic-closure-call lowering. `func()` inside `throwsAsync`
emits a `ref.test`/`call_ref` chain over a FIXED list of candidate lifted func
types; forcing the async closure's result to `externref` gives it a type that is
not in that list, so the call falls through to the host bridge and the throw
escapes the callee's `try` after all. Net effect on the harness: **0 fixed, 0
broken** — so the work was reverted rather than landed.

Closing it needs the candidate-type list at a dynamic call site to admit the
closure's actual lifted type (or the wrapper-struct sharing to be keyed so the
async signature participates), which is a change to the dynamic-dispatch
substrate, not to async lowering.

## Attempted and REVERTED — callee-side async Promise envelope (7 tests)

Async-ness is applied entirely at the CALL SITE, which cannot reach the indirect
call `assert.throwsAsync` makes (`res = func()` on an untyped parameter).
Measured: `async function () { return 1; }` invoked that way returned the NUMBER
`1` and `async function () { throw x; }` threw SYNCHRONOUSLY — a §27.7.5.1
violation.

A callee-side envelope was built for the await-free, try-free subset and it
WORKS. Three things had to line up, each found by a measurement, and all three
are worth keeping for whoever revisits this:

1. **The decision must live in `computeClosureWrapperSig`**, the shared
   signature oracle. The #2939 dynamic-dispatch candidate PRE-SCAN and the real
   compile both call it; deciding only at the compile site left the closure's
   lifted type out of every candidate list, so an indirect `func()` fell through
   to the host bridge and the throw escaped anyway — a closure held in a
   VARIABLE worked while the same closure passed INLINE did not.
2. **The `__make_callback` trampoline needs the same envelope.** An inline async
   fn-expr ARGUMENT is compiled a SECOND time, separately, as `__cb_N` — which
   was a bare `throw`. That is the spelling every asyncHelpers test uses; the
   WAT is what showed it.
3. **`try` bodies must be excluded.** The per-`return` wrap emits a wasm
   `return`, which unwinds past a `finally`; a 220-file sample caught
   `language/expressions/async-arrow-function/try-return-finally-throw.js`
   regressing pass → fail.

### Why it was reverted

**It is depended upon.** `tests/equivalence/promise-chains.test.ts :: async
arrow function` asserts

```ts
const double = async (x: number): Promise<number> => x * 2;
export function main(): number { return double(21) as any as number; }
// expect(wasm.main()).toBe(42)
```

i.e. it CODIFIES the legacy synchronous pass-through. Under the envelope
`double(21)` is a Promise — spec-correct — and the cast yields `NaN`, so the
required `equivalence-gate` check failed. Landing the envelope means amending
that expectation, which is a deliberate project-level behaviour decision, and it
would be made for **0 harness tests gained**: the envelope removes the
"threw synchronously" failure but both `throwsAsync` tests then fail on the NEXT
defect instead.

Local sampling did not catch this: 620 async test262 files showed 0 status
changes, and the `tests/equivalence` slices run locally were the array / object /
coercion ones, not `promise-chains`. **The equivalence gate is the check that
sees this class of change — test262 sampling cannot.**

### The next defect behind it, already isolated

With the envelope in place the async cluster fails on a DIFFERENT, pre-existing
bug — confirmed identical on the baseline, so it is not caused by the envelope:

```js
asyncTest(async function () { await Promise.resolve(1); });
// TypeError: Cannot read properties of null (reading 'then')
asyncTest(async function () { var a = Promise.resolve(1); await a; });   // passes
```

`await <call-expression>` inside an async fn-expr yields a null operand, while
hoisting the operand into a variable first works. That, not the envelope, is
what now gates the `throwsAsync` tests.

## Remaining buckets (GC lane, 23 fail)

| bucket | n | signature |
| --- | ---: | --- |
| `deepEqual` (residual) | 1 | deep structural compare of nested objects/arrays |
| asyncHelpers / `asyncTest` / `throwsAsync` | 7 | an async function EXPRESSION compiles as a plain sync function (the Promise wrap is call-site-driven and an indirect call never gets it); plus one null-deref trap |
| propertyHelper, symbol-keyed | 3 | root cause 6 above — blocked on the #2610 symbol value-rep pass |
| `Object` method on null receiver | 2 | `TypeError: Object method called on null or undefined` |
| singletons | 9 | `isConstructor`, `testTypedArray`, `wellKnownIntrinsicObjects`, `fnGlobalObject`, `detachArrayBuffer` ×2, `assert-throws-native`, `assert-throws-custom-typeerror`, `verifyProperty-value`, `verifyProperty-desc-is-not-object` |

## Acceptance criteria

- [x] `e.constructor === Test262Error` holds for the literal-harness declaration
      in the GC lane, with no status change on a conformance sample.
- [ ] `assert.deepEqual` runs (the `_compare` closure resolves).
- [ ] The harness cohort reaches 116/116 in the GC lane.
- [ ] Every change is measured both ways; a previously-"passing" test that flips
      to failing because a helper stopped lying is a **correct** outcome and is
      reported, not suppressed.

## Parallel-bucket integration (2026-08-14) — async, tostring-dispatch, string-callable

Three of six parallel bucket agents delivered; their patches are integrated on
this branch. Each was measured by its agent with a targeted standalone A/B
(0 flips) and an unchanged GC lane, full evidence in the per-bucket reports.

| bucket | fixed (standalone) | key finding |
| --- | --- | --- |
| async | 13 of 18 asyncHelpers-* | The "completion marker not observed" stalls were two silent-drop policies composing: a `.then` handler without compile-time ClosureInfo was treated as ABSENT, and the standalone `.then` rejection path never resumed the driver. The `__str_concat_3` derefs were a null string carrier reaching a statically-string-typed concat. |
| tostring-dispatch | deepEqual-array/deep/object | Not one bug — a pipeline of silent guarded-cast nulls: closure pick by KIND (not exact signature), rest-vec arg coercion, externref if-joins and TDZ-box reuse each degrade a type mismatch to ref.null, so the first wrong pick surfaces as a null deref somewhere else. The exact call_ref signature registry (closure-sig-match.ts) fixes the pick; calls.ts SHRANK. |
| string-callable | compare-array-arguments/arraylike | Every standalone dynamic invocation lane funnels through `__apply_closure`, so ONE ref.eq identity front-guard arm there (builtin-ctor-callable.ts) makes the `String` carrier callable everywhere at once without touching its object identity — the exact fix shape the reverted registry attempt pointed at. |

Still failing out of these buckets, with owners:

- `asyncHelpers-throwsAsync-same-realm` — needs `$262.createRealm()`; realms do
  not exist standalone. Candidate for a permanent exclusion note.
- `asyncHelpers-asyncTest-return-not-thenable` — the bucket agent isolated a
  distinct defect and WITHDREW its fix after measurement (see async.report.md).
- `compare-array-symbol` — #2610 symbol carrier, confirmed blocked.
- `deepEqual-mapset` — past the toString trap now; distinct remaining cause.
- `deepEqual-primitives-bigint` — `deepEqual(1n, 1n)` itself now passes; the
  test fails on a later line.
- Everything identity-shaped (`sta.js`, `deepEqual-primitives`,
  `verifyProperty-same-value`/`value-error`, `asyncTest-*` overlaps) — owned by
  the test262error-identity bucket, still in flight.
