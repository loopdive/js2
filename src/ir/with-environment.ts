// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Backend-neutral selection contract for capturing a `with` Object Environment
 * Record in a closure.
 *
 * A supported closure captures the environment's receiver by reference. The
 * backend may use a struct ref for a proven closed object or an externref for a
 * dynamic object; either way the closure must rehydrate the same ordered scope
 * entry rather than snapshotting individual property values.
 *
 * This first slice deliberately accepts only ordinary synchronous function
 * expressions. Function declarations, arrows, classes, methods, generators,
 * constructors, and async functions remain explicit selector refusals until their own
 * creation/hoisting contracts can carry the environment record.
 */
import { forEachChild, ts } from "../ts-api.js";

export type IrWithEnvironmentSelection =
  | { readonly ok: true; readonly closureCount: number }
  | { readonly ok: false; readonly reason: string };

export interface IrWithEnvironmentCapture {
  /** Hidden binding that carries the object-environment receiver. */
  readonly bindingName: string;
  /** Outer-to-inner ordering within the active `with` scope chain. */
  readonly scopeIndex: number;
}

/**
 * Select the exact nested-boundary surface supported by the first IR contract.
 * The walk is complete: an unseen nested boundary is never treated as safe.
 */
export function selectWithEnvironmentClosures(statement: ts.Statement): IrWithEnvironmentSelection {
  let closureCount = 0;
  let refusal: string | null = null;
  const closureBindingNames = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (refusal !== null) return;
    if (node !== statement) {
      if (ts.isFunctionExpression(node)) {
        if (node.asteriskToken) {
          refusal = "generator function expression capture is not in the with-environment IR slice";
          return;
        }
        if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
          refusal = "async function expression capture is not in the with-environment IR slice";
          return;
        }
        closureCount++;
        let bindingExpression: ts.Expression = node;
        while (ts.isParenthesizedExpression(bindingExpression.parent)) bindingExpression = bindingExpression.parent;
        const parent = bindingExpression.parent;
        if (
          ts.isVariableDeclaration(parent) &&
          parent.initializer === bindingExpression &&
          ts.isIdentifier(parent.name)
        ) {
          closureBindingNames.add(parent.name.text);
        } else if (
          ts.isBinaryExpression(parent) &&
          parent.right === bindingExpression &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(parent.left)
        ) {
          closureBindingNames.add(parent.left.text);
        }
      } else if (ts.isArrowFunction(node)) {
        refusal = "arrow-function capture is not in the with-environment IR slice";
        return;
      } else if (ts.isFunctionDeclaration(node)) {
        refusal = "function-declaration hoisting is not in the with-environment IR slice";
        return;
      } else if (
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        refusal = "class or method capture is not in the with-environment IR slice";
        return;
      }
    }
    forEachChild(node, visit);
  };

  visit(statement);
  if (refusal === null && closureCount > 0) {
    const visitConstructors = (node: ts.Node): void => {
      if (refusal !== null) return;
      if (ts.isNewExpression(node)) {
        let callee: ts.Expression = node.expression;
        while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
        if (ts.isFunctionExpression(callee) || (ts.isIdentifier(callee) && closureBindingNames.has(callee.text))) {
          refusal = "constructible closure capture is not in the with-environment IR slice";
          return;
        }
      }
      forEachChild(node, visitConstructors);
    };
    visitConstructors(statement);
  }
  return refusal === null ? { ok: true, closureCount } : { ok: false, reason: refusal };
}

/** Create the ordered capture contract consumed by backend closure lowering. */
export function planWithEnvironmentCaptures(bindingNames: readonly string[]): readonly IrWithEnvironmentCapture[] {
  return bindingNames.map((bindingName, scopeIndex) => ({ bindingName, scopeIndex }));
}
