// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S5 — the bindings the module initializer's `var` lists declare
// (`isModuleInitVarList`, `src/shared/var-declaration-lists.ts`). Each binding
// is backed by an exact persistent `__mod_<name>` global, so it needs no
// hoisting support:
//
//   - a top-level `var` statement: its identifier declarations and, in a
//     script, its pattern leaves;
//   - a `var` statement or `for (;;)` `var` head in top-level control flow:
//     its identifier declarations (levers L, L2) and, in a script, its leaves.
//
// Every other `var` is hoisting the IR refuses. The ordinary module
// selector still rejects duplicate declarations, missing initializers,
// use-before-declaration, and any binding the module-global resolver cannot
// represent.

import {
  isModuleInitVarList,
  isTopLevelStatementDeclaration,
  moduleInitVarLists,
  type ScriptVarModel,
} from "../shared/var-declaration-lists.js";
import { ts } from "../ts-api.js";
import { bindingDeclarationList, patternLeaves, type BindingLeaf } from "./binding-pattern-plan.js";

/** The modelled `var` lists ({@link moduleInitVarLists}) of every module-init statement. */
export function collectIrSafeModuleVarDeclarationLists(
  statements: readonly ts.Statement[],
  model: ScriptVarModel,
): ReadonlySet<ts.VariableDeclarationList> {
  return new Set(statements.flatMap((statement) => moduleInitVarLists(statement, model)));
}

/** A name a module-init statement binds to a module global, or a pattern with no one-to-one global. */
export type ModuleInitBinding =
  | { readonly name: ts.Identifier; readonly declaration: ts.VariableDeclaration | BindingLeaf }
  | { readonly unmapped: ts.VariableDeclaration };

/**
 * What one module-init statement binds, in source order: each identifier
 * declaration of a top-level statement or of a modelled `for` head, and each
 * leaf of a modelled `var` list. A lexical top-level pattern has no one-to-one
 * global.
 */
export function moduleInitBindings(statement: ts.Statement, model: ScriptVarModel): ModuleInitBinding[] {
  const lists = ts.isVariableStatement(statement) ? [statement.declarationList] : moduleInitVarLists(statement, model);
  return lists.flatMap((list) => {
    const leavesBind = isModuleInitVarList(list, model);
    return list.declarations.flatMap((declaration): ModuleInitBinding[] => {
      if (ts.isIdentifier(declaration.name)) return [{ name: declaration.name, declaration }];
      if (!leavesBind) return [{ unmapped: declaration }];
      return [...patternLeaves(declaration.name)].map((leaf) => ({ name: leaf.name, declaration: leaf }));
    });
  });
}

/**
 * The `let`/`const` flag of a module binding declaration. A leaf has none: it
 * binds as a module global only from a modelled `var` list.
 */
export function moduleBindingLexicalFlags(declaration: ts.VariableDeclaration | ts.BindingElement): ts.NodeFlags {
  return ts.isVariableDeclaration(declaration)
    ? declaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)
    : ts.NodeFlags.None;
}

type VarBinding = ts.VariableDeclaration | BindingLeaf;

const varBindingsBySource = new WeakMap<ts.SourceFile, Map<ScriptVarModel, readonly VarBinding[]>>();

/**
 * The bindings of `sourceFile`'s module-init statements under `model` ({@link moduleInitBindings}) that are not a
 * top-level statement's own declaration, in source order: the leaves of a modelled `var` list and the names of a
 * modelled `for` head.
 */
function moduleInitVarBindings(sourceFile: ts.SourceFile, model: ScriptVarModel): readonly VarBinding[] {
  let byModel = varBindingsBySource.get(sourceFile);
  if (!byModel) varBindingsBySource.set(sourceFile, (byModel = new Map()));
  let declarations = byModel.get(model);
  if (!declarations) {
    declarations = sourceFile.statements
      .flatMap((statement) => moduleInitBindings(statement, model))
      .flatMap((binding) =>
        "name" in binding && !isTopLevelStatementDeclaration(binding.declaration) ? [binding.declaration] : [],
      );
    byModel.set(model, declarations);
  }
  return declarations;
}

/**
 * The module binding declarations of `sourceFile` under `model` in ordinal order: every top-level statement
 * declaration (a pattern keeps its ordinal without a binding, as `module-init-plan.ts` numbers them), then every
 * other module-init binding ({@link moduleInitVarBindings}). Appending them moves no statement declaration's
 * binding id.
 */
export function moduleBindingDeclarationOrder(sourceFile: ts.SourceFile, model: ScriptVarModel): readonly ts.Node[] {
  const declarations = sourceFile.statements.flatMap((statement): readonly ts.Node[] =>
    ts.isVariableStatement(statement) ? statement.declarationList.declarations : [],
  );
  return [...declarations, ...moduleInitVarBindings(sourceFile, model)];
}

const leafNamesBySource = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * The names of `sourceFile`'s module-init pattern leaves. They are the same under both script-var models: the
 * for-in head `"with-for-in-heads"` adds declares one identifier, never a pattern.
 */
function moduleInitLeafNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  let names = leafNamesBySource.get(sourceFile);
  if (!names) {
    const leaves = moduleInitVarBindings(sourceFile, "statement-and-for-heads").filter((binding) =>
      ts.isBindingElement(binding),
    );
    leafNamesBySource.set(sourceFile, (names = new Set(leaves.map((leaf) => leaf.name.text))));
  }
  return names;
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
  const leafNames = moduleInitLeafNames(node.getSourceFile());
  const reads: ts.Identifier[] = [];
  const visit = (child: ts.Node): void => {
    if (!ts.isIdentifier(child)) child.forEachChild(visit);
    else if (leafNames.has(child.text) && isCarrierLeaf(resolve(child))) reads.push(child);
  };
  if (leafNames.size > 0) visit(node);
  return reads;
}

/**
 * Whether `declaration` binds a module-init global: a top-level `VariableStatement`'s own name, in a script or an
 * ES module, or (#7106 S5, L, L2) in a script a leaf, a `for` head's or a nested `var`'s name of a list `model`
 * models. The resolver, the startup plan and the Prepared producer all ask this one rule.
 */
export function isModuleInitGlobalDeclaration(
  declaration: ts.VariableDeclaration | ts.BindingElement,
  model: ScriptVarModel,
): boolean {
  if (isTopLevelStatementDeclaration(declaration)) return true;
  return (
    !ts.isExternalModule(declaration.getSourceFile()) && isModuleInitVarList(bindingDeclarationList(declaration), model)
  );
}
