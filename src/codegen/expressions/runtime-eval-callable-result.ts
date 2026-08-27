// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Narrow admission predicate for a Function(...).call/apply constructor result. */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { resolvesToGlobalFunctionAlias } from "./eval-inline.js";

/**
 * (#4647) The standalone runtime-eval Function provider returns an interpreted
 * callable marker.  Admit only a direct `.call`/`.apply` of a global Function
 * constructor result; other dynamic call results retain their fallback.
 */
export function isRuntimeEvalCallableResultExpression(ctx: CodegenContext, expression: ts.Expression): boolean {
  const unwrap = (value: ts.Expression): ts.Expression => {
    let current = value;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = ts.isParenthesizedExpression(current)
        ? current.expression
        : ts.isAsExpression(current)
          ? current.expression
          : ts.isNonNullExpression(current)
            ? current.expression
            : (current as ts.TypeAssertion).expression;
    }
    return current;
  };

  const resultCall = unwrap(expression);
  if (!ts.isCallExpression(resultCall) || resultCall.questionDotToken !== undefined) return false;
  const member = unwrap(resultCall.expression);
  if (!ts.isPropertyAccessExpression(member) || (member.name.text !== "call" && member.name.text !== "apply")) {
    return false;
  }
  const functionResult = unwrap(member.expression);
  if (!ts.isCallExpression(functionResult) || functionResult.questionDotToken !== undefined) return false;
  const functionCtor = unwrap(functionResult.expression);
  return ts.isIdentifier(functionCtor) && resolvesToGlobalFunctionAlias(functionCtor, ctx.oracle);
}
