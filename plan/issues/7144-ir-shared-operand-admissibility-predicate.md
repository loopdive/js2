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
# 2026-10-26 (#7144 review round 3): from-ast grows by 4 lines net — the strict
# undefined compare now reads the shared `isUndefinedCompareOperand` /
# `undefinedCompareOperandAdmissible` (two imports, one widened condition).
loc-budget-allow:
  - src/ir/from-ast.ts
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

## Resolution (2026-10-26, Opus; review rounds 2 and 3 the same day)

probe/test reference: `tests/issue-7144-operand-admissibility.test.ts` (selector ⇔ from-ast
agreement matrix on standalone, wasi and gc native-first; IR-claimed rows run against node) and
the committed probes `tests/fixtures/ir-closure-probes/probe{7,9..24}.mts` (p7–p24 of the
#6834 rounds; run by hand with `npx tsx <probe> <worktree-root>`).

2026-10-26 stakeholder: #7144 first; #6834 to be rebuilt on it. (Recorded here because
the #7113 issue file exists only on the #6834 branch, not on `main`.)

### What moved

`src/ir/analysis/operand-admissibility.ts` (new, pure: no IR builder, no checker) holds the
rules. `from-ast` maps every lowered value to an `OperandFamily` once
(`irOperandFamily(IrType, operand)`) and its withdrawal sites call the predicates; the
selector calls the same predicates over the families it proves before lowering
(`src/ir/select-planned-closure-operands.ts`, new), from `isPhase1ClosureLiteral` for every
closure that carries a function-member plan.

| from-ast site | predicate | selector arm (`operand-coercion-unsupported`) |
|---|---|---|
| `lowerBinary` `+` proof gate (#2781) | `additiveOperandsProvable` (+ `additiveOperandProof`) | `closure-additive-operands` |
| `lowerBinary` dynamic arms (`tryLowerDynamicEq`, `IR_DYN_ADD_FN`, `tryLowerDynamicRelational`, `tryLowerDynamicArithmetic`) | `binaryOperandsAdmissible` gates the arms; an admitted pair with no producer is an invariant | `closure-binary-operands` |
| `lowerBinary` string path ("mixed string/non-string", "string operator") | `binaryOperandsAdmissible` | `closure-binary-operands` |
| `lowerBinary` matching-carrier path ("requires matching operand types", the 15 `requireF64` calls, "`==` on X operands") | `binaryOperandsAdmissible` (`requireF64` deleted) | `closure-binary-operands` |
| fused-i32 `x \| 0` / `x ^ 0` identity (`lowerBitwiseAsI32`, `tryLowerFusedI32Binary`) | `i32IdentityBitwiseOperand` (`analysis/i32-slots.ts`) + `isWrapI32Lowerable` | accepted before the operand predicate |
| `tryFoldNullCompare` | `nullComparisonFolds` | `closure-null-compare` (direct `null` operand only, as the fold sees it) |
| `lowerExpr` `null` arm ("bare 'null' in non-reference context") | `nullValueAdmissible` | `closure-null-value` (discarded / `throw` consumers are externref) |
| `lowerNullish` | `nullishLeftAdmissible` | `closure-nullish-left` |
| `lowerCompoundAssignment` (string `+=`, dynamic `+=`, f64 arithmetic, RHS f64) | `compoundWriteAdmissible`, `isF64CompoundAssignOperator` | `closure-compound-write` |
| `lowerIncrementDecrement` | `incrementSlotAdmissible` | `closure-increment-slot` |
| `lowerIdentifierAssignment` slot write | `slotWriteVerdict`, then `irTypeAssignable` for `representation-refined` (the selector refuses that verdict) | `closure-slot-write` (also chained writes: a write's value family is its slot's) |
| `boxConcreteToDynamic` | `boxableIntoDynamic` via `irOperandFamily` | — |
| a value `void x` (round 2) | `OperandFamily` `"undefined"` (`isValueVoid`): every predicate above | `closure-void-value` for consumers no predicate judges |
| `tryLowerUndefinedCompare` (round 3) | `isUndefinedCompareOperand` (the identifier `undefined` or a direct `void 0`), `undefinedCompareOperandAdmissible` (never the `void` sentinel on the other side) | `closure-undefined-compare` |
| select.ts `isPhase1CompoundAssignOperator` + four inline `+= -= *= /=` lists | `isF64CompoundAssignOperator` | — |
| select.ts `isComparisonResultOperator`, five inline equality lists, three strict-equality spellings | `isComparisonResultOperator`, `isEqualityOperator`, `isStrictEqualityOperator` | — |

`lowerDiscardedExpression` needed no predicate of its own: it lowers any value under an
externref hint, and the only operand family that constrains is `null` (`nullValueAdmissible`).
The selector's family proof reuses `obviousSelectorValueFamily` (literal / operator result
families) and the checker's declared primitive family; `unknown` is refused by every predicate.

**`void` (review round 2, finding A).** from-ast lowers a value `void x` to the f64 NaN
sentinel. That is ToNumber(undefined), so it is exact for `- * / %`, the relationals, the
bitwise operators, a ToBoolean / ToNumber reader and an equality against an f64 (neither
`undefined` nor NaN equals a number), and for `=== null`. It is wrong wherever the value is
observed: any other equality, `+`, `== null`, a box into the carrier, a slot write, `typeof`,
a call argument. `irOperandFamily` now maps it to `"undefined"`, the predicates refuse it in the
second group (so from-ast demotes those functions instead of emitting the NaN), and the walk
refuses a `void` whose consumer is not judged by a predicate (`voidValueConsumerAdmissible`).
A direct `void 0` operand of a strict equality is not that value: `tryLowerUndefinedCompare`
reads it as `undefined` (an exact tag test against the carrier, `true` against another
`void 0`), and the walk now recognises it through the same `isUndefinedCompareOperand`
(round 3), so `k === void 0`, `m !== void 0` and `void 0 === void 0` claim as on base.

**Host-assisted gc bytes.** `irOperandFamily` is shared by every function, so the from-ast half
also demotes a plain (non-closure) function that observed `void x` as a value. Those functions
were IR-compiled wrongly on base and now take the correct legacy path, which changes their gc
host-assisted bytes. Example: `function top(n: number) { return (void 0) === (void 0) ? 1 : 2 }`
returned 2 on base (node: 1) and returns 1 now, gchost hash `31ceb949f1af` → `12963685c530`; the
same for `(void 0) == null ? 1 : 2`. These are the only gchost byte changes found: neither the
byte samples below nor the review's 435 + 174-row corpus sample contain such a function.

**Scope of the selector half.** It covers planned member closures only — not the
`isPhase1Expr` arms of top-level functions (plan step 3). Those arms decide top-level selection,
which the host-assisted gc lane shares; routing them through the walk would move top-level
claims and host-assisted bytes, and top-level dynamic subjects already have the move-only scan.
That is the next slice.

### Measured

Base `origin/main` 61b1b07d2b for p7–p24 and the byte sample; base eef2ba9c3c (the current
merge-base; differs by one 2-line backend file) for the review's adversarial probes.

- p7–p24 (5,680 row × lane results over standalone / wasi / gc / gchost / fast): 0 new
  post-claim errors, 0 new claims, 0 gc host-assisted / fast byte changes on these programs
  (all are planned closures), 0 IR-claimed result that differs from node. 414
  claim-then-withdraw results become refusals at select; 128 remain, all in the left-out classes
  below. gc native-first compile failures on the probe programs: 169 → 35.
- **Claims given up (48 on p7–p24; 4 + 23 on the review's adv1 / adv2), and why:**
  - wrong on base: `void 0 == null` / `!= null`, `(void 0) === (void 0)` (parenthesised, so not
    the undefined compare), `m = void 0; m === undefined`, `m = void 0; throw m`,
    `m = void 0; throw typeof m`, wasi `k == void 0`;
  - wrong in general, right on base only for the probes' inputs (which cannot tell NaN from
    `undefined`, or `undefined` from a number): `m(void 0)`, `[void 0]`, `m = void 0`,
    `q = void 0`, `m += void 0`, `k += void 0`, `m + (void 0)` (NaN for a numeric `m`,
    `"aNaN"` vs `"aundefined"` for a string), `void null === m` (a `void` that is not the
    literal `void 0`);
  - right on base, given up deliberately: wasi only `m == undefined` / `k == undefined` (the
    walk does not type the `undefined` identifier; the loose carrier `==` it would admit fails
    at preparation on standalone and gc).
- Claims restored: `(k < 1) | 0` (round 2, the fused-i32 identity), `n == void 0` (round 2),
  and in round 3 the strict undefined compare with a direct `void 0`: `k === void 0`,
  `m !== void 0`, `void 0 === m`, `void 0 === void 0`, `void 0 === "x"`.
- No-`D` twins of review-6834-r10 now refused at select: AI `"a" + 1`, `true + 1`,
  `true + "a"`, `(void 0) + 1`, `a + 1` (`var a = [1]`), `"3" * 2`, `s * s`, `s - 1`, `b - 1`,
  `(k === 1) - 1`, `!k - 1`, `typeof k - 1`, `` `3` - 1 ``, `a[0] + "s"`, `s < m`,
  `k < "1"`, `s == 1`, `true == 1`; AJ `s += true`, `q += "a"`, `q += true`, `s = 1`,
  `s++`, `b++`, `a++`, `m = [1]`, `var o; o = {…}`, mixed chained writes; AF/AA `??` everywhere; AD the
  aliased object `=== null`; r8/r9 bare `null` in a value position; `throw void 0`,
  `var t = void 0`; `(void 0) === undefined` (round 3, N4).
- Byte sample (20 equivalence programs + the 13 playground examples): identical on gc
  native-first, gc host-assisted, standalone, wasi, fast and `JS2WASM_NATIVE_REGIME_JS=0`.
- `check:ir-fallbacks`: identical to base (no bucket moved).

### Left out (pre-existing on main, recorded for the next slice)

- Typing gates outside operand / write admissibility, still claim-then-withdraw in a planned
  closure: scalar `throw` (`throw 42`), unary `-` of an object, conditional arms of different
  types (`throw k ? void 0 : m`), `switch` on a dynamic discriminant, element / member stores
  (`a[0] = "s"`, `m.x = 1`, `m[0] = 1`), element reads (`a[k]` with a dynamic index, `a[0]` on a
  string array: `element-access-unsupported`), array literals of objects / dynamics, writes to
  a `const`, and the wasi-only direct-call plan (class P).
- `__ir_dyn_call_box` / `__dyn_member_get` ABI identity (loose `==` on the carrier, `in`,
  regex): from-ast lowers these, so the predicates admit them; they fail later at preparation on
  standalone / gc. Unchanged.
- `void` outside planned closures: from-ast now refuses the observing uses everywhere (above),
  but a top-level function's selector does not refuse them up front (they demote after the
  claim to the correct legacy body).
- `isValueVoid` looks through parentheses and commas only, so a type assertion hides the
  sentinel: `(void 0 as any) == null` is still IR-claimed and wrong (2 where node gives 3) on
  every lane, identically on base. Peeling `as` / `!` / `satisfies` there would move gc
  host-assisted bytes, so it is left for its own change.
- The strict undefined compare (`tryLowerUndefinedCompare`) keeps its own dispatch over the
  other operand (tag test, externref probe, checker-proved fold); the shared predicate only
  excludes the `void` sentinel there.
- The top-level move-only scan (`concreteDynamicAssignmentOperandIsBuildable`, select.ts)
  keeps its own spelling of the boxable families; folding it in would move top-level selection
  and host-assisted bytes.
