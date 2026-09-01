// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";

export function isNestedFunctionScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

export function transparentLinearBlockStatements(stmt: ts.Statement): readonly ts.Statement[] | undefined {
  if (!ts.isBlock(stmt)) return undefined;
  return stmt.statements.every((child) => ts.isBlock(child) || ts.isExpressionStatement(child))
    ? stmt.statements
    : undefined;
}

/** True if `block` contains a return without crossing a nested function. */
export function blockHasTopLevelReturn(block: ts.Block): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found || isNestedFunctionScope(node)) return;
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  };
  forEachChild(block, walk);
  return found;
}

export function countAwaitsInStatement(stmt: ts.Node, awaitSet: ReadonlySet<ts.AwaitExpression>): number {
  let count = 0;
  const walk = (node: ts.Node): void => {
    if (isNestedFunctionScope(node) && node !== stmt) return;
    if (ts.isAwaitExpression(node) && awaitSet.has(node)) count++;
    forEachChild(node, walk);
  };
  walk(stmt);
  return count;
}

export function findAwaitInStatement(
  stmt: ts.Node,
  awaitSet: ReadonlySet<ts.AwaitExpression>,
): ts.AwaitExpression | undefined {
  let found: ts.AwaitExpression | undefined;
  const walk = (node: ts.Node): void => {
    if (found || (isNestedFunctionScope(node) && node !== stmt)) return;
    if (ts.isAwaitExpression(node) && awaitSet.has(node)) {
      found = node;
      return;
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return found;
}

export function statementContainsNode(stmt: ts.Node, target: ts.Node): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (node === target) {
      found = true;
      return;
    }
    if (isNestedFunctionScope(node) && node !== stmt) return;
    forEachChild(node, walk);
  };
  walk(stmt);
  return found;
}
