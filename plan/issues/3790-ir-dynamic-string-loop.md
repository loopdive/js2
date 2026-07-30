---
id: 3790
title: "IR dynamic method calls and numeric loop coercion"
status: in-progress
sprint: current
created: 2026-07-30
updated: 2026-07-30
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir
es_edition: multi
language_feature: dynamic-values
goal: ir-full-coverage
depends_on: [2949, 3053, 3789]
related: [2058, 2059, 3787]
assignee: ttraenkler/codex-ir-dynamic-string-loop
branch: codex/3790-ir-dynamic-string-loop
loc-budget-allow:
  - src/codegen/dyn-ops.ts
  - src/codegen/dyn-read.ts
  - src/codegen/index.ts
  - src/ir/backend/handles.ts
  - src/ir/builder.ts
  - src/ir/effects.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
  - src/ir/select.ts
  - src/ir/verify.ts
coercion-sites-allow:
  - src/codegen/dyn-ops.ts
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/from-ast.ts::lowerBinary
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/from-ast.ts::lowerCompoundAssignment
  - src/ir/from-ast.ts::lowerIncrementDecrement
  - src/ir/from-ast.ts::tryLowerDynamicRelational
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/integration.ts::makeDynamicLowering
  - src/ir/lower.ts::lowerFunction
  - src/ir/select.ts::planIrCompilation
  - src/ir/select.ts::dynamicUsesAreMoveOnly
---

# #3790 — carry dynamic method calls and loop coercions through IR

## Problem

Issue #3789 gave reassigned dynamic parameters backend-resolved slots without
changing their ABI. Acorn's `nextLineBreak(code, from, end)` now reaches the
next capability boundary: its body calls `code.charCodeAt(i)`, compares two
dynamic loop values, computes `i + 1`, and increments the dynamic loop counter.
Those operations all have established direct-codegen runtimes, but the IR
cannot yet express them without narrowing the parameters.

## Scope

- Preserve `code`, `from`, and `end` as dynamic parameters.
- Add a representation-neutral dynamic method-call operation that delegates to
  the existing generic method runtime, including receiver binding and argument
  marshalling. Do not add an Acorn-only `charCodeAt` shortcut.
- Add dynamic `+` and full abstract relational comparison by reusing the same
  host and standalone runtime semantics as direct codegen.
- Lower dynamic `++`/`--` as `ToNumber`, numeric update, canonical number
  boxing, and slot write.
- Keep unsupported call shapes and compound assignments on direct codegen until
  their runtime behavior is represented.
- Gate the new runtime operations off in fast-carrier configurations until
  their AnyValue/host bridges have exact ABI and string-operation parity.
- Do not touch the #3808 Acorn representation/performance files.

## Baseline

On merged `main` at `56c8c354`, the unchanged runtime-dynamic Acorn driver
emits 21 of 43 reachable functions through IR with zero post-claim
withdrawals. Residuals are 12 body-shape, 5 parameter-type, 2 RegExp
constructor, 1 constructor-resolution, 1 call-graph closure, and 1 logical
value. `nextLineBreak` is a parameter-type residual and `isNewLine` is the
call-graph residual.

## Result

- The unchanged runtime-dynamic standalone Acorn driver now emits 23 of 43
  reachable functions through IR. `isNewLine` and `nextLineBreak` are both
  emitted, with zero post-claim withdrawals.
- One exact runtime iteration returns checksum 422 with zero Wasm imports.
- IR native string constants now use the same interned representation as direct
  codegen, preserving the allocation and method-dispatch fast paths.
- Remaining residuals are 12 body-shape, 2 parameter-type, 2 RegExp
  constructor, 2 call-graph closure, 1 constructor-resolution, and 1 logical
  value.

## Acceptance criteria

- [x] Host and standalone runtime tests cover dynamic named method calls with
      zero and one argument, including a custom receiver method.
- [x] Dynamic `+` preserves number addition and string concatenation.
- [x] Dynamic relational comparison preserves numeric, string, and
      incomparable behavior for all four operators.
- [x] Dynamic `++` and `--` update the stored carrier through `ToNumber` and
      canonical number boxing.
- [x] The unchanged Acorn driver is remeasured by emitted name, residual bucket,
      and withdrawal count; `nextLineBreak` no longer fails on the four
      operations in this issue.
- [ ] Focused tests, typecheck, IR fallback ratchet, function budget,
      equivalence gate, and merge-group Test262 pass.
