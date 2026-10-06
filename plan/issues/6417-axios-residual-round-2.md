---
id: 6417
title: "axios residual round 2: 23 failures across eight files after the under-applied `.call` receiver fix"
status: done
sprint: current
created: 2026-09-12
updated: 2026-10-05
completed: 2026-10-05
assignee: ttraenkler/wave11-axios
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
loc-budget-allow:
  # 2026-10-05 (#6417): one-line call sites into the new leaf modules
  # closures/host-boolean-callback.ts, expressions/typeof-import-binding.ts and
  # expressions/callable-property-omittable-param.ts; the mechanisms live there.
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/typeof-delete.ts
oracle-ratchet-allow:
  # 2026-10-05 (#6417): `nativeTypeOfDeclaration(ctx.checker, decl)` mirrors
  # lowerParamType's own native-annotation test byte-for-byte — a wasm-lowering
  # ValType question (does `x: i32` pin a scalar slot?) the oracle cannot answer.
  - src/codegen/expressions/callable-property-omittable-param.ts
func-budget-allow:
  # 2026-10-05 (#6417): the same call sites (+6 / +1 lines).
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
---

## Problem

axios is **208/231** on `upstream/main` `cf82f78d6d` + the
[#5341](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5341-axios-residual-buckets)
receiver fix (202 before it). The six tests that moved were the whole
`transformData`/`transformResponse` bucket. What is left is what #5341
explicitly did not take, re-measured after it, plus one bucket that #5341's
own evidence mis-attributed.

## Evidence (2026-09-12, `tests/dogfood/report/axios-upstream-suite.json`)

```
 3  TypeError: Cannot access property on null or undefined   buildURL.test.js
 3  assertion 1 toEqual mismatch                             isX.test.js
 2  assertion 1 instance mismatch                            validator.test.js   (0/2)
 2  validation function expected "true". Received 1          fromDataURI.test.js
 2  randomFillSync is not a function                         platform.test.js    ← host shim gap
 1  Function.prototype.bind called on incompatible undefined buildURL.test.js
 1  assertion 1 toEqual mismatch                             buildURL.test.js
 1  assertion 1 toBe: string:undefined != string:function    buildURL.test.js
 1  assertion 1 instance mismatch                            AxiosError.test.js
 1  assertion 2 instance mismatch                            settle.test.js
 1  assertion 1 toBe: object:null != boolean:true            AxiosError.test.js
 1  assertion 1 expected contained value                     AxiosError.test.js
 1  assertion 1 toBe: object != object                       AxiosError.test.js
 1  assertion 1 toBe: object:null != boolean:true            canceledError.test.js
 1  RuntimeError: dereferencing a null pointer               composeSignals.test.js
 1  validation function expected "true". Received 1          transformResponse.test.js
```

Ordered by what a single mechanism would buy:

1. **`buildURL` (6)** — the biggest single file. Three shapes, probably one
   cause: `AxiosURLSearchParams` construction/`toString(_encode)` returning
   nullish. Note `should be exported as a named export` reports the module's
   own `buildURL` binding as `string:undefined` where `function` is expected,
   which points at the module-shape side rather than the body.
2. **The `instance mismatch` cluster (4)** — `validator` ×2, `AxiosError` ×1,
   `settle` ×1. `instanceof` against a class that crossed the host boundary;
   same family as #5325's residual and #5347. **Check #5347 first and fix it
   there once** rather than locally here.
3. **`The validation function is expected to return "true". Received 1` (3)** —
   `fromDataURI` ×2, `transformResponse` ×1. Node's `assert.throws(fn,
   validator)` requires the validator to return literally `true`; a compiled
   validator returning a boolean answers `1` to the host caller. If that is a
   boolean→number boxing at the function-RETURN host boundary it is one
   narrow mechanism worth taking on its own — verify before assuming, the
   validators also contain an `instanceof` that may be failing for reason 2.
4. **`isX` (3)** — `ArrayBuffer`, `ArrayBufferView`, `Date` type predicates.
5. **`util.types.isNativeError` answers `null` (2)** — `AxiosError` and
   `canceledError` both assert a compiled Error subclass is recognised as a
   native error by Node; the host call answers `null`.
6. **`composeSignals` (1)** — the one remaining trap in axios. `AbortSignal`
   composition through `addEventListener` callbacks; capture-cell family
   (#5320/#5323).
7. **`platform` (2) is NOT a compiler bug.** `randomFillSync` is a Node
   `crypto` builtin the host shim does not expose. Record, do not fix.

So the compiler-addressable ceiling here is **229/231**, and the realistic
next step is 1 + 2 (10 tests).

## Acceptance criteria

1. axios ≥ 214/231, or an equivalent gain if a target bucket turns out to be
   non-compiler.
2. One PR per independent cause; a cause shared with #5347 lands there.
3. Regression tests with untyped `.js` two-file fixtures, failing on the
   parent, with an anti-vacuity control.
4. A/B at one HEAD over the 17 dogfood suites, per test file.

## Implementation Plan (2026-10-05, re-measured)

Base re-measured on `upstream/main` `42d289a96f`: **212/231**, 19 failures
(the four `transformData`-adjacent rows and `fromDataURI` ×1 of the table
above had already moved). Regrouped by root cause from
`tests/dogfood/report/axios-upstream-suite.json`, each reduced to an untyped
two-file fixture:

| # | Root cause | Tests | Action |
|---|---|---|---|
| A | `typeof importedBinding` folds to `"undefined"`: the alias symbol has no `valueDeclaration` | buildURL ×1 | fix here |
| B | A callable property whose stored closure widened an omittable formal to `externref` (`@param {Number} [position]`, TS `function f(x?: number)`) is dispatched only through the declared-f64 arm → "Cannot access property on null or undefined". `utils.endsWith` is that shape; `toFormData` calls it for every non-scalar param | buildURL ×3 | fix here |
| C | `X.prototype.toString = function (encoder)` stored through the fixed zero-arity bridge loses its argument | buildURL ×1 (special chars) | fix here |
| D | A compiled Date passed to a dynamic host method crosses as the struct facade → `Object.prototype.toString.call(d)` is `[object Object]` | isX Date ×1, buildURL date (with B) | fix here |
| E | A host-invoked `boolean` callback returns the raw i32 → `assert.throws` validator "Received 1" | fromDataURI ×1, transformResponse ×1 | fix here |
| F | Dynamic `actual instanceof expected` with a compiled CLASS VALUE on the right answers false | AxiosError ×1, settle ×1, validator ×2 | → [#6873](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6873-dynamic-instanceof-compiled-class-value) |
| G | A hoisted function declaration taken as a VALUE before a later `const` it closes over is initialized captures the TDZ snapshot (`null`) | buildURL array ×1 | → [#6874](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6874-hoisted-fn-value-captures-tdz-snapshot) |
| H | byte-vec carrier tags `[object Array]` (ArrayBuffer) / `ArrayBuffer.isView(DataView)` false | isX ×2 | #6433 + follow-up |
| I | AxiosError enumerable `message` / toJSON identity | AxiosError ×2 | follow-up |
| J | `composeSignals` null deref (capture-cell family #5320/#5323) | ×1 | follow-up |
| K | `crypto.randomFillSync` absent from the web host shim — not a compiler bug | platform ×2 | record only |

Mechanisms for A–E (one PR, five small leaf changes):

- **A** `src/codegen/expressions/typeof-import-binding.ts::typeofOperandIsDeclared` resolves an
  `Alias` symbol through `ctx.oracle.aliasedValueDeclarationOf`; both
  `compileTypeofExpression` and `compileTypeofComparison` use it in place of
  `!!sym?.valueDeclaration`.
- **B** `src/codegen/expressions/callable-property-omittable-param.ts` mirrors the two
  lowering rules exactly (function declaration: `parameterMayBeOmitted` without a
  native annotation; arrow/function expression: JSDoc-optional only) and
  `compileCallablePropertyCall` widens that slot to `externref`.
- **C** `src/runtime.ts::_wrapStoredMethodValue` (the four `__extern_set*`
  sites): unknown-arity bridge first, the zero-arity dispatcher only as fallback.
- **D** `src/runtime/date-host-method.ts::hostArgsWithDates` marshals Date
  carrier ARGUMENTS of `__extern_method_call` as their host Date view (the
  receiver keeps `tryCallWasmDateHostMethod`).
- **E** `src/codegen/closures/host-boolean-callback.ts`: host lane only, a callback whose
  TS result is `boolean` declares an `externref` result; `return` operands are
  branded `boolean` (`FunctionContext.hostBooleanReturn`) so `coerceType` boxes
  through `__box_boolean`; an expression body boxes the same way.

## Resolution (2026-10-05)

A–E landed in one PR; axios **212 → 219/231** (buildURL 15→19, fromDataURI
11→12, transformResponse 5→6, isX 11→12). F and G are filed with plans as
#6873 and #6874; H–K remain as listed above.

A/B at one HEAD (`42d289a96f` base vs the fix, same scratch copies, run one
at a time), per test file:

| suite | base | fix |
|---|---|---|
| axios | 212/231 | **219/231** |
| prettier | 75/151 | 75/151 |
| hono | 294/324 | 294/324 |
| redux | 76/82 | 76/82 |
| lodash | 60/62 | 60/62 |
| jest | 336/356 | 336/356 |
| marked | 18/30 | 18/30 |
| uuid | 75/75 | 75/75 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| moment | 10/10 | 10/10 |

No per-file line differs outside axios. Scoped test262 slices
(`expressions/typeof`, `module-code/instn-*`, `expressions/call`,
`expressions/instanceof`; plus host-lane `expressions/addition`,
`String/prototype/split`, `Date/prototype/toJSON`,
`Object/prototype/toString`): standalone 134/289 → 134/289 and host 225/281 →
225/281, identical non-pass sets.

Regression test: `tests/issue-6417-axios-residual-mechanisms.test.ts` —
9 failed / 4 passed on the parent, 13/13 with the fix.
