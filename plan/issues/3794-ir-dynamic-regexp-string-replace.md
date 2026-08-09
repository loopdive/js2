---
id: 3794
title: "IR dynamic RegExp/string replace dispatch"
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
language_feature: dynamic-values
goal: ir-full-coverage
parent: 3522
depends_on: [3793]
related: [3790, 3791]
assignee: ttraenkler/codex-ir-dynamic-replace
branch: codex/3794-ir-dynamic-replace
files:
  - src/codegen/dyn-ops.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - tests/issue-3794-ir-dynamic-replace.test.ts
loc-budget-allow:
  - src/codegen/dyn-ops.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/dyn-ops.ts::ensureDynamicStringReplace
  - src/ir/from-ast.ts::lowerStatementList
  - src/ir/from-ast.ts::lowerCall
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::isExactDynamicStringReplaceNumberParser
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::buildLocalCallGraph
  - src/ir/select.ts::parseNumberCallUsesDynamicCarrier
  - src/ir/select.ts::implicitParameterHasOnlyStringCallArguments
---

# #3794 — dispatch Acorn's dynamic RegExp/string replacement through IR

## Problem

After #3793, Acorn's exact runtime-dynamic standalone build emits 30 of 43
reachable functions through IR. `stringToNumber` remains direct because its
dynamic string parameter calls `replace(/_/g, "")` before crossing the native
`parseFloat` boundary.

The generic dynamic method bridge only supports zero or one argument, and
standalone's open-receiver dispatcher does not implement the RegExp replace
brand. Widening either path would admit unsupported arities and post-claim
failures.

## Scope

- Admit only the exact side-effect-free `receiver.replace(/_/g, "")` shape on
  a dynamic receiver.
- Preserve the ordinary host receiver and argument order. In standalone,
  lower the exact global underscore deletion through the equivalent native
  literal `replaceAll` primitive.
- Carry the non-fast dynamic result directly into the established externref
  ABI of `parseInt` and `parseFloat`; fast AnyValue modes remain rejected.
- Preserve Acorn's legacy boolean ABI for the exact numeric parser guard when
  a widened call edge makes the speculative IR override dynamic.
- Reject wider arities, spreads, dynamic replacement values, RegExp
  references, different patterns, and non-empty replacements before claim.
- Preserve every #3793 emitted name and avoid changes to the #3808-owned
  representation files, `codegen/index.ts`, module bindings, runtime/Program
  ABI, and Date lowering.

## Acceptance criteria

- [x] Focused execution proves the exact `parseFloat(str.replace(/_/g, ""))`
      path and the legacy-octal `parseInt` branch.
- [x] Focused negatives reject unsupported arity, spread, replacement, and
      RegExp shapes before claim with zero post-claim withdrawals.
- [x] Custom dynamic receivers retain ordinary `replace` method dispatch, and
      inferred string parse carriers reject before claim.
- [x] The exact Acorn driver emits 31 of 43 reachable functions through IR,
      including `stringToNumber`.
- [x] All prior 30 Acorn IR names remain emitted.
- [x] Runtime remains checksum 422 with zero Wasm imports and zero post-claim
      withdrawals.
- [x] Focused and adjacent tests, typecheck, formatting, IR fallback ratchet,
      function/LOC budgets, and issue checks pass.

## Result

- The exact runtime-dynamic Acorn driver emits 31 of 43 reachable functions
  through IR, up from 30 of 43; `stringToNumber` is the sole new name.
- Runtime remains checksum 422 with zero module imports, zero function
  imports, and zero post-claim withdrawals.
- Standalone reuses the native string `replaceAll` implementation for the
  admitted `/_/g, ""` equivalence. Host mode constructs the exact RegExp and
  retains receiver-preserving method dispatch.
- Unsupported arity, spread, dynamic replacement, RegExp reference, different
  pattern, and non-empty replacement shapes remain on direct codegen.
- The standalone helper brand-tests its receiver before the native string fast
  path; custom objects fall through to the receiver-preserving method bridge.
  Inferred string first parameters are rejected before the parse-helper ABI
  can be planned.
- Focused proof: `tests/issue-3794-ir-dynamic-replace.test.ts`.
  Adjacent coverage: #3790 and #3791 focused suites.
