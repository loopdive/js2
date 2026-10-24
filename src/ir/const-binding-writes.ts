// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7014) Syntactic write-to-`const` detection for the IR lowerer.
 *
 * A write to a `const` binding is a TypeScript error that still emits code, and
 * at run time it must throw a TypeError. The IR binds a `const` as an SSA local
 * (and the name-based mutation pre-pass can bind a const for-of variable as a
 * slot), so these helpers let `from-ast.ts` demote such functions to the legacy
 * lowering — the path that raises the TypeError — instead of failing an
 * invariant or silently performing the write.
 */
import { ts, forEachChild } from "../ts-api.js";

/** (#7014) Does `body` assign / compound-assign / ++/-- the identifier `name` (nested functions excluded)? */
export function bodyWritesIdentifier(body: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== body && ts.isFunctionLike(node))) return;
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        (node.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment)) &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      found = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * (#7014) Is `id` a write target that resolves to a `const` declaration? Such a
 * write is a TS error that still emits code, and at run time it must throw a
 * TypeError — which only the legacy lowering raises. The IR binds a `const` as
 * an SSA local, so the write reaches the non-slot arm of the assignment
 * lowerers; this lets them demote instead of firing the #4502 producer-promise
 * invariant (a hard compile error). Purely syntactic (nearest enclosing
 * declaration of the name), and only consulted on that failure path, so every
 * module that compiled before is unaffected.
 */
export function isWriteToConstDeclaration(id: ts.Identifier): boolean {
  const declares = (list: ts.VariableDeclarationList): boolean =>
    list.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === id.text);
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      for (const st of n.statements) {
        if (ts.isVariableStatement(st) && declares(st.declarationList)) {
          return (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
        }
        if (ts.isFunctionDeclaration(st) && st.name?.text === id.text) return false;
      }
    }
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n)) && n.initializer) {
      const init = n.initializer;
      if (ts.isVariableDeclarationList(init) && declares(init)) return (init.flags & ts.NodeFlags.Const) !== 0;
    }
    if (ts.isFunctionLike(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text)) {
      return false;
    }
  }
  return false;
}
