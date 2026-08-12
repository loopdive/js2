// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression } from "../shared.js";
import { noJsHost } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/** Call an externref receiver's runtime-computed member through the fixed host bridge. */
export function tryEmitDynamicElementHostMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
): InnerResult | undefined {
  if (
    noJsHost(ctx) ||
    elemAccess.argumentExpression === undefined ||
    expr.arguments.length > 4 ||
    expr.arguments.some((arg) => ts.isSpreadElement(arg))
  ) {
    return undefined;
  }

  const externref: ValType = { kind: "externref" };
  const importName = `__extern_method_call_${expr.arguments.length}`;
  const callIdx = ensureLateImport(
    ctx,
    importName,
    Array.from({ length: 2 + expr.arguments.length }, () => externref),
    [externref],
  );
  flushLateImportShifts(ctx, fctx);
  if (callIdx === undefined) return undefined;

  const pushExtern = (value: ts.Expression): void => {
    const type = compileExpression(ctx, fctx, value, externref);
    if (type === null) fctx.body.push({ op: "ref.null.extern" });
    else if (type.kind !== "externref") coerceType(ctx, fctx, type, externref);
  };
  pushExtern(elemAccess.expression);
  pushExtern(elemAccess.argumentExpression);
  for (const arg of expr.arguments) pushExtern(arg);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(importName) ?? callIdx });
  return externref;
}
