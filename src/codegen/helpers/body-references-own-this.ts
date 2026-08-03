// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

/**
 * Module-level memo cache. WeakMap keys die with their ts.Node when the
 * TS program is discarded between compiles — no explicit reset needed.
 */
const cache = new WeakMap<ts.Node, boolean>();

/**
 * #2152 — Check whether a node tree references `this` in its OWN function scope.
 *
 * A non-arrow `function` / method / accessor / constructor / class rebinds
 * `this`, so a `this` inside such a nested scope is unrelated to the function
 * whose body we are scanning — we do NOT descend into those. Arrow functions
 * are lexically `this`-bound, so a `this` inside a nested arrow DOES refer to
 * the enclosing function's `this` and counts — we traverse into arrows.
 *
 * Used to decide whether a (nested or top-level) function declaration body
 * should read the `__current_this` module global for `this` (#1636-S1 / #1702):
 * when such a function is passed by reference as an array-HOF callback
 * (`arr.filter(callbackfn, thisArg)`), the dispatcher installs the spec
 * `thisArg` into `__current_this` before the `call_ref`. For direct calls the
 * global is null and the null-guarded read falls back to `undefined`, so
 * enabling the read is behavior-preserving for ordinary calls.
 *
 * Iterative DFS to avoid stack overflow on deep ASTs (CI cgroup limits,
 * mirrors `bodyUsesArguments`), memoized so overlapping subtrees stay O(N).
 */
export function bodyReferencesOwnThis(node: ts.Node): boolean {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;

  const stack: ts.Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      cache.set(node, true);
      return true;
    }
    // A direct eval may reference `this` in source that is unavailable to the
    // outer TypeScript AST (including a runtime-built string). Treat the call
    // as an own-this use so callable dispatch preserves an explicit receiver;
    // the eval bridge separately performs sloppy null/undefined substitution.
    if (ts.isCallExpression(current)) {
      let callee: ts.Expression = current.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      if (ts.isIdentifier(callee) && callee.text === "eval") {
        cache.set(node, true);
        return true;
      }
    }
    // Non-arrow function-like / class scopes rebind `this` — don't descend.
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isClassExpression(current)
    ) {
      continue;
    }
    // Arrow functions inherit the enclosing `this` — traverse into them.
    current.forEachChild((child) => {
      stack.push(child);
    });
  }
  cache.set(node, false);
  return false;
}
