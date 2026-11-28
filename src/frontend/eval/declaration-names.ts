// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** The declared names of an eval Script (§19.2.1.3), shared by the legacy fold and the IR's literal eval. */
import { ts } from "../typescript.js";

export function addFoldedEvalBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addFoldedEvalBindingNames(element.name, names);
  }
}

export interface FoldedEvalDeclarationNames {
  varNames: ReadonlySet<string>;
  blockFunctionNames: ReadonlySet<string>;
}

/** Collect ordinary VarDeclaredNames separately from sloppy Annex-B block
 * functions. The former collide with intervening lexical records; the latter
 * use B.3.3's cancellation rule and must fall back instead of throwing. */
export function foldedEvalDeclarationNames(sourceFile: ts.SourceFile): FoldedEvalDeclarationNames {
  const varNames = new Set<string>();
  const blockFunctionNames = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) {
        (ts.isSourceFile(node.parent) ? varNames : blockFunctionNames).add(node.name.text);
      }
      return;
    }
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      if (ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
        addFoldedEvalBindingNames(node.name, varNames);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { varNames, blockFunctionNames };
}
