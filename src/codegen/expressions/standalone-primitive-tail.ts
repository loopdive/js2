// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4516) Small standalone-only tails for primitive-wrapper prototype methods.
 *
 * These paths live outside the receiver-method dispatcher so the large shared
 * dispatch function does not grow for one ES5 compatibility bucket.  The
 * callbacks in the Number helper keep this leaf independent of `calls.ts`,
 * which owns the main call-expression dispatcher and imports the receiver
 * dispatcher itself.
 */
import { ts } from "../../ts-api.js";
import { isBooleanWrapperType, isNumberWrapperType, isStringWrapperType } from "../../checker/type-mapper.js";
import type { ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { emitToBoolean, emitToString, runtimeToPrimitiveInstrs } from "../coercion-engine.js";
import { coerceType, compileExpression } from "../shared.js";
import type { InnerResult } from "../shared.js";
import { ensureWrapperProtoDynamicMember } from "../wrapper-proto-dynamic-demand.js";

function isBooleanPrototype(fctx: FunctionContext, expr: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== "prototype") return false;
  const base = expr.expression;
  if (!ts.isIdentifier(base) || base.text !== "Boolean") return false;
  return !fctx.localMap.has("Boolean") && !(fctx.boxedCaptures?.has("Boolean") ?? false);
}

/** Emit the canonical ToBoolean path used by standalone `new Boolean(value)`. */
export function emitStandaloneBooleanConstructorValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): void {
  let argType: ValType | null;
  if (args.length > 0) {
    argType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
      argType = { kind: "externref" };
    } else if (argType.kind !== "externref") {
      coerceType(ctx, fctx, argType, { kind: "externref" });
      argType = { kind: "externref" };
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
    argType = { kind: "externref" };
  }
  emitToBoolean(ctx, argType, fctx.body);
  fctx.body.push({ op: "f64.convert_i32_s" });
}

export interface WrapperDynamicTailCallbacks {
  sourceOverridesMethodOnReceiver: (receiver: ts.Expression, methodName: string, ctx?: CodegenContext) => boolean;
  emitWrapperDynamicMethodCall: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    receiver: ts.Expression,
    methodName: string,
  ) => ValType | null;
}

/** Route an overridden wrapper method through its demanded runtime closure. */
export function tryCompileWrapperDynamicMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
  callbacks: WrapperDynamicTailCallbacks,
): ValType | undefined {
  const methodName = propAccess.name.text;
  const brand = isStringWrapperType(receiverType)
    ? "String"
    : isNumberWrapperType(receiverType)
      ? "Number"
      : isBooleanWrapperType(receiverType)
        ? "Boolean"
        : undefined;
  if (!brand || (methodName !== "valueOf" && methodName !== "toString")) return undefined;
  if (!callbacks.sourceOverridesMethodOnReceiver(propAccess.expression, methodName, ctx)) return undefined;

  ensureWrapperProtoDynamicMember(ctx, brand, methodName);
  const memberIgnoresArguments = methodName === "valueOf" || (methodName === "toString" && brand !== "Number");
  if (callExpr.arguments.length !== 0 && !memberIgnoresArguments) return undefined;
  return callbacks.emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, methodName) ?? undefined;
}

/**
 * After deleting `String.prototype.toString`, wrapper instances inherit
 * `Object.prototype.toString`. Re-emit that borrowed call before the native
 * String-wrapper fast path can recover and stringify [[StringData]] directly.
 */
export function tryCompileStandaloneDeletedStringToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
  expectedType: ValType | undefined,
  compileCallExpression: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    expr: ts.CallExpression,
    expectedType?: ValType,
  ) => InnerResult,
): InnerResult | undefined {
  if (
    !ctx.standalone ||
    propAccess.name.text !== "toString" ||
    !isStringWrapperType(receiverType) ||
    !ctx.deletedBuiltinPrototypeMembers?.has("String.prototype.toString")
  ) {
    return undefined;
  }

  const objectProto = ts.factory.createPropertyAccessExpression(
    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Object"), "prototype"),
    "toString",
  );
  const borrowed = ts.factory.createPropertyAccessExpression(objectProto, "call");
  const borrowedCall = ts.factory.createCallExpression(borrowed, undefined, [
    propAccess.expression,
    ...Array.from(callExpr.arguments),
  ]);
  ts.setTextRange(borrowedCall, callExpr);
  (borrowedCall as { parent?: ts.Node }).parent = callExpr.parent;
  return compileCallExpression(ctx, fctx, borrowedCall, expectedType);
}

/**
 * After deleting `Boolean.prototype.toString`, Boolean prototypes and wrapper
 * instances inherit `Object.prototype.toString`. Re-emit that borrowed call
 * before the Boolean-wrapper fast path recovers the internal boolean slot.
 */
export function tryCompileStandaloneDeletedBooleanToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
  expectedType: ValType | undefined,
  compileCallExpression: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    expr: ts.CallExpression,
    expectedType?: ValType,
  ) => InnerResult,
): InnerResult | undefined {
  if (
    !ctx.standalone ||
    propAccess.name.text !== "toString" ||
    receiverType.getSymbol()?.name !== "Boolean" ||
    !ctx.deletedBuiltinPrototypeMembers?.has("Boolean.prototype.toString")
  ) {
    return undefined;
  }

  const objectProto = ts.factory.createPropertyAccessExpression(
    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Object"), "prototype"),
    "toString",
  );
  const borrowed = ts.factory.createPropertyAccessExpression(objectProto, "call");
  const borrowedCall = ts.factory.createCallExpression(borrowed, undefined, [
    propAccess.expression,
    ...Array.from(callExpr.arguments),
  ]);
  ts.setTextRange(borrowedCall, callExpr);
  (borrowedCall as { parent?: ts.Node }).parent = callExpr.parent;
  return compileCallExpression(ctx, fctx, borrowedCall, expectedType);
}

/**
 * Compile `Boolean.prototype.toString()` and Boolean wrapper `toString()` in
 * standalone mode.  The native prototype has the built-in false slot, while
 * a wrapper's slot is recovered by the shared runtime primitive engine.
 */
export function tryCompileStandaloneBooleanToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
  expectedType: ValType | undefined,
  compileCallExpression: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    expr: ts.CallExpression,
    expectedType?: ValType,
  ) => InnerResult,
): InnerResult | undefined {
  if (!ctx.standalone || receiverType.getSymbol()?.name !== "Boolean" || propAccess.name.text !== "toString") {
    return undefined;
  }

  const deletedBooleanToString = tryCompileStandaloneDeletedBooleanToString(
    ctx,
    fctx,
    propAccess,
    callExpr,
    receiverType,
    expectedType,
    compileCallExpression,
  );
  if (deletedBooleanToString !== undefined) return deletedBooleanToString;

  ensureObjectRuntime(ctx);
  const receiverLocal = allocLocal(fctx, `__bool_toString_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: receiverLocal });
  for (const arg of callExpr.arguments) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType !== null) fctx.body.push({ op: "drop" });
  }

  if (isBooleanPrototype(fctx, propAccess.expression)) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return emitToString(ctx, fctx, { kind: "i32" }, { kind: "boolean" }, "string");
  }

  const toPrimitive = runtimeToPrimitiveInstrs(ctx, "string");
  const unboxBoolean = ctx.funcMap.get("__unbox_boolean");
  if (toPrimitive !== null && unboxBoolean !== undefined) {
    fctx.body.push({ op: "local.get", index: receiverLocal }, ...toPrimitive, { op: "call", funcIdx: unboxBoolean });
    return emitToString(ctx, fctx, { kind: "i32" }, { kind: "boolean" }, "string");
  }

  fctx.body.push({ op: "local.get", index: receiverLocal });
  return { kind: "externref" };
}

export interface NumberPrototypeTailCallbacks {
  sourceOverridesBuiltinPrototypeMember: (
    ctx: CodegenContext,
    anchor: ts.Node,
    builtinName: string,
    methodName: string,
  ) => boolean;
  compileCallExpression: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    expr: ts.CallExpression,
    expectedType?: ValType,
  ) => InnerResult;
  emitWrapperDynamicMethodCall: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    receiver: ts.Expression,
    methodName: string,
    callExpr?: ts.CallExpression,
  ) => ValType | null;
}

/**
 * Apply exact Number.prototype override/delete semantics before the numeric
 * formatter.  The callbacks avoid importing the main call dispatcher here,
 * which would create a cycle through `call-receiver-method.ts`.
 */
export function tryCompileStandaloneNumberPrototypeTail(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  expectedType: ValType | undefined,
  callbacks: NumberPrototypeTailCallbacks,
): InnerResult | undefined {
  if (!ctx.standalone || propAccess.name.text !== "toString") return undefined;

  if (
    callbacks.sourceOverridesBuiltinPrototypeMember(ctx, callExpr, "Number", "toString") &&
    callExpr.arguments.length === 0
  ) {
    const dynamic = callbacks.emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, "toString", callExpr);
    if (dynamic !== null) return dynamic;
  }

  if (!ctx.deletedBuiltinPrototypeMembers?.has("Number.prototype.toString")) return undefined;

  const objectProto = ts.factory.createPropertyAccessExpression(
    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Object"), "prototype"),
    "toString",
  );
  const borrowed = ts.factory.createPropertyAccessExpression(objectProto, "call");
  const borrowedCall = ts.factory.createCallExpression(borrowed, undefined, [
    propAccess.expression,
    ...Array.from(callExpr.arguments),
  ]);
  ts.setTextRange(borrowedCall, callExpr);
  (borrowedCall as { parent?: ts.Node }).parent = callExpr.parent;
  return callbacks.compileCallExpression(ctx, fctx, borrowedCall, expectedType);
}
