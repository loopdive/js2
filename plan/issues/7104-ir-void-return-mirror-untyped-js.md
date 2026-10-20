---
id: 7104
title: "IR selector: mirror legacy's no-result registration for unannotated JS functions"
status: in-progress
sprint: current
created: 2026-10-20
updated: 2026-10-20
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 6920
assignee: "ttraenkler/claude-c"
# 2026-10-20: `planIrOverlay` grows by the void-mirror arm in the override-map
# builder (+13 lines) and `src/codegen/index.ts` by the same lines plus one
# import; both are the minimal change that makes the registered IR signature
# agree with the selector's verdict.
# 2026-10-20 (dyn.undefined): one new IR instruction threaded through its
# node, verifier, builder, lowering (both dynamic strategies), pre-registration
# and the from-ast/selector arms that use it; each growth is that one arm.
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  - src/ir/integration.ts::makeDynamicLowering
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/runtime/verify.ts::verifyInstrStructure
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/select.ts::whyNotIrClaimable
  - src/ir/passes/inline-small.ts::renameInstrOperands
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - src/ir/builder.ts
  - src/ir/runtime/verify.ts
  - src/ir/core/nodes.ts
  - src/ir/prepared-component-dependencies.ts
  - src/codegen/any-helpers.ts
---

# IR selector: mirror legacy's no-result registration for unannotated JS functions

## Problem

On test262 the IR claims almost nothing (measured 2026-10-20 with the
fallback-free metric of #6806: 0 of 45 passes on `language/expressions/addition/`
are fallback-free). One root cause is an ABI divergence for the most common
plain-JS function shape: an unannotated function whose body never returns a
value (`function f() { throw … }`, `function g() {}`, `function h() { return; }`).
Legacy registers it with no result (`() -> ()`); the lattice seeds it `unknown`,
the selector's dynamic arm turns that into a `() -> externref` claim, and every
such claim withdraws post-claim on `abi-signature-parity` (`$DONOTEVALUATE` in
every harness assembly).

## Change

Part 2 — `dyn.undefined` (the carrier's `undefined`): a new IR instruction
lowered to exactly legacy's `undefined` on each lane (gc: the `$undefined`
singleton; host: the pre-registered `__get_undefined` import; standalone
externref carrier: the extern-wrapped singleton or `ref.null.extern`). With it
a dynamic-return function may have a bare `return;`, `return undefined`, an
empty body, and an `if`-without-else tail (fall-through, or a terminating
then-arm), each producing legacy's value. Measured: `function f(){throw…}`,
`g(){}`, `h(){return;}`, `k(a){if(a){return 1;}}` and their caller all
IR-emitted on standalone.

- `src/ir/select.ts::resolveReturnType`: an unannotated `FunctionDeclaration`
  whose body has no `return <expr>` (outside nested function-likes) resolves
  `void` when the lattice fact is absent/unknown/dynamic. Shared helper
  `irFunctionBodyReturnsValue`.
- `src/codegen/index.ts::planIrOverlay`: the override map registers the same
  function with `returnType: null`, so the IR signature equals legacy's.

## Acceptance

- `$DONOTEVALUATE` in a test262 harness assembly is IR-emitted (not withdrawn).
- `pnpm run check:ir-fallbacks` unchanged; selector suites unchanged
  (`issue-1231` and `issue-4612` fail identically on main — pre-existing).
- `ir_only_pass` on the filtered standalone run does not regress.
