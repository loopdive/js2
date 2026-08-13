// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../../ir/types.js";
import type { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { tryEmitDynamicValueOfCall } from "../wrapper-valueof.js";
import { compileExpression } from "../shared.js";

/** Apply Object.prototype.valueOf only when no live compiled override may exist. */
export function tryEmitValueOfFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (access.name.text !== "valueOf" || call.arguments.length !== 0) return undefined;
  const receiverFact = ctx.oracle.typeFactOf(access.expression).kind;
  const dynamicReceiver = receiverFact === "any" || receiverFact === "unknown";
  if (!ctx.standalone && dynamicReceiver) return undefined;
  return tryEmitDynamicValueOfCall(ctx, fctx, access) ?? compileExpression(ctx, fctx, access.expression);
}
