// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";

/** Conservatively collect writes in the function-like enclosing a lifted closure. */
export function collectOuterWrites(
  fn:
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
): Set<string> {
  const writes = new Set<string>();
  let outer: ts.Node | undefined = fn.parent;
  while (
    outer &&
    !ts.isFunctionDeclaration(outer) &&
    !ts.isFunctionExpression(outer) &&
    !ts.isArrowFunction(outer) &&
    !ts.isMethodDeclaration(outer) &&
    !ts.isGetAccessorDeclaration(outer) &&
    !ts.isSetAccessorDeclaration(outer) &&
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

/** Allocate shared storage before control flow can create an accessor capture. */
export function isCapturedByOrdinaryDescriptor(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return false;
  let owner: ts.Node | undefined = declaration.parent;
  while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  if (!owner || !("body" in owner) || !owner.body) return false;
  let captured = false;
  const visit = (node: ts.Node, nested: boolean, descriptor: boolean): void => {
    if (captured) return;
    const isClosure = ts.isFunctionLike(node);
    const inDescriptor =
      descriptor ||
      ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
        ts.isObjectLiteralExpression(node.parent));
    if (nested && inDescriptor && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      captured = true;
      return;
    }
    forEachChild(node, (child) => visit(child, nested || isClosure, inDescriptor));
  };
  visit(
    owner.body as ts.Node,
    false,
    (ts.isGetAccessorDeclaration(owner) || ts.isSetAccessorDeclaration(owner)) &&
      ts.isObjectLiteralExpression(owner.parent),
  );
  return captured;
}

/** Free lexical bindings needed by descendants must cross the enclosing environment. */
export function collectTransitiveClosureCaptures(
  descendant: ts.Node,
  enclosing: ts.Node,
  checker: ts.TypeChecker,
): { readonly referenced: Set<string>; readonly written: Set<string> } {
  const referenced = new Set<string>();
  const written = new Set<string>();
  const declaredInside = (declaration: ts.Node): boolean => {
    for (let node: ts.Node | undefined = declaration; node; node = node.parent) if (node === enclosing) return true;
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const symbol =
        ts.isShorthandPropertyAssignment(parent) && parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node);
      // Property labels and named members are not lexical environment reads.
      if (symbol && symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class)) {
        const declarations = symbol.declarations;
        if (declarations?.length && declarations.every((declaration) => !declaredInside(declaration))) {
          referenced.add(node.text);
          if (isLexicalBindingWrite(node)) written.add(node.text);
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(descendant);
  return { referenced, written };
}

/** Follow assignment-pattern containers, never a member receiver or computed key. */
function isLexicalBindingWrite(identifier: ts.Identifier): boolean {
  let target: ts.Node = identifier;
  for (;;) {
    const parent = target.parent;
    if (!parent) return false;
    if (ts.isBinaryExpression(parent))
      return (
        parent.left === target &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      return (
        parent.operand === target &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
      );
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === target;
    if (
      (ts.isParenthesizedExpression(parent) && parent.expression === target) ||
      (ts.isSpreadElement(parent) && parent.expression === target) ||
      (ts.isSpreadAssignment(parent) && parent.expression === target) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === target) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent)
    ) {
      target = parent;
      continue;
    }
    return false;
  }
}
