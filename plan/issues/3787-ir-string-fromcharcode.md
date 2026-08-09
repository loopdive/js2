---
id: 3787
title: "IR ambient String.fromCharCode lowering"
status: done
completed: 2026-07-30
sprint: 77
created: 2026-07-30
updated: 2026-07-30
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
language_feature: builtins
goal: ir-full-coverage
depends_on: [2949]
related: [2122, 2601, 2875]
assignee: ttraenkler/codex-ir-string-fromcharcode
branch: codex/3787-ir-string-fromcharcode
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::isPhase1StatementListInScope
---

# #3787 — lower ambient `String.fromCharCode` through IR

## Problem

Acorn's `codePointToString` helper is otherwise IR-shaped, but both of its
return arms call the ambient static builtin `String.fromCharCode`. The selector
treats the ambient `String` receiver as an external call, leaving the function
on the legacy body path.

## Scope

- Claim only the exact, unshadowed ambient `String.fromCharCode(...)` identity.
- Admit zero or more non-spread arguments whose numeric representation is
  proven by the checker/IR selector.
- Preserve left-to-right argument evaluation and variadic concatenation.
- Use `env.String_fromCharCode(f64)` in the host lane.
- Use `__str_fromCharCode(i32)` in native/standalone lanes after the exact
  ToUint16 modulo fold already used by direct codegen.
- Reuse the existing f64-slot compound-assignment lowering at body top level,
  which is the second masked shape in Acorn's `codePointToString` helper.
- Keep coercion-general, spread, `String.fromCodePoint`, and shadowed bindings
  on legacy.

## Acceptance criteria

- [x] Host and standalone runtime tests cover zero, one, and multiple args.
- [x] Standalone tests cover large, negative, fractional, NaN, and infinity
      ToUint16 behavior.
- [x] A shadowed `String` binding is not selected.
- [x] Acorn's exact runtime-dynamic driver moves from 20/43 to 21/43
      IR-emitted reachable functions with no withdrawals.
- [x] Focused tests, typecheck, IR fallback ratchet, and equivalence gate pass.

## Completion evidence

- Exact unchanged Acorn runtime-dynamic driver: 21 emitted of 43 reachable
  functions; `codePointToString` is newly emitted; body-shape residuals fall
  from 14 to 13; no post-claim withdrawals.
- Focused #3787 suite: 6/6 passing across host and standalone.
- Existing early-return/guard suites: 18/18 passing.
- Typecheck and IR fallback ratchet pass; the ratchet reports no unintended,
  module-level, or post-claim increases.
- Equivalence gate: 1,611 passing, no new regressions. Four baseline failures
  now pass.
- Existing unrelated baseline: the standalone `String.fromCodePoint` surrogate
  length assertion in `tests/issue-2122.test.ts` fails identically on merged
  main. The `fromCharCode` cases in that file pass.
