// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Native-string kernels for derived scalar observations. */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { STR_TRIM_LENGTH_FN } from "./native-strings-ws.js";
import { coerceType, compileExpression } from "./shared.js";

export function staticUniformDerivedLength(
  receiverValues: readonly string[] | undefined,
  method: string,
  args: ts.NodeArray<ts.Expression>,
): number | undefined {
  if (!receiverValues) return undefined;
  if (method === "trim" && args.length === 0) {
    const lengths = new Set(receiverValues.map((value) => value.trim().length));
    return lengths.size === 1 ? lengths.values().next().value : undefined;
  }
  if (method === "split" && args.length === 1 && ts.isStringLiteralLike(args[0]!)) {
    const separator = args[0]!.text;
    const lengths = new Set(receiverValues.map((value) => value.split(separator).length));
    return lengths.size === 1 ? lengths.values().next().value : undefined;
  }
  return undefined;
}

/**
 * Emit a runtime trim-span scan when an immutable string table proves that the
 * receiver cannot be an object with a user-defined `trim` method.
 */
export function tryEmitNativeTrimLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
  receiverValues: readonly string[] | undefined,
): ValType | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const callee = call.expression;
  if (!receiverValues || !ctx.nativeStrings || callee.name.text !== "trim" || call.arguments.length !== 0) {
    return undefined;
  }
  const trimLengthIdx = ctx.nativeStrHelpers.get(STR_TRIM_LENGTH_FN);
  if (trimLengthIdx === undefined || ctx.anyStrTypeIdx < 0) return undefined;

  const receiverType = compileExpression(ctx, fctx, callee.expression);
  const expected: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  if (receiverType) coerceType(ctx, fctx, receiverType, expected);
  fctx.body.push({ op: "call", funcIdx: trimLengthIdx });
  return { kind: "i32" };
}
