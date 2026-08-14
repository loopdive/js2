// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) Is a builtin Error constructor name SHADOWED by a user declaration at
 * this `new` site?
 *
 * `tryCompileBuiltinGlobalNew` claims `new TypeError(…)` — and the rest of the
 * NativeError family — by NAME, with no scope check. So
 *
 * ```js
 * (function () {
 *   function TypeError() {}
 *   assert.throws(TypeError, function () { throw new TypeError(); });
 * })();
 * ```
 *
 * constructed the INTRINSIC TypeError while the `TypeError` identifier read the
 * local one — measured: `e.constructor === TypeError` false,
 * `e.constructor === intrinsicTypeError` true. That is the exact collision
 * `harness/assert-throws-custom-typeerror.js` exists to detect, and which
 * `assert.throws` reports as "Expected a TypeError but got a different error
 * constructor with the same name".
 *
 * The test is purely syntactic on purpose: it walks the enclosing scope chain
 * from the `new` site looking for a binding of the name, so it costs no checker
 * query (the oracle cannot express "which binding wins here" as a `ValType`
 * question, and a raw `getSymbolAtLocation` would trip the oracle ratchet).
 *
 * It is deliberately CONSERVATIVE — every miss keeps today's behaviour. In
 * particular a `var` nested inside a block hoists to function scope but is not
 * reported here; adding that would be a widening, not a correction.
 */
import { ts } from "../../ts-api.js";

/** Does this statement list declare `name` as a var / function / class? */
function statementsDeclare(statements: readonly ts.Statement[], name: string): boolean {
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      if (stmt.name !== undefined && stmt.name.text === name) return true;
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        // Only a plain `var x` / `let x` binds the bare name; a destructuring
        // pattern that happens to mention it is not this name's declaration.
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return true;
      }
    }
  }
  return false;
}

/** Does a parameter list bind `name`? Identifier params only; patterns are not. */
function parametersDeclare(params: readonly ts.ParameterDeclaration[], name: string): boolean {
  return params.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
}

/**
 * True when `name` resolves to a USER binding somewhere in the scope chain
 * enclosing `node` — i.e. the intrinsic of that name is shadowed here.
 *
 * The source file's own top level counts: a script that declares
 * `function TypeError` at module scope genuinely shadows the intrinsic for
 * every `new TypeError()` below it.
 */
/** Does this statement list declare `name` as a FUNCTION declaration? */
function statementsDeclareFunction(statements: readonly ts.Statement[], name: string): boolean {
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined && stmt.name.text === name) return true;
  }
  return false;
}

/**
 * (#4394 standalone) True when `name` is shadowed by a user FUNCTION
 * DECLARATION in the scope chain enclosing `node` — the literal sta.js shape
 * (`function Test262Error(message) { … }`).
 *
 * Deliberately NARROWER than {@link errorCtorNameIsUserShadowed}: a `class
 * Test262Error extends Error` (the wrapped-harness injection #2902 was built
 * for) or a `var Test262Error = …` does NOT match, so the standalone
 * `$Error_struct` interception keeps claiming those shapes and the ~2,779
 * host-free wrapped tests are untouched. Only the declared-function shape —
 * where the interception's `$Error_struct` return FAILS the
 * `$__fnctor_Test262Error` cast at the binding site and leaves the instance
 * NULL (no `.message`, no `.constructor`, `instanceof` null-deref, thrown
 * value rendered "undefined") — declines into the ordinary user-fnctor
 * lowering.
 */
export function errorCtorNameIsUserFunctionShadowed(node: ts.Node, name: string): boolean {
  let cursor: ts.Node | undefined = node.parent;
  while (cursor !== undefined) {
    if (ts.isSourceFile(cursor)) return statementsDeclareFunction(cursor.statements, name);
    if (ts.isBlock(cursor) || ts.isModuleBlock(cursor)) {
      if (statementsDeclareFunction(cursor.statements, name)) return true;
    } else if (ts.isCaseClause(cursor) || ts.isDefaultClause(cursor)) {
      if (statementsDeclareFunction(cursor.statements, name)) return true;
    }
    cursor = cursor.parent;
  }
  return false;
}

export function errorCtorNameIsUserShadowed(node: ts.Node, name: string): boolean {
  let cursor: ts.Node | undefined = node.parent;
  while (cursor !== undefined) {
    if (ts.isSourceFile(cursor)) return statementsDeclare(cursor.statements, name);
    if (ts.isBlock(cursor) || ts.isModuleBlock(cursor)) {
      if (statementsDeclare(cursor.statements, name)) return true;
    } else if (ts.isCaseClause(cursor) || ts.isDefaultClause(cursor)) {
      if (statementsDeclare(cursor.statements, name)) return true;
    } else if (
      ts.isFunctionDeclaration(cursor) ||
      ts.isFunctionExpression(cursor) ||
      ts.isArrowFunction(cursor) ||
      ts.isMethodDeclaration(cursor) ||
      ts.isConstructorDeclaration(cursor) ||
      ts.isGetAccessorDeclaration(cursor) ||
      ts.isSetAccessorDeclaration(cursor)
    ) {
      if (parametersDeclare(cursor.parameters, name)) return true;
      // A named function expression binds its own name inside its body.
      if (ts.isFunctionExpression(cursor) && cursor.name?.text === name) return true;
    } else if (ts.isCatchClause(cursor)) {
      const vd = cursor.variableDeclaration;
      if (vd !== undefined && ts.isIdentifier(vd.name) && vd.name.text === name) return true;
    } else if (ts.isForStatement(cursor) || ts.isForInStatement(cursor) || ts.isForOfStatement(cursor)) {
      const init = cursor.initializer;
      if (init !== undefined && ts.isVariableDeclarationList(init)) {
        for (const decl of init.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name) return true;
        }
      }
    }
    cursor = cursor.parent;
  }
  return false;
}
