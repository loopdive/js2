// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S5 — the bindings the module initializer's `var` lists declare
// (`moduleInitVarList`, `src/shared/module-init-var-list.ts`). Each binding is
// backed by an exact persistent `__mod_<name>` global, so it needs no hoisting
// support:
//
//   - a top-level `var` statement: its identifier declarations and, in a
//     script, its pattern leaves;
//   - a top-level `for (;;)` `var` head, labelled or not: its identifier
//     declarations (lever L) and, in a script, its pattern leaves.
//
// Every other `var` is nested hoisting the IR refuses. The ordinary module
// selector still rejects duplicate declarations, missing initializers,
// use-before-declaration, and any binding the module-global resolver cannot
// represent.

import { isModuleInitVarList, moduleInitVarList } from "../shared/module-init-var-list.js";
import { ts } from "../ts-api.js";
import { patternLeaves, type BindingLeaf } from "./binding-pattern-plan.js";

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
 * The `let`/`const` flag of a module binding declaration. A leaf has none: it
 * binds as a module global only from a {@link moduleInitVarList}.
 */
export function moduleBindingLexicalFlags(declaration: ts.VariableDeclaration | ts.BindingElement): ts.NodeFlags {
  return ts.isVariableDeclaration(declaration)
    ? declaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)
    : ts.NodeFlags.None;
}

interface ModuleInitVarBindings {
  /** Every pattern leaf and every `for` head name, in source order. */
  readonly declarations: readonly (ts.VariableDeclaration | BindingLeaf)[];
  readonly leafNames: ReadonlySet<string>;
}

const varBindingsBySource = new WeakMap<ts.SourceFile, ModuleInitVarBindings>();

/**
 * The bindings of `sourceFile`'s module-init statements ({@link moduleInitBindings})
 * that are not a top-level statement's own declaration: the leaves of a modelled
 * `var` list and the names of a modelled `for` head.
 */
function moduleInitVarBindings(sourceFile: ts.SourceFile): ModuleInitVarBindings {
  let cached = varBindingsBySource.get(sourceFile);
  if (!cached) {
    const declarations = sourceFile.statements
      .flatMap(moduleInitBindings)
      .flatMap((binding) =>
        "name" in binding && !isStatementDeclaration(binding.declaration) ? [binding.declaration] : [],
      );
    const leaves = declarations.filter((declaration) => ts.isBindingElement(declaration));
    cached = { declarations, leafNames: new Set(leaves.map((leaf) => leaf.name.text)) };
    varBindingsBySource.set(sourceFile, cached);
  }
  return cached;
}

/** A top-level statement's own identifier declaration, numbered with the statements. */
function isStatementDeclaration(declaration: ts.VariableDeclaration | BindingLeaf): boolean {
  return ts.isVariableDeclaration(declaration) && ts.isVariableStatement(declaration.parent.parent);
}

/**
 * The module binding declarations of `sourceFile` in ordinal order: every
 * top-level statement declaration (a pattern keeps its ordinal without a
 * binding, as `module-init-plan.ts` numbers them), then every other module-init
 * binding ({@link moduleInitVarBindings}). Appending them moves no statement
 * declaration's binding id.
 */
export function moduleBindingDeclarationOrder(sourceFile: ts.SourceFile): readonly ts.Node[] {
  const declarations = sourceFile.statements.flatMap((statement): readonly ts.Node[] =>
    ts.isVariableStatement(statement) ? statement.declarationList.declarations : [],
  );
  return [...declarations, ...moduleInitVarBindings(sourceFile).declarations];
}

/**
 * (#7106 S5) A leaf whose slot is the carrier: legacy widens a no-default
 * number leaf to `externref` so that `undefined` survives (#3423), while the
 * checker still types it as a number. Its read is a dynamic value, so the
 * checker type of an expression that reads one is no evidence of its IR type.
 */
function isCarrierLeaf(binding: ModuleBindingRepresentation | undefined): boolean {
  return binding !== undefined && ts.isBindingElement(binding.declaration) && binding.valueKind.kind === "dynamic";
}

/** What {@link isCarrierLeaf} reads of a module binding identity. */
interface ModuleBindingRepresentation {
  readonly declaration: ts.Node;
  readonly valueKind: { readonly kind: string };
}

/** The reads under `node` of a module-init leaf that `resolve` binds to the carrier. */
export function carrierLeafReads(
  node: ts.Node,
  resolve: (identifier: ts.Identifier) => ModuleBindingRepresentation | undefined,
): ts.Identifier[] {
  const { leafNames } = moduleInitVarBindings(node.getSourceFile());
  const reads: ts.Identifier[] = [];
  const visit = (child: ts.Node): void => {
    if (!ts.isIdentifier(child)) child.forEachChild(visit);
    else if (leafNames.has(child.text) && isCarrierLeaf(resolve(child))) reads.push(child);
  };
  if (leafNames.size > 0) visit(node);
  return reads;
}
