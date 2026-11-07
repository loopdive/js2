// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S5 / #7288 — which top-level `var` lists the synthetic module
// initializer models as module bindings (see `ir/module-init-vars.ts` for the
// bindings they declare). Shared below both the IR and codegen: legacy observes
// exactly the `__mod_<name>` slots of these lists under their declarations
// (`codegen/module-global-registration.ts`), and the IR resolves them there.

import { ts } from "../ts-api.js";
import { isPatternDeclaration } from "./pattern-declaration.js";

/** A `var` list (not `let` / `const` / `using`). */
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
  if (!list || !isVarDeclarationList(list)) return undefined;
  // (#7288) An identifier head binds a module global in a script only; an ES module keeps the S5 pattern heads.
  const script = !ts.isExternalModule(statement.getSourceFile());
  return ts.isVariableStatement(statement) || script || list.declarations.every(isPatternDeclaration)
    ? list
    : undefined;
}

/** Whether `node` is the `var` list of a top-level statement that {@link moduleInitVarList} models. */
export function isModuleInitVarList(node: ts.Node | undefined): node is ts.VariableDeclarationList {
  if (node === undefined || !ts.isVariableDeclarationList(node)) return false;
  let statement: ts.Node = node.parent;
  while (ts.isLabeledStatement(statement.parent)) statement = statement.parent;
  return ts.isSourceFile(statement.parent) && moduleInitVarList(statement) === node;
}

function unlabelled(statement: ts.Node): ts.Node {
  return ts.isLabeledStatement(statement) ? unlabelled(statement.statement) : statement;
}
