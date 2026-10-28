---
id: 7183
title: "IR: compound assignment `%=`, `**=` and the bitwise operators on number slots — one numeric binary emitter for `a op b` and `x op= b`"
status: ready
created: 2026-10-28
updated: 2026-10-28
assignee: ttraenkler/opus-ir-compound
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
language_feature: compound-assignment
goal: ir-full-coverage
sprint: current
parent: 7143
related: [7144, 3741, 5163]
---

# #7183 — IR: `%=`, `**=` and bitwise compound assignment on number slots

## Problem

The #7143 B1 census (PR #6956; `JS2WASM_IR_SHAPE_DIAG=1 node --import tsx
scripts/measure-legacy-reach.mjs --target standalone --blockers 4`, full B0
corpus, measured 2026-10-28) ranks `nontail-compound-or-binary-stmt` as the
blocker with the most units that it alone keeps on legacy: **13 of its 16
first-blocker units have no other blocker**, so fixing it claims them outright.
Every one is a compound assignment statement with an operator the selector does
not admit:

```ts
x %= 5;  x |= 3;  x &= 9;  x <<= 3;  x >>= 2;   // compound-assignment-coercion.test.ts #4–#8
```

`isF64CompoundAssignOperator` (`src/ir/analysis/operand-admissibility.ts`)
admits only `+= -= *= /=`, and from-ast's `compoundF64Binop` maps exactly those
four to `f64.add/sub/mul/div`. Yet `lowerBinary` (`src/ir/from-ast.ts`) already
lowers the binary forms of all the missing operators on numbers:

| operator | `lowerBinary` producer |
| --- | --- |
| `%` | `emitNumberRemainder` with `remainderFastPathPlan` + `fmodRefFor` |
| `**` | the `AsteriskAsteriskToken` arm |
| `& \| ^ << >> >>>` | `js.bitand/bitor/bitxor/shl/shr_s/shr_u`, result f64 |

So `compoundF64Binop` is a second, smaller copy of `lowerBinary`'s numeric
switch, and the operators missing from the copy are the coverage gap.

## Implementation Plan

**Target structure (quality criterion first).**

1. **One numeric binary emitter.** Extract from `lowerBinary` the part that,
   given two already-lowered number operands, emits `+ - * / % ** & | ^ << >>
   >>>` (including `%`'s fast-path plan and `**`'s helper), as
   `emitNumberBinary(op: BinaryOperator, lhs, rhs, left: ts.Expression,
   right: ts.Expression, cx)` next to `lowerBinary` in `src/ir/from-ast.ts` (or
   a sibling module under `src/ir/` if from-ast's func budget requires it; same
   layer). `lowerBinary` calls it for number operands; behaviour unchanged.
2. **Compound reuses it.** `lowerCompoundAssignment` maps the compound token to
   its binary operator (`ts.SyntaxKind.PercentEqualsToken` → `PercentToken`, …)
   and calls `emitNumberBinary` with the slot read as `lhs`. **Delete
   `compoundF64Binop`.** The string `+=` and the i32-promoted
   (`lowerPromotedI32CompoundAssignment`, #3741) arms stay as they are.
3. **Selector admits the same set.** Widen `isF64CompoundAssignOperator` in
   `operand-admissibility.ts` to the full numeric compound set (rename to
   `isNumberCompoundAssignOperator`; all six call sites in `select.ts` follow).
   `compoundWriteAdmissible` keeps its families: a number slot and a number or
   `undefined` value. The selector and from-ast keep using the one predicate
   (#7144), so a new operator cannot be admitted without a producer.
4. Out of scope (separate blockers in the census): element/property targets
   (`obj[key] %= 3`), module-scope compounds (`tail-module-compound`, 5 units),
   logical assignment, BigInt operands.

**Acceptance.**

- `tests/issue-7183-ir-compound-numeric.test.ts`: for each of `%= **= &= |= ^=
  <<= >>= >>>=` on a function-local number, the function is IR-claimed with
  zero post-claim errors and the result equals node, on standalone and gc.
  Include ToInt32 edges (`x = 2**32 + 5; x |= 0`, negative shifts, `>>>=` of a
  negative, shift counts ≥ 32), `%=` with negative / fractional / zero / NaN
  operands, and `**=` with `NaN`/`Infinity`.
- The 5 `compound-assignment-coercion.test.ts` cases (#4–#8) claim on IR.
- Existing `+= -= *= /=` output is **byte-identical** to main on the
  equivalence corpus and the playground examples, gc and standalone (the
  extraction must not change a single instruction). Quote the counts.
- Census re-run: `nontail-compound-or-binary-stmt` first-blocker count drops
  by at least 13 on the full corpus; standalone demoted total drops by ≥ 13.
- `compoundF64Binop` is gone; no new operator table exists outside
  `emitNumberBinary` and the selector predicate.
- Gate chain bare: loc, func, coercion, oracle, dead-exports, import-cycles,
  compiler-boundaries, ir-layering, ir-fallbacks, flat-dir, standalone-arms.
