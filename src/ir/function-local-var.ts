// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3783 — proof for the function-local `var` subset that the IR can represent
// with its existing lexical local/slot model.

import { forEachChild, ts } from "../ts-api.js";

function isVarDeclarationList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) === 0;
}

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

function nodeIsWithin(node: ts.Node, region: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === region) return true;
  }
  return false;
}

function addBindingNames(name: ts.BindingName, counts: Map<string, number>): void {
  if (ts.isIdentifier(name)) {
    counts.set(name.text, (counts.get(name.text) ?? 0) + 1);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) addBindingNames(element.name, counts);
  }
}

/**
 * Certify the narrow `var` subset whose observable scope is already
 * representable by IR locals.
 *
 * A plain declaration is modeled in its enclosing block; a C-style for-head
 * is modeled in the ForStatement. Every reference must follow the initializer
 * and remain inside that region. Duplicate bindings and nested-function
 * captures are refused, which excludes hoisting/redeclaration behavior instead
 * of approximating it.
 */
export function collectIrSafeVarDeclarationLists(
  fn: ts.FunctionLikeDeclaration,
  parameterNames: ReadonlySet<string>,
): ReadonlySet<ts.VariableDeclarationList> {
  if (!fn.body || !ts.isBlock(fn.body)) return new Set();
  const body = fn.body;

  const bindingCounts = new Map<string, number>();
  for (const name of parameterNames) bindingCounts.set(name, 1);
  const varDeclarations: ts.VariableDeclaration[] = [];
  let containsForOf = false;

  const collectBindings = (node: ts.Node): void => {
    if (node !== body && isFunctionBoundary(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        bindingCounts.set(node.name.text, (bindingCounts.get(node.name.text) ?? 0) + 1);
      }
      return;
    }
    if (ts.isForOfStatement(node)) containsForOf = true;
    if (ts.isVariableDeclaration(node)) {
      addBindingNames(node.name, bindingCounts);
      if (ts.isVariableDeclarationList(node.parent) && isVarDeclarationList(node.parent)) {
        varDeclarations.push(node);
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      bindingCounts.set(node.name.text, (bindingCounts.get(node.name.text) ?? 0) + 1);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingNames(node.variableDeclaration.name, bindingCounts);
    }
    forEachChild(node, collectBindings);
  };
  forEachChild(body, collectBindings);
  // A `for...of` over a generator that is later withdrawn for ABI parity can
  // leave its newly claimed caller without a compatible IR element carrier.
  // Keep that cross-unit interaction outside this first `var` slice; ordinary
  // C-style loops and `for...in` remain eligible.
  if (containsForOf) return new Set();

  const safeDeclarations = new Set<ts.VariableDeclaration>();
  for (const declaration of varDeclarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const name = declaration.name.text;
    if (bindingCounts.get(name) !== 1) continue;

    const list = declaration.parent;
    if (!ts.isVariableDeclarationList(list)) continue;
    const owner = list.parent;
    const region =
      ts.isForStatement(owner) && owner.initializer === list
        ? owner
        : ts.isVariableStatement(owner) && ts.isBlock(owner.parent)
          ? owner.parent
          : undefined;
    if (!region) continue;

    let safe = true;
    const scanReferences = (node: ts.Node, insideNestedFunction = false): void => {
      if (!safe) return;
      const nested = insideNestedFunction || (node !== body && isFunctionBoundary(node));
      if (ts.isIdentifier(node) && node.text === name && isIdentifierReference(node)) {
        if (nested || node.getStart() < declaration.end || !nodeIsWithin(node, region)) {
          safe = false;
          return;
        }
      }
      forEachChild(node, (child) => scanReferences(child, nested));
    };
    scanReferences(body);
    if (safe) safeDeclarations.add(declaration);
  }

  const safeLists = new Set<ts.VariableDeclarationList>();
  for (const declaration of varDeclarations) {
    const list = declaration.parent;
    if (
      ts.isVariableDeclarationList(list) &&
      list.declarations.length > 0 &&
      list.declarations.every((candidate) => safeDeclarations.has(candidate))
    ) {
      safeLists.add(list);
    }
  }
  return safeLists;
}

/**
 * Top-level `var` lists are already backed by exact persistent module globals,
 * so the synthetic module initializer can model them without pretending they
 * are lexical locals. The ordinary module selector still rejects duplicate
 * declarations, missing initializers, use-before-declaration, and any binding
 * the module-global resolver cannot represent; this helper only removes the
 * function-local hoisting gate from direct source-file statements.
 */
export function collectIrSafeModuleVarDeclarationLists(
  statements: readonly ts.Statement[],
): ReadonlySet<ts.VariableDeclarationList> {
  const safe = new Set<ts.VariableDeclarationList>();
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!isVarDeclarationList(statement.declarationList)) continue;
    safe.add(statement.declarationList);
  }
  return safe;
}
