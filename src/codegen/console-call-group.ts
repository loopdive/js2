// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { reportError } from "./context/errors.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { ensureNativeStringExternBridge } from "./native-strings.js";
import { coerceType, compileExpression } from "./shared.js";
import { expressionHasWidenedPropertyType } from "./strict-eq-stale-type.js";

/** Compile one argument with the same boundary conversion as a single-argument console call. */
function compileArgument(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): { tag: string; type: ValType } {
  const type = ctx.oracle.typeFactOf(arg);
  const stale = expressionHasWidenedPropertyType(ctx, arg);
  if (!stale && type.kind === "number") {
    compileExpression(ctx, fctx, arg, { kind: "f64" });
    return { tag: "n", type: { kind: "f64" } };
  }
  if (!stale && type.kind === "boolean") {
    compileExpression(ctx, fctx, arg, { kind: "i32" });
    return { tag: "b", type: { kind: "i32" } };
  }
  const stringLike =
    type.kind === "string" ||
    (type.kind === "union" && type.parts.length > 0 && type.parts.every((part) => part.kind === "string")) ||
    (type.kind === "builtin" && type.name === "String");
  if (!stale && stringLike) {
    compileExpression(ctx, fctx, arg);
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      ensureNativeStringExternBridge(ctx);
      flushLateImportShifts(ctx, fctx);
      const flatten = ctx.nativeStrHelpers.get("__str_flatten");
      if (flatten !== undefined) fctx.body.push({ op: "call", funcIdx: flatten });
      const toExtern = ctx.nativeStrHelpers.get("__str_to_extern");
      if (toExtern !== undefined) fctx.body.push({ op: "call", funcIdx: toExtern });
    }
    return { tag: "s", type: { kind: "externref" } };
  }
  const value = compileExpression(ctx, fctx, arg);
  if (!value) emitUndefined(ctx, fctx);
  else if (value.kind === "f64" || value.kind === "i32" || value.kind === "i64") {
    coerceType(ctx, fctx, value, { kind: "externref" });
  }
  return { tag: "e", type: { kind: "externref" } };
}

/**
 * #5394: values stay on the Wasm stack until ALL argument evaluations finish.
 * One fixed-signature host import then invokes console once. Nested calls do
 * not share an accumulator, and a throwing argument never invokes the outer call.
 */
export function compileGroupedHostConsole(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
): void {
  if (expr.arguments.some(ts.isSpreadElement)) {
    reportError(
      ctx,
      expr,
      "Console spread arguments require iterator expansion before grouped host invocation (#5394)",
    );
    return;
  }
  const arguments_ = expr.arguments.map((arg) => compileArgument(ctx, fctx, arg));
  const signature = arguments_.map((arg) => arg.tag).join("") || "0";
  const name = `console_${method}_group_${signature}`;
  const provisional = ensureLateImport(
    ctx,
    name,
    arguments_.map((arg) => arg.type),
    [],
  );
  flushLateImportShifts(ctx, fctx);
  const index = ctx.funcMap.get(name) ?? provisional;
  if (index === undefined) reportError(ctx, expr, "Grouped console host import could not be registered (#5394)");
  else fctx.body.push({ op: "call", funcIdx: index });
}
