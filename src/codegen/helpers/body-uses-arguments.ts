// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

/**
 * Module-level memo cache. WeakMap keys die with their ts.Node when the
 * TS program is discarded between compiles — no explicit reset needed.
 */
const cache = new WeakMap<ts.Node, boolean>();
const valueUseCache = new WeakMap<ts.Node, boolean>();

function bindingNameBindsArguments(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return name.text === "arguments";
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindingNameBindsArguments(element.name));
}

/**
 * ES5 §10.5 / ES2015+ FunctionDeclarationInstantiation: an ordinary
 * function does not create an implicit arguments object when one of its
 * formal parameter BoundNames is `arguments`.
 *
 * Keep this structural rule shared by every lowering path. Those paths use a
 * spelling-keyed local map, so creating the object would otherwise overwrite
 * the real parameter before body references are compiled (#4555).
 */
export function formalParametersBindArguments(parameters: readonly ts.ParameterDeclaration[]): boolean {
  return parameters.some((parameter) => bindingNameBindsArguments(parameter.name));
}

/** Whether this lowering should materialize the function's implicit object. */
export function needsImplicitArgumentsObject(
  declaration: ts.FunctionLikeDeclarationBase,
  reachesDirectEval = false,
): boolean {
  const body = declaration.body;
  return (
    body !== undefined &&
    !formalParametersBindArguments(declaration.parameters) &&
    (bodyUsesArguments(body) || reachesDirectEval)
  );
}

/**
 * Check if a node tree references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 *
 * Uses iterative DFS to avoid stack overflow on deeply nested ASTs
 * (CI cgroup limits, #1085). Results are memoized so repeated calls on
 * overlapping subtrees collapse from O(N²) to O(N) total (#1086).
 */
export function bodyUsesArguments(node: ts.Node): boolean {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;

  const stack: ts.Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ts.isIdentifier(current) && current.text === "arguments") {
      cache.set(node, true);
      return true;
    }
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
      continue;
    }
    // Arrow functions do NOT have their own `arguments` — they inherit
    // the enclosing function's, so we must traverse into them.
    current.forEachChild((child) => {
      stack.push(child);
    });
  }
  cache.set(node, false);
  return false;
}

/**
 * Whether a body contains a value-position use of `arguments` that requires
 * the function's implicit arguments object.
 *
 * Generator admission needs a narrower answer than {@link bodyUsesArguments}:
 * a bare body binding such as `let arguments;` or `var arguments;` is relevant
 * to EvalDeclarationInstantiation, but does not read or write the implicit
 * arguments object. Treating the binding name itself as a value use needlessly
 * routes otherwise native standalone generators through the host buffer.
 *
 * This remains deliberately conservative. Only declaration/binding names and
 * non-computed property names are ignored; every executable reference,
 * including assignment targets and shorthand properties, still counts.
 */
export function bodyNeedsArgumentsObject(node: ts.Node): boolean {
  const cached = valueUseCache.get(node);
  if (cached !== undefined) return cached;

  const stack: ts.Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ts.isIdentifier(current) && current.text === "arguments") {
      const parent = current.parent;
      const isBindingName =
        (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) &&
        parent.name === current;
      const isNonComputedPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
        (ts.isPropertyAssignment(parent) && parent.name === current) ||
        (ts.isMethodDeclaration(parent) && parent.name === current) ||
        (ts.isPropertyDeclaration(parent) && parent.name === current) ||
        (ts.isGetAccessorDeclaration(parent) && parent.name === current) ||
        (ts.isSetAccessorDeclaration(parent) && parent.name === current);
      if (!isBindingName && !isNonComputedPropertyName) {
        valueUseCache.set(node, true);
        return true;
      }
    }
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
      continue;
    }
    current.forEachChild((child) => {
      stack.push(child);
    });
  }
  valueUseCache.set(node, false);
  return false;
}
