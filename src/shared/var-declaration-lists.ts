// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `var`-kind declaration lists, and (#7106 S5, lever L) the ones the synthetic
// module initializer models: a top-level `var` statement's list, and a
// top-level `for (;;)` `var` head, labelled or not. Their names are script
// `var`s, each in an exact persistent `__mod_<name>` slot, so they need no
// hoisting support. Shared by the IR (selection, lowering, binding identity)
// and by legacy's module-global registration, which hands a head's slot to the
// Program ABI.

import { ts } from "../ts-api.js";

/** A `var` list: not `let`, `const`, `using` or `await using`. */
export function isVarDeclarationList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) === 0;
}

/** The `var` list `statement` contributes to the module initializer, if it models one. */
export function moduleInitVarList(statement: ts.Node): ts.VariableDeclarationList | undefined {
  const loop = unlabelled(statement);
  const list = ts.isVariableStatement(statement)
    ? statement.declarationList
    : ts.isForStatement(loop) && loop.initializer && ts.isVariableDeclarationList(loop.initializer)
      ? loop.initializer
      : undefined;
  return list && isVarDeclarationList(list) ? list : undefined;
}

/** Whether `node` is the `var` list of a top-level statement that {@link moduleInitVarList} models. */
export function isModuleInitVarList(node: ts.Node | undefined): boolean {
  if (node === undefined || !ts.isVariableDeclarationList(node)) return false;
  let statement: ts.Node = node.parent;
  while (ts.isLabeledStatement(statement.parent)) statement = statement.parent;
  return ts.isSourceFile(statement.parent) && moduleInitVarList(statement) === node;
}

function unlabelled(statement: ts.Node): ts.Node {
  return ts.isLabeledStatement(statement) ? unlabelled(statement.statement) : statement;
}
