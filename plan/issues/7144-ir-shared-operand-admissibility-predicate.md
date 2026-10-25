---
id: 7144
title: "IR: one spelling of operand/write admissibility — from-ast exports its typing gates and the selector calls them"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
parent: 7106
related: [7113, 7112, 7119]
---

# #7144 — one spelling of operand/write admissibility (selector ⇄ from-ast)

## Problem

PR #6834 (#7113) went through ten fresh-context review rounds. Every round closed
the previous ring of claim-then-demote rows and the next review found the next
ring: `null` positions, compound writes, `??`, `void`, object operands, then the
operator typing per `IrType` (`"a" + 1`, `r | 0`, `r >= "a"`), compound writes
into string slots, `switch`, `in`, regex literals, loose `==` on a dynamic
carrier (review-6834-r10, findings AI–AK: ~50 rows in two probes). Every no-`D`
twin of those rows is a **pre-existing** claim-then-demote of the planned-closure
lane on `main`; the dynamic-conditional admission only made them reachable in
more closures.

Root cause: `src/ir/select.ts` re-derives from-ast's typing rules by hand —
`isPhase1Expr`, `closureWriteUnlowerable`, `closureNullValuePosition`,
`nullCompareFoldFails`, `plannedClosureValueFamilyAdmissible`,
`plannedClosureWriteProved` each spell a subset of what `lowerBinary`
(from-ast.ts ≈15310–15316 both-number / both-string, ≈15469 matching types),
`tryFoldNullCompare` (≈16115–16213), `lowerNullish` (≈15682–15698), the
compound-assign arm (≈13555–13643), `boxConcreteToDynamic` (≈16326–16345) and
`lowerDiscardedExpression` (≈2546–2620) actually accept. Two spellings of one
limit drift, and the drift is a claim-then-demote (#2855 is phasing those out;
the IR code-quality rule forbids a second spelling).

## Goal

Exactly one spelling: from-ast's admissibility is a **predicate the selector
calls**, so the two can never disagree. A selector refusal and a from-ast
withdrawal become the same function evaluated at two times.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. **Inventory the gates.** List every `throw`/withdrawal site in
   `src/ir/from-ast.ts` that is reachable from a planned member closure body
   (grep `not in slice`, `not supported in IR`, `requires … evidence`,
   `unprovable`, `has no exact AST-site plan`, `incomplete dependencies`) and the
   condition each tests on its operand `IrType`s. Table in this file:
   site, condition, which selector function currently mirrors it (or none).
2. **Extract the typing gates as pure functions** in a new module
   `src/ir/operand-admissibility.ts` (one concern): `binaryOperandsAdmissible(op,
   left: Family, right: Family)`, `compoundWriteAdmissible(op, slot: Family,
   value: Family)`, `nullComparisonFolds(op, other: Family)`,
   `nullishLeftAdmissible(left: Family)`, `discardedValueAdmissible(kind)`,
   `incrementSlotAdmissible(slot)`, where `Family` is the selector's
   `obviousSelectorValueFamily` vocabulary extended with `dynamic`, `vec<number>`,
   `externref`, `unknown`. **from-ast calls these** at its withdrawal sites
   (mapping its `IrType` to `Family` once, in one helper) so the predicate is
   load-bearing there, not documentation.
3. **The selector calls the same functions** from `plannedClosureValueFamilyAdmissible`
   and the `isPhase1Expr` arms, and the hand-rolled spellings are deleted:
   `plannedClosureWriteProved`, the operator arm of `plannedClosureValueAdmitted`,
   `nullCompareFoldFails`' family tests, the `??` arm, the string-`+=` special
   case. Reason codes collapse to one per gate family. Target: `select.ts` net
   negative vs the #6834 head (review-6834-r10 AM lists 60–90 LOC foldable before
   this change).
4. **Unknown family = refuse**, in both callers. Where the selector cannot name a
   family (call result, member read of unknown shape) it passes `unknown`; the
   predicate refuses unless from-ast has a lowering that accepts any type there
   (today: `+ - * / %` and `=== !== < <= > >=` with the dynamic carrier on one
   side, measured in review-6834-r10 AI).
5. **Acceptance.** Re-run probes p7–p24 from the #6834 scratchpad (committed
   under `tests/fixtures/ir-closure-probes/` by this issue, so the next PR does
   not rebuild them): zero claim-then-withdraw rows in any planned closure on
   standalone and gc native-first; zero lost base claims; host-assisted gc and
   fast bytes identical. A new test `tests/issue-7144-operand-admissibility.test.ts`
   asserts, for each gate, that the selector's answer equals from-ast's outcome
   on a matrix of family pairs (claim ⇔ lowered, refuse ⇔ would-withdraw).
6. **Order.** Lands before the general dynamic-conditional admission of #7113
   is re-attempted; #6834 is narrowed to the exact #7106 harness shapes until
   then (stakeholder decision pending, 2026-10-25).

## Residual (from review-6834-r10, pre-existing on main, out of scope here)

- wasi-only: a direct call to a module function inside a planned closure
  withdraws "no exact AST-site plan" on wasi only; `supportsBackendCapability`
  (select.ts ≈717, #3529 P4 seam) is the sanctioned place for a lane capability.
- `__ir_dyn_call_box` / `__dyn_member_get` have no Program ABI identity on
  standalone/gc (loose `==` on a dynamic carrier, `in`, regex literal reach
  `late-preparation-unsupported`); wasi lowers them.
- `tryFoldNullCompare` constant-folds `void 0 == null` as `false` (base
  miscompile, `ran=0` vs node `1`).
