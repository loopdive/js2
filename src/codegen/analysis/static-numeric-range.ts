// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

export interface StaticIntegerRange {
  readonly min: number;
  readonly max: number;
}

/** Conservative integer range proof for literals and canonical counted loops. */
export function staticIntegerRange(ctx: CodegenContext, expression: ts.Expression): StaticIntegerRange | undefined {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isNumericLiteral(current)) {
    const value = Number(current.text);
    return Number.isSafeInteger(value) ? { min: value, max: value } : undefined;
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
    const inner = staticIntegerRange(ctx, current.operand);
    return inner ? { min: -inner.max, max: -inner.min } : undefined;
  }
  if (ts.isIdentifier(current)) return countedLoopIdentifierRange(ctx, current);
  if (!ts.isBinaryExpression(current)) return undefined;
  const left = staticIntegerRange(ctx, current.left);
  const right = staticIntegerRange(ctx, current.right);
  switch (current.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return left && right ? { min: left.min + right.min, max: left.max + right.max } : undefined;
    case ts.SyntaxKind.MinusToken:
      return left && right ? { min: left.min - right.max, max: left.max - right.min } : undefined;
    case ts.SyntaxKind.AsteriskToken:
      if (!left || !right) return undefined;
      {
        const products = [left.min * right.min, left.min * right.max, left.max * right.min, left.max * right.max];
        const min = Math.min(...products);
        const max = Math.max(...products);
        return Number.isSafeInteger(min) && Number.isSafeInteger(max) ? { min, max } : undefined;
      }
    case ts.SyntaxKind.PercentToken:
      if (!left || !right || left.min < 0 || right.min !== right.max || right.min <= 0) return undefined;
      return { min: 0, max: Math.min(left.max, right.min - 1) };
    default:
      return undefined;
  }
}

function countedLoopIdentifierRange(ctx: CodegenContext, identifier: ts.Identifier): StaticIntegerRange | undefined {
  const symbol = ctx.checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  const list = declaration.parent;
  const loop = ts.isVariableDeclarationList(list) && ts.isForStatement(list.parent) ? list.parent : undefined;
  if (!loop || loop.initializer !== list || !loop.condition || !loop.incrementor) return undefined;
  const start = staticIntegerRange(ctx, declaration.initializer);
  if (!start || start.min !== start.max) return undefined;
  if (!ts.isBinaryExpression(loop.condition) || !ts.isIdentifier(loop.condition.left)) return undefined;
  if (ctx.checker.getSymbolAtLocation(loop.condition.left) !== symbol) return undefined;
  const bound = staticIntegerRange(ctx, loop.condition.right);
  if (!bound || bound.min !== bound.max) return undefined;
  let max: number;
  if (loop.condition.operatorToken.kind === ts.SyntaxKind.LessThanToken) max = bound.max - 1;
  else if (loop.condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) max = bound.max;
  else return undefined;
  if (!isIncreasingLoopIncrement(ctx, loop.incrementor, symbol)) return undefined;
  return start.min <= max ? { min: start.min, max } : undefined;
}

function isIncreasingLoopIncrement(ctx: CodegenContext, expression: ts.Expression, symbol: ts.Symbol): boolean {
  if (ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)) {
    return (
      expression.operator === ts.SyntaxKind.PlusPlusToken &&
      ts.isIdentifier(expression.operand) &&
      ctx.checker.getSymbolAtLocation(expression.operand) === symbol
    );
  }
  if (!ts.isBinaryExpression(expression) || !ts.isIdentifier(expression.left)) return false;
  if (ctx.checker.getSymbolAtLocation(expression.left) !== symbol) return false;
  if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    const step = staticIntegerRange(ctx, expression.right);
    return step !== undefined && step.min === step.max && step.min > 0;
  }
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isBinaryExpression(expression.right)) {
    return false;
  }
  const rhs = expression.right;
  if (rhs.operatorToken.kind !== ts.SyntaxKind.PlusToken || !ts.isIdentifier(rhs.left)) return false;
  if (ctx.checker.getSymbolAtLocation(rhs.left) !== symbol) return false;
  const step = staticIntegerRange(ctx, rhs.right);
  return step !== undefined && step.min === step.max && step.min > 0;
}
