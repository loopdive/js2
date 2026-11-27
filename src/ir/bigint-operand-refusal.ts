// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7525) The IR has no BigInt value: its dynamic numeric, additive and loose-equality operators run ToNumber, a
 * Number addition or Number loose equality on the carrier, where the spec takes ToNumeric. On a host-free lane the
 * selector therefore refuses such an operator when the checker types an operand with a BigInt member, and legacy
 * compiles the unit; the Prepared path, which has no selector, refuses it by name at build. Both ask the one
 * predicate, built by `bigIntOperandOption` (module-bindings.ts, beside the other checker-backed selection options).
 * The ToNumeric ops that let the IR claim these units are #7526.
 */
import type { ts } from "../ts-api.js";
import { refuseUnselected } from "./outcomes.js";

export type BigIntOperandPredicate = (expr: ts.Expression) => boolean;

/** Does an operand have a BigInt member? `undefined` (a JavaScript-environment lane, or no checker) answers no. */
export function someBigIntOperand(
  isBigIntOperand: BigIntOperandPredicate | undefined,
  ...operands: readonly ts.Expression[]
): boolean {
  return isBigIntOperand !== undefined && operands.some(isBigIntOperand);
}

/** The builder's side: a selector refused this operator, so meeting it here names that refusal (`refuseUnselected`). */
export function refuseBigIntDynamicOperand(
  cx: {
    readonly resolver?: { isBigIntOperand?: BigIntOperandPredicate };
    readonly unselected?: boolean;
    readonly funcName: string;
  },
  ...operands: readonly ts.Expression[]
): void {
  if (!someBigIntOperand(cx.resolver?.isBigIntOperand, ...operands)) return;
  refuseUnselected(
    cx.unselected,
    "operand-coercion-unsupported",
    `ir/from-ast: dynamic numeric operator on a BigInt operand in ${cx.funcName} (#7526)`,
  );
}
