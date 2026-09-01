// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared static RegExp-expression facts used by variable-carrier inference.
 * Keeping these predicates outside the declaration drivers prevents another
 * host RegExp result exception from growing the codegen god-files.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { noJsHost } from "./js-errors.js";

export function stripInferenceWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}

export function isStaticRegExpExpression(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripInferenceWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if (ts.isNewExpression(unwrapped) || (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken)) {
    const callee = stripInferenceWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && callee.text === "RegExp";
  }
  if (ts.isIdentifier(unwrapped)) {
    const initializer = ctx.oracle.variableInitializerOf(unwrapped);
    return initializer !== undefined && isStaticRegExpExpression(ctx, initializer);
  }
  return false;
}

/**
 * A host RegExp match is a native Array with observable own properties such as
 * `groups` and `indices`. The checker exposes that result as
 * `RegExpExecArray`/`RegExpMatchArray`, but the generic host-mode type cascade
 * otherwise resolves it to a Wasm vector and materializes a copy. Keep the
 * binding on the externref carrier so property descriptors and Array
 * prototype interactions stay native. Standalone has its own match-vector
 * representation and must continue through the existing inference below.
 */
export function hostRegExpMatchResultNeedsExternref(
  ctx: CodegenContext,
  initializer: ts.Expression | undefined,
): boolean {
  if (noJsHost(ctx) || !initializer) return false;
  const unwrapped = stripInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped)) return false;

  let regexpExpression: ts.Expression | undefined;
  const callee = unwrapped.expression;
  if (ts.isPropertyAccessExpression(callee) && !ts.isPrivateIdentifier(callee.name)) {
    if (callee.name.text === "exec") {
      regexpExpression = callee.expression;
    } else if (callee.name.text === "match" && unwrapped.arguments.length === 1) {
      regexpExpression = unwrapped.arguments[0];
    }
  } else if (ts.isElementAccessExpression(callee) && unwrapped.arguments.length === 1) {
    const key = callee.argumentExpression;
    if (
      ts.isPropertyAccessExpression(key) &&
      ts.isIdentifier(key.expression) &&
      key.expression.text === "Symbol" &&
      key.name.text === "match"
    ) {
      regexpExpression = callee.expression;
    }
  }
  if (!regexpExpression || !isStaticRegExpExpression(ctx, regexpExpression)) return false;
  return true;
}
