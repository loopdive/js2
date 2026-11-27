---
id: 7525
title: "Standalone IR: arithmetic on an `any` narrowed to bigint runs ToNumber (`String(-t)` is \"NaN\")"
status: done
completed: 2026-11-26
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: core-semantics
related: [7135, 7497, 6656, 7526, 7403]
# (2026-11-26) Each line is the new option's declaration, its import, or a one-line call at an existing arm; the
# predicate, the option builder and the refusal live in src/ir/bigint-operand-refusal.ts.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/codegen/index.ts
  # (2026-11-27) +27: `bigIntOperandOption` moved here from bigint-operand-refusal.ts (net 0 across the two), so
  # the checker value import rides module-bindings.ts's existing ir->checker and codegen->ir edges (import-cycles).
  - src/ir/module-bindings.ts
func-budget-allow:
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
  - src/ir/from-ast.ts::lowerBinary
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  # (2026-11-26, RV7497 finding 3) +2: the move-only scan's named decline replaces the generic one.
  - src/ir/select.ts::whyNotIrClaimable
---

# #7525 — IR arithmetic on an `any` narrowed to `bigint` runs ToNumber

## Problem

Standalone, `function f(t: any): string { if (typeof t === "bigint") return String(-t); return "o"; } f(5n)` answers
`"NaN"` (node: `"-5"`). Found by RV7459 (review of #7459); scope widened by PRV-7525 (plan review of ce535aec).

Measured by S18, TypeScript, `f(t: any, u: any)` with both narrowed by `typeof … === "bigint"` (or as noted), on
standalone. "IR" means `trackIrOutcomes` shows `f` emitted; otherwise the refusal code.

| shape | node | c75ee1a01f^ | c75ee1a01f | main 1a726b3e64 |
| --- | --- | --- | --- | --- |
| `String(-t)` (`5n`) | `"-5"` | right (legacy) | `"NaN"` (IR) | `"NaN"` (IR) |
| `+t` | TypeError | right | NaN, no throw | NaN, no throw |
| `String(t * t)`, `t - u`, `t / u`, `t % u` | BigInt result | right | wrong | wrong |
| `t * 2` | TypeError | right | no throw | no throw |
| `k++`, `--k` on a narrowed copy `let k = t` | BigInt result | right | wrong | wrong |
| `t + u` | `7n` | — | — | wrong (IR) |
| `t != u` (`5n`, `5n`) | false | — | — | wrong (IR) |
| `t == 1` (`1n`) | true | — | — | traps (IR) |
| `-t` on `t` narrowed to `bigint \| number` | `-5n` / `-3` | wrong (legacy) | wrong (IR) | wrong (IR) |
| already right: `t === u`, `t + ""`, `t < u` / `t > u` (refused, `operand-coercion-unsupported`), `t + 1` (refused), un-narrowed `t: bigint` | | | | right |

`—`: not run at those commits. The `+` / `==` / `!=` rows are claimed by the same `f` admission, so they are taken to
share the cause; they are not bisected.

gc answers right in every row but the `bigint | number` one: there the IR refuses `f` (`call-graph-closure`) and
legacy compiles it. Legacy is wrong on `bigint | number` too (pre-existing, #7526).

## Cause

- **Bisect.** `c75ee1a01f` (#7135, "… certify explicit-any caller boundaries") is the first bad commit for every
  bisected row: S18 compared it with its parent; RV7459's automated bisect named it. From it on the IR claims `f` on
  standalone.
- **Mechanism.** The IR has no BigInt value. Its dynamic-operand arms run ToNumber (`dyn.to_number`) or a
  number/string addition or loose equality, where the spec takes ToNumeric (§13.5.4–5, §13.15.3, §13.4) or
  IsLooselyEqual's BigInt steps (§7.2.15):
  - selector (`src/ir/select.ts`, `dynamicUsesAreMoveOnly` → `scanExpr`): `+` arm (~L3972), equality arm (~L3995),
    `- * / %` arm (~L4051, "#2949 S5.P"), prefix `+ -` and `++ --` arms (~L4072–4089);
  - builder (`src/ir/from-ast.ts`): `lowerPrefixUnary`'s dynamic `-` / `+` arms, `relOperandToF64` (arithmetic),
    the dynamic `++` / `--` arm (~L13556), the dynamic `+` and loose-equality producers.
- Legacy is right on a checker-`bigint` operand: `expressions/unary.ts` negates on the i64 lane or with
  `__bigint_carrier_neg`; `binary-ops.ts` takes its BigInt arms.

## Implementation Plan

### Approach

The IR refuses, at selection, every dynamic-operand arithmetic, update, addition or loose-equality arm whose operand
the checker types with a BigInt member; legacy compiles that unit, as before #7135. The Prepared whole-program path,
which has no selector, refuses the same shapes at build through `refuseUnselected` (the #7364 / #7354 D1 pattern).
Both ask ONE checker-backed predicate instance. The refusal is gated to the host-free lanes, so gc output stays
byte-identical. The real fix — ToNumeric dynamic ops that let the IR claim these units — is #7526.

### Target structure

1. **`src/checker/type-mapper.ts`** — split `typeMayBeBigInt` (#7371) into its two halves: a new exported
   `typeHasBigIntMember(type)` (`isBigIntType`, or a union with a member that is) and `typeMayBeBigInt = any/unknown ||
   typeHasBigIntMember`. No behaviour change for `typeMayBeBigInt`'s callers. "Some member", not every member: a
   narrowed `bigint | number` is wrong too.
2. **`src/ir/module-bindings.ts`** — `makeIrBigIntOperandPredicate(checker)`, a sibling of
   `makeIrRegExpExpressionPredicate` in the same shape (`getTypeAtLocation(unwrapParens(expr))`, `false` on a throw),
   answering `typeHasBigIntMember`. Memoised per checker (the `makeIrPrimitiveExpressionClassifier` WeakMap), so the
   selector and the builder get the same instance. It is NOT added to `makeIrCheckerSelectionOptions`: that factory
   feeds gc planners too.
3. **Wiring, host-free only** — `isBigIntOperand` is set where `nativeRegExpCompiles` is set, only when there is no
   JavaScript embedder, using the condition each site already reads:
   - selector options: `codegen/index.ts` (~L3317, next to `nativeDynamicInBuildable: … hostFreeEnvironment(ctx)`) and
     `ir/integration.ts` `compileIrPathFunctions` (~L2603, `ctx.targetProfile.environment !== "javascript"`, the
     in-place read that file already uses to avoid the import cycle);
   - builder options: `ir/integration.ts` `makeFromAstResolver` (~L7215), same condition.
   No new target option: the environment question already exists; this only decides which planners get the predicate.
4. **`src/ir/select.ts`** — `IrSelectionOptions.isBigIntOperand?: (expr) => boolean`, documented like
   `isRegExpExpression` (absent ⇒ unproven ⇒ claim as today). One helper next to `dynamicUsesAreMoveOnly`'s other
   operand predicates:
   `const refusesNumericOperand = (op) => currentSelectionOptions?.isBigIntOperand?.(op) === true;`
   asked at each dynamic arm in (Cause) for each dyn-shaped operand, returning `false` (not claimed) when it answers
   true. `!` and `===` stay: ToBoolean and strict equality are exact on the carrier.
5. **`src/ir/from-ast.ts`** — `IrFromAstResolver.isBigIntOperand?(expr)`, the same instance. One helper,
   `refuseBigIntNumericOperand(operand, cx)`, calls
   `refuseUnselected(cx.unselected, "operand-coercion-unsupported", …)` when the predicate answers true. It is asked at
   the builder arms in (Cause). On the ordinary pipeline the selector refused first, so `refuseUnselected` is an
   invariant there, not a withdrawal; on the Prepared path it is the named refusal.

### As built (2026-11-26)

- The predicate, the host-free option builder and the builder refusal live in `src/ir/bigint-operand-refusal.ts`, not
  in `module-bindings.ts`: one concern (the refusal), and the four wiring sites (both selector planners, the builder
  resolver, the Prepared resolver in `program-source-units.ts`) then need one spread line each, where a
  `module-bindings.ts` predicate needed a conditional object at each.
- (2026-11-27, quality fix) The checker-backed option builder `bigIntOperandOption` then moved to
  `module-bindings.ts`, beside `makeIrCheckerSelectionOptions`: in its own file it opened a new `ir -> checker` and
  `codegen -> ir` two-way edge (import-cycles ratchet). `bigint-operand-refusal.ts` keeps the checker-free selector
  and builder halves.
- The rule is shared as `isBigIntUnsafeDynamicOperator(op)` (every typed binary operator but strict equality); the
  builder also refuses at `lowerCompoundAssignment`'s dynamic arms (`*=`, `+=`, `-=`, `<<=`, …; RV7497).
- A selector decline carries `operand-coercion-unsupported` (latched by `capabilityNo`), not the generic
  `param-type-not-resolvable`.

### What it reuses, what it removes

- Reuses `isBigIntType` / `typeMayBeBigInt` (#7371), the sibling predicate shape and memo, the `nativeRegExpCompiles`
  wiring sites, `refuseUnselected`, and the existing refusal code `operand-coercion-unsupported`.
- Removes the BigInt-member check's would-be duplicate: `typeMayBeBigInt` and the new predicate share
  `typeHasBigIntMember`.

### Acceptance criteria

- **Correctness.** `tests/issue-7525-ir-bigint-numeric-operand.test.ts`, on gc and standalone against node's answer:
  every row of the table (unary, binary `- * / %`, `t * 2`, `++` / `--`, `t + u`, `t != u`, `t == 1`, `bigint | number`),
  plus the already-right controls and a `typeof t === "number"` control that the IR keeps claiming (`trackIrOutcomes`
  shows `f` emitted). The rows that are wrong on main fail on main and pass after. `bigint | number` is pinned as
  "refused by the IR"; legacy's answer is still wrong on both lanes (#7526), so node's value is not asserted.
- **Prepared path.** One pin under `wholeProgram: { kind: "prepared-program-required" }` expects the named refusal
  `operand-coercion-unsupported`, not a wrong value.
- **Bytes.** gc output identical to main on the 160-file test262 sample and the IR fallback corpus. Standalone
  identical except units with a BigInt-typed numeric operand; every such unit in the sample is listed in the PR.
  `pnpm run check:ir-fallbacks` reports no growth in unintended buckets.
- **Code quality.** One predicate, built on `isBigIntType` through `typeHasBigIntMember`; one selector helper asked at
  every dynamic numeric arm; the builder asks the same instance through one helper and `refuseUnselected`. No growth
  in `select.ts` / `from-ast.ts` past their budgets without a written reason. Adversarial review before release.

### Left open

- **#7526** — a ToNumeric dynamic numeric op family (`neg`, binary `- * / %`, `++` / `--`, BigInt-aware `+` and loose
  equality), so the IR can claim these units instead of refusing them; it also fixes un-narrowed `any` holding a
  BigInt and `bigint | number` on both pipelines.
