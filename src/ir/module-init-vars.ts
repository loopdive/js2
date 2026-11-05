// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S5 — the top-level `var` lists the synthetic module initializer models
// and the bindings they declare. Each binding is backed by an exact persistent
// `__mod_<name>` global, so it needs no hoisting support:
//
//   - a top-level `var` statement: its identifier declarations and, in a
//     script, its pattern leaves;
//   - a top-level `for (;;)` `var` head, labelled or not, whose declarations
//     are all patterns: its leaves. An identifier head is the S6 follow-up.
//
// Every other `var` is nested hoisting the IR refuses. The ordinary module
// selector still rejects duplicate declarations, missing initializers,
// use-before-declaration, and any binding the module-global resolver cannot
// represent.

import { ts } from "../ts-api.js";
import { isPatternDeclaration, patternLeaves, type BindingLeaf } from "./binding-pattern-plan.js";
import { isVarDeclarationList } from "./function-local-var.js";

/** The `var` list `statement` contributes to the module initializer, if it models one. */
export function moduleInitVarList(statement: ts.Node): ts.VariableDeclarationList | undefined {
  const loop = unlabelled(statement);
  const list = ts.isVariableStatement(statement)
    ? statement.declarationList
    : ts.isForStatement(loop) && loop.initializer && ts.isVariableDeclarationList(loop.initializer)
      ? loop.initializer
      : undefined;
  if (!list || !isVarDeclarationList(list)) return undefined;
  return ts.isVariableStatement(statement) || list.declarations.every(isPatternDeclaration) ? list : undefined;
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

interface ModuleInitLeaves {
  readonly leaves: readonly BindingLeaf[];
  readonly names: ReadonlySet<string>;
}

const leavesBySource = new WeakMap<ts.SourceFile, ModuleInitLeaves>();

/** Every leaf the module-init statements of `sourceFile` bind ({@link moduleInitBindings}), in source order. */
function moduleInitLeaves(sourceFile: ts.SourceFile): ModuleInitLeaves {
  let cached = leavesBySource.get(sourceFile);
  if (!cached) {
    const leaves = sourceFile.statements
      .flatMap(moduleInitBindings)
      .flatMap((binding) =>
        "name" in binding && ts.isBindingElement(binding.declaration) ? [binding.declaration] : [],
      );
    cached = { leaves, names: new Set(leaves.map((leaf) => leaf.name.text)) };
    leavesBySource.set(sourceFile, cached);
  }
  return cached;
}

/**
 * The module binding declarations of `sourceFile` in ordinal order: every
 * top-level statement declaration (a pattern keeps its ordinal without a
 * binding, as `module-init-plan.ts` numbers them), then every module-init
 * leaf. Appending the leaves moves no statement declaration's binding id.
 */
export function moduleBindingDeclarationOrder(sourceFile: ts.SourceFile): readonly ts.Node[] {
  const declarations = sourceFile.statements.flatMap((statement): readonly ts.Node[] =>
    ts.isVariableStatement(statement) ? statement.declarationList.declarations : [],
  );
  return [...declarations, ...moduleInitLeaves(sourceFile).leaves];
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
  const { names } = moduleInitLeaves(node.getSourceFile());
  const reads: ts.Identifier[] = [];
  const visit = (child: ts.Node): void => {
    if (!ts.isIdentifier(child)) child.forEachChild(visit);
    else if (names.has(child.text) && isCarrierLeaf(resolve(child))) reads.push(child);
  };
  if (names.size > 0) visit(node);
  return reads;
}
