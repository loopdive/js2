// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { identifierWritesOf, skipOuterExpressions } from "../../shared/binding-writes.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * (#7334) A module `var` the closure map records by its function write while
 * another write stores something else (`getter = function () {}; getter = 3`).
 * The recorded signature does not describe the live value, so the call takes
 * the dynamic route, which tests IsCallable and throws a catchable TypeError,
 * instead of casting to the recorded closure and trapping on the failed cast.
 * A nullish write keeps the closure route: its guard throws for null and
 * undefined (`emitNullCheckThrow`).
 */
const moduleVarNonFunctionWrites = new WeakMap<ts.VariableDeclaration, boolean>();

export function moduleVarHoldsNonFunctionWrite(ctx: CodegenContext, identifier: ts.Identifier): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ctx.moduleGlobals.has(identifier.text)) return false;
  let found = moduleVarNonFunctionWrites.get(declaration);
  if (found !== undefined) return found;
  found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    for (const write of identifierWritesOf(node)) {
      if (ctx.oracle.valueDeclarationOf(write.target) !== declaration) continue;
      const value = write.kind === "value" ? skipOuterExpressions(write.expr) : undefined;
      if (!value || !(isFunctionValue(value) || isNullishValue(value))) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  moduleVarNonFunctionWrites.set(declaration, found);
  return found;
}

function isFunctionValue(value: ts.Expression): boolean {
  return ts.isFunctionExpression(value) || ts.isArrowFunction(value);
}

function isNullishValue(value: ts.Expression): boolean {
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value) ||
    (ts.isIdentifier(value) && value.text === "undefined")
  );
}
