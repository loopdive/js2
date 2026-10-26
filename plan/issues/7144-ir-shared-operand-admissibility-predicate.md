---
id: 7144
title: "IR: one spelling of operand/write admissibility — from-ast exports its typing gates and the selector calls them"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-26
completed: 2026-10-26
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

## Resolution (2026-10-26, Opus)

probe/test reference: `tests/issue-7144-operand-admissibility.test.ts` (selector ⇔ from-ast
agreement matrix, standalone + gc native-first) and the committed probes
`tests/fixtures/ir-closure-probes/probe{7,9..24}.mts` (p7–p24 of the #6834 rounds; run by
hand with `npx tsx <probe> <worktree-root>`).

2026-10-26 stakeholder: #7144 first; #6834 to be rebuilt on it. (Recorded here because
the #7113 issue file exists only on the #6834 branch, not on `main`.)

### What moved

`src/ir/analysis/operand-admissibility.ts` (new, pure: no IR builder, no checker) holds the
rules. `from-ast` maps every lowered value to an `OperandFamily` once
(`irOperandFamily(IrType, operand)`) and its withdrawal sites now call the predicates; the
selector calls the same predicates over the families it proves before lowering
(`src/ir/select-planned-closure-operands.ts`, new), from `isPhase1ClosureLiteral` for every
closure that carries a function-member plan.

| from-ast site | condition (unchanged) | predicate | selector arm (`operand-coercion-unsupported`) |
|---|---|---|---|
| `lowerBinary` `+` proof gate (#2781) | both number / both string unless an operand produces the carrier | `additiveOperandsProvable` (+ `additiveOperandProof`) | `closure-additive-operands` |
| `lowerBinary` dynamic arms (`tryLowerDynamicEq`, `IR_DYN_ADD_FN`, `tryLowerDynamicRelational`, `tryLowerDynamicArithmetic`) | other side boxable / f64 / carrier | `binaryOperandsAdmissible` (gates the arms; an admitted pair with no producer is now an invariant) | `closure-binary-operands` |
| `lowerBinary` string path ("mixed string/non-string", "string operator") | both string; `+`, equality, relational | `binaryOperandsAdmissible` | `closure-binary-operands` |
| `lowerBinary` matching-carrier path ("requires matching operand types", the 15 `requireF64` calls, "`==` on X operands") | one carrier; f64 for `+ - * / %` | `binaryOperandsAdmissible` (`requireF64` deleted) | `closure-binary-operands` |
| `tryFoldNullCompare` | strict-only for dynamic / externref; no fold for string / class / object / closure / callable / boxed / `ref_null` | `nullComparisonFolds` | `closure-null-compare` (direct `null` operand only, as the fold sees it) |
| `lowerExpr` `null` arm ("bare 'null' in non-reference context") | consumer is externref / `ref_null` | `nullValueAdmissible` | `closure-null-value` (discarded / `throw` consumers are externref) |
| `lowerNullish` | left is externref / `ref_null` | `nullishLeftAdmissible` | `closure-nullish-left` |
| `lowerCompoundAssignment` (string `+=`, dynamic `+=`, f64 arithmetic, RHS f64) | per slot family | `compoundWriteAdmissible`, `isF64CompoundAssignOperator` | `closure-compound-write` |
| `lowerIncrementDecrement` | f64 or dynamic slot | `incrementSlotAdmissible` | `closure-increment-slot` |
| `lowerIdentifierAssignment` slot write | families, then `irTypeAssignable` | `slotWriteVerdict` (`representation-refined` = needs `irTypeAssignable`; the selector refuses it) | `closure-slot-write` (also chained writes: a write's value family is its slot's) |
| `boxConcreteToDynamic` | string / proven boolean / f64 (+ numeric-literal tag corner) | `boxableIntoDynamic` via `irOperandFamily` | — |
| select.ts `isPhase1CompoundAssignOperator` + three inline `+= -= *= /=` lists | — | `isF64CompoundAssignOperator` (one spelling) | — |
| select.ts `isComparisonResultOperator` | — | moved to the module (shared) | — |

`lowerDiscardedExpression` needed no predicate of its own: it lowers any value under an
externref hint, and the only operand family that constrains is `null` (`nullValueAdmissible`).
The selector's family proof reuses `obviousSelectorValueFamily` (literal / operator result
families) and the checker's declared primitive family; `unknown` is refused by every predicate.

### Measured (base = `origin/main` 61b1b07d2b)

- p7–p24 (5,680 row × lane results over standalone / wasi / gc / gchost / fast): **0 lost
  claims, 0 new post-claim errors, 0 new claims, 0 host-assisted gc / fast byte changes**.
  366 claim-then-withdraw results become refusals at select (legacy body, `= node`); 176
  remain, all in the left-out classes below. gc native-first compile failures on the probe
  programs: 169 → 51.
- No-`D` twins of review-6834-r10 now refused at select: AI `"a" + 1`, `true + 1`,
  `true + "a"`, `(void 0) + 1`, `a + 1` (`var a = [1]`), `"3" * 2`, `s * s`, `s - 1`, `b - 1`,
  `(k === 1) - 1`, `!k - 1`, `typeof k - 1`, `` `3` - 1 ``, `a[0] + "s"`, `s < m`,
  `k < "1"`, `s == 1`, `true == 1`; AJ `s += true`, `q += "a"`, `q += true`, `s = 1`,
  `s++`, `b++`, `a++`, `m = [1]`, `var o; o = {…}`, mixed chained writes; AF/AA `??` everywhere; AD the
  aliased object `=== null`; r8/r9 bare `null` in a value position.
- Byte sample (20 equivalence programs + the 13 playground examples): identical on gc
  native-first, gc host-assisted, standalone, wasi, fast and `JS2WASM_NATIVE_REGIME_JS=0`.
- `check:ir-fallbacks`: identical to base (no bucket moved).

### Left out (pre-existing on main, recorded for the next slice)

- Typing gates outside operand / write admissibility, still claim-then-withdraw in a planned
  closure: throw of a scalar (`throw void 0`, "throw val not in slice 9"), an f64 local whose
  TS type is not provably number (`var t = void 0`), unary `-` of an object, conditional arms
  of different types (`throw k ? void 0 : m`), `switch` on a dynamic discriminant, element /
  member stores (`a[0] = "s"`, `m.x = 1`, `m[0] = 1`), array literals of objects / dynamics,
  `compound assign to const`, and the wasi-only direct-call plan (class P).
- `__ir_dyn_call_box` / `__dyn_member_get` ABI identity (loose `==` on the carrier, `in`,
  regex): the predicates admit these (from-ast lowers them); they fail later at preparation on
  standalone / gc. Unchanged.
- `void 0 == null` constant-fold miscompile: `void` is an f64 to the fold; unchanged.
- The top-level move-only scan (`concreteDynamicAssignmentOperandIsBuildable`, select.ts)
  keeps its own spelling of the boxable families; folding it in would move top-level selection
  and host-assisted bytes.
