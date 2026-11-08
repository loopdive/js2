---
id: 7307
title: "IR: split the #2949 move-only scan (dynamicUsesAreMoveOnly, ~890 lines) by concern"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
related: [2949, 7283, 7265, 7272]
---

# IR: split `dynamicUsesAreMoveOnly` by concern

## Problem

`dynamicUsesAreMoveOnly` in `src/ir/select.ts` is the shared #2949 move-only
scan. It checks that every use of a dynamic carrier value in a function is a
move or a box the from-ast builder can lower. It is about 890 lines, and its
`scanExprInner` closure alone is about 510.

Every admission lands inside it. #7265, #7272 and #7283 each needed a
`func-budget-allow` grant on both functions, and each grant points at "a
separate refactor". This is that refactor.

## Target structure

Split by concern into a module of its own under `src/ir/` (for example
`move-only-scan.ts`), keeping the selector's call site:

- **Statement walk:** declarations, assignments, `return`, `if`/loops, and
  statement-position calls.
- **Expression scan:** what `scanExprInner` does today, i.e. operand
  positions, member reads, equality/logical operands and call arguments.
- **Direct-call argument checks:** `scanDirectCallArgs` and the
  dyn-parameter/boxable rules.
- **Shared predicates**, already module-level: `isBoolCallResult`,
  `isModuleBooleanAliasCall`, `concreteDynamicAssignmentOperandIsBuildable`
  and their siblings. They move with the scan or stay as imports.

The state today kept in closures (`dynNames`, the per-subject carrier sets)
becomes one explicit scan-context object passed to each part.

## Acceptance criteria

- Pure refactor: the wrapped stride-40 ledger has identical per-file legacy
  sets, the playground corpus produces identical bytes, and the equivalence
  gate is unchanged.
- No function over the func budget without a grant. The #7265/#7272/#7283
  grants on `dynamicUsesAreMoveOnly`/`scanExprInner` are removed.
- No new `ir → codegen` edge. `check:ir-layering` and
  `check:import-cycles` pass.
