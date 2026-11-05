// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

export interface DynamicMemberSelection {
  readonly native: boolean;
  readonly stableStores: boolean;
  readonly runtime: boolean;
  readonly reads: boolean;
  readonly boxableParameters: ReadonlySet<string>;
  isDynamic(expression: ts.Expression): boolean;
  scan(expression: ts.Expression, dynamic: boolean): boolean;
  isNumber(expression: ts.Expression): boolean;
  hasStoreRoot(expression: ts.Expression): boolean;
  canBox(expression: ts.Expression): boolean;
}

function unparenthesized(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function isBoxableParameter(expression: ts.Expression, host: DynamicMemberSelection): boolean {
  return host.native && ts.isIdentifier(expression) && host.boxableParameters.has(expression.text);
}

/** Reads and writes share the producer's primitive-key boxing proof. */
function scanKey(expression: ts.Expression, host: DynamicMemberSelection, numericExpressions: boolean): boolean {
  const key = unparenthesized(expression);
  if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return true;
  if (host.isDynamic(key)) return host.scan(key, true);
  if (numericExpressions && host.isNumber(key)) return host.scan(key, false);
  return isBoxableParameter(key, host) && host.scan(key, false);
}

/** Undefined leaves unrelated expression families with their existing selector. */
export function scanDynamicMember(
  expression: ts.Expression,
  expectDynamic: boolean,
  host: DynamicMemberSelection,
): boolean | undefined {
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = expression.left;
    if (
      expectDynamic ||
      (!host.stableStores && !host.native) ||
      !ts.isExpressionStatement(expression.parent) ||
      expression.parent.expression !== expression ||
      (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) ||
      target.questionDotToken !== undefined ||
      !host.hasStoreRoot(target.expression) ||
      !host.isDynamic(target.expression)
    )
      return undefined;
    if (!host.runtime || !host.scan(target.expression, true)) return false;
    if (ts.isElementAccessExpression(target) && !scanKey(target.argumentExpression, host, false)) return false;
    const value = unparenthesized(expression.right);
    const dynamic = host.isDynamic(value);
    return (dynamic || host.canBox(value) || isBoxableParameter(value, host)) && host.scan(value, dynamic);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (host.isDynamic(expression.expression))
      return host.reads && expectDynamic && host.scan(expression.expression, true);
    return !expectDynamic && host.scan(expression.expression, false);
  }
  if (ts.isElementAccessExpression(expression)) {
    if (host.isDynamic(expression.expression))
      return (
        host.reads &&
        expectDynamic &&
        host.scan(expression.expression, true) &&
        scanKey(expression.argumentExpression, host, true)
      );
    return !expectDynamic && host.scan(expression.expression, false) && host.scan(expression.argumentExpression, false);
  }
  return undefined;
}
