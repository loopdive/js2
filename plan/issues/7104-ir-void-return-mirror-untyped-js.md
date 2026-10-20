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
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/select.ts
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
