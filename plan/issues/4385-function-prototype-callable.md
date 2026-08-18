---
id: 4385
title: "Standalone ES5: Function.prototype itself is not callable"
status: done
sprint: 78
created: 2026-08-12
updated: 2026-08-18
priority: high
horizon: s
feasibility: high
reasoning_effort: medium
task_type: bugfix
area: ir, codegen
es_edition: 5
language_feature: function-prototype
goal: es5
assignee: ttraenkler/codex-es5-function-prototype
related: [1472, 2378, 4265]
files:
  - src/codegen/function-prototype-callable.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/ir/backend/legality.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - tests/issue-4385-function-prototype-callable.test.ts
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/select.ts::isPhase1Expr
---

# Standalone ES5: `Function.prototype` itself is not callable

## Problem

ES5 §15.3.4 defines `%Function.prototype%` as a Function object whose
`[[Call]]` accepts any arguments and returns `undefined`. The standalone
compiler instead treats `Function.prototype(...)` as a dynamic
`Namespace.member(...)` lookup and refuses it through `env::__get_builtin`.

The fresh 2026-08-12 standalone Test262 baseline contains four ES5 failures at
this exact call site:

- `built-ins/Function/prototype/S15.3.4_A2_T1.js`
- `built-ins/Function/prototype/S15.3.4_A2_T2.js`
- `built-ins/Function/prototype/S15.3.4_A2_T3.js`
- `built-ins/Function/prototype/S15.3.3.1_A1.js`

The surrounding `Function/prototype` directory has 59 ES5 failures. Forty use
dynamic `Function`/eval and are outside the current ex-dynamic-code goal. Of
the 19 reachable cases, six belong to already-claimed bind issue #4196. This
four-file family is the largest coherent unclaimed root cause.

## Fix

Recognise only the exact ambient `Function.prototype(...)` call. Both the
legacy and IR front-ends evaluate every argument left-to-right and discard its
value, then invoke one host-free runtime provider that returns the existing
standalone `undefined` singleton. A local binding named `Function` declines the
intrinsic and keeps ordinary method-call semantics.

The IR selector has an explicit standalone-WasmGC backend capability, and the
AST-to-IR lowerer emits a symbolic runtime call. This keeps the semantic entry
point on the IR path rather than adding a legacy-only exception.

## Acceptance criteria

- [x] The four named ES5 Test262 files change from compile error to pass in the
      standalone lane.
- [x] A direct call accepts zero or multiple arguments, evaluates them for
      effects, and returns real `undefined`.
- [x] The exact call is genuinely IR-emitted with no post-claim demotion.
- [x] A shadowing local named `Function` is not intercepted.
- [x] The standalone module remains valid and has zero host imports.
- [x] The reachable ES5 `Function/prototype` control set has zero regressions.

## Validation

Baseline commit `8c9f889680730001c08d0290bc40234514277505` and candidate
`a3fcafc959fdb2e` were compared with the authoritative standalone Test262
runner. A causal ablation of the new exact-call branch reproduced the baseline
`env::__get_builtin` compile error for all four files; enabling it changed all
four to pass. The runner used the local refusal runtime-eval provider, which is
not CI-comparable for dynamic-code tests, but these four sources do not invoke
eval or the Function constructor.

The full 19-file reachable ES5 `Function/prototype` failure control set had
zero regressions: five files advanced in phase (the four target files reached
pass) and fourteen retained their prior status. The exact executable ES5
`Function.prototype(...)` trigger population is the four target files.

Focused validation:

- `pnpm exec vitest run tests/issue-4385-function-prototype-callable.test.ts`
  — 3/3 pass
- `pnpm exec tsc --noEmit --pretty false` — pass
- `pnpm run check:ir-fallbacks` — pass, no fallback or post-claim increases
- `pnpm run check:loc-budget` — pass with issue-scoped allowances
- `pnpm run check:func-budget` — pass with issue-scoped allowances
