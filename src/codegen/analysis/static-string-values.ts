// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Conservatively enumerate the string literals a source expression can
 * produce. This is intentionally narrower than general constant propagation:
 * it accepts literals and reads from const literal arrays only when the array
 * binding is never aliased or written anywhere in its source file.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

export function staticConstStringValues(
  ctx: CodegenContext,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): readonly string[] | undefined {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return staticConstStringValues(ctx, expression.expression, seen);
  }
  if (ts.isElementAccessExpression(expression)) {
    return staticConstStringValues(ctx, expression.expression, seen);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: string[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return undefined;
      const elementValues = staticConstStringValues(ctx, element, seen);
      if (!elementValues) return undefined;
      values.push(...elementValues);
    }
    return values;
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "split" &&
    expression.arguments.length === 1
  ) {
    const receivers = staticConstStringValues(ctx, expression.expression.expression, new Set(seen));
    const separators = staticConstStringValues(ctx, expression.arguments[0]!, new Set(seen));
    if (!receivers || !separators || new Set(separators).size !== 1) return undefined;
    const separator = separators[0]!;
    const values: string[] = [];
    for (const receiver of receivers) {
      values.push(...receiver.split(separator));
      if (values.length > 10_000) return undefined;
    }
    return values;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = ctx.checker.getSymbolAtLocation(expression);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList) || !(declarationList.flags & ts.NodeFlags.Const)) return undefined;
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);
  if (ts.isArrayLiteralExpression(declaration.initializer) && !constArrayBindingIsReadOnly(ctx, symbol, declaration)) {
    return undefined;
  }
  return staticConstStringValues(ctx, declaration.initializer, seen);
}

function constArrayBindingIsReadOnly(
  ctx: CodegenContext,
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
): boolean {
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isIdentifier(node) && ctx.checker.getSymbolAtLocation(node) === symbol) {
      if (node === declaration.name) return;
      const elementAccess = node.parent;
      if (!ts.isElementAccessExpression(elementAccess) || elementAccess.expression !== node) {
        safe = false;
        return;
      }
      const use = elementAccess.parent;
      if (
        (ts.isBinaryExpression(use) &&
          use.left === elementAccess &&
          use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          use.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ((ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use)) && use.operand === elementAccess) ||
        (ts.isDeleteExpression(use) && use.expression === elementAccess)
      ) {
        safe = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return safe;
}
