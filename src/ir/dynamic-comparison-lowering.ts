// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2949 S5.3, #7354 L0a) The front end's comparisons over the dynamic value: which operand pairs take the carrier, and
 * the relational operators' lowering. Equality over the carrier is `dyn.eq` (from-ast's `tryLowerDynamicEq`); on the
 * Prepared path both are expanded by the dynamic-value legalization (`program/dynamic-comparisons.ts`), and on the
 * ordinary pipeline the relational helpers are codegen's (`dyn-ops.ts`).
 */
import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { asVal, irVal, type IrBinop, type IrType, type IrValueId } from "./nodes.js";
import { storedCarrierValue, type FunctionObjectLoweringHost } from "./function-object-lowering.js";
import { IrUnsupportedError } from "./outcomes.js";
import {
  IR_DYN_GE_FN,
  IR_DYN_GT_FN,
  IR_DYN_LE_FN,
  IR_DYN_LT_FN,
} from "../shared/contracts/dynamic-operator-helpers.js";

/** What a comparison is lowered with: from-ast's function-object host (its builder, boxing and lane). */
export type ComparisonLoweringHost = FunctionObjectLoweringHost;

const RELATIONAL: ReadonlyMap<ts.SyntaxKind, { readonly binop: IrBinop; readonly helper: string }> = new Map([
  [ts.SyntaxKind.LessThanToken, { binop: "f64.lt", helper: IR_DYN_LT_FN }],
  [ts.SyntaxKind.LessThanEqualsToken, { binop: "f64.le", helper: IR_DYN_LE_FN }],
  [ts.SyntaxKind.GreaterThanToken, { binop: "f64.gt", helper: IR_DYN_GT_FN }],
  [ts.SyntaxKind.GreaterThanEqualsToken, { binop: "f64.ge", helper: IR_DYN_GE_FN }],
]);
const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * (#7354 L0a) On the Prepared lane, whether a comparison takes the carrier: every pair except two dynamic values (the
 * front end's dynamic arm already has them) and the typed fast paths, which are two scalars of one kind (two numbers)
 * and two strings under an equality operator. A string relational, a string against a non-string, two scalars of
 * different kinds (a Boolean against a number) and an object or function operand are JavaScript's coercions, which the
 * carrier's legalization implements.
 */
export function comparisonTakesCarrier(
  op: ts.SyntaxKind,
  lt: IrType,
  rt: IrType,
  host: ComparisonLoweringHost,
): boolean {
  if (!host.createsFunctionObjects() || (!RELATIONAL.has(op) && !EQUALITY.has(op))) return false;
  if (lt.kind === "dynamic" && rt.kind === "dynamic") return false;
  if (lt.kind === "string" && rt.kind === "string") return RELATIONAL.has(op);
  const [lv, rv] = [asVal(lt), asVal(rt)];
  return lv === null || rv === null || lv.kind !== rv.kind;
}

/**
 * A comparison operand as the dynamic value: as is, or a concrete value stored into the carrier (on the Prepared lane
 * also an object or a closure's function value, `storedCarrierValue`); `null` where it has no carrier.
 */
export function carrierOperand(
  value: IrValueId,
  source: ts.Expression,
  host: ComparisonLoweringHost,
): IrValueId | null {
  const carried = storedCarrierValue(value, source, host);
  return host.builder.typeOf(carried).kind === "dynamic" ? carried : null;
}

/**
 * The end of the front end's dynamic arm when no producer took the operands: (L0a) a comparison taken for the carrier
 * whose operand has none is a capability gap; any other pair broke the producer promise.
 */
export function dynamicOperandsUnlowered(op: ts.SyntaxKind, carrierComparison: boolean, funcName: string): Error {
  const operator = ts.tokenToString(op);
  if (carrierComparison)
    return new IrUnsupportedError(
      "operand-coercion-unsupported",
      "build",
      `ir/from-ast: '${operator}' operand has no dynamic carrier in ${funcName}`,
    );
  // invariant (producer-promise): every admitted dynamic operand pair has a producer — #7144.
  return new Error(`ir/from-ast: admitted dynamic '${operator}' has no lowering in ${funcName}`);
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
  host: ComparisonLoweringHost,
): IrValueId | null {
  const relational = RELATIONAL.get(op);
  if (relational === undefined) return null;
  const helper = (l: IrValueId, r: IrValueId): IrValueId => {
    const result = host.builder.emitCall(irRuntimeFuncRef(relational.helper), [l, r], irVal({ kind: "i32" }));
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
    return host.builder.emitBinary(relational.binop, lf, rf, irVal({ kind: "i32" }));
  }
  if (!host.createsFunctionObjects()) return null;
  const dynL = carrierOperand(lhs, expr.left, host);
  const dynR = carrierOperand(rhs, expr.right, host);
  return dynL === null || dynR === null ? null : helper(dynL, dynR);
}
