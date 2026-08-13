// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Semantic lowering for stored Object builtins and statically-known uncurried
 * prototype methods. Metadata reads still observe the canonical builtin
 * closure; only invocation is routed to the same provider as the direct
 * spelling.
 */
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileArrayMethodCall } from "../array-methods.js";
import { allocLocal } from "../context/locals.js";
import { resolveStoredObjectStaticMethod, resolveUncurriedBuiltinPrototypeMethod } from "../object-builtin-effects.js";
import { compileObjectDefineProperties, compileObjectDefineProperty } from "../object-ops.js";
import { ensureObjVecBuilders } from "../object-runtime.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression } from "../shared.js";
import { pushDefaultValue } from "../type-coercion.js";
import { emitThrowTypeError, noJsHost } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { ts } from "../../ts-api.js";

export function tryCompileObjectCreateStaticPrototype(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): InnerResult | undefined {
  // ES5 §15.2.3.5 step 1: the requested [[Prototype]] must be an Object
  // or null. The standalone native helper can only see an externref carrier;
  // reject statically known primitives after preserving argument evaluation.
  if (noJsHost(ctx)) {
    const protoTag = ctx.oracle.staticJsTypeOf(arg);
    if (
      protoTag === "number" ||
      protoTag === "string" ||
      protoTag === "boolean" ||
      protoTag === "bigint" ||
      protoTag === "symbol" ||
      protoTag === "undefined"
    ) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Object prototype may only be an Object or null");
      return { kind: "externref" };
    }
  }

  // Object.create(Foo.prototype) → struct.new with default fields (Wasm-native fast path)
  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression) && arg.name.text === "prototype") {
    const protoClassName = arg.expression.text;
    const structTypeIdx = ctx.structMap.get(protoClassName);
    const fields = ctx.structFields.get(protoClassName);
    if (ctx.classSet.has(protoClassName) && structTypeIdx !== undefined && fields) {
      for (const field of fields) pushDefaultValue(fctx, field.type, ctx);
      fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
      return { kind: "ref", typeIdx: structTypeIdx };
    }
  }
  return undefined;
}

function emitExternrefArgument(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  index: number,
  externRef: ValType,
): void {
  const arg = expr.arguments[index];
  if (!arg) {
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  const actual = compileExpression(ctx, fctx, arg, externRef);
  if (actual === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (actual.kind !== "externref") {
    coerceType(ctx, fctx, actual, externRef);
  }
}

function emitStoredObjectIntegrityCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: "freeze" | "seal" | "preventExtensions",
): InnerResult {
  const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
  if (!argType) return null;
  if (argType.kind === "ref" || argType.kind === "ref_null" || argType.kind === "anyref" || argType.kind === "eqref") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (argType.kind !== "externref") {
    return argType;
  }
  const helperName =
    method === "freeze" ? "__object_freeze" : method === "seal" ? "__object_seal" : "__object_preventExtensions";
  const externRef: ValType = { kind: "externref" };
  const helperIdx = ensureLateImport(ctx, helperName, [externRef], [externRef]);
  flushLateImportShifts(ctx, fctx);
  const finalHelperIdx = ctx.funcMap.get(helperName) ?? helperIdx;
  if (finalHelperIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalHelperIdx });
  return externRef;
}

function emitStoredObjectIntrospectionCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: "getOwnPropertyDescriptor" | "getOwnPropertyNames",
): ValType {
  const externRef: ValType = { kind: "externref" };
  const arity = method === "getOwnPropertyDescriptor" ? 2 : 1;
  for (let index = 0; index < arity; index++) emitExternrefArgument(ctx, fctx, expr, index, externRef);
  const helperName = method === "getOwnPropertyDescriptor" ? "__getOwnPropertyDescriptor" : "__getOwnPropertyNames";
  const helperIdx = ensureLateImport(
    ctx,
    helperName,
    Array.from({ length: arity }, () => externRef),
    [externRef],
  );
  flushLateImportShifts(ctx, fctx);
  const finalHelperIdx = ctx.funcMap.get(helperName) ?? helperIdx;
  if (finalHelperIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: finalHelperIdx });
  } else {
    for (let index = 0; index < arity; index++) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
  }
  return externRef;
}

function emitStoredObjectAssignCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): ValType {
  const externRef: ValType = { kind: "externref" };
  emitExternrefArgument(ctx, fctx, expr, 0, externRef);
  const targetLocal = allocLocal(fctx, `__stored_assign_tgt_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: targetLocal });

  const nativeSemanticProviders = ctx.targetProfile.semanticProviders === "native-first";
  const nativeBuilders = nativeSemanticProviders ? ensureObjVecBuilders(ctx) : undefined;
  const arrNewIdx = nativeBuilders?.newIdx ?? ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  const arrPushIdx = nativeBuilders?.pushIdx ?? ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  const assignIdx = ensureLateImport(ctx, "__object_assign", [externRef, externRef], [externRef]);
  flushLateImportShifts(ctx, fctx);
  const finalArrNewIdx = nativeBuilders?.newIdx ?? ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
  const finalArrPushIdx = nativeBuilders?.pushIdx ?? ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  const finalAssignIdx = ctx.funcMap.get("__object_assign") ?? assignIdx;
  if (finalArrNewIdx === undefined || finalArrPushIdx === undefined || finalAssignIdx === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
    return externRef;
  }

  fctx.body.push({ op: "call", funcIdx: finalArrNewIdx });
  const sourcesLocal = allocLocal(fctx, `__stored_assign_src_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: sourcesLocal });
  for (let index = 1; index < expr.arguments.length; index++) {
    fctx.body.push({ op: "local.get", index: sourcesLocal });
    emitExternrefArgument(ctx, fctx, expr, index, externRef);
    fctx.body.push({ op: "call", funcIdx: finalArrPushIdx });
  }
  fctx.body.push({ op: "local.get", index: targetLocal });
  fctx.body.push({ op: "local.get", index: sourcesLocal });
  fctx.body.push({ op: "call", funcIdx: finalAssignIdx });
  return externRef;
}

export function tryCompileStoredObjectBuiltinCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  const storedObjectStatic = resolveStoredObjectStaticMethod(ctx.oracle, expr.expression);
  if (storedObjectStatic === "assign" && expr.arguments.length >= 1 && !noJsHost(ctx)) {
    return emitStoredObjectAssignCall(ctx, fctx, expr);
  }
  if (storedObjectStatic === "defineProperty" && expr.arguments.length >= 3) {
    return compileObjectDefineProperty(ctx, fctx, expr);
  }
  if (storedObjectStatic === "defineProperties" && expr.arguments.length >= 2) {
    return compileObjectDefineProperties(ctx, fctx, expr);
  }
  if (
    (storedObjectStatic === "freeze" || storedObjectStatic === "seal" || storedObjectStatic === "preventExtensions") &&
    expr.arguments.length >= 1
  ) {
    return emitStoredObjectIntegrityCall(ctx, fctx, expr, storedObjectStatic);
  }
  if (storedObjectStatic === "getOwnPropertyDescriptor" || storedObjectStatic === "getOwnPropertyNames") {
    return emitStoredObjectIntrospectionCall(ctx, fctx, expr, storedObjectStatic);
  }

  const uncurriedMethod = resolveUncurriedBuiltinPrototypeMethod(ctx.oracle, expr.expression);
  if (uncurriedMethod === undefined) return undefined;
  if (uncurriedMethod.builtin === "Array") {
    // (#3571) propertyHelper's `__push`/`__join` aliases are immutable builtin
    // identities. Compile `alias(receiver, ...args)` exactly as
    // `receiver.push/join(...args)`, preserving argument order while avoiding
    // the incomplete generic Function.call → builtin-method carrier chain.
    const receiver = expr.arguments[0];
    if (!receiver) return undefined;
    const receiverFact = ctx.oracle.typeFactOf(receiver);
    if (receiverFact.kind !== "array" && receiverFact.kind !== "tuple") return undefined;
    const propAccess = ts.factory.createPropertyAccessExpression(receiver, uncurriedMethod.method);
    ts.setTextRange(propAccess, expr);
    (propAccess as { parent: ts.Node }).parent = expr.parent;
    const call = ts.factory.createCallExpression(propAccess, undefined, expr.arguments.slice(1));
    ts.setTextRange(call, expr);
    (call as { parent: ts.Node }).parent = expr.parent;
    return compileArrayMethodCall(ctx, fctx, propAccess, call, undefined, uncurriedMethod.method);
  }

  const externRef: ValType = { kind: "externref" };
  emitExternrefArgument(ctx, fctx, expr, 0, externRef);
  if (uncurriedMethod.method === "valueOf") return externRef;
  emitExternrefArgument(ctx, fctx, expr, 1, externRef);
  const helperName = uncurriedMethod.method === "hasOwnProperty" ? "__hasOwnProperty" : "__propertyIsEnumerable";
  const boolType: ValType = { kind: "i32", boolean: true };
  const helperIdx = ensureLateImport(ctx, helperName, [externRef, externRef], [boolType]);
  flushLateImportShifts(ctx, fctx);
  const finalHelperIdx = ctx.funcMap.get(helperName) ?? helperIdx;
  if (finalHelperIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: finalHelperIdx });
  } else {
    fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "i32.const", value: 0 });
  }
  return boolType;
}
