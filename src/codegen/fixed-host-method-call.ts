// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { BUILTIN_CLASS_NAMES } from "./expressions/builtin-class-names.js";
import { maybeStampCompiledFunctionArgName } from "./expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { compileExpression } from "./shared.js";

const MAX_FIXED_HOST_METHOD_CALL_ARITY = 3;

/**
 * Emit one fixed-signature import for a small dynamic JS-host method call.
 *
 * The generic bridge otherwise crosses into JS once to allocate an argument
 * array and once per argument to populate it before the actual method call.
 * Passing evaluated arguments directly removes those crossings. The runtime
 * companion still delegates to the canonical `__extern_method_call`, keeping
 * receiver wrapping, callbacks, mutation reconciliation, and errors identical.
 */
export function tryEmitFixedHostMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): boolean {
  if (
    ctx.standalone ||
    ctx.wasi ||
    ctx.targetProfile.semanticProviders === "native-first" ||
    process.env.JS2WASM_FIXED_HOST_METHOD_CALLS === "0" ||
    expr.arguments.length > MAX_FIXED_HOST_METHOD_CALL_ARITY ||
    expr.arguments.some((arg) => ts.isSpreadElement(arg))
  ) {
    return false;
  }

  const externref = { kind: "externref" as const };
  const importName = `__extern_method_call_${expr.arguments.length}`;
  const methodCallIdx = ensureLateImport(
    ctx,
    importName,
    Array.from({ length: 2 + expr.arguments.length }, () => externref),
    [externref],
  );
  const receiver = propAccess.expression;
  const receiverIsBuiltin = ts.isIdentifier(receiver) && BUILTIN_CLASS_NAMES.has(receiver.text);
  const getBuiltinIdx = receiverIsBuiltin
    ? ensureLateImport(ctx, "__get_builtin", [externref], [externref])
    : undefined;
  flushLateImportShifts(ctx, fctx);
  if (methodCallIdx === undefined || (receiverIsBuiltin && getBuiltinIdx === undefined)) return false;

  if (receiverIsBuiltin) {
    addStringConstantGlobal(ctx, (receiver as ts.Identifier).text);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, (receiver as ts.Identifier).text));
    fctx.body.push({ op: "call", funcIdx: getBuiltinIdx! });
  } else {
    const recvType = compileExpression(ctx, fctx, receiver, externref);
    if (recvType && recvType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  }
  const recvLocal = allocLocal(fctx, `__emc_recv_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: recvLocal });

  const argLocals: number[] = [];
  for (const arg of expr.arguments) {
    const argType = compileExpression(ctx, fctx, arg, externref);
    if (argType && argType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
    if (argType === null) fctx.body.push({ op: "ref.null.extern" });
    maybeStampCompiledFunctionArgName(ctx, fctx, arg);
    const argLocal = allocLocal(fctx, `__emc_arg_${fctx.locals.length}`, externref);
    fctx.body.push({ op: "local.set", index: argLocal });
    argLocals.push(argLocal);
  }

  fctx.body.push({ op: "local.get", index: recvLocal });
  addStringConstantGlobal(ctx, methodName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
  for (const argLocal of argLocals) fctx.body.push({ op: "local.get", index: argLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(importName) ?? methodCallIdx });
  return true;
}
