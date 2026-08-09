---
id: 3793
title: "IR retained Acorn parser wrapper projection"
status: done
sprint: 77
created: 2026-07-30
updated: 2026-07-30
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir
es_edition: multi
language_feature: functions
goal: ir-full-coverage
parent: 3522
depends_on: [3791]
related: [3583]
assignee: ttraenkler/codex-ir-parser-wrappers
branch: codex/3793-ir-acorn-retained-parser-wrappers
files:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/module-bindings.ts
  - src/ir/integration.ts
  - src/codegen/index.ts
  - tests/issue-3793-ir-acorn-retained-parser-wrappers.test.ts
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/select.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::makeIrImplicitParamTypeResolver
  - src/codegen/index.ts::planIrOverlay
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/from-ast.ts::lowerCall
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/module-bindings.ts::buildModuleBindings
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::isPhase1Expr
---

# #3793 — project retained Acorn parser wrapper targets into IR

## Problem

After #3791, Acorn's exact runtime-dynamic standalone build emits 27 of 43
reachable functions through IR. The public module wrappers `parse`,
`parseExpressionAt`, and `tokenizer` remain direct because their exact static
targets are retained module `FunctionExpression` values rather than ordinary
function declarations.

The retained closure identity and receiver semantics already exist in the
direct path. The IR needs a narrow projection of those exact targets, not a
general conversion of function values or closures.

## Scope

- Resolve only stable retained module `FunctionExpression` values whose exact
  target is known before IR selection.
- Preserve the existing retained closure identity rather than synthesizing a
  second callable.
- Preserve call receiver semantics. In particular, `Parser.parse` contains
  `new this(...)`; it must not be rewritten into or invoked as a bare call.
- Keep aliases, reassigned bindings, polymorphic/generic retained closures,
  and receiver-ambiguous calls on direct codegen. Captures remain owned by the
  retained direct FunctionExpression body; the IR wrapper must preserve that
  existing closure rather than copy it.
- Preserve the #3808 numeric-local, closed-token-table, and
  `Parser.options` representation decisions.
- Do not claim the called `FunctionExpression` bodies are IR-emitted or that
  their direct bodies can be retired.

## Acceptance criteria

- [x] Focused positive tests prove exact retained module wrapper targets emit
      and execute with their required receiver.
- [x] Negative tests keep reassigned, aliased, generic, and receiver-ambiguous
      retained targets on direct codegen.
- [x] Concrete-result dispatcher calls and arguments without a proven bridge
      are rejected before claim, with zero post-claim withdrawals.
- [x] The unchanged exact Acorn driver reports its measured emitted-name
      count, checksum 422, zero imports, and zero post-claim withdrawals.
- [x] All 27 previously emitted Acorn names remain emitted.
- [x] Focused and adjacent tests, typecheck, formatting, IR fallback ratchet,
      and function/LOC budget gates pass.

## Result

- The exact runtime-dynamic Acorn driver emits 30 of 43 reachable functions
  through IR, up from 27 of 43. The new names are `parse`,
  `parseExpressionAt`, and `tokenizer`; none of the previous 27 withdrew.
- Runtime remains checksum 422 with zero Wasm imports and zero post-claim
  withdrawals.
- Adversarial ABI coverage keeps typed string-result wrappers on direct
  codegen because the closed dispatcher still returns boxed dynamic, and
  rejects boolean-parameter wrappers before claim because their unbranded i32
  argument has no proven box at this bridge.
- A same-host paired measurement recorded 49.415 ms/op for this slice versus
  49.954 ms/op for its #3791 parent (about 1.1% faster). The migration win is
  the three additional IR bodies; the runtime delta is small enough to treat as
  neutral.
- Focused proof: `tests/issue-3793-ir-acorn-retained-parser-wrappers.test.ts`.
  Adjacent coverage: #3791, #3790, and #1712 focused suites.
- The retained method FunctionExpression bodies and closed dispatcher remain
  direct-codegen-owned. This slice does not retire that path.
