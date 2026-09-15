// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";

/** A nested declaration needs one closure value when referenced outside a direct call. */
export function nestedFunctionUsedAsValue(fn: ts.FunctionDeclaration, checker?: ts.TypeChecker): boolean {
  if (!fn.name || !checker) return false;
  const symbol = checker.getSymbolAtLocation(fn.name);
  if (!symbol) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node === fn) return;
    if (ts.isShorthandPropertyAssignment(node) && checker.getShorthandAssignmentValueSymbol(node) === symbol) {
      found = true;
      return;
    }
    if (
      ts.isIdentifier(node) &&
      checker.getSymbolAtLocation(node) === symbol &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  if (fn.parent) visit(fn.parent);
  return found;
}

/** Exact lexical binding captured by a nested function, not a same-named shadow. */
export function declarationHasNestedCapture(declaration: ts.VariableDeclaration, checker?: ts.TypeChecker): boolean {
  if (!checker || !ts.isIdentifier(declaration.name)) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return false;
  let owner: ts.Node | undefined = declaration.parent;
  while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  if (!owner || ts.isSourceFile(owner) || !("body" in owner) || !owner.body) return false;
  let found = false;
  const visit = (node: ts.Node, nested: boolean): void => {
    if (found) return;
    const inside = nested || ts.isFunctionLike(node);
    if (inside && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      found = true;
      return;
    }
    forEachChild(node, (child) => visit(child, inside));
  };
  visit(owner.body as ts.Node, false);
  return found;
}

/** Conservatively collect writes in the function-like enclosing a lifted closure. */
export function collectOuterWrites(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration,
): Set<string> {
  const writes = new Set<string>();
  let outer: ts.Node | undefined = fn.parent;
  while (
    outer &&
    !ts.isFunctionDeclaration(outer) &&
    !ts.isFunctionExpression(outer) &&
    !ts.isArrowFunction(outer) &&
    !ts.isSourceFile(outer)
  ) {
    outer = outer.parent;
  }
  if (!outer || !("body" in outer) || !outer.body) return writes;
  const body = outer.body as ts.Node;
  const visit = (node: ts.Node): void => {
    if (node === fn) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) writes.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) writes.add(node.operand.text);
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return writes;
}
