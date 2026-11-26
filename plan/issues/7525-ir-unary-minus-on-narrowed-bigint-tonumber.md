---
id: 7525
title: "Standalone IR: `-t` / `+t` on an `any` narrowed to bigint runs ToNumber (`String(-t)` is \"NaN\")"
status: in-progress
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
related: [7135, 7497, 6656]
---

# #7525 — IR unary `-` / `+` on an `any` narrowed to `bigint` runs ToNumber

## Problem

Standalone, `function f(t: any): string { if (typeof t === "bigint") return String(-t); return "o"; } f(5n)` answers
`"NaN"` (node: `"-5"`). Found by RV7459 (review of #7459). Measured by S18, TypeScript, standalone:

| program (`t: any`, narrowed by `typeof t === "bigint"`, called with `5n`) | node | c75ee1a01f^ | c75ee1a01f | main 1a726b3e64 |
| --- | --- | --- | --- | --- |
| `String(-t)` | `"-5"` | right | `"NaN"` | `"NaN"` |
| `String(-t)` with `-7n` | `"7"` | right | wrong | wrong |
| `typeof -t` | `"bigint"` | right | `"number"` | `"number"` |
| `+t` | TypeError | TypeError | TypeError | `NaN`, no throw |
| controls: `-t === -5n`, `String(t * -1n)`, `const k: any = -t`, un-narrowed `t: bigint` | — | right | right | right |

gc answers right in every row: there the IR refuses `f` (`call-graph-closure`) and legacy compiles it.

## Cause

- **Bisect.** `c75ee1a01f` (#7135, "lower native dynamic in …; certify explicit-any caller boundaries") is the first bad
  commit for the `-` rows: S18 compared it with its parent; RV7459's automated bisect named it. From it on, the IR
  claims `f` on standalone (`trackIrOutcomes`: `f` emitted, not refused). The `+t` row was still right at
  `c75ee1a01f` (legacy compiled that shape); a later admission let the IR claim it. Not bisected.
- **Mechanism.** `lowerPrefixUnary` (`src/ir/from-ast.ts`) lowers `-x` / `+x` on a `dynamic` operand as
  `dyn.to_number`, then `f64.neg` for `-` (the #2949 S5.5 arms). That is ToNumber; §13.5.4 / §13.5.5 take ToNumeric for
  `-` (a BigInt is negated as a BigInt) and ToNumber for `+` (a BigInt throws TypeError). The IR has no BigInt value, so
  a BigInt operand cannot be lowered there. The selector admits both shapes for any dyn-shaped operand
  (`dynamicUsesAreMoveOnly` → `scanExpr`, `src/ir/select.ts` ~L4072) without asking what the checker knows about it.
- Legacy is right: `expressions/unary.ts` negates a checker-bigint operand on the i64 lane, or with
  `__bigint_carrier_neg` on a carrier, and its `+` ToNumber throws on a BigInt.

## Implementation Plan

### Approach

Refuse, at selection, a unary `-` or `+` whose operand the checker types as `bigint`; legacy compiles that unit, as
it did before #7135. On the Prepared whole-program path, which has no selector, the builder refuses the same shape by
name, at the point it would lower it (the #7364 pattern). Both ask ONE checker-backed predicate, so the two pipelines
cannot disagree.

Not chosen: a ToNumeric `dyn.negate` op. It would also fix the un-narrowed `any` case, which is NOT this
regression: legacy gets it wrong too (it answers NaN). It needs a new dialect op in ~10 exhaustive switches
(builder, verifier, effects, inline-small, monomorphize, legalization, lower-generic, prepared dependencies,
async-linear) and a `dynamic` result where the selector and builder now promise `f64`. That is the IR's general
BigInt foundation, and it belongs in its own issue, not in a regression fix.

### Target structure

1. **`src/ir/module-bindings.ts`** — `makeIrBigIntExpressionPredicate(checker)`, next to its siblings
   `makeIrArrayExpressionPredicate` / `makeIrRegExpExpressionPredicate`, in the same shape:
   `checker.getTypeAtLocation(unwrapParens(expr))` is BigInt-like, or a union whose non-nullish members all are;
   `false` on a throw. It is registered in `makeIrCheckerSelectionOptions` as `isBigIntExpression`, so every planner
   that uses the shared factory (`codegen/index.ts`, `ir/integration.ts`, the linear backend, the fallback gate)
   gets it with no per-planner wiring.
2. **`src/ir/select.ts`** — `IrSelectionOptions.isBigIntExpression?: (expr) => boolean`, documented like
   `isRegExpExpression` (checker-backed, absent ⇒ unproven ⇒ claim as today). In `dynamicUsesAreMoveOnly`'s
   prefix-unary arm, `+` / `-` on a dyn-shaped operand returns `false` when
   `currentSelectionOptions?.isBigIntExpression?.(op) === true`. `!` stays: ToBoolean of a BigInt is exact on the
   carrier.
3. **`src/ir/from-ast.ts`** — `lowerPrefixUnary`'s two `dynamic` arms (`-`, `+`) throw
   `IrUnsupportedError("operand-coercion-unsupported", "build", …)` when the same predicate, built once per lowering
   from `cx.checker`, answers true. On the ordinary pipeline this branch is unreachable (the selector refused first),
   and it states the producer contract the Prepared path otherwise lacks. The existing
   `checkerProvesUnaryCoercionGap` is NOT reused: its `checkerOperandFamily` folds BigInt into `"other"` together
   with objects, for which ToNumber is right.

### What it reuses, what it removes

- Reuses the shared checker-selection factory and the sibling predicate shape; no new resolver wiring.
- Reuses the existing refusal code `operand-coercion-unsupported`; no new code in the fallback buckets.
- Removes nothing: there is no duplicate to fold. The predicate is the only BigInt question either pipeline asks.

### Acceptance criteria

- **Correctness.** Pins in `tests/issue-7525-ir-unary-minus-narrowed-bigint.test.ts`, on gc and standalone, against
  node's answer: every row in the table above, plus `-t` / `+t` on a narrowed `bigint | undefined` and a non-narrowed
  number control that the IR keeps claiming (`trackIrOutcomes` shows `f` emitted). The pins fail on main and pass
  after.
- **Prepared path.** One pin runs `TEST262_COMPILER_PATH=ir`-equivalent options (`wholeProgram:
  { kind: "prepared-program-required" }`) and expects the named refusal, not a wrong value.
- **No regression.** Bytes identical to main on the 160-file test262 sample × {gc, standalone} and on the IR fallback
  corpus (`pnpm run check:ir-fallbacks` unchanged); only units with a BigInt-typed unary operand move.
- **Code quality.** One predicate, two askers. The selector arm and the builder arm are one-line conditions in the
  existing `-`/`+` arms, with no new branches elsewhere. No growth in `select.ts` / `from-ast.ts` past their
  budgets without a written reason. Reviewed adversarially before release.

### Left open (separate issues)

- Un-narrowed `-t` / `+t` on an `any` holding a BigInt answers NaN on both pipelines (pre-existing): needs the IR's
  ToNumeric `dyn.negate` above, and legacy's `any` negate to call `__bigint_carrier_neg`.
