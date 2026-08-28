// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2121 / #5139) Parameter-list AST predicates shared by every lane that emits
 * parameter defaults: plain functions (`function-body.ts`) and class
 * constructors / methods / accessors (`class-bodies.ts`). Kept dependency-free
 * (AST only) so both can import it without a module cycle.
 */
import { ts, forEachChild } from "../ts-api.js";

/**
 * (#2121) Per §10.2.11 FunctionDeclarationInstantiation, parameter bindings are
 * initialized left-to-right, so a default value that reads its own parameter or
 * a *later* one observes that binding in the TDZ and must throw ReferenceError.
 * Scan the default initializer of the parameter at `paramIndex` for an
 * identifier naming a parameter at index ≥ `paramIndex`. Returns that name when
 * found (the default would throw if it fired), else undefined. References to
 * strictly-earlier params (e.g. `f(a, b = a)`) are valid and ignored.
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
    forEachChild(node, walk);
  };
  walk(init);
  return found;
}

/**
 * (#5139) True when some parameter's DEFAULT initializer reads `arguments`
 * (`method(x = arguments[2])`). §10.2.11 creates the arguments object BEFORE
 * IteratorBindingInitialization runs the defaults, so the lane must materialize
 * it up front instead of after the parameter loop — otherwise the default reads
 * an uninitialized slot. Nested functions are not descended into: `arguments`
 * there binds to the inner function's own object.
 */
export function paramDefaultsReferenceArguments(decl: ts.FunctionLikeDeclarationBase): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === "arguments") {
      found = true;
      return;
    }
    forEachChild(node, walk);
  };
  for (const param of decl.parameters) {
    if (param.initializer) walk(param.initializer);
    if (found) break;
  }
  return found;
}
