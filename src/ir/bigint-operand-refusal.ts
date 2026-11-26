// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7525) The IR has no BigInt value: its dynamic numeric, additive and loose-equality operators run ToNumber, a
 * Number addition or Number loose equality on the carrier, where the spec takes ToNumeric. On a host-free lane the
 * selector therefore refuses such an operator when the checker types an operand with a BigInt member, and legacy
 * compiles the unit; the Prepared path, which has no selector, refuses it by name at build. Both ask the one
 * predicate below. The ToNumeric ops that let the IR claim these units are #7526.
 */
import type { ts } from "../ts-api.js";
import { typeHasBigIntMember } from "../checker/type-mapper.js";
import { refuseUnselected } from "./outcomes.js";

type BigIntOperandPredicate = (expr: ts.Expression) => boolean;

const predicates = new WeakMap<ts.TypeChecker, BigIntOperandPredicate>();

/**
 * The `isBigIntOperand` selection and builder option: set on a host-free lane only, so a JavaScript-environment
 * unit is selected exactly as before. One predicate per checker, so the selector and the builder ask the same one.
 */
export function bigIntOperandOption(
  checker: ts.TypeChecker,
  hostFree: boolean,
): { isBigIntOperand?: BigIntOperandPredicate } {
  if (!hostFree) return {};
  let predicate = predicates.get(checker);
  if (predicate === undefined) {
    predicate = (expr) => {
      try {
        return typeHasBigIntMember(checker.getTypeAtLocation(expr));
      } catch {
        return false;
      }
    };
    predicates.set(checker, predicate);
  }
  return { isBigIntOperand: predicate };
}

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
