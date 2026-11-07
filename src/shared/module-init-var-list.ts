// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7106 S5, levers L and L2) The `var` lists the synthetic module initializer
// models: the list of a `var` statement or of a `for (;;)` `var` head anywhere
// in a script's top-level code, directly or nested in its blocks, branches,
// loops, labels, `try` and `switch`. Their names are script `var`s, each in an
// exact persistent `__mod_<name>` slot that the prologue seeds, so they need no
// hoisting support: a nested declaration is a write at its position. Shared by
// the IR (selection, lowering, binding identity) and by legacy's module-global
// registration, which hands such a slot to the Program ABI.

import { ts } from "../ts-api.js";

export function isVarDeclarationList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) === 0;
}

/**
 * Whether `node` is a modelled `var` list. A list inside a function, a `with`
 * body (its names may resolve to the object), or a `catch` clause whose
 * parameter it re-declares (Annex B.3.5: that `var` writes the parameter) is
 * not, nor is a `for-in` / `for-of` head.
 */
export function isModuleInitVarList(node: ts.Node | undefined): node is ts.VariableDeclarationList {
  if (node === undefined || !ts.isVariableDeclarationList(node) || !isVarDeclarationList(node)) return false;
  const owner = node.parent;
  if (!ts.isVariableStatement(owner) && !(ts.isForStatement(owner) && owner.initializer === node)) return false;
  for (let container: ts.Node = owner.parent; !ts.isSourceFile(container); container = container.parent) {
    if (!SCRIPT_STATEMENT_CONTAINERS.has(container.kind)) return false;
    if (ts.isCatchClause(container) && catchParameterIsRedeclared(container, node)) return false;
  }
  return true;
}

/** Every modelled `var` list in `statement`, in source order. */
export function moduleInitVarLists(statement: ts.Statement): ts.VariableDeclarationList[] {
  const lists: ts.VariableDeclarationList[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (isModuleInitVarList(node)) lists.push(node);
    node.forEachChild(visit);
  };
  visit(statement);
  return lists;
}

const SCRIPT_STATEMENT_CONTAINERS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.CaseBlock,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.DefaultClause,
]);

function catchParameterIsRedeclared(clause: ts.CatchClause, list: ts.VariableDeclarationList): boolean {
  const parameter = clause.variableDeclaration?.name;
  if (parameter === undefined) return false;
  if (!ts.isIdentifier(parameter)) return true;
  const declares = (name: ts.BindingName): boolean =>
    ts.isIdentifier(name)
      ? name.text === parameter.text
      : name.elements.some((element) => !ts.isOmittedExpression(element) && declares(element.name));
  return list.declarations.some((declaration) => declares(declaration.name));
}
