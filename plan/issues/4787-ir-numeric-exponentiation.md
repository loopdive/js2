---
id: 4787
title: "IR numeric exponentiation retirement checkpoint through semantic math.pow"
status: done
assignee: ttraenkler/codex
branch: codex/4787-ir-numeric-exponentiation
created: 2026-08-27
updated: 2026-08-27
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir
language_feature: exponentiation
goal: ir-first
related: [2135, 4681]
files:
  - src/ir/capability.ts
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - tests/issue-2135.test.ts
  - tests/issue-4787-ir-numeric-exponentiation.test.ts
loc-budget-allow:
  - src/ir/capability.ts
  - src/ir/from-ast.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerBinary
  - src/ir/select.ts::isPhase1Expr
---

# Issue #4787 — IR numeric exponentiation retirement checkpoint

Status: complete
Assignee: ttraenkler/codex
Branch: codex/4787-ir-numeric-exponentiation

## Objective

Retire the direct AST→Wasm `BinaryExpression **` route for the bounded exact
numeric slice. An already-prepared, single-source top-level function body may
claim `**` only when both operands are checker-proven primitive numbers and the
active target can provide the existing semantic `math.pow` intrinsic. The IR
builder must lower the operands left-to-right and emit `math.pow`; the legacy
`compileNumericBinaryOp` route remains the explicit control/fallback path for
everything outside that contract.

## Implementation plan

1. Flip the shared `AsteriskAsteriskToken` capability row together with the
   exact selector gate. Keep unsupported operand/provider shapes pre-claim as
   typed `operand-coercion-unsupported` outcomes, including bigint,
   any/unknown, unions, generics, object/boxed/coercive/property values,
   `**=`, module-init/class/closure/multi-source units, and targets without the
   symbolic math provider.
2. Add a selection-side prepared-body/context check and a narrow numeric
   operand proof that reuses the existing checker primitive classifier and
   `IR_MATH_METHOD_TABLE.pow` provider capability. Preserve the existing
   function-wide shape and call-graph gates so an admitted operand has a
   lowering plan rather than a shape-only claim.
3. Add a from-AST `**` arm after the capability assertion. Lower the left value,
   then the right value, assert both are exact f64 IR values, and call
   `IrFunctionBuilder.emitIntrinsic("math.pow", ...)` with the source site.
   Any post-claim proof/provider/result mismatch is an IR invariant, never a
   demotion.
4. Add focused #4787 coverage: a non-vacuous eligible denominator, exact
   semantic-intrinsic/provider evidence, direct-body poison plus the existing
   `JS2WASM_IR_FIRST=0` control arm, runtime edge parity, typed exclusions, and
   zero post-claim errors. Update only the affected #2135 capability assertions.
5. Run the focused #2135/#4787 tests first, record the actual results here,
   inspect the final diff for scope, and commit without pushing or opening a
   PR.

## Status notes

- The issue reservation was atomically allocated and verified on
  `upstream/issue-assignments` for `ttraenkler/codex` before implementation.
- Existing runtime-manifest and `math.pow` provider definitions are being
  reused. No #3525, module-init, or multi-prepared implementation files are in
  scope.
- The bounded selector claim and from-AST semantic lowering are implemented.
- Focused `tests/issue-4787-ir-numeric-exponentiation.test.ts` passes 15/15;
  focused #2135/#4787 together pass 20/20 after the final test additions.
- The repository `pnpm run typecheck` check passes in the provisioned
  worktree.
- Targeted Prettier, `git diff --check`, and the repository LOC/function budget
  checks pass. The function budget records the intentionally expanded
  `isPhase1Expr` allowance above.

## Test Results

- `vitest run tests/issue-4787-ir-numeric-exponentiation.test.ts`: 15/15
  passed.
- `vitest run tests/issue-2135.test.ts tests/issue-4787-ir-numeric-exponentiation.test.ts`:
  20/20 passed.
- `pnpm run typecheck`: passed.
- Targeted Prettier check: passed.
- LOC and function budgets: passed with the scoped allowances in frontmatter.
- Coverage proves a non-vacuous eligible denominator, exact `math.pow`
  intrinsic/provider evidence, left-to-right IR ordering, direct-body poison
  plus the `JS2WASM_IR_FIRST=0` control arm, runtime edge parity, typed
  pre-claim exclusions, and zero post-claim evidence.

## Post-PR hardening follow-up

Review of PR #5095 found one selection/preparation seam in the otherwise exact
operand gate. A direct local call could satisfy the checker-number predicate
and the ordinary Phase-1 call walk before direct-call plans existed. If later
preparation could not produce the exact AST-site f64 call plan, lowering
demoted the operand after the enclosing exponentiation had already claimed the
body, turning a valid direct-fallback program into a post-claim build failure.

The narrow follow-up rejects call expressions from this checkpoint until the
selector can consume an exact prepared call plan. Generic call selection is
unchanged. Regressions cover a type-alias numeric return and an overload whose
implementation returns `any`; both now remain pre-claim unsupported, compile
successfully through the direct path, and record no build post-claim error.

- Focused #4787 coverage after the fix: 22/22 passed.
- TypeScript 7 typecheck after the fix: passed.
- Follow-up implementation commit: `db6e5605ade11d323a00a170cc25ab9ce8beaec1`.

## Risks and explicit non-goals

- The full suite and Test262 were intentionally not run during this focused
  checkpoint.
- `compileNumericBinaryOp` remains available for the explicit kill-switch and
  residual unsupported forms; only the exact prepared single-source numeric
  slice is retired from that route.
- Runtime manifest/provider definitions were not changed because the existing
  `math.pow` provider is available on the active target matrix; selection
  requires the symbolic-provider capability and rejects unavailable targets
  before claim.
