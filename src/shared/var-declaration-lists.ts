// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `var`-kind declaration lists, and (#7106 S5, levers L and L2) the ones the
// synthetic module initializer models: the list of a `var` statement or of a
// `for (;;)` `var` head anywhere in a script's top-level code, directly or
// nested in its blocks, branches, loops, labels, `try` and `switch`. Their
// names are script `var`s, each in an exact persistent `__mod_<name>` slot that
// the prologue seeds, so they need no hoisting support: a nested declaration is
// a write at its position. Shared by the IR (selection, lowering, binding
// identity) and by legacy's module-global registration, which hands such a
// slot to the Program ABI.

import { ts } from "../ts-api.js";

/** A `var` list: not `let`, `const`, `using` or `await using`. */
export function isVarDeclarationList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) === 0;
}

/**
 * Whether `node` is a modelled `var` list. A list inside a function, a `with`
 * body (its names may resolve to the object), or a `catch` clause whose
 * parameter it re-declares (Annex B.3.5: that `var` writes the parameter) is
 * not, nor is a `for-in` / `for-of` head.
 */
export function isModuleInitVarList(node: ts.Node | undefined): boolean {
  if (node === undefined || !ts.isVariableDeclarationList(node) || !isVarDeclarationList(node)) return false;
  const owner = node.parent;
  if (!ts.isVariableStatement(owner) && !(ts.isForStatement(owner) && owner.initializer === node)) return false;
  for (let container: ts.Node = owner.parent; !ts.isSourceFile(container); container = container.parent) {
    if (!SCRIPT_STATEMENT_CONTAINERS.has(container.kind)) return false;
    if (ts.isCatchClause(container) && catchParameterIsRedeclared(container, node)) return false;
  }
  return true;
}

/**
 * Whether a modelled `list` (`bindingDeclarationList`'s answer, so possibly
 * absent) belongs to a top-level statement (a `var` statement or a `for (;;)`
 * head, labelled or not), which runs before every later top-level statement.
 * A nested one may never run (lever L2).
 */
export function isTopLevelVarList(list: ts.VariableDeclarationList | undefined): boolean {
  if (list === undefined) return false;
  let statement: ts.Node = list.parent;
  while (ts.isLabeledStatement(statement.parent)) statement = statement.parent;
  return ts.isSourceFile(statement.parent);
}

/** Whether `declaration` is a top-level `VariableStatement`'s own, numbered and observed with the statements. */
export function isTopLevelStatementDeclaration(declaration: ts.Node): boolean {
  const statement = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : undefined;
  return statement !== undefined && ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
}

/** Every modelled `var` list in `statement`, in source order. */
export function moduleInitVarLists(statement: ts.Statement): ts.VariableDeclarationList[] {
  const lists: ts.VariableDeclarationList[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isVariableDeclarationList(node) && isModuleInitVarList(node)) lists.push(node);
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

/**
 * Whether `list` declares a name the catch parameter binds. With a pattern
 * parameter that is an early error (B.3.5 exempts only an identifier), so a
 * match refuses a program that does not compile anyway.
 */
function catchParameterIsRedeclared(clause: ts.CatchClause, list: ts.VariableDeclarationList): boolean {
  const parameter = clause.variableDeclaration?.name;
  if (parameter === undefined) return false;
  const names = (name: ts.BindingName): string[] =>
    ts.isIdentifier(name)
      ? [name.text]
      : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : names(element.name)));
  const parameterNames = new Set(names(parameter));
  return list.declarations.some((declaration) => names(declaration.name).some((name) => parameterNames.has(name)));
}
