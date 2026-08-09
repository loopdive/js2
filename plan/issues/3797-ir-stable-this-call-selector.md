---
id: 3797
title: "IR stable this-call selector preclaim"
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
language_feature: function-calls
goal: ir-full-coverage
parent: 3522
depends_on: [3795]
related: [2069, 2949, 3053, 3796]
assignee: ttraenkler/codex-finish-node-at-selector
claimed_by: codex-symphony
claimed_at: 2026-07-30
branch: codex/3797-finish-node-at-selector
files:
  - src/ir/module-bindings.ts
  - src/ir/select.ts
  - tests/issue-3797-ir-stable-this-call-selector.test.ts
loc-budget-allow:
  - src/ir/module-bindings.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/module-bindings.ts::makeStableFunctionCallPlan
  - src/ir/module-bindings.ts::targetThisUsesOnlyDynamicMemberRoots
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::isPhase1BodyStatement
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/select.ts::scanExpr
  - src/ir/select.ts::whyNotIrClaimable
---

# #3797 — preclaim Acorn `finishNodeAt` for receiver-aware IR lowering

## Problem

Acorn's runtime-dynamic standalone build emits 32 of 43 reachable functions
through IR after #3795. `finishNodeAt` remains direct because its body observes
ambient `this`, mutates dynamic named and indexed members, and is referenced
through `finishNodeAt.call(thisArg, node, type, pos, loc)`.

The ordinary direct-call proof is insufficient. A first-class alias,
reassignment, optional call, spread, or arity mismatch could bypass the
receiver bridge, while a selector-only widening could claim a body that the
AST-to-IR builder cannot yet bind.

## Scope

- Add checker-backed proof for an exact top-level four-parameter
  `FunctionDeclaration` whose complete source reference population consists
  only of fixed five-argument `.call(thisArg, a, b, c, d)` sites.
- Carry exact declaration, checker signature, call expression, receiver, user
  arguments, complete call-site population, and structural unit identity.
- Keep the selector effect behind
  `stableFunctionCallIntegrationBuildable`, which defaults false until the
  receiver bridge and ambient-`this` AST-to-IR lowering consume this proof.
- Restrict the proof to the non-fast externref lane and an exact parenthesized
  bare-`this` receiver. Typed identifiers, type parameters, assertions, and
  checker-derived nullability remain outside this first executable slice.
- Treat only a module-private declaration in an external module as a complete
  source-local population. Exported/export-listed targets and global scripts
  remain unproven without a future Program-wide reference inventory.
- Expose ambient `this` only when every use starts an admitted, non-optional
  dynamic member read.
- Preclaim statement-position dynamic named and element stores rooted in an
  exact dynamic parameter or admitted ambient `this`.
- Keep assignment-as-value, compound/update, optional, nullable, computed-key,
  spread, alias, bare-call, and unsupported receiver shapes rejected before
  claim.

## Acceptance criteria

- [x] Exact two-site Acorn-shaped `.call` references produce one stable plan
      with arity four and exact AST identity.
- [x] Alias, bare call, reassignment, spread, optional, arity mismatch, bare
      `.call` property, and nullable receiver references invalidate the whole
      plan.
- [x] Assertion-derived, nullable, unresolved type-parameter, and non-`this`
      receiver types; optional-chain segments anywhere in the target/call
      shape; exported targets; and global-script targets do not produce a plan.
- [x] Bare, written, or optional ambient `this` uses do not receive the
      selector capability.
- [x] With the explicit test-only integration capability enabled, the exact
      `node.type`, `node.end`, `node.loc.end`, and `node.range[1]` statement
      stores pass selector preclaim on the non-fast lane.
- [x] With the capability absent/default-false, both structural selection and
      a production standalone compile keep `finishNodeAt` on direct codegen
      with no post-claim withdrawal.
- [x] Production GC and standalone anti-vacuity compiles emit a known-positive
      IR control while keeping `finishNodeAt` absent.
- [x] Assignment-as-value, compound, optional, nullable, and call-produced
      store receivers remain preclaim rejections.
- [ ] Receiver-aware direct `.call` and AST-to-IR `__current_this` integration
      land before the Acorn census counts `finishNodeAt` as the 33rd IR
      function.
- [x] Focused tests, typecheck, formatting, IR fallback ratchet, function/LOC
      budgets, and issue checks pass.

## Integration boundary

This slice owns selection evidence only. It does not bind `__current_this`,
lower the `.call` site, change direct codegen, or report 33/43. Those executable
pieces must consume the exact plan and preserve receiver restoration on normal
and exceptional exits before the integration capability can be enabled or this
issue can be marked done.

## Evidence

- Focused selector and identity proof:
  `tests/issue-3797-ir-stable-this-call-selector.test.ts` (33/33), including
  production compile anti-vacuity assertions for GC and standalone.
- Exact unchanged runtime-dynamic Acorn driver: 32/43 reachable functions
  emitted, `finishNodeAt` remains a selector refusal, checksum 422, zero module
  and function imports, and zero post-claim withdrawals.
- Adjacent #3794, #3795, and direct-member-equality suites pass.
- Three failures in the wider #2949/#3053 selector sample reproduce unchanged
  at the exact `b1304d81e2722e0d4ee975518e2478f2c7c5ef9f` stack base.
- Typecheck, Prettier, IR fallback, issue-integrity, optimization-retirement,
  LOC, and function-budget gates pass.
