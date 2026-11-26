// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { identifierWritesOf, skipOuterExpressions } from "../../shared/binding-writes.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * (#7334) A `var` or `let` (module or function-local) written more than
 * once, some write of which stores something other than a function
 * expression, an arrow or a nullish value. The typed identifier-call routes cast the slot to one closure signature: the
 * one the closure map records from a function write, or the checker's
 * declared type (`var getter = function () {}`). Any other value, a number,
 * `g += 1`, an `any` or a union, a function declaration or builtin of another
 * signature, fails that cast; the guard throws only for a nullish value, and
 * the funcref fetch traps. Such a binding takes the dynamic route, which tests
 * IsCallable and calls whatever callable the slot holds, or throws a catchable
 * TypeError. A nullish write keeps the typed routes: their guard throws for
 * null and undefined (`emitNullCheckThrow`), with the message #7287 pins.
 */
const varNonClosureWrites = new WeakMap<ts.VariableDeclaration, boolean>();

export function varMayHoldNonClosure(ctx: CodegenContext, identifier: ts.Identifier): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  const cached = varNonClosureWrites.get(declaration);
  if (cached !== undefined) return cached;
  let writes = 0;
  let nonClosureWrite = false;
  const count = (stored: ts.Expression | undefined): void => {
    writes++;
    if (stored === undefined || !isClosureOrNullish(ctx, skipOuterExpressions(stored))) nonClosureWrite = true;
  };
  // The declaration's own initializer, which `identifierWritesOf` leaves out
  // for a `let`/`const` declarator (`let g = function () {}; g = 3`).
  if (declaration.initializer) count(declaration.initializer);
  const visit = (node: ts.Node): void => {
    if (node !== declaration) {
      for (const write of identifierWritesOf(node)) {
        if (ctx.oracle.valueDeclarationOf(write.target) === declaration) {
          // Only a `value` write names what it stores (for `g += v`, the assignment itself).
          count(write.kind === "value" ? write.expr : undefined);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(varScopeOf(declaration));
  // A var written once holds the value its checker type describes, which the
  // typed routes trust as they trust any typed value (`var format = o.format`).
  const found = writes > 1 && nonClosureWrite;
  varNonClosureWrites.set(declaration, found);
  return found;
}

function isClosureOrNullish(ctx: CodegenContext, value: ts.Expression): boolean {
  return (
    ts.isFunctionExpression(value) ||
    ts.isArrowFunction(value) ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value) ||
    // The global `undefined`, not a binding that shadows it.
    (ts.isIdentifier(value) && value.text === "undefined" && ctx.oracle.typeFactOf(value).kind === "undefined")
  );
}

/** The function or source file whose body holds every write of a `var` declared in it. */
function varScopeOf(declaration: ts.VariableDeclaration): ts.Node {
  let scope: ts.Node = declaration;
  while (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  return scope;
}
