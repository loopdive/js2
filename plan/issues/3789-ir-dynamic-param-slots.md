---
id: 3789
title: "IR mutable dynamic parameter slots"
status: done
sprint: 77
created: 2026-07-30
updated: 2026-07-30
completed: 2026-07-30
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
es_edition: multi
language_feature: dynamic-values
goal: ir-full-coverage
depends_on: [2949]
related: [3053, 3787]
assignee: ttraenkler/codex-ir-dynamic-param-slots
branch: codex/3789-ir-dynamic-param-slots
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/select.ts::whyNotIrClaimable
---

# #3789 — store reassigned dynamic parameters in backend-resolved slots

## Problem

The IR already has a canonical dynamic value type and lowers it to the same
boxed-any carrier used by direct codegen. Mutable parameter setup does not ask
for that carrier, however, so selection rejects any reassigned dynamic
parameter with `param-mutation-no-slot-representation`.

Acorn's `nextLineBreak(code, from, end)` reaches this gap first: unannotated
`end` is reassigned from `code.length` when omitted. A current-main probe after
opening the slot gate shows that all three parameters still have a dynamic IR
ABI, so the loop also needs dynamic string-method dispatch and mutable dynamic
numeric loop state. This slice lands the shared storage substrate and records
those newly exposed blockers rather than claiming the helper prematurely.

## Scope

- Expose the existing backend dynamic carrier through `IrFromAstResolver`.
- Seed reassigned dynamic parameters into a slot of that carrier.
- Preserve the logical `dynamic` type on reads and box concrete assignment
  values through the existing canonical boxing instruction.
- Widen the selector only for concrete assignment values the IR can prove and
  box; keep ambiguous i32, object, callable, and unsupported union assignments
  on direct codegen.
- Recognize strict dynamic comparison against Acorn's exact, side-effect-free
  `void 0` spelling as the Undefined partition; keep loose comparison deferred.
- Cover both the host `externref` carrier and standalone `$AnyValue` carrier.
- Do not change Acorn representation/codegen files owned by the #3808
  performance baseline.

## Baseline

The unchanged runtime-dynamic Acorn driver on `main` at `89f9034e` emits 21 of
43 reachable functions through IR, reports 13 body-shape residuals and one
call-graph residual, and has zero post-claim withdrawals. `nextLineBreak` is a
body-shape residual; `isNewLine` is the call-graph residual.

## Acceptance criteria

- [x] Host and standalone runtime tests prove reassignment and subsequent reads
      of a dynamic parameter.
- [x] Numeric, string, and boolean concrete assignments use the established
      boxing path; unsupported assignments remain unclaimed.
- [x] Strict `value === void 0` takes the dynamic Undefined-tag path, while
      loose `value == void 0` remains unclaimed.
- [x] The unchanged Acorn driver is remeasured, including emitted names,
      residual buckets, withdrawals, and the next exposed blockers.
- [x] Focused tests, typecheck, IR fallback ratchet, function budget, and
      equivalence gates pass.

## Completion evidence

- Focused #3789 and adjacent dynamic-boxing suites: 13/13 passing. Runtime
  assertions cover numeric, string, and boolean writes on host and standalone;
  the host lane also executes the boxed Undefined branch by value.
- The full #2949 regression set matches merged `main`: 115 passing and the same
  7 pre-existing failures; this branch adds 3 passing #3789 tests.
- Typecheck, lint, formatting, issue integrity, function budget, and IR
  fallback ratchet pass. The fallback gate reports zero unintended,
  module-level, or post-claim increases.
- Equivalence gate: 1,611 passing, 32 baseline failures, 4 baseline failures
  now passing, and zero new regressions.
- The unchanged runtime-dynamic Acorn driver remains 21/43 IR-emitted with zero
  withdrawals. The opened storage gate moves `nextLineBreak` from the
  body-shape bucket to `param-type-not-resolvable`: body-shape residuals move
  13→12 and parameter residuals 4→5. Instrumented selection shows `code`,
  `from`, and `end` all retain dynamic IR ABIs. The next slice must therefore
  add dynamic string-method dispatch plus mutable numeric loop-state coercion;
  slot storage is no longer the blocker.
