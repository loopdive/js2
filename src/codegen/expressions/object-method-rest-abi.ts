// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext, RestParamInfo } from "../context/types.js";
import { getArrTypeIdxFromVec } from "../registry/types.js";
import { skipTransparentExpressions } from "../shared.js";
import { pushDefaultValue } from "../type-coercion.js";
import { compileInternalCallArgument } from "./internal-call-argument.js";

function objectLiteralMethodDeclaration(
  ctx: CodegenContext,
  expr: ts.CallExpression,
): ts.MethodDeclaration | undefined {
  const callee = skipTransparentExpressions(expr.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  let receiver = skipTransparentExpressions(callee.expression);
  if (ts.isIdentifier(receiver)) {
    const initializer = ctx.oracle.constInitializerOf(receiver);
    if (initializer) receiver = skipTransparentExpressions(initializer);
  }
  if (!ts.isObjectLiteralExpression(receiver)) return undefined;
  return receiver.properties.find(
    (property): property is ts.MethodDeclaration =>
      ts.isMethodDeclaration(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) &&
      property.name.text === callee.name.text,
  );
}

/**
 * Decline the direct object-method arm when its source rest parameter binds a
 * pattern (`m(...[x]) {}`). That method body has a fixed tuple formal, so
 * padding an omitted argument with a null ref traps before parameter setup.
 * The generic closed dispatcher performs the required rest initialization.
 */
export function directObjectMethodFuncIdx(
  ctx: CodegenContext,
  expr: ts.CallExpression,
  funcIdx: number | undefined,
): number | undefined {
  if (funcIdx === undefined) return undefined;
  const declaration = objectLiteralMethodDeclaration(ctx, expr);
  const hasRestBinding = declaration?.parameters.some(
    (parameter) =>
      parameter.dotDotDotToken !== undefined &&
      (ts.isArrayBindingPattern(parameter.name) || ts.isObjectBindingPattern(parameter.name)),
  );
  return hasRestBinding ? undefined : funcIdx;
}

/**
 * Object-literal lowering does not publish `funcRestParams`. Recover the
 * already-materialized vec ABI for an identifier rest parameter only; binding
 * patterns use the tuple ABI and are deliberately left to generic dispatch.
 */
export function knownMethodRestInfo(
  ctx: CodegenContext,
  expr: ts.CallExpression,
  fullName: string,
  paramTypes: ValType[] | undefined,
  selfOffset: number,
): RestParamInfo | undefined {
  const registered = ctx.funcRestParams.get(fullName);
  if (registered) return registered;
  const declaration = objectLiteralMethodDeclaration(ctx, expr);
  const restIndex = declaration?.parameters.findIndex(
    (parameter) => parameter.dotDotDotToken !== undefined && ts.isIdentifier(parameter.name),
  );
  if (restIndex === undefined || restIndex < 0) return undefined;
  const restType = paramTypes?.[selfOffset + restIndex];
  if (!restType || (restType.kind !== "ref" && restType.kind !== "ref_null")) return undefined;
  const vecTypeIdx = restType.typeIdx;
  const arrayTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrayTypeIdx < 0) return undefined;
  const arrayType = ctx.mod.types[arrayTypeIdx];
  if (!arrayType || arrayType.kind !== "array") return undefined;
  return { restIndex, elemType: arrayType.element, arrayTypeIdx, vecTypeIdx };
}

/** Materialize the hidden vec argument for a known JavaScript rest method. */
export function emitKnownRestMethodArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  paramTypes: ValType[] | undefined,
  restInfo: RestParamInfo,
  selfOffset: number,
): boolean {
  if (expr.arguments.some((argument) => ts.isSpreadElement(argument))) return false;
  const fixedCount = restInfo.restIndex;
  for (let index = 0; index < fixedCount; index++) {
    if (index < expr.arguments.length) {
      compileInternalCallArgument(ctx, fctx, expr.arguments[index]!, paramTypes?.[selfOffset + index]);
    } else {
      pushDefaultValue(fctx, paramTypes?.[selfOffset + index] ?? { kind: "f64" }, ctx);
    }
  }
  const restCount = Math.max(0, expr.arguments.length - fixedCount);
  fctx.body.push({ op: "i32.const", value: restCount });
  for (let index = fixedCount; index < expr.arguments.length; index++) {
    compileInternalCallArgument(ctx, fctx, expr.arguments[index]!, restInfo.elemType);
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: restCount });
  fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
  return true;
}
