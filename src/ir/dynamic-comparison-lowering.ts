// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2949 S5.3, #3167, #7354 L0a) The front end's relational and equality comparisons that are not two proven numbers:
 * which operand pairs take the dynamic carrier, the relational operators over it, and the compare of two typed
 * strings. Equality over the carrier is `dyn.eq` (from-ast's `tryLowerDynamicEq`). On the Prepared path the carrier
 * operators are expanded by the dynamic-value legalization (`program/dynamic-comparisons.ts`); on the ordinary
 * pipeline the relational helpers are codegen's (`dyn-ops.ts`).
 */
import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "./callable-bindings.js";
import { asVal, irVal, type IrType, type IrValueId } from "./nodes.js";
import { storedCarrierValue, type FunctionObjectLoweringHost } from "./function-object-lowering.js";
import { IR_STRING_COMPARE_FN } from "./runtime-symbols.js";
import { isEqualityOperator } from "./analysis/operand-admissibility.js";
import { RELATIONAL_OPERATORS, type RelationalOperator } from "../shared/contracts/dynamic-operator-helpers.js";

const I32 = irVal({ kind: "i32" });

/** The relational operator `op` is, if it is one. */
function relationalOperator(op: ts.SyntaxKind): RelationalOperator | undefined {
  const token = ts.tokenToString(op);
  return token !== undefined && Object.hasOwn(RELATIONAL_OPERATORS, token)
    ? RELATIONAL_OPERATORS[token as keyof typeof RELATIONAL_OPERATORS]
    : undefined;
}

/**
 * (#7354 L0a) On the Prepared lane, whether a comparison takes the carrier: every pair except two dynamic values (the
 * front end's dynamic arm already has them) and the typed paths, which are two numeric scalars of one kind (two
 * numbers) and two strings; an `externref` scalar is an object value, not a number. A string against a non-string, two
 * scalars of different kinds (a Boolean against a number) and an object or function operand are JavaScript's
 * coercions, which the carrier's legalization implements.
 */
export function comparisonTakesCarrier(
  op: ts.SyntaxKind,
  lt: IrType,
  rt: IrType,
  host: FunctionObjectLoweringHost,
): boolean {
  if (!host.onPreparedDynamicLane() || (relationalOperator(op) === undefined && !isEqualityOperator(op))) return false;
  if ((lt.kind === "dynamic" && rt.kind === "dynamic") || (lt.kind === "string" && rt.kind === "string")) return false;
  const [lv, rv] = [asVal(lt), asVal(rt)];
  return lv === null || rv === null || lv.kind !== rv.kind || lv.kind === "externref";
}

/**
 * A comparison operand as the dynamic value: as is, or a concrete value stored into the carrier (on the Prepared lane
 * also an object or a closure's function value, `storedCarrierValue`); `null` where it has no carrier.
 */
export function carrierOperand(
  value: IrValueId,
  source: ts.Expression,
  host: FunctionObjectLoweringHost,
): IrValueId | null {
  const carried = storedCarrierValue(value, source, host);
  return host.builder.typeOf(carried).kind === "dynamic" ? carried : null;
}

/**
 * #2949 S5.3/S5.5 — coerce ONE numeric-abstract operand to `f64` (shared by the relational compare and the
 * numeric-arithmetic arm): a dynamic carrier ToNumbers via `dyn.to_number`; a concrete `f64` is used as-is. Any other
 * concrete kind (i32/ref/string) returns `null` so the caller demotes cleanly — these slices only convert the dynamic
 * side (numeric literals lower to `f64` under the f64 hint the operands were lowered with, so `dyn > 0` / `dyn - 1` are
 * covered; a boolean partner arrives already converted by `lowerBinaryOperands`, #7282).
 */
export function relOperandToF64(v: IrValueId, t: IrType, builder: IrFunctionBuilder): IrValueId | null {
  if (t.kind === "dynamic") return builder.emitDynToNumber(v);
  const tv = asVal(t);
  if (tv && tv.kind === "f64") return v;
  return null;
}

/**
 * #2949 S5.3 — lower `dyn < x` / `dyn > x` / `dyn <= x` / `dyn >= x`. Two dynamic operands call the operator's helper
 * (IsLessThan with both ToPrimitives, string compare included); a dynamic operand against a number is the ToNumber of
 * the dynamic side and the `f64` compare, which is exact: a number on one side rules out the string×string compare.
 * (#7354 L0a) On the Prepared lane any other pair boxes its concrete operands into the carrier and calls the helper.
 * Returns `null` (clean demote) for a non-relational operator or an operand without a lowering here.
 */
export function tryLowerDynamicRelational(
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  lhs: IrValueId,
  rhs: IrValueId,
  lt: IrType,
  rt: IrType,
  host: FunctionObjectLoweringHost,
): IrValueId | null {
  const relational = relationalOperator(op);
  if (relational === undefined) return null;
  const helper = (l: IrValueId, r: IrValueId): IrValueId => {
    const result = host.builder.emitCall(irRuntimeFuncRef(relational.helper), [l, r], I32);
    if (result === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(
        `ir/from-ast: dynamic relational helper ${relational.helper} produced no result in ${host.funcName}`,
      );
    }
    return result;
  };
  if (lt.kind === "dynamic" && rt.kind === "dynamic") return helper(lhs, rhs);
  // Decided before anything is emitted: a ToNumber of one side that the other side then refuses would run its
  // conversion methods for nothing.
  if ([lt, rt].every((type) => type.kind === "dynamic" || asVal(type)?.kind === "f64")) {
    const lf = relOperandToF64(lhs, lt, host.builder)!;
    const rf = relOperandToF64(rhs, rt, host.builder)!;
    return host.builder.emitBinary(relational.number, lf, rf, I32);
  }
  if (!host.onPreparedDynamicLane()) return null;
  const dynL = carrierOperand(lhs, expr.left, host);
  const dynR = carrierOperand(rhs, expr.right, host);
  return dynL === null || dynR === null ? null : helper(dynL, dynR);
}

/**
 * (#3167) A both-string relational `<`/`>`/`<=`/`>=` (§7.2.13: code-unit order, not locale, not numeric): the -1/0/1
 * sign of the compare, folded to the operator's boolean by a signed i32 compare against 0 (the sign is total for two
 * strings). The ordinary pipeline calls the mode-resolved helper (`IR_STRING_COMPARE_FN`, `resolveFunc` in
 * integration.ts); (#7354 L0a) the Prepared lane's compare is the `js.value.string_compare` intrinsic, the one the
 * dynamic relational operators' string arm calls too.
 */
export function emitStringRelational(
  op: ts.SyntaxKind,
  lhs: IrValueId,
  rhs: IrValueId,
  host: FunctionObjectLoweringHost,
): IrValueId {
  const relational = relationalOperator(op)!;
  const sign = host.onPreparedDynamicLane()
    ? host.builder.emitIntrinsic("js.value.string_compare", [lhs, rhs])
    : host.builder.emitCall(irIntrinsicFuncRef(IR_STRING_COMPARE_FN), [lhs, rhs], I32);
  if (sign === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: string compare produced void result (${host.funcName})`);
  }
  const zero = host.builder.emitConst({ kind: "i32", value: 0 }, I32);
  return host.builder.emitBinary(relational.sign, sign, zero, I32);
}
