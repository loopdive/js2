// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The narrow standalone Error.prototype.toString replacement arm used by the
// receiver-method dispatcher. Keeping the source proof here avoids growing
// that dispatcher god-file for one ES5 residual row.

import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression, type InnerResult } from "../shared.js";
import { compileStringLiteral } from "../string-ops.js";
import { isBuiltinErrorConstructorExpression } from "./builtin-prototype-constructor.js";
import { resolvesToNamedAmbientGlobal } from "./non-constructable.js";

/** Does this binding hold an Error made by the native builtin constructor path? */
function isBuiltinErrorInstance(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(expr);
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
  const initializer = declaration.initializer;
  return ts.isNewExpression(initializer) && isBuiltinErrorConstructorExpression(ctx, initializer.expression);
}

function isBuiltinErrorReceiverValue(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (isBuiltinErrorInstance(ctx, expr)) return true;
  if (!ts.isCallExpression(expr) || expr.arguments.length !== 0) return false;
  const callee = expr.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "valueOf" &&
    isBuiltinErrorInstance(ctx, callee.expression)
  );
}

/** Detect the exact builtin-prototype write that can shadow Error#toString. */
function writesErrorPrototypeToString(ctx: CodegenContext, anchor: ts.Node): boolean {
  if (!ctx.protoNamedWrittenMembers.has("toString")) return false;
  const source = anchor.getSourceFile();
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isPropertyAccessExpression(node.right)
    ) {
      const target = node.left;
      const prototype = target.expression;
      const replacement = node.right;
      const replacementPrototype = replacement.expression;
      if (
        target.name.text === "toString" &&
        ts.isPropertyAccessExpression(prototype) &&
        prototype.name.text === "prototype" &&
        ts.isIdentifier(prototype.expression) &&
        resolvesToNamedAmbientGlobal(ctx, prototype.expression, "Error") &&
        replacement.name.text === "toString" &&
        ts.isPropertyAccessExpression(replacementPrototype) &&
        replacementPrototype.name.text === "prototype" &&
        resolvesToNamedAmbientGlobal(ctx, replacementPrototype.expression, "Object")
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/**
 * Preserve the ES5 result of replacing Error.prototype.toString with
 * Object.prototype.toString for a native Error instance. The arm is
 * standalone-only and deliberately exact; all other replacement values keep
 * the ordinary dynamic method path.
 */
export function tryCompileStandaloneErrorPrototypeToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (
    !ctx.standalone ||
    propAccess.name.text !== "toString" ||
    expr.arguments.length !== 0 ||
    !writesErrorPrototypeToString(ctx, propAccess) ||
    !isBuiltinErrorReceiverValue(ctx, propAccess.expression)
  ) {
    return undefined;
  }

  const receiver = compileExpression(ctx, fctx, propAccess.expression);
  if (receiver !== null) fctx.body.push({ op: "drop" });
  return compileStringLiteral(ctx, fctx, "[object Error]");
}
