// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S5 — the top-level `var` lists the synthetic module initializer models
// and the bindings they declare. Each binding is backed by an exact persistent
// `__mod_<name>` global, so it needs no hoisting support:
//
//   - a top-level `var` statement: its identifier declarations and, in a
//     script, its pattern leaves;
//   - a top-level `for (;;)` `var` head whose declarations are all patterns:
//     its leaves. An identifier head is the S6 follow-up.
//
// Every other `var` is nested hoisting the IR refuses. The ordinary module
// selector still rejects duplicate declarations, missing initializers,
// use-before-declaration, and any binding the module-global resolver cannot
// represent.

import { ts } from "../ts-api.js";
import { isPatternDeclaration, patternLeaves, type BindingLeaf } from "./binding-pattern-plan.js";
import { isVarDeclarationList } from "./function-local-var.js";

/** The `var` list `statement` contributes to the module initializer, if it models one. */
export function moduleInitVarList(statement: ts.Statement): ts.VariableDeclarationList | undefined {
  const list = ts.isVariableStatement(statement)
    ? statement.declarationList
    : ts.isForStatement(statement) && statement.initializer && ts.isVariableDeclarationList(statement.initializer)
      ? statement.initializer
      : undefined;
  if (!list || !isVarDeclarationList(list)) return undefined;
  return ts.isVariableStatement(statement) || list.declarations.every(isPatternDeclaration) ? list : undefined;
}

/** Whether `node` is the `var` list of a top-level statement that {@link moduleInitVarList} models. */
export function isModuleInitVarList(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isVariableDeclarationList(node) &&
    ts.isSourceFile(node.parent.parent) &&
    moduleInitVarList(node.parent) === node
  );
}

/** The {@link moduleInitVarList} of every module-init statement. */
export function collectIrSafeModuleVarDeclarationLists(
  statements: readonly ts.Statement[],
): ReadonlySet<ts.VariableDeclarationList> {
  return new Set(statements.flatMap((statement) => moduleInitVarList(statement) ?? []));
}

/** A name a module-init statement binds to a module global, or a pattern with no one-to-one global. */
export type ModuleInitBinding =
  | { readonly name: ts.Identifier; readonly declaration: ts.VariableDeclaration | BindingLeaf }
  | { readonly unmapped: ts.VariableDeclaration };

/**
 * What one module-init statement binds, in source order: each identifier
 * declaration of a top-level statement, and each leaf of a modelled `var`
 * list. A lexical top-level pattern has no one-to-one global.
 */
export function moduleInitBindings(statement: ts.Statement): ModuleInitBinding[] {
  const list = ts.isVariableStatement(statement) ? statement.declarationList : moduleInitVarList(statement);
  if (!list) return [];
  const leavesBind = isModuleInitVarList(list);
  return list.declarations.flatMap((declaration): ModuleInitBinding[] => {
    if (ts.isIdentifier(declaration.name)) return [{ name: declaration.name, declaration }];
    if (!leavesBind) return [{ unmapped: declaration }];
    return [...patternLeaves(declaration.name)].map((leaf) => ({ name: leaf.name, declaration: leaf }));
  });
}

/**
 * The module binding declarations of `sourceFile` in ordinal order: every
 * top-level statement declaration (a pattern keeps its ordinal without a
 * binding, as `module-init-plan.ts` numbers them), then every leaf of a
 * modelled `var` list in source order. Appending the leaves moves no statement
 * declaration's binding id.
 */
export function moduleBindingDeclarationOrder(sourceFile: ts.SourceFile): readonly ts.Node[] {
  const statements = sourceFile.statements;
  const declarations = statements.flatMap((statement): readonly ts.Node[] =>
    ts.isVariableStatement(statement) ? statement.declarationList.declarations : [],
  );
  const leaves = statements.flatMap((statement) =>
    (moduleInitVarList(statement)?.declarations ?? []).flatMap((declaration) =>
      isPatternDeclaration(declaration) ? [...patternLeaves(declaration.name)] : [],
    ),
  );
  return [...declarations, ...leaves];
}
