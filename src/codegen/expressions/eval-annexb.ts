// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

export function hasScriptScopeAnnexBFunction(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node)) {
      if (node.parent && !ts.isSourceFile(node.parent)) found = true;
      // Do not cross into a nested function's declaration-instantiation scope.
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * Return whether sloppy Annex B declarations in a foreign eval Script can use
 * the ordinary-source B.3.3 lowering without needing EvalDeclarationInstantiation
 * conflict handling.
 *
 * A duplicate same-name block function has special "declaredFunctionOrVarNames"
 * lifecycle rules, while a same-name lexical declaration can suppress the
 * synthetic outer `var` binding (or make replacing the declaration with `var`
 * an early error). Falling back preserves the existing host behavior and
 * standalone diagnostic instead of partially mutating the module.
 */
export function evalAnnexBDeclarationsInlineSupported(sf: ts.SourceFile): boolean {
  const annexBNames = new Map<string, number>();
  const lexicalNames = new Set<string>();

  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      lexicalNames.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      addBindingName(element.name);
    }
  };

  const isFunctionBodyBlock = (block: ts.Block): boolean => {
    const parent = block.parent;
    return (
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isConstructorDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.body === block
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      if (
        node.name &&
        !ts.isSourceFile(node.parent) &&
        !(ts.isBlock(node.parent) && isFunctionBodyBlock(node.parent))
      ) {
        annexBNames.set(node.name.text, (annexBNames.get(node.name.text) ?? 0) + 1);
      }
      // A nested function body is a separate declaration-instantiation scope.
      // Its lexical names cannot cancel an outer eval Script candidate.
      return;
    }

    if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
      for (const decl of node.declarations) addBindingName(decl.name);
    } else if (ts.isClassDeclaration(node) && node.name) {
      lexicalNames.add(node.name.text);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingName(node.variableDeclaration.name);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  for (const [name, count] of annexBNames) {
    if (count > 1 || lexicalNames.has(name)) return false;
  }
  return true;
}
