---
id: 7278
title: "IR: harness-defined bindings referenced from harness functions and test bodies (`expr-ident-not-in-scope`)"
status: wont-fix
completed: 2026-11-06
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7267, 7275, 7276, 7251, 7252, 7266, 2928, 7106]
assignee: "ttraenkler/c-lane-opus"
---

# #7278 — IR: harness-defined bindings referenced from harness functions and test bodies

## Problem

`expr-ident-not-in-scope` is the second-largest refusal family on the wrapped
stride-40 standalone census (main d28280a0: 687 parts — `assert` 183,
`Function` 129, `Array` 59, `Float16Array` / `Int32Array` 52 each,
`nonAtomicsFriendlyTypedArrayConstructors` 50, `Object` 45, …). Many are
references to **harness-defined** top-level bindings (the `assert` object
literal, harness arrays) from inside harness functions.

## Outcome: measured, bounded yield 0, no code change

The census shows **no admission in this issue's scope that moves a single file
to zero legacy**. The harness-defined names are refused for reasons owned by
other work: the runtime-eval carrier (#2928), builtin values and providers
(#7275 / #7276), and ambient calls (#7267). The issue closes as `wont-fix` with
the routing below, so the next lane does not re-measure it.

## Measurement (main `ec914820`, 2026-11-06)

`JS2WASM_IR_SHAPE_DIAG=1 npx tsx scripts/ir-claim-ledger.mts --wrapped --stride 40 --target standalone --jobs 3 --files-json .tmp/base-files.json`
(1296 files, 14448 units; ir 1137 / both 8561 / legacy 4750; zero-legacy 32
files). The resolver columns come from a throw-away probe at the
`expr-ident-not-in-scope` arm of `isPhase1Expr` (`currentModuleBindingResolver`
and `functionObjectValues.resolveTopLevelFunctionValue`); `-` means no answer.

### Per name × unit (first refusal)

"eval-linked" = the file needs the linked runtime-eval callable carrier.
`src/codegen/index.ts` (#2928) then puts **every** unit of the file on legacy
(`late-preparation-unsupported`), whatever the selector says.

| Name | Unit (origin) | Parts | eval-linked / plain | Use shape | Defined | Resolver answer |
| --- | --- | ---: | --- | --- | --- | --- |
| `Function` | test `<module-init>` | 129 | 0 / 129 | member access (e.g. `Function.prototype.…`; not probed per row) | ambient | lib-only ambient → #7267 / #7275 |
| `assert` | harness `assert` | 74 | 74 / 0 | `assert._toString(x)` (function-object expando call) | `assert.js`, function declaration with expandos | binding -, direct no, top-level fn value **no** (planner absent in eval-linked files) |
| `assert` | harness `compareArray` | 74 | 74 / 0 | `!assert._isSameValue(b[i], a[i])` | same | same |
| `assert` | test `<module-init>` | 32 | 31 / 1 | `assert.<method>(…)` receiver (e.g. `assert.deepEqual`) | same | same |
| `Array` | harness `makeArray` | 52 | 3 / 49 | `Array.from(x)` | ambient | lib-only ambient → #7267 (ambient calls) |
| `Int32Array` | harness `testWithAtomicsFriendlyTypedArrayConstructors` | 52 | 3 / 49 | constructor as an array-literal element `[Int32Array, …]` | ambient | lib-only ambient; no IR value kind for a constructor value → #7275 |
| `Float16Array` | harness `floatTypedArrayConstructorPrecision` | 52 | 3 / 49 | `typeof Float16Array !== "undefined" && FA === Float16Array` | **not in the TS lib** | not lib-only, not ambient: an undeclared global; legacy handles `typeof` |
| `nonAtomicsFriendlyTypedArrayConstructors` | harness `testWithNonAtomicsFriendlyTypedArrayConstructors` | 50 | 3 / 47 | call argument | `testTypedArray.js` `var` = array of ambient constructors | binding -, direct no (its module storage is itself refused as `vardecl-module-storage-unrepresentable`) |
| `Object` | test `<module-init>` / harness `asyncTest` | 45 | 0 / 45 | member calls (e.g. `Object.getPrototypeOf`; not probed per row) | ambient | → #7267 / #7275 |
| `String` | harness `buildString` / test | 24 | 0 / 24 | member / direct calls (not probed per row) | ambient | → #7267 |
| `Reflect` | harness `isConstructor` / test | 18 | 0 / 18 | `Reflect.construct(…)` in `isConstructor` | ambient | → #7267 |
| `$262` | harness `$DETACHBUFFER` | 7 | 6 / 1 | `!$262`, `$262.detachArrayBuffer` | host-provided, absent on standalone | undeclared |
| `__globalObject` | harness `fnGlobalObject` | 5 | 5 / 0 | value | `fnGlobalObject.js` | eval-linked |
| `verifyPrimordialProperty` / `nonIndexNumericPropertyName` | harness `propertyHelper.js` | 4 / 2 | 6 / 0 | call / value | harness | eval-linked |
| `Test262Error` | test `<module-init>` | 3 | 0 / 3 | argument value `assert.throws(Test262Error, fn)` | `sta.js` function declaration | top-level fn value not planned for a dynamic call argument |

### Sole-blocker files

Files whose every legacy unit refuses on a **harness-defined** name (`assert`,
`compareArray`, `nonAtomicsFriendlyTypedArrayConstructors`, `__globalObject`,
`$262`, `verifyPrimordialProperty`, `nonIndexNumericPropertyName`,
`Test262Error`): **3 of 124**. The other 121 carry 1–23 further legacy units
each (41 files: 12; 31 files: 6; 28 files: 7). Unmasking each of the 3 with a
probe that admits the name shows the next blocker straight away, so none goes
zero-legacy:

| File | First refusal | Next blocker once admitted |
| --- | --- | --- |
| `built-ins/Promise/try/ctx-ctor-throws.js` | `Test262Error` value argument | `closure-return-type` on `function () { Promise.try.call(…) }` |
| `language/statements/const/dstr/obj-ptrn-id-init-throws.js` | `Test262Error` value argument | `tail-unhandled` on `const { x = thrower() } = {}` |
| `harness/deepEqual-mapset.js` | `assert` (deepEqual's call) | `template-substitution-unsupported` on `format(actual)`, plus a parenthesized IIFE callee |

The file-level sole-blocker list for ambient names (`Object` 23, `String` 6,
`Reflect` 3–4, `Date` 4, …) belongs to #7267 / #7275 / #7276 and is not
repeated here.

## Why no bounded admission was made

- **`assert` / `compareArray` (148 parts plus 32 in module-inits):** every one
  is in an eval-linked file. `src/codegen/index.ts` (#2928) puts all of that
  file's units on legacy after selection, so admitting the reference changes no
  route. Where no eval carrier is involved, the existing #7106 function-object
  receiver path already claims `assert` and `compareArray`; measured on
  `test/harness/deepEqual-mapset.js`, both take the IR body. The real fix is
  the IR owning the runtime-eval callable carrier (#2928), not scope
  resolution.
- **Ambient constructors as values (`Int32Array` array elements,
  `Float16Array`):** the IR has no value kind for an ambient constructor
  object. That is #7275 / #7276's provider question. `Float16Array` is not in
  the TS lib, so it is an undeclared global; the #7264 lib-only quantifier
  correctly refuses it.
- **`nonAtomicsFriendlyTypedArrayConstructors`:** a harness `var` holding an
  array of ambient constructors. Its module storage is refused first; the
  reference cannot resolve until that storage exists (again #7275).
- **`Test262Error` as a call argument:** the function-object planner would need
  a new "top-level function boxed as a dynamic call argument" use. All 3 files
  that would benefit have a further blocker (table above), so the yield is 0.
  This is the only in-scope shape left; it is worth doing only together with
  closure-return / destructuring work on the same files.

## Follow-ups (routing, no new issues)

- #2928: the IR owning the linked runtime-eval callable carrier would unlock
  the `assert` / `compareArray` / `propertyHelper` refusals in all 74
  eval-linked stride files at once. It is the largest single lever behind this
  family.
- #7275 / #7276: a value kind for ambient constructors as values (array
  elements, equality operands) and for harness arrays of them.
- #7267: `Array.from`, `String.fromCharCode`, `Reflect.construct`,
  `Object.*` calls.

## Acceptance criteria

- [x] Per-name use shapes, definition site and resolver answer measured.
- [x] Sole-blocker files listed (3), each unmasked: none reaches zero legacy.
- [x] No code change (bounded yield 0); routing recorded.
