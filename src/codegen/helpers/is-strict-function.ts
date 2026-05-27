// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

const cache = new WeakMap<ts.Node, boolean>();

/** True when the prologue of `body` opens with a `"use strict"` directive. */
function hasUseStrictPrologue(statements: readonly ts.Statement[]): boolean {
  for (const s of statements) {
    // A Directive Prologue is a leading run of ExpressionStatements whose
    // expression is a string literal. The first non-directive statement ends it.
    if (ts.isExpressionStatement(s) && ts.isStringLiteralLike(s.expression)) {
      if (s.expression.text === "use strict") return true;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Decide whether `fn`'s body is strict-mode code (ECMA-262 §11.2.2).
 *
 * Strict applies when any of these hold:
 *  - the function body itself opens with a `"use strict"` directive,
 *  - an enclosing function body or the SourceFile opens with `"use strict"`,
 *  - the function is a class element or lives anywhere inside a class
 *    (ClassDeclaration / ClassExpression bodies are always strict).
 *
 * NOTE: ES-module strictness is deliberately NOT inferred from top-level
 * import/export here. The compiler wraps every program in a synthetic
 * `export function test(...)` entry point, which would make *every* source a
 * module and wrongly unmap sloppy-mode `arguments`. The only reliable signals
 * left after wrapping are explicit `"use strict"` prologues and class context.
 *
 * This drives the mapped-vs-unmapped `arguments` split: strict functions get
 * an *unmapped* arguments object, so writes to `arguments[i]` must not flow
 * back into the named parameter (#779e).
 */
export function isStrictFunction(fn: ts.FunctionLikeDeclaration): boolean {
  const cached = cache.get(fn);
  if (cached !== undefined) return cached;

  let result = false;

  // 1. The function's own directive prologue.
  if (fn.body && ts.isBlock(fn.body) && hasUseStrictPrologue(fn.body.statements)) {
    result = true;
  }

  // 2. Walk enclosing scopes for a class context or an outer "use strict".
  if (!result) {
    for (let node: ts.Node | undefined = fn.parent; node; node = node.parent) {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        result = true;
        break;
      }
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
        if (node.body && ts.isBlock(node.body) && hasUseStrictPrologue(node.body.statements)) {
          result = true;
          break;
        }
      }
      if (ts.isSourceFile(node)) {
        if (hasUseStrictPrologue(node.statements)) {
          result = true;
        }
        break;
      }
    }
  }

  cache.set(fn, result);
  return result;
}
