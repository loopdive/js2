// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { isBuiltinConstructorIdentityName } from "./builtin-static-globals.js";
import { tryEnsureNativeProtoBrand } from "./builtin-value-read.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { compileExpression } from "./shared.js";
import { bindingIsSingleAssignment } from "./single-assignment-binding.js";

function ambientConstructedBuiltinName(ctx: CodegenContext, instance: ts.Expression): string | undefined {
  let construction = instance;
  if (ts.isIdentifier(instance)) {
    const declaration = ctx.oracle.variableDeclarationOf(instance);
    if (
      !declaration?.initializer ||
      !bindingIsSingleAssignment(ctx, instance) ||
      declaration.getSourceFile() !== instance.getSourceFile() ||
      instance.getStart() < declaration.end
    ) {
      return undefined;
    }
    construction = declaration.initializer;
  }
  while (
    ts.isParenthesizedExpression(construction) ||
    ts.isAsExpression(construction) ||
    ts.isTypeAssertionExpression(construction) ||
    ts.isNonNullExpression(construction)
  ) {
    construction = construction.expression;
  }
  if (!ts.isNewExpression(construction) || !ts.isIdentifier(construction.expression)) return undefined;
  const builtinName = construction.expression.text;
  if (!isBuiltinConstructorIdentityName(builtinName)) return undefined;
  const constructorDeclaration = ctx.oracle.valueDeclarationOf(construction.expression);
  return constructorDeclaration?.getSourceFile().isDeclarationFile ? builtinName : undefined;
}

const constructorPropTouchCache = new WeakMap<ts.SourceFile, boolean>();

/** Whether source code can install, assign, or delete a `constructor` property. */
export function moduleTouchesConstructorProp(sourceFile: ts.SourceFile): boolean {
  let touched = constructorPropTouchCache.get(sourceFile);
  if (touched !== undefined) return touched;
  touched = false;
  const isConstructorMember = (expression: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(expression) && expression.name.text === "constructor") ||
    (ts.isElementAccessExpression(expression) &&
      ts.isStringLiteralLike(expression.argumentExpression) &&
      expression.argumentExpression.text === "constructor");
  const visit = (node: ts.Node): void => {
    if (touched) return;
    if (
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        isConstructorMember(node.left)) ||
      (ts.isDeleteExpression(node) && isConstructorMember(node.expression))
    ) {
      touched = true;
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (
        method === "defineProperty" &&
        node.arguments.length >= 2 &&
        ts.isStringLiteralLike(node.arguments[1]!) &&
        node.arguments[1]!.text === "constructor"
      ) {
        touched = true;
        return;
      }
      if (method === "defineProperties" && node.arguments.length >= 2) {
        const descriptors = node.arguments[1];
        if (
          descriptors !== undefined &&
          ts.isObjectLiteralExpression(descriptors) &&
          descriptors.properties.some((property) => {
            const name = property.name;
            return (
              name !== undefined &&
              (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
              name.text === "constructor"
            );
          })
        ) {
          touched = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  constructorPropTouchCache.set(sourceFile, touched);
  return touched;
}

/**
 * Preserve the intrinsic identity of `<builtin instance>.constructor.prototype`.
 * The ambient `constructor` property is typed as broad `Function`, so a generic
 * outer read otherwise observes `%Function.prototype%`. The caller supplies the
 * module-wide proof that no source write can shadow `constructor`.
 */
export function tryEmitBuiltinInstanceConstructorPrototype(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | undefined {
  if (
    !ctx.standalone ||
    moduleTouchesConstructorProp(expr.getSourceFile()) ||
    expr.name.text !== "prototype" ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.name.text !== "constructor"
  ) {
    return undefined;
  }
  const instance = expr.expression.expression;
  const builtinName = ambientConstructedBuiltinName(ctx, instance);
  if (builtinName === undefined) return undefined;
  const brand = tryEnsureNativeProtoBrand(ctx, builtinName);
  if (brand === undefined) return undefined;
  const instanceResult = compileExpression(ctx, fctx, instance);
  if (instanceResult !== null) fctx.body.push({ op: "drop" });
  return emitLazyNativeProtoGet(ctx, fctx, brand) ? { kind: "externref" } : undefined;
}
