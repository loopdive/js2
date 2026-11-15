// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7346 step A) The string uses from-ast cannot lower, refused at selection
 * instead of withdrawn after the claim. Each rule asks the predicate from-ast's
 * own string arm asks, over the selector's proof that the operand is a string:
 *   - a member read other than a call's callee: `stringMemberReadLowerable`
 *     (`lowerPropertyAccess`);
 *   - an element read: `stringElementReadLowerable` over the unit's literal
 *     lengths and the counted-loop proof (`lowerElementAccess`);
 *   - an equality with `null`: a string has no fold (`nullComparisonFolds`) and
 *     `null` does not lower beside it (`nullValueAdmissible`).
 * A local and a module string take the same rules.
 */
import { ts } from "../ts-api.js";
import { stringElementReadLowerable, stringMemberReadLowerable } from "./capability.js";
import { nullComparedOperand, nullComparisonFolds, nullValueAdmissible } from "./analysis/operand-admissibility.js";
import { countedLoopProvesElementRead } from "./fixed-literal-loop-proof.js";
import { outermostParenthesized } from "../shared/binding-writes.js";
import type { IrFallbackReason } from "../shared/contracts/ir-preparation-failure.js";

export interface StringUseRefusal {
  readonly reason: IrFallbackReason;
  readonly arm: string;
}

/** The refusal of `expr` as a string use, or `undefined`; `isString` is the selector's string proof. */
export function stringUseRefusal(
  expr: ts.Expression,
  isString: (operand: ts.Expression) => boolean,
  literalLengths: ReadonlyMap<string, number> | undefined,
): StringUseRefusal | undefined {
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const read = outermostParenthesized(expr);
    const callee = ts.isCallExpression(read.parent) && read.parent.expression === read;
    if (callee || stringMemberReadLowerable(expr.name.text) || !isString(expr.expression)) return undefined;
    return { reason: "string-method-unsupported", arm: "expr-string-member-read" };
  }
  if (ts.isElementAccessExpression(expr)) {
    if (!isString(expr.expression)) return undefined;
    if (stringElementReadLowerable(expr, literalLengths, countedLoopProvesElementRead(expr))) return undefined;
    return { reason: "string-method-unsupported", arm: "expr-string-element-read" };
  }
  if (ts.isBinaryExpression(expr)) {
    const other = nullComparedOperand(expr);
    if (other === null || nullComparisonFolds(expr.operatorToken.kind, "string") || nullValueAdmissible("string")) {
      return undefined;
    }
    return isString(other) ? { reason: "operand-coercion-unsupported", arm: "expr-string-null-compare" } : undefined;
  }
  return undefined;
}
