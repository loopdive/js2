---
id: 3795
title: "IR dynamic local widening and member set"
status: done
sprint: 77
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
parent: 3522
depends_on: [3794]
related: [2949, 3053, 3789, 3808]
assignee: ttraenkler/codex
claimed_by: codex-symphony
claimed_at: 2026-07-30
branch: codex/3795-ir-dynamic-member-set
completed: 2026-07-30
files:
  - src/codegen/dyn-read.ts
  - src/ir/backend/handles.ts
  - src/ir/builder.ts
  - src/ir/dynamic-local-widening.ts
  - src/ir/effects.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
  - src/ir/passes/inline-small.ts
  - src/ir/passes/monomorphize.ts
  - src/ir/select.ts
  - src/ir/verify.ts
  - tests/issue-3795-ir-dynamic-member-set.test.ts
loc-budget-allow:
  - src/codegen/dyn-read.ts
  - src/ir/backend/handles.ts
  - src/ir/builder.ts
  - src/ir/dynamic-local-widening.ts
  - src/ir/effects.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
  - src/ir/passes/inline-small.ts
  - src/ir/passes/monomorphize.ts
  - src/ir/select.ts
  - src/ir/verify.ts
func-budget-allow:
  - src/codegen/dyn-read.ts::ensureDynMemberSet
  - src/ir/builder.ts::emitDynMemberSet
  - src/ir/dynamic-local-widening.ts::collectDynamicStringLocalWidening
  - src/ir/effects.ts::isSideEffecting
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/from-ast.ts::lowerElementStore
  - src/ir/from-ast.ts::lowerVarDecl
  - src/ir/integration.ts::makeDynamicLowering
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/lower.ts::emitBlockBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/select.ts::whyNotIrClaimable
  - src/ir/verify.ts::verifyInstruction
---

# #3795 — add canonical dynamic member mutation to Acorn IR

## Problem

After #3794, Acorn's exact runtime-dynamic standalone build emits 31 of 43
reachable functions through IR. `isPrivateNameConflicted` remains direct even
though its reads, comparisons, truthiness, and dynamic string concatenation are
already representable.

Two related representation gaps remain:

1. `next` starts as the concrete string `"true"` and later receives a dynamic
   concatenation. The existing dynamic slot machinery can carry the later value
   but whole-local selection does not widen and box the initializer.
2. `privateNameMap[name] = value` is a statement-position write to the
   canonical dynamic carrier. IR has `dyn.member_get` but no write dual.

The current `param-type-not-resolvable` outcome is the dynamic-use preclaim
gate masking those unsupported uses, not an unresolved parameter declaration.

## Scope

- Prove the exact mutable-local family where a boxable concrete string
  initializer is later assigned a dynamic string concatenation, widen that
  local to the canonical dynamic slot, and box the initializer exactly once.
- Add statement-position `dyn.member_set(recv, key, value)` over canonical
  dynamic carriers.
- Preserve JavaScript evaluation order and single evaluation of receiver, key,
  and value.
- Use strict assignment semantics in Acorn's module body, including setter
  failure behavior.
- Preserve host and WasmGC carrier parity and `Object.create(null)` data-key
  behavior, including `__proto__`.
- Keep assignment-as-value, optional writes, arbitrary dynamic mutation, and
  wider mixed-representation or explicitly-typed locals rejected before claim.
- Preserve `RequireObjectCoercible` for dynamic Get and Set: null, undefined,
  and their tag-0/tag-1 carrier forms throw before the object runtime observes
  the access.
- Preserve #3808's closed token-table, open `Parser.options`, and numeric-local
  representation decisions without editing their owner paths.

## Acceptance criteria

- [x] Focused truth-table tests cover instance/static private get/set pairs,
      duplicate declarations, and the transition to the `"true"` conflict
      marker.
- [x] Focused write tests prove receiver/key/value single evaluation and
      left-to-right order, strict setter failure, and `Object.create(null)`
      `__proto__` behavior.
- [x] Negative tests keep assignment-as-value, optional/wider writes, and
      explicitly-typed/unsupported local widening on direct codegen with zero
      withdrawals in both overlay and IR-first modes.
- [x] Both host and standalone/GC carrier strategies execute the admitted
      shape with identical observable results.
- [x] The exact Acorn driver emits 32 of 43 reachable functions through IR;
      `isPrivateNameConflicted` is the sole new name and all prior 31 remain.
- [x] Runtime remains checksum 422 with zero module imports, zero function
      imports, and zero post-claim withdrawals.
- [x] Focused and adjacent tests, typecheck, formatting, IR fallback ratchet,
      function/LOC budgets, and issue checks pass.

## Evidence

- The unchanged runtime-dynamic Acorn driver emits 32 of 43 reachable
  functions through IR. `isPrivateNameConflicted` is the sole new emitted
  name, and all prior 31 names remain.
- The exact runtime run returns checksum 422 with zero module imports, zero
  function imports, and no post-claim withdrawal.
- The shared whole-local proof widens only direct-body mutable string-literal
  locals whose complete write set consists of statement-position dynamic
  string concatenations. Assignment-as-value, compound/update, nested, and
  mixed wider or explicitly-typed writes remain pre-claim refusals in overlay
  and `JS2WASM_IR_FIRST=1`.
- `dyn.member_set` is a void, call-like heap mutation. Its DCE liveness,
  verifier, inliner, monomorphizer, and Wasm lowering all consume receiver,
  key, and value in source order.
- The strict helper stores raw tag-5 string and tag-6 object payloads while
  preserving the canonical conversion for other dynamic partitions. Its shared
  receiver peel rejects null/undefined/tag-0/tag-1 before both Get and Set, and
  standalone strict Set routes through the native `Reflect.set` verdict before
  throwing a catchable TypeError. A zero-argument in-Wasm driver executes the
  compiled Acorn function across instance/static transitions, duplicate and
  mixed conflicts, the `"true"` marker, frozen-set failure, and an own
  `__proto__` key on `Object.create(null)`, returning the checked `0xffff`
  checksum without host-object marshalling.
- Focused proof:
  `tests/issue-3795-ir-dynamic-member-set.test.ts` (10/10). Adjacent #3789 and
  #3794 suites pass. Typecheck and the exact Acorn driver pass.
