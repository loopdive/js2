// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";

/**
 * (#2121) Per §10.2.11 FunctionDeclarationInstantiation, parameter bindings are
 * initialized left-to-right, so a default value that reads its own parameter or
 * a *later* one observes that binding in the TDZ and must throw ReferenceError.
 * Scan the default initializer of the parameter at `paramIndex` for an
 * identifier naming a parameter at index ≥ `paramIndex`. Returns that name when
 * found (the default would throw if it fired), else undefined. References to
 * strictly-earlier params (e.g. `f(a, b = a)`) are valid and ignored.
 *
 * (#5139) Lives in its own dependency-free module so every parameter lane —
 * plain functions (`function-body.ts`) and class methods/accessors
 * (`class-bodies.ts`) — shares one proof instead of only the first one.
 */
export function findTdzViolatingParamRef(decl: ts.FunctionLikeDeclarationBase, paramIndex: number): string | undefined {
  // Names of params bound at or after this one (the TDZ window). Skip binding
  // patterns and the `this` pseudo-param — only plain identifier params can be
  // referenced by name and observed in the TDZ here.
  const poisoned = new Set<string>();
  for (let j = paramIndex; j < decl.parameters.length; j++) {
    const p = decl.parameters[j]!;
    if (ts.isIdentifier(p.name) && p.name.text !== "this") poisoned.add(p.name.text);
  }
  if (poisoned.size === 0) return undefined;

  const init = decl.parameters[paramIndex]!.initializer;
  if (!init) return undefined;
  let found: string | undefined;
  const walk = (node: ts.Node): void => {
    if (found) return;
    // Do not descend into nested functions/arrows: a reference to the param
    // there is a closure capture resolved after instantiation, not a TDZ read.
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node) && poisoned.has(node.text)) {
      // Exclude identifiers in non-reference positions (property names, etc.).
      const parent = node.parent;
      if (
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node))
      ) {
        return;
      }
      found = node.text;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(init);
  return found;
}
