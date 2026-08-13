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
  # The host-side `Test262Error` class and the `__new_Test262Error_ctor` builtin
  # belong to the runtime's import-resolution table, which lives here; there is
  # no separate host-error subsystem module to add them to.
  - src/runtime.ts
  # +18 lines: one more arm in the top-level-statement keep ladder, which lives
  # here next to the #2671 / #3666 / #2660 arms it mirrors. Splitting a single
  # arm out would separate it from the ladder whose order is load-bearing.
  - src/codegen/declarations.ts
  # +89 lines: the expected-struct diversion helper plus the arm that calls it.
  # It belongs next to the #3536 arm it generalizes and to
  # `compileObjectLiteralForStruct`, which it dispatches to; both live here.
  - src/codegen/literals.ts
  # +7 lines: the new arm's body lives in its own module
  # (codegen/host-dyn-valueof.ts); what remains here is the guarded call.
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  # +23 lines: one more entry in the host import-resolution table. The table is
  # a flat dispatch over import names; there is no sub-unit to split it into
  # that would not just move the same switch arm behind an indirection.
  - src/runtime.ts::resolveImport
  # +5 lines: the new arm's body lives in its own module
  # (expressions/test262-error-ctor.ts); what remains here is the guarded call.
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  # +18 lines: one more arm in this function's top-level-statement keep ladder,
  # whose arm ORDER is load-bearing (each `continue`s past the later ones).
  - src/codegen/declarations.ts::collectDeclarations
  # +29 lines: the new diversion is one guarded call plus the comment that
  # records the failure mode; the body lives in its own helper alongside.
  - src/codegen/literals.ts::compileObjectLiteral
  # +13 lines: a one-condition change to the existing widening scan plus the
  # comment recording the literal-vs-non-literal divergence it closes.
  - src/codegen/literals.ts::compileArrayLiteral
  # +6 lines: the new arm is a guarded call into codegen/host-dyn-valueof.ts.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
oracle-ratchet-allow:
  # `resolveStructName` keys off raw `ts.Type` IDENTITY to reach anonTypeMap /
  # structMap — a wasm-lowering ValType question the oracle does not express.
  # Same grant, same reason, as the adjacent #3536 arm in this file.
  - src/codegen/literals.ts
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
  - src/codegen/host-dyn-valueof.ts
  - tests/issue-4394-host-dynamic-valueof.test.ts
  - tests/test262-runner.ts
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

Mirror #4201's structure in `src/codegen/host-dyn-valueof.ts` — decide
in-module and return the ORIGINAL externref for the identity case, never a host
round-trip:

```
recv → local
local.get recv ; call __dyn_valueof_is_override           ;; i32
if (result externref)
  then local.get recv ; call __dyn_valueof_call            ;; wrapper slot / user override
  else local.get recv                                      ;; identity, no round-trip
```

where `__dyn_valueof_is_override` answers 0 — the identity arm — when the
receiver's resolved `valueOf` is absent, non-callable, or exactly
`Object.prototype.valueOf`.

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
