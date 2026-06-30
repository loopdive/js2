---
id: 2886
title: "new <global-non-constructor-builtin>() must throw TypeError (decodeURI/encodeURI/…/parseInt/parseFloat/isNaN/isFinite)"
status: done
sprint: current
priority: medium
horizon: s
area: codegen
language_feature: global-functions
assignee: ttraenkler/explore7
feasibility: medium
reasoning_effort: max
task_type: bug
goal: test262-conformance
related: [2884, 2500]
created: 2026-06-30
completed: 2026-06-30
---

# #2886 — `new <global-non-constructor-builtin>()` must throw `TypeError`

## Problem

The global builtin **functions** `decodeURI`, `decodeURIComponent`, `encodeURI`,
`encodeURIComponent`, `parseInt`, `parseFloat`, `isNaN`, `isFinite` are ordinary
built-in function objects that do **not** implement the `[[Construct]]` internal
method (ECMA-262 §19.2). Therefore `new decodeURI()` (etc.) must throw a
`TypeError`.

Before this fix, a `new <id>()` whose `<id>` was one of these names fell through
the `new`-expression dispatch in `compileNewExpression` to the _unknown
constructor_ path and was mis-routed to an `extern_class` host import. At runtime
the host resolver threw a **bare** `Error: No dependency provided for extern
class "decodeURI"` — an `Error`, **not** a `TypeError`.

The Sputnik tests check `e instanceof TypeError` strictly:

```js
try {
  new decodeURI();
  throw new Test262Error("#1.1: …");
} catch (e) {
  if (e instanceof TypeError !== true) {
    // ← fails: e is a bare Error
    throw new Test262Error("#1.2: new decodeURI() throw TypeError. Actual: " + e);
  }
}
```

`isNaN`/`isFinite`'s `_A2.7` tests use the looser `assert.throws(TypeError, …)`
harness shim (which accepts any throw) and so already passed; the 4 URI `_A5.7`
tests and `parseFloat`'s `_A7.7` use the strict Sputnik shape and failed.

## Spec

- ECMA-262 §13.3.5.1 `EvaluateNew`, step 5: _"If `IsConstructor(constructor)` is
  `false`, throw a `TypeError` exception."_
- §19.2 _Function Properties of the Global Object_ — these are function objects
  with no `[[Construct]]` (their definitions never state "is a constructor").

## Root cause

`src/codegen/expressions/new-super.ts` already had a `NAMESPACE_NON_CONSTRUCTORS`
identifier guard (`Math`/`JSON`/`Reflect`/`Atomics`) that emits a real
`TypeError` throw via `emitThrowTypeError`. The global **functions** had no
equivalent guard, so they reached the unknown-ctor → `extern_class` fallback.
They are ambient `FunctionDeclaration`s (not `VariableDeclaration`s), so
`resolvesToConstructableFunctionValue` / `resolvesToNonConstructableValue` do not
classify them, and the existing throwing paths never fired.

## Fix

In `compileNewExpression` (`src/codegen/expressions/new-super.ts`), extend the
existing identifier non-constructor block with a `GLOBAL_NON_CONSTRUCTOR_FUNCTIONS`
set covering the 8 global functions. When the `new`-target identifier is one of
them AND resolves to the **ambient global** binding (all declarations in lib
`.d.ts` files — see `resolvesToAmbientGlobal`), emit
`emitThrowTypeError(ctx, fctx, "<name> is not a constructor")` and return.

The ambient-binding guard is the load-bearing safety check: a user-defined
shadow such as `function parseInt() { this.x = 7 }` **is** constructable, so a
declaration in a real (non-`.d.ts`) source file disqualifies the intercept and
the normal constructor path runs. `ctx.classSet` / `ctx.externClasses` are also
excluded.

`emitThrowTypeError` already falls back to a plain string throw when
`__new_TypeError` is unregistered (standalone/WASI), so standalone is strictly
improved (a throw instead of the extern-class host `Error`) and never made worse.
The ordinary CALL form (`decodeURI(x)`, `parseInt(s)`) is untouched — only the
`new` dispatch changed.

## test262 impact (fresh single-file scan vs current origin/main)

5 tests flip CE/FAIL → PASS, 0 regressions across all 8 global-function dirs
(312 files scanned fresh, one process per file):

- `built-ins/decodeURI/S15.1.3.1_A5.7.js`
- `built-ins/decodeURIComponent/S15.1.3.2_A5.7.js`
- `built-ins/encodeURI/S15.1.3.3_A5.7.js`
- `built-ins/encodeURIComponent/S15.1.3.4_A5.7.js`
- `built-ins/parseFloat/S15.1.2.3_A7.7.js`

(`isNaN`/`isFinite` `_A2.7` and the `not-a-constructor.js` files already passed
and remain green; the `_A6_T1` ToPrimitive and `_A5.2` `.length`-own-property
families are separate root causes, out of scope here.)

## Tests

`tests/issue-2886.test.ts` — `new <fn>()` throws a `TypeError` instance for all
8 functions; CALL form still works; and two regression controls verify a
user-defined shadow stays constructable.
