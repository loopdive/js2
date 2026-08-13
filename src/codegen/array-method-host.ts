// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/** Invoke an Array method on a real host-owned Array carried as externref. */
export function compileArrayMethodExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  methodName: string,
): ValType | null {
  const externref: ValType = { kind: "externref" };
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externref]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externref, externref], []);
  const methodCallIdx = ensureLateImport(ctx, "__extern_method_call", [externref, externref, externref], [externref]);
  addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);
  if (arrNewIdx === undefined || arrPushIdx === undefined || methodCallIdx === undefined) return null;

  const recvLocal = allocLocal(fctx, `__array_ext_recv_${fctx.locals.length}`, externref);
  const recvType = compileExpression(ctx, fctx, propAccess.expression, externref);
  if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, externref);
  fctx.body.push({ op: "local.set", index: recvLocal }, { op: "call", funcIdx: arrNewIdx });

  const argsLocal = allocLocal(fctx, `__array_ext_args_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of callExpr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, externref);
    if (argType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, externref);
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  }

  fctx.body.push(
    { op: "local.get", index: recvLocal },
    ...stringConstantExternrefInstrs(ctx, methodName),
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: methodCallIdx },
  );
  return externref;
}
