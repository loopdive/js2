// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { TypeOracle } from "../../checker/oracle.js";
import { loopBodyMutatesIndexOrArray } from "./loop-shape.js";

export interface StaticIntegerRangeContext {
  readonly oracle: Pick<TypeOracle, "variableDeclarationOf">;
}

export interface StaticIntegerRange {
  readonly min: number;
  readonly max: number;
}

/** Conservative integer range proof for literals and canonical counted loops. */
export function staticIntegerRange(
  ctx: StaticIntegerRangeContext,
  expression: ts.Expression,
): StaticIntegerRange | undefined {
  return staticIntegerRangeInner(ctx, expression, new Set());
}

function staticIntegerRangeInner(
  ctx: StaticIntegerRangeContext,
  expression: ts.Expression,
  visiting: Set<ts.VariableDeclaration>,
): StaticIntegerRange | undefined {
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
    const inner = staticIntegerRangeInner(ctx, current.operand, visiting);
    return inner ? { min: -inner.max, max: -inner.min } : undefined;
  }
  if (ts.isIdentifier(current)) {
    const declaration = ctx.oracle.variableDeclarationOf(current);
    if (!declaration || visiting.has(declaration)) return undefined;
    visiting.add(declaration);
    try {
      return (
        countedLoopIdentifierRange(ctx, current, declaration, visiting) ??
        constIdentifierRange(ctx, current, declaration, visiting)
      );
    } finally {
      visiting.delete(declaration);
    }
  }
  if (!ts.isBinaryExpression(current)) return undefined;
  const left = staticIntegerRangeInner(ctx, current.left, visiting);
  const right = staticIntegerRangeInner(ctx, current.right, visiting);
  switch (current.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      if (!left || !right) return undefined;
      {
        const min = left.min + right.min;
        const max = left.max + right.max;
        return Number.isSafeInteger(min) && Number.isSafeInteger(max) ? { min, max } : undefined;
      }
    case ts.SyntaxKind.MinusToken:
      if (!left || !right) return undefined;
      {
        const min = left.min - right.max;
        const max = left.max - right.min;
        return Number.isSafeInteger(min) && Number.isSafeInteger(max) ? { min, max } : undefined;
      }
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

function constIdentifierRange(
  ctx: StaticIntegerRangeContext,
  identifier: ts.Identifier,
  declaration: ts.VariableDeclaration,
  visiting: Set<ts.VariableDeclaration>,
): StaticIntegerRange | undefined {
  if (!declaration.initializer) return undefined;
  if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) {
    return undefined;
  }
  // Do not fold a lexical binding through its temporal dead zone. Comparing
  // source positions also rejects a later declaration referenced from an
  // earlier const initializer.
  if (identifier.getSourceFile() !== declaration.getSourceFile() || identifier.getStart() <= declaration.getEnd()) {
    return undefined;
  }
  return staticIntegerRangeInner(ctx, declaration.initializer, visiting);
}

function countedLoopIdentifierRange(
  ctx: StaticIntegerRangeContext,
  identifier: ts.Identifier,
  declaration: ts.VariableDeclaration,
  visiting: Set<ts.VariableDeclaration>,
): StaticIntegerRange | undefined {
  if (!declaration.initializer) return undefined;
  const list = declaration.parent;
  const loop = ts.isVariableDeclarationList(list) && ts.isForStatement(list.parent) ? list.parent : undefined;
  if (!loop || loop.initializer !== list || !loop.condition || !loop.incrementor) return undefined;
  const start = staticIntegerRangeInner(ctx, declaration.initializer, visiting);
  if (!start || start.min !== start.max) return undefined;
  if (!ts.isBinaryExpression(loop.condition) || !ts.isIdentifier(loop.condition.left)) return undefined;
  if (ctx.oracle.variableDeclarationOf(loop.condition.left) !== declaration) return undefined;
  const bound = staticIntegerRangeInner(ctx, loop.condition.right, visiting);
  if (!bound || bound.min !== bound.max) return undefined;
  let max: number;
  if (loop.condition.operatorToken.kind === ts.SyntaxKind.LessThanToken) max = bound.max - 1;
  else if (loop.condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) max = bound.max;
  else return undefined;
  if (!isIncreasingLoopIncrement(ctx, loop.incrementor, declaration)) return undefined;
  // The loop header alone is not a range proof if the body can reassign the
  // counter before a use. Passing an impossible array-binding name asks the
  // shared mutation scan to check only the index (and conservatively rejects
  // nested closures that could capture it).
  if (loopBodyMutatesIndexOrArray(loop.statement, identifier.text, "")) return undefined;
  return start.min <= max ? { min: start.min, max } : undefined;
}

function isIncreasingLoopIncrement(
  ctx: StaticIntegerRangeContext,
  expression: ts.Expression,
  declaration: ts.VariableDeclaration,
): boolean {
  if (ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)) {
    return (
      expression.operator === ts.SyntaxKind.PlusPlusToken &&
      ts.isIdentifier(expression.operand) &&
      ctx.oracle.variableDeclarationOf(expression.operand) === declaration
    );
  }
  if (!ts.isBinaryExpression(expression) || !ts.isIdentifier(expression.left)) return false;
  if (ctx.oracle.variableDeclarationOf(expression.left) !== declaration) return false;
  if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    const step = staticIntegerRangeInner(ctx, expression.right, new Set([declaration]));
    return step !== undefined && step.min === step.max && step.min > 0;
  }
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isBinaryExpression(expression.right)) {
    return false;
  }
  const rhs = expression.right;
  if (rhs.operatorToken.kind !== ts.SyntaxKind.PlusToken || !ts.isIdentifier(rhs.left)) return false;
  if (ctx.oracle.variableDeclarationOf(rhs.left) !== declaration) return false;
  const step = staticIntegerRangeInner(ctx, rhs.right, new Set([declaration]));
  return step !== undefined && step.min === step.max && step.min > 0;
}
