// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3783 — proof for the function-local `var` subset that the IR can represent
// with its existing lexical local/slot model.

import { isNonReferenceName } from "../shared/binding-writes.js";
import { isVarDeclarationList } from "../shared/var-declaration-lists.js";
import { forEachChild, ts } from "../ts-api.js";

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
 * Every binding of a function body (or script) outside nested functions: each name's count over parameters,
 * variable, function, class and catch declarations at any block depth, and the `var` declarations.
 */
function collectBindings(
  body: ts.Node,
  parameterNames: Iterable<string>,
): { bindingCounts: Map<string, number>; varDeclarations: ts.VariableDeclaration[]; containsForOf: boolean } {
  const bindingCounts = new Map<string, number>();
  for (const name of parameterNames) bindingCounts.set(name, 1);
  const varDeclarations: ts.VariableDeclaration[] = [];
  let containsForOf = false;
  const visit = (node: ts.Node): void => {
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
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return { bindingCounts, varDeclarations, containsForOf };
}

const repeatedNames = new WeakMap<ts.Node, ReadonlySet<string>>();

/**
 * (#7354) Whether the `var` `declaration` shares its name with another binding of its function (or script): a
 * second `var` at any block depth, a parameter, a function, class, catch or lexical declaration. Lowering binds a
 * `var` in its own block, so a repeat would open a second, separate local where JavaScript has one hoisted binding.
 */
export function isRepeatedVarBinding(declaration: ts.VariableDeclaration, name: string): boolean {
  if (!ts.isVariableDeclarationList(declaration.parent) || !isVarDeclarationList(declaration.parent)) return false;
  let owner: ts.Node = declaration;
  while (owner.parent && !isFunctionBoundary(owner)) owner = owner.parent;
  let names = repeatedNames.get(owner);
  if (!names) {
    const body = isFunctionBoundary(owner) ? (owner as ts.FunctionLikeDeclaration).body! : owner;
    const parameters = new Map<string, number>();
    if (isFunctionBoundary(owner))
      for (const parameter of (owner as ts.FunctionLikeDeclaration).parameters)
        addBindingNames(parameter.name, parameters);
    const { bindingCounts } = collectBindings(body, parameters.keys());
    names = new Set([...bindingCounts].flatMap(([name, count]) => (count > 1 ? [name] : [])));
    repeatedNames.set(owner, names);
  }
  return names.has(name);
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
  const { bindingCounts, varDeclarations, containsForOf } = collectBindings(body, parameterNames);
  // A `for...of` over a generator that is later withdrawn for ABI parity can
  // leave its newly claimed caller without a compatible IR element carrier.
  // Keep that cross-unit interaction outside this first `var` slice; ordinary
  // C-style loops and `for...in` remain eligible.
  if (containsForOf) return new Set();

  const safeDeclarations = new Set<ts.VariableDeclaration>();
  for (const declaration of varDeclarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    // (#7106 Stage 4) An uninitialized `var x;` statement (assert.throws'
    // `var expectedName, actualName;`) is held to the same reference rules;
    // a for-head `var` without an initializer stays out.
    if (!declaration.initializer && !ts.isVariableStatement(declaration.parent.parent)) continue;
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
      if (ts.isIdentifier(node) && node.text === name && !isNonReferenceName(node)) {
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
