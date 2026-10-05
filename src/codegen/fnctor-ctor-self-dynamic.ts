// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6861) Does a function constructor call an INHERITED method on `this` while
 * it constructs?
 *
 * The #2660 escape gate classifies each `new F()` site by how the new instance is
 * used afterwards. A `keep-static` instance is lowered to the bespoke
 * `$__fnctor_<F>` struct, which has own fields but no `[[Prototype]]` link, so
 * every method that lives on `F.prototype` is unreachable from it. The use-site
 * ladder never looks inside `F` itself, so it misses the most common ES5 shape
 * of all, where the constructor delegates to its own prototype:
 *
 * ```js
 * function Hash(entries) { this.clear(); ... }   // lodash
 * Hash.prototype.clear = hashClear;
 * var data = { hash: new Hash };                 // site classified keep-static
 * ```
 *
 * Every instance runs `this.clear()` before any caller sees it, so every
 * `new Hash` site is used dynamically. With the site kept static, that call
 * found nothing and threw `TypeError: called value is not a function`. lodash's
 * module init died this way once #6738 made `new (memoize.Cache || MapCache)`
 * construct instead of evaluating to null.
 *
 * Only calls are matched (`this.m(…)`, where `m` is not an own field the
 * constructor assigns). A plain read like `this.x` is left alone: it may name a
 * field that a method assigns later, which is not evidence of a prototype
 * dispatch. Nested ordinary functions and classes bind their own `this` and are
 * skipped; arrow functions share the constructor's `this` and are searched.
 */
import { ts, forEachChild } from "../ts-api.js";

function ctorBodies(ctorSym: ts.Symbol): ts.Block[] {
  const bodies: ts.Block[] = [];
  for (const decl of ctorSym.getDeclarations() ?? []) {
    if ((ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl)) && decl.body) {
      bodies.push(decl.body);
      continue;
    }
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.body) bodies.push(init.body);
    }
  }
  return bodies;
}

const bindsOwnThis = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isClassDeclaration(node) ||
  ts.isClassExpression(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

/** True when `F`'s body calls `this.m(…)` for a method `m` it does not own. */
export function fnctorCtorCallsInheritedThisMethod(ctorSym: ts.Symbol, ownFields: ReadonlySet<string>): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found || bindsOwnThis(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      !ts.isPrivateIdentifier(node.expression.name) &&
      !ownFields.has(node.expression.name.text)
    ) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  };
  for (const body of ctorBodies(ctorSym)) {
    forEachChild(body, walk);
    if (found) return true;
  }
  return false;
}
