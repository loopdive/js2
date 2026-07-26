// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Semantic lowering for stored Object builtins and uncurried Object prototype
 * methods. Metadata reads still observe the canonical builtin closure; only
 * invocation is routed to the same provider as the direct spelling.
 */
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolveStoredObjectStaticMethod, resolveUncurriedObjectPrototypeMethod } from "../object-builtin-effects.js";
import { compileObjectDefineProperties, compileObjectDefineProperty } from "../object-ops.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression } from "../shared.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { ts } from "../../ts-api.js";

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

export function tryCompileStoredObjectBuiltinCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  const storedObjectStatic = resolveStoredObjectStaticMethod(ctx.oracle, expr.expression);
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

  const uncurriedObjectMethod = resolveUncurriedObjectPrototypeMethod(ctx.oracle, expr.expression);
  if (uncurriedObjectMethod === undefined) return undefined;
  const externRef: ValType = { kind: "externref" };
  emitExternrefArgument(ctx, fctx, expr, 0, externRef);
  if (uncurriedObjectMethod === "valueOf") return externRef;
  emitExternrefArgument(ctx, fctx, expr, 1, externRef);
  const helperName = uncurriedObjectMethod === "hasOwnProperty" ? "__hasOwnProperty" : "__propertyIsEnumerable";
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
