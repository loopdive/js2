---
id: 4737
title: "eval is not a constructor in standalone output"
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
status: done
priority: high
depends_on: []
es_edition: es2015
language_feature: eval
task_type: bug
files:
  - src/codegen/closures/ordinary-fn-constructibility.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/new-super.ts
  - scripts/test262-sandbox-globals.mjs
  - tests/issue-4737.test.ts
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
---

# `eval` is not a constructor in standalone output

## Scope

Fix the exact Test262 case `test/built-ins/eval/not-a-constructor.js`.
The confirmed host baseline fails at upstream commit `627013f0f`.

The case checks both `isConstructor(eval) === false` and that `new eval('')`
throws `TypeError`. Its source does not execute dynamic eval: the `eval` value
is only inspected by `Reflect.construct`, and the `new` expression must reject
it before invocation. Standalone validation may therefore use the repository's
interpreter-refusal provider; QuickJS is not required for this case.

Include Function/constructor controls so the fix does not make genuine
constructors non-constructable.

## Acceptance

- The focused Test262 case passes in the host lane and standalone/refusal lane.
- `Function` and an ordinary user constructor remain constructable.
- Production change stays within 180 net lines and is limited to the `new`
  non-constructor classification path.

## Implementation Plan

1. Reproduce the exact Test262 file on the confirmed host baseline
   `627013f0f`, using an absolute path so the compiler can resolve the source
   file. Record the host failure and the standalone failure with the
   repository's interpreter-refusal provider.
2. Materialize an unshadowed host `eval` read from the realm global object,
   classify the synthetic standalone indirect-eval adapter as callable but
   non-constructible, and include `eval` in the static global
   non-constructor `new` guard.
3. Add the missing `eval` name to the Test262 sandbox globals and exercise the
   exact case plus Function/ordinary-function/arrow controls.

The exact source only probes `eval` through `isConstructor` and
`Reflect.construct`; it does not execute dynamic code. Therefore the
standalone run uses the repository refusal provider and does not require
QuickJS.

## Test Results

### Provider and baseline evidence

- Built the repository refusal provider with
  `node --import tsx scripts/build-runtime-eval-provider.mjs --refusal-only`.
  Cache key: `53838e1372b11156`; artifact:
  `.test262-cache/runtime-eval-refusal-53838e1372b11156.wasm` (138827 bytes,
  canary verified).
- At upstream `627013f0f`, exact host run failed with
  `Test262Error: isConstructor invoked with a non-function value` (Wasm SHA
  `db1bd6eeadfe`).
- At the same baseline, exact standalone/refusal run failed with
  `Test262Error: isConstructor(eval) must return false` (Wasm SHA
  `42760785cff0`). The default QuickJS lane was unavailable because its
  `libquickjs.wasm` artifact was not present; QuickJS is not needed for this
  no-dynamic-eval case.

### Fixed revision

- Exact host Test262 case: `pass` (Wasm SHA `39900f71c380`; total 3747.6 ms).
- Exact standalone Test262 case with refusal provider: `pass` (Wasm SHA
  `73de890f8587`; total 6953.34 ms). The provider announced refusal key
  `53838e1372b11156` and no dynamic eval was executed.
- Focused controls: standalone `eval` is non-constructible, an ordinary
  function expression remains constructible, an arrow remains
  non-constructible; host `%Function%` remains constructible.
- Focused Vitest: 3/3 pass under the interpreter-refusal provider.
- TypeScript 5 and TypeScript 7 checks, ESLint, Prettier, issue validation,
  LOC budget, and function budget: pass. The narrowly scoped budget grants
  cover the `eval` classification branches recorded above.
