// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4208 S1) §7.2.16 IsStrictlyEqual step 1 — "If Type(x) is different from
 * Type(y), return false" — for the SCALAR operand regime.
 *
 * ## The defect
 *
 * `1 === true` answered **true**. `compileBinaryExpression` sees an `f64` left
 * and an `i32` right, promotes the `i32` with `f64.convert_i32_s`, and only
 * then dispatches — reaching `compileNumericBinaryOp`, which emits `f64.eq`.
 * Boolean and Number share the f64 slot, so the promotion **erases `Type()`
 * before the comparison ever runs**:
 *
 * ```wat
 * f64.const 1        ;; 1
 * i32.const 1        ;; true
 * f64.convert_i32_s  ;; <-- Type() dies here
 * f64.eq             ;; => 1
 * ```
 *
 * Measured 2026-08-07 on `origin/main@1f613276d8`, `--target standalone`: a
 * 27-cell strict-equality matrix over every ES5 `Type()`-disjoint pair found
 * **Number ⊥ Boolean to be the only broken pair**, in both operand orders,
 * for both `===` and `!==`, and for both literals and locals. String↔Boolean,
 * String↔Number, wrapper-object↔primitive and object-literal↔primitive all
 * already answer correctly — they never reach the scalar regime, because a
 * string/object operand is an `externref` or a struct `ref` and is handled by
 * the `#296` cross-type arm further down. So this file deliberately covers
 * exactly one pair rather than reimplementing a general Type() table that
 * would duplicate working code.
 *
 * ## Why deciding this STATICALLY is sound, in an issue about static types
 *
 * #4208 is "operator abstract-ops are lowered from the static TypeScript type
 * rather than the runtime value", so adding *more* static folding needs an
 * explicit argument. The argument is that this fold keys on the **agreement
 * between the Wasm representation and the static type**, not on the static
 * type alone:
 *
 * - An operand whose runtime value may be of a JS type other than its declared
 *   one is never given a scalar slot. It is boxed — `externref` in the JS-host
 *   lane, `$AnyValue` in standalone — precisely because the representation has
 *   to carry a tag. Those operands never reach this arm.
 * - The known escape where a scalar slot outlives a truthful static type is
 *   excluded: a bare `var` used as a **for-in target** (dynamically a
 *   property-key string while TypeScript still reports the initializer's type
 *   — the same `forInIdentifierVars` guard the `#296` externref arm carries).
 *   Heterogeneously-assigned bindings and non-Number `++`/`--` targets are
 *   routed onto dynamic storage, so they cannot arrive here as `i32`/`f64`.
 * - `i32` is not a boolean marker on its own: a `type i32 = number` annotation
 *   and `string.length` both produce `i32` with a *number* static type. The
 *   boolean side therefore demands `isBooleanType` **and** the absence of every
 *   other primitive predicate, so a numeric `i32` can never be read as Boolean.
 *
 * The fold is refused whenever any of those hold, which is the difference
 * between "trust the declared type" and "trust a representation the compiler
 * itself chose and cannot have chosen for a differently-typed value".
 *
 * Loose equality is untouched: `1 == true` is genuinely `true` (§7.2.13 applies
 * ToNumber to the Boolean), and the existing f64 collapse computes that
 * correctly by accident of representation.
 */
import { ts } from "../ts-api.js";
import { isBigIntType, isBooleanType, isNumberType, isStringType } from "../checker/type-mapper.js";
import type { ValType } from "../ir/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { FunctionContext } from "./context/types.js";

/** The §6.1 language types this fold can decide from a scalar representation. */
export type ScalarJsTypeClass = "number" | "boolean";

/**
 * Classify an operand's §6.1 `Type()` from its Wasm representation *and* its
 * static type, returning `undefined` unless the two agree unambiguously.
 *
 * `isDynamicallyRetyped` is the caller's escape hatch for a binding whose
 * static type is known to be stale at this use (today: a for-in target).
 */
export function scalarJsTypeClass(
  tsType: ts.Type,
  valType: ValType,
  isDynamicallyRetyped: boolean,
): ScalarJsTypeClass | undefined {
  if (isDynamicallyRetyped) return undefined;
  const num = isNumberType(tsType);
  const bool = isBooleanType(tsType);
  const str = isStringType(tsType);
  const big = isBigIntType(tsType);
  // Exactly one primitive predicate may hold. A union (`number | boolean`)
  // carries none of these flags on the union type itself and is refused here;
  // an intersection or an odd synthetic type that trips two is refused too.
  if (valType.kind === "f64" && num && !bool && !str && !big) return "number";
  if (valType.kind === "i32" && bool && !num && !str && !big) return "boolean";
  return undefined;
}

/** Is this identifier a `var` the enclosing function also drives as a for-in target? */
export function isDynamicForInOperand(fctx: FunctionContext, expr: ts.Expression): boolean {
  return ts.isIdentifier(expr) && fctx.forInIdentifierVars?.has(expr.text) === true;
}

/**
 * Emit the §7.2.16 step-1 constant when the two SCALAR operands are provably
 * of different §6.1 types, or return `undefined` to let the caller proceed.
 *
 * Both operands are already on the stack (left below right), so the fold drops
 * them in place to preserve their side effects and pushes the `i32` result —
 * the same shape the mixed-`i64`/`f64` strict-eq arm in the typed dispatch uses
 * for BigInt ⊥ Number.
 */
function tryFoldStrictEqTypeDisjoint(
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  leftType: ValType,
  rightType: ValType,
  leftTsType: ts.Type,
  rightTsType: ts.Type,
): ValType | undefined {
  const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!isStrictEq && !isStrictNeq) return undefined;

  const leftStale = isDynamicForInOperand(fctx, expr.left);
  const leftClass = scalarJsTypeClass(leftTsType, leftType, leftStale);
  if (leftClass === undefined) return undefined;
  const rightStale = isDynamicForInOperand(fctx, expr.right);
  const rightClass = scalarJsTypeClass(rightTsType, rightType, rightStale);
  if (rightClass === undefined) return undefined;
  if (leftClass === rightClass) return undefined;

  // Drop both operands (side effects already emitted) and answer from Type().
  fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
  return { kind: "i32" };
}

/**
 * The §7.2.16 step-1 fold **and** the i32↔f64 operand promotion that follows
 * it, as one call — because their ORDER is the whole fix.
 *
 * The promotion (`f64.convert_i32_s` on whichever operand is `i32`) was written
 * for `string.length:i32 !== 8:f64`, where both sides really are Numbers. It
 * fires on every i32/f64 pair, so running it first merges a Boolean into the
 * f64 slot and `Type()` is gone before any comparison can consult it. Keeping
 * the two steps in separate places invites re-introducing the bug by moving
 * one; keeping them here makes the sequence the module's contract.
 *
 * Returns `folded` when the operands are provably of different §6.1 types
 * (caller returns it directly), otherwise the possibly-promoted operand types.
 */
export function foldTypeDisjointThenPromote(
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  leftType: ValType,
  rightType: ValType,
  leftTsType: ts.Type,
  rightTsType: ts.Type,
): { folded?: ValType; leftType: ValType; rightType: ValType } {
  const folded = tryFoldStrictEqTypeDisjoint(fctx, expr, op, leftType, rightType, leftTsType, rightTsType);
  if (folded !== undefined) return { folded, leftType, rightType };

  if (leftType.kind === "i32" && rightType.kind === "f64") {
    const tmpR = allocTempLocal(fctx, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: tmpR });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.get", index: tmpR });
    releaseTempLocal(fctx, tmpR);
    return { leftType: { kind: "f64" }, rightType };
  }
  if (leftType.kind === "f64" && rightType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { leftType, rightType: { kind: "f64" } };
  }
  return { leftType, rightType };
}
