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

## Root cause 4 (2 tests) — dynamic-receiver `valueOf` — DIAGNOSED, NOT LANDED

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

**A blanket "fall through to the dynamic host method call" is NOT the fix**, and
was measured and reverted here rather than landed: routing the call through
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

The host-lane fix has to mirror #4201's structure — decide in-module and return
the ORIGINAL externref for the identity case, never a host round-trip:

```
recv → local
local.get recv ; call __dyn_valueOf_is_identity          ;; i32
if (result externref)
  then local.get recv                                     ;; identity, no round-trip
  else local.get recv ; <dynamic "valueOf" method call>
```

where `__dyn_valueOf_is_identity` answers 1 when the receiver's resolved
`valueOf` is absent, non-callable, or `Object.prototype.valueOf`.

## Remaining buckets (GC lane, 28 fail)

| bucket | n | signature |
| --- | ---: | --- |
| `deepEqual` (residual) | 3 | 2 are root cause 4 above (boxed-primitive unbox); 1 is deep structural compare |
| dynamic-receiver `valueOf` | (2, counted above) | root cause 4 — diagnosed, fix designed, not landed |
| asyncHelpers / `asyncTest` / `throwsAsync` | 8 | sync-vs-async throw ordering, `$DONE` flag plumbing, one null-deref trap |
| propertyHelper, symbol-keyed | 3 | symbol key reaches the integer-typed property path |
| `compareArray` | 2 | `arguments` formatting, `assert.throws` inside the comparator |
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
