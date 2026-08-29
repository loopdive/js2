// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-callable initializer analysis shared by storage typing and call dispatch.
 *
 * A builtin member value such as `Date.now` is a genuine JavaScript function
 * (externref), not one of this compiler's Wasm closure structs.  Bindings whose
 * initializer can select such a value must therefore keep an externref carrier
 * in host mode.  The call dispatcher uses the same proof to admit its
 * `__call_function` fallback when the runtime value is not a Wasm closure.
 */

import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { BUILTIN_CLASS_NAMES } from "../expressions/builtin-class-names.js";
import { resolvesToAmbientGlobal } from "../expressions/non-constructable.js";

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolvedVariableDeclaration(
  ctx: CodegenContext,
  identifier: ts.Identifier,
): ts.VariableDeclaration | undefined {
  let declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (declaration && (ts.isImportClause(declaration) || ts.isImportSpecifier(declaration))) {
    declaration = ctx.importBindingTargets?.get(declaration);
  }
  return declaration && ts.isVariableDeclaration(declaration) ? declaration : undefined;
}

function isHostBuiltinNamespace(
  ctx: CodegenContext,
  expression: ts.Expression,
  seen: Set<ts.VariableDeclaration>,
): boolean {
  const current = unwrap(expression);
  if (!ts.isIdentifier(current)) return false;
  if (ctx.declaredGlobals.has(current.text)) return true;
  if (BUILTIN_CLASS_NAMES.has(current.text) && resolvesToAmbientGlobal(ctx, current)) return true;

  const declaration = resolvedVariableDeclaration(ctx, current);
  if (!declaration?.initializer || seen.has(declaration)) return false;
  seen.add(declaration);
  return isHostBuiltinNamespace(ctx, declaration.initializer, seen);
}

function isHostBuiltinMember(ctx: CodegenContext, expression: ts.Expression): boolean {
  const current = unwrap(expression);
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false;
  return isHostBuiltinNamespace(ctx, current.expression, new Set());
}

function isDeclaredHostGlobal(ctx: CodegenContext, expression: ts.Expression): boolean {
  const current = unwrap(expression);
  return ts.isIdentifier(current) && ctx.declaredGlobals.has(current.text);
}

function isReflectiveAccessorExtraction(expression: ts.Expression): boolean {
  const current = unwrap(expression);
  if (!ts.isPropertyAccessExpression(current) || (current.name.text !== "get" && current.name.text !== "set")) {
    return false;
  }
  const receiver = unwrap(current.expression);
  if (!ts.isCallExpression(receiver)) return false;
  const callee = unwrap(receiver.expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "getOwnPropertyDescriptor";
}

/** True when `expression` can evaluate to a genuine host function. */
export function initializerMayProduceHostCallable(ctx: CodegenContext, expression: ts.Expression): boolean {
  if (ctx.standalone || ctx.wasi) return false;
  const current = unwrap(expression);

  if (
    ts.isNewExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "Proxy" &&
    resolvesToAmbientGlobal(ctx, current.expression)
  ) {
    return true;
  }
  if (isHostBuiltinMember(ctx, current) || isDeclaredHostGlobal(ctx, current)) return true;
  if (isReflectiveAccessorExtraction(current)) return true;
  if (ts.isConditionalExpression(current)) {
    return (
      initializerMayProduceHostCallable(ctx, current.whenTrue) ||
      initializerMayProduceHostCallable(ctx, current.whenFalse)
    );
  }
  if (
    ts.isBinaryExpression(current) &&
    (current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      initializerMayProduceHostCallable(ctx, current.left) || initializerMayProduceHostCallable(ctx, current.right)
    );
  }
  return false;
}

/** Resolve a variable (including a named import) and classify its initializer. */
export function variableMayProduceHostCallable(ctx: CodegenContext, identifier: ts.Identifier): boolean {
  const declaration = resolvedVariableDeclaration(ctx, identifier);
  return declaration?.initializer !== undefined && initializerMayProduceHostCallable(ctx, declaration.initializer);
}
